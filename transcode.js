// On-the-fly transcoding with ffmpeg: probe, fragmented-MP4 streaming, embedded subtitles.
import { spawn, execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { touch } from './cache.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';
const MAX_TRANSCODES = Number(process.env.MAX_TRANSCODES || 2);
const X264_PRESET = process.env.X264_PRESET || 'veryfast';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '192k';

// What browsers can play inside an MP4/WebM without help.
const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.webm']);
const BROWSER_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis']);
// Codecs we can copy straight into a fragmented MP4. Audio is always re-encoded:
// copied MP3/AAC from AVI and TV rips often has broken timestamps or gaps and drifts.
const COPY_VIDEO = new Set(['h264']);
const TEXT_SUBS = new Set(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);

// ---------- probe ----------
const probeCache = new Map();

function runProbe(file) {
  return new Promise((resolve, reject) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { maxBuffer: 16 << 20, timeout: 30_000 },
      (err, stdout) => {
        if (err) return reject(new Error('ffprobe failed: ' + (err.stderr || err.message).toString().slice(0, 300)));
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

export async function probe(file) {
  const st = await fsp.stat(file);
  const key = `${file}:${st.mtimeMs}`;
  if (probeCache.has(key)) return probeCache.get(key);

  const j = await runProbe(file);
  const streams = j.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');

  const info = {
    duration: Number(j.format?.duration) || Number(v?.duration) || 0,
    startTime: Number(j.format?.start_time) || 0,
    video: v ? { codec: v.codec_name, width: v.width, height: v.height, pixFmt: v.pix_fmt || '' } : null,
    audio: audio.map((s, i) => ({
      index: i,
      codec: s.codec_name,
      channels: s.channels || 0,
      lang: s.tags?.language || '',
      title: s.tags?.title || '',
      default: !!s.disposition?.default,
    })),
    // only text subtitles can become WebVTT; image subs (PGS/VobSub) are skipped
    subs: subs
      .map((s, i) => ({ index: i, codec: s.codec_name, lang: s.tags?.language || '', title: s.tags?.title || '' }))
      .filter((s) => TEXT_SUBS.has(s.codec)),
  };
  if (probeCache.size > 2000) probeCache.clear();
  probeCache.set(key, info);
  return info;
}

// ---------- decide how to play ----------
export function plan(file, info, audioIdx = 0) {
  const ext = path.extname(file).toLowerCase();
  const v = info.video;
  const a = info.audio[audioIdx];
  // 10-bit / 4:2:2 / 4:4:4 H.264 is not playable in browsers
  const plainPix = !/(10|12)(le|be)|422|444/.test(v?.pixFmt || '');
  const videoOk = !!v && BROWSER_VIDEO.has(v.codec) && plainPix;
  const audioOk = !a || BROWSER_AUDIO.has(a.codec);
  // browsers play only the first audio track of a direct file
  const direct = DIRECT_CONTAINERS.has(ext) && videoOk && audioOk && audioIdx === 0;

  const copyVideo = !!v && COPY_VIDEO.has(v.codec) && plainPix;
  let mode = 'direct';
  if (!direct) mode = copyVideo ? 'audio' : 'video';
  return { mode, copyVideo };
}

// ---------- seek point ----------
// When video is copied, ffmpeg can only start at a keyframe. Find the keyframe at or before `t`
// so the player knows exactly where the stream begins (timeline and subtitles stay correct).
// `ss` is what we pass to ffmpeg: a bit after that keyframe (but before the next one), because
// ffmpeg's MKV seeking falls back to the previous keyframe when -ss equals the keyframe time.
export function keyframeBefore(file, info, t) {
  if (t <= 0) return Promise.resolve({ start: 0, ss: 0 });
  const base = info.startTime || 0;
  const abs = base + t;
  const from = Math.max(0, abs - 15);
  return new Promise((resolve) => {
    execFile(
      FFPROBE,
      ['-v', 'error', '-select_streams', 'V:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0',
        '-read_intervals', `${from.toFixed(3)}%${(abs + 3).toFixed(3)}`, file],
      { maxBuffer: 32 << 20, timeout: 15_000 },
      (err, stdout) => {
        if (err) return resolve({ start: t, ss: t });
        const keys = [];
        for (const line of stdout.split('\n')) {
          const [pts, flags] = line.split(',');
          const x = Number(pts);
          if (flags && flags.includes('K') && Number.isFinite(x)) keys.push(x);
        }
        keys.sort((x, y) => x - y);
        const before = keys.filter((x) => x <= abs + 0.001);
        if (!before.length) return resolve({ start: t, ss: t });
        const k = before[before.length - 1];
        const next = keys.find((x) => x > k + 0.001);
        const nudge = next ? Math.min(0.5, (next - k) / 2) : 0.5;
        const start = Math.max(0, k - base);
        resolve({ start, ss: start + nudge });
      },
    );
  });
}

export async function seekPoint(file, info, t, audioIdx) {
  const p = plan(file, info, audioIdx);
  if (p.mode === 'direct' || !p.copyVideo) return { start: t, ss: t }; // re-encoded video starts exactly at t
  return keyframeBefore(file, info, t);
}

// ---------- streaming transcode ----------
let active = 0;
// one live stream per viewer session: a new request (seek, audio switch, reconnect) replaces the old one
const bySession = new Map();

export function streamTranscode(req, res, file, info, { ss = 0, audio = 0, session = '' } = {}) {
  // The output is generated on the fly and can't be resumed at a byte offset. Browsers send
  // "Range: bytes=N-" when they reconnect after a dropped connection; refuse it so the player
  // restarts the stream at the right *time* instead of receiving the wrong bytes.
  const m = /^bytes=(\d+)-/.exec(req.headers.range || '');
  if (m && Number(m[1]) > 0) {
    res.setHeader('Content-Range', 'bytes */*');
    return res.sendStatus(416);
  }
  const prev = session && bySession.get(session);
  if (prev) prev.destroy(); // frees its ffmpeg via the 'close' handler below

  if (active >= MAX_TRANSCODES) {
    return res.status(503).json({ error: 'Too many simultaneous streams, try again in a moment' });
  }
  const p = plan(file, info, audio);
  const ext = path.extname(file).toLowerCase();

  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (ext === '.avi') args.push('-fflags', '+genpts'); // old Xvid/DivX files often lack timestamps
  if (ss > 0) args.push('-ss', ss.toFixed(3));
  args.push('-i', file, '-map', '0:V:0'); // V = real video, not cover art
  if (info.audio.length) args.push('-map', `0:a:${audio}`);
  args.push('-sn', '-dn');

  if (p.copyVideo) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'libx264', '-preset', X264_PRESET, '-crf', '22', '-pix_fmt', 'yuv420p',
      '-vf', "scale=-2:'min(1080,ih)'", '-g', '48', '-threads', '0',
    );
  }
  if (info.audio.length) {
    // async resampling keeps audio locked to timestamps: fills gaps with silence, trims overlaps
    args.push('-af', 'aresample=async=1000:min_hard_comp=0.1', '-c:a', 'aac', '-b:a', AUDIO_BITRATE, '-ac', '2');
  }
  args.push('-max_muxing_queue_size', '4096');
  args.push('-avoid_negative_ts', 'make_zero', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

  const ff = spawn(FFMPEG, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  active++;
  if (session) bySession.set(session, res);
  const t0 = Date.now();
  let bytes = 0;
  ff.stdout.on('data', (d) => (bytes += d.length));
  let stderr = '';
  ff.stderr.on('data', (d) => {
    if (stderr.length < 4000) stderr += d;
  });
  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    active--;
  };
  ff.on('error', (e) => {
    done();
    console.error('ffmpeg spawn failed:', e.message);
    if (!res.headersSent) res.status(500).json({ error: 'ffmpeg not available' });
    else res.destroy();
  });
  ff.on('close', (code, signal) => {
    done();
    if (code && !signal && stderr) console.error(`ffmpeg exited ${code} for ${path.basename(file)}:`, stderr.trim().slice(0, 500));
  });

  res.status(200);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Transcode-Mode', p.mode);
  ff.stdout.pipe(res);
  // viewer closed the tab or seeked -> stop ffmpeg right away
  res.on('close', () => {
    if (session && bySession.get(session) === res) bySession.delete(session);
    if (!finished) ff.kill('SIGKILL');
    console.log(`stream ${path.basename(file)} @${ss.toFixed(0)}s [${p.mode}] closed after ${((Date.now() - t0) / 1000).toFixed(0)}s, ${(bytes / 1e6).toFixed(1)} MB`);
  });
}

// ---------- subtitles ----------
const TS = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

function parseTs(s) {
  const m = TS.exec(s);
  if (!m) return null;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}
function fmtTs(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)}.${p(r, 3)}`;
}

// Shift every cue back by `offset` seconds (the stream started at `offset`).
export function shiftVtt(vtt, offset) {
  if (!offset) return vtt;
  const blocks = vtt.split(/\n{2,}/);
  const out = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) {
      out.push(b);
      continue;
    }
    const [l, r] = lines[i].split('-->');
    const start = parseTs(l);
    const endMatch = TS.exec(r);
    const end = parseTs(r);
    if (start == null || end == null) continue;
    const ns = start - offset;
    const ne = end - offset;
    if (ne <= 0) continue;
    const settings = r.slice(endMatch.index + endMatch[0].length);
    lines[i] = `${fmtTs(Math.max(0, ns))} --> ${fmtTs(ne)}${settings}`;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n');
}

// Embedded subtitles are extracted once (whole file read) and cached on disk.
const extracting = new Map();

export async function embeddedVtt(file, subIdx, cacheDir) {
  const st = await fsp.stat(file);
  const key = crypto.createHash('sha1').update(`${file}:${st.mtimeMs}:${subIdx}`).digest('hex');
  const out = path.join(cacheDir, 'subs', key + '.vtt');
  try {
    const text = await fsp.readFile(out, 'utf8');
    touch(out);
    return text;
  } catch {}
  if (extracting.has(out)) return extracting.get(out);

  const job = (async () => {
    await fsp.mkdir(path.dirname(out), { recursive: true });
    const tmp = out + '.tmp';
    await new Promise((resolve, reject) => {
      execFile(
        FFMPEG,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', file, '-map', `0:s:${subIdx}`, '-f', 'webvtt', tmp],
        { timeout: 5 * 60_000 },
        (err) => (err ? reject(err) : resolve()),
      );
    });
    await fsp.rename(tmp, out);
    return fsp.readFile(out, 'utf8');
  })();
  extracting.set(out, job);
  try {
    return await job;
  } finally {
    extracting.delete(out);
  }
}
