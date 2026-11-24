// Music library: folder tree, CUE sheets, tags, covers, streaming and cached transcoding.
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { sendRange, decodeText } from './util.js';
import { touch } from './cache.js';

const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

const AUDIO_EXT = new Set(['.mp3', '.flac', '.ogg', '.oga', '.opus', '.wav', '.ape', '.wv', '.wma', '.m4a', '.aac', '.aif', '.aiff', '.tta', '.mpc']);
// played by browsers as-is (whole files only; CUE tracks are always cut by ffmpeg)
const DIRECT = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
const LOSSLESS = new Set(['.flac', '.wav', '.ape', '.wv', '.aif', '.aiff', '.tta']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.gif', '.webp']);
const ART_DIRS = /^(covers?|scans?|artwork|art|images?)$/i;

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const ext = (f) => path.extname(f).toLowerCase();
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function run(cmd, args, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 32 << 20, timeout }, (err, stdout, stderr) =>
      err ? reject(new Error((stderr || err.message).toString().slice(0, 400))) : resolve(stdout),
    );
  });
}

// tiny semaphore so a burst of requests doesn't start a dozen ffmpegs on the Pi
function limiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

// ---------- CUE ----------
// returns { title, performer, date, files: [{ name, tracks: [{ n, title, performer, start }] }] }
export function parseCue(text) {
  const cue = { title: '', performer: '', date: '', files: [] };
  let file = null;
  let track = null;
  const unq = (s) => s.trim().replace(/^"(.*)"$/, '$1');
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const cmd = m[1].toUpperCase();
    const arg = m[2];
    if (cmd === 'FILE') {
      const fm = /^"(.+)"\s+\S+$/.exec(arg) || /^(.+?)\s+\S+$/.exec(arg) || [null, arg];
      file = { name: fm[1].trim(), tracks: [] };
      cue.files.push(file);
      track = null;
    } else if (cmd === 'TRACK' && file) {
      track = { n: parseInt(arg, 10), title: '', performer: '', start: null };
      file.tracks.push(track);
    } else if (cmd === 'INDEX' && track) {
      const im = /^(\d+)\s+(\d+):(\d+):(\d+)/.exec(arg);
      if (im && (Number(im[1]) === 1 || track.start == null)) track.start = Number(im[2]) * 60 + Number(im[3]) + Number(im[4]) / 75;
    } else if (cmd === 'TITLE') {
      (track || cue).title = unq(arg);
    } else if (cmd === 'PERFORMER') {
      (track || cue).performer = unq(arg);
    } else if (cmd === 'REM' && /^DATE\s/i.test(arg)) {
      cue.date = unq(arg.slice(5));
    }
  }
  return cue;
}

// CUE that describes one big audio file ("image") -> that file's name in the folder, else null
function cueImage(cue, audioFiles) {
  if (cue.files.length !== 1 || cue.files[0].tracks.length < 2) return null;
  const want = path.basename(cue.files[0].name.replace(/\\/g, '/')).toLowerCase();
  const byName = audioFiles.find((f) => f.toLowerCase() === want);
  if (byName) return byName;
  // cue often says .wav while the file is .flac/.ape
  const stem = want.replace(/\.[^.]+$/, '');
  return audioFiles.find((f) => f.toLowerCase().replace(/\.[^.]+$/, '') === stem) || null;
}

// ---------- tags ----------
async function probeAudio(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-select_streams', 'a:0', '-of', 'json', file], 30_000);
  const j = JSON.parse(out);
  const tags = {};
  for (const src of [j.format?.tags, j.streams?.[0]?.tags]) {
    for (const [k, v] of Object.entries(src || {})) tags[k.toLowerCase()] ??= v;
  }
  const s = j.streams?.[0] || {};
  return {
    duration: Number(j.format?.duration) || 0,
    codec: s.codec_name || '',
    bitrate: Math.round((Number(s.bit_rate) || Number(j.format?.bit_rate) || 0) / 1000), // kbps
    sampleRate: Number(s.sample_rate) || 0,
    bits: Number(s.bits_per_raw_sample) || Number(s.bits_per_sample) || 0,
    title: tags.title || '',
    artist: tags.artist || tags.album_artist || '',
    album: tags.album || '',
    n: parseInt(tags.track, 10) || 0,
    date: tags.date || tags.year || '',
  };
}

// ---------- quality labels: "MP3 320", "FLAC 16/44.1", "FLAC 24/96" ----------
const CODEC_NAMES = { alac: 'ALAC', aac: 'AAC', vorbis: 'OGG', opus: 'OPUS', wmav1: 'WMA', wmav2: 'WMA', wmapro: 'WMA', wmalossless: 'WMA LL' };
export function qualityLabel(file, info) {
  const e = ext(file);
  const name = (['.m4a', '.ogg', '.oga', '.wma'].includes(e) && CODEC_NAMES[info.codec]) || e.slice(1).toUpperCase();
  const lossless = LOSSLESS.has(e) || ['alac', 'wmalossless'].includes(info.codec);
  const khz = info.sampleRate ? String(+(info.sampleRate / 1000).toFixed(1)) : '';
  if (lossless && info.bits && khz) return `${name} ${info.bits}/${khz}`;
  if (lossless && khz) return `${name} ${khz} кГц`;
  if (!lossless && info.bitrate) return `${name} ${info.bitrate}`;
  return name;
}

// ---------- router ----------
export function createMusicRouter({ root, cacheDir, cacheLimitMb = 2048, ecoBitrate = '192k' }) {
  const ROOT = path.resolve(root);
  const AUDIO_CACHE = path.join(cacheDir, 'audio');
  const COVER_CACHE = path.join(cacheDir, 'covers');
  const router = express.Router();
  const ffmpegSlot = limiter(2);

  const toId = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const fromId = (id) => {
    try {
      return JSON.parse(Buffer.from(String(id), 'base64url').toString('utf8'));
    } catch {
      return null;
    }
  };
  const resolveRel = (rel) => {
    const abs = path.resolve(ROOT, String(rel || ''));
    return abs === ROOT || abs.startsWith(ROOT + path.sep) ? abs : null;
  };

  // ----- tree: every folder that contains playable audio -----
  let tree = { at: 0, data: null, pending: null };
  async function scan() {
    const folders = [];
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
      const audio = files.filter((f) => AUDIO_EXT.has(ext(f))).sort(natural);
      if (audio.length) {
        let count = audio.length;
        // a CUE image counts as its tracks, not as one file
        for (const c of files.filter((f) => ext(f) === '.cue')) {
          try {
            const cue = parseCue(decodeText(await fsp.readFile(path.join(dir, c))));
            if (cueImage(cue, audio)) count += cue.files[0].tracks.length - 1;
          } catch {}
        }
        folders.push({ path: path.relative(ROOT, dir).split(path.sep).join('/'), count, files: audio });
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information') {
          await walk(path.join(dir, e.name));
        }
      }
    }
    await walk(ROOT);
    folders.sort((a, b) => natural(a.path, b.path));
    return folders;
  }
  async function getTree(force) {
    if (!force && tree.data && Date.now() - tree.at < 10 * 60_000) return tree.data;
    if (!tree.pending) {
      tree.pending = scan()
        .then((data) => {
          tree = { at: Date.now(), data, pending: null };
          folderCache.clear();
          return data;
        })
        .catch((e) => {
          tree.pending = null;
          throw e;
        });
    }
    return tree.pending;
  }

  router.get('/tree', async (req, res) => {
    res.json(await getTree(req.query.refresh === '1'));
  });

  // ----- one folder: tracks with tags, CUE images split into tracks -----
  const folderCache = new Map();
  async function readFolder(rel) {
    const dir = resolveRel(rel);
    if (!dir) return null;
    const st = await fsp.stat(dir);
    const hit = folderCache.get(rel);
    if (hit && hit.mtime === st.mtimeMs) return hit.data;

    const names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name);
    const audio = names.filter((f) => AUDIO_EXT.has(ext(f))).sort(natural);
    const images = new Map();
    for (const c of names.filter((f) => ext(f) === '.cue')) {
      try {
        const cue = parseCue(decodeText(await fsp.readFile(path.join(dir, c))));
        const img = cueImage(cue, audio);
        if (img && !images.has(img)) images.set(img, cue);
      } catch {}
    }

    const tracks = [];
    for (const f of audio) {
      const fileRel = rel ? rel + '/' + f : f;
      let info;
      try {
        info = await probeAudio(path.join(dir, f));
      } catch {
        continue; // unreadable file
      }
      const cue = images.get(f);
      if (cue) {
        const list = cue.files[0].tracks.filter((t) => t.start != null);
        list.forEach((t, i) => {
          const end = i + 1 < list.length ? list[i + 1].start : info.duration;
          tracks.push({
            id: toId({ f: fileRel, s: Math.round(t.start * 1000), e: Math.round(end * 1000) }),
            n: t.n,
            title: t.title || `Трек ${t.n}`,
            artist: t.performer || cue.performer || info.artist,
            album: cue.title || info.album,
            duration: Math.max(0, end - t.start),
            format: ext(f).slice(1),
            quality: qualityLabel(f, info),
            deliver: deliverLabels({ f: fileRel, s: 1 }),
          });
        });
      } else {
        tracks.push({
          id: toId({ f: fileRel }),
          n: info.n,
          title: info.title || f.replace(/\.[^.]+$/, ''),
          artist: info.artist,
          album: info.album,
          duration: info.duration,
          format: ext(f).slice(1),
          quality: qualityLabel(f, info),
          deliver: deliverLabels({ f: fileRel }),
        });
      }
    }
    // keep file order, but use tag track numbers when every file has one
    if (tracks.length && tracks.every((t) => t.n) && new Set(tracks.map((t) => t.n)).size === tracks.length && !images.size) {
      tracks.sort((a, b) => a.n - b.n);
    }
    const data = { path: rel, tracks };
    folderCache.set(rel, { mtime: st.mtimeMs, data });
    if (folderCache.size > 500) folderCache.delete(folderCache.keys().next().value);
    return data;
  }

  router.get('/folder', async (req, res) => {
    try {
      const data = await readFolder(String(req.query.path || ''));
      if (!data) return res.sendStatus(404);
      res.json(data);
    } catch {
      res.sendStatus(404);
    }
  });

  // ----- playback -----
  // Decide what to send: the original file, or a cached transcode (FLAC = lossless, M4A/AAC = compact).
  function target(t, q) {
    const e = ext(t.f);
    const whole = t.s == null;
    if (whole && DIRECT[e] && !(q === 'eco' && LOSSLESS.has(e))) return null;
    if (q === 'eco' || !LOSSLESS.has(e)) return 'm4a';
    return 'flac';
  }

  // what the browser actually receives in each mode; null = the original file as-is
  function deliverLabels(t) {
    const label = (fmt) => (fmt == null ? null : fmt === 'flac' ? 'FLAC' : `AAC ${String(ecoBitrate).replace(/k$/i, '')}`);
    return { orig: label(target(t, 'orig')), eco: label(target(t, 'eco')) };
  }

  async function prepare(abs, t, fmt) {
    const st = await fsp.stat(abs);
    const key = sha1(`${abs}:${st.mtimeMs}:${t.s ?? ''}:${t.e ?? ''}:${fmt}:${ecoBitrate}`);
    const out = path.join(AUDIO_CACHE, `${key}.${fmt}`);
    try {
      await fsp.access(out);
      touch(out); // mark as recently used
      return out;
    } catch {}
    return ffmpegSlot(async () => {
      try {
        await fsp.access(out);
        return out; // another request finished it while we waited
      } catch {}
      await fsp.mkdir(AUDIO_CACHE, { recursive: true });
      const tmp = `${out}.${process.pid}.${Date.now()}.tmp`;
      const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y'];
      if (t.s != null) args.push('-ss', (t.s / 1000).toFixed(3));
      args.push('-i', abs);
      if (t.e != null) args.push('-t', ((t.e - (t.s || 0)) / 1000).toFixed(3));
      args.push('-map', '0:a:0', '-vn', '-map_metadata', '-1');
      if (fmt === 'flac') args.push('-c:a', 'flac', '-compression_level', '1', '-f', 'flac', tmp);
      else args.push('-c:a', 'aac', '-b:a', ecoBitrate, '-ac', '2', '-movflags', '+faststart', '-f', 'mp4', tmp);
      try {
        await run(FFMPEG, args, 10 * 60_000);
        await fsp.rename(tmp, out);
      } catch (e) {
        await fsp.rm(tmp, { force: true });
        throw e;
      }
      trimCache().catch(() => {});
      return out;
    });
  }

  let trimming = false;
  async function trimCache() {
    if (trimming) return;
    trimming = true;
    try {
      const names = await fsp.readdir(AUDIO_CACHE);
      const files = [];
      for (const n of names) {
        if (n.endsWith('.tmp')) continue;
        const st = await fsp.stat(path.join(AUDIO_CACHE, n)).catch(() => null);
        if (st) files.push({ n, size: st.size, t: st.mtimeMs });
      }
      let total = files.reduce((a, f) => a + f.size, 0);
      const limit = cacheLimitMb * 1024 * 1024;
      files.sort((a, b) => a.t - b.t);
      for (const f of files) {
        if (total <= limit) break;
        await fsp.rm(path.join(AUDIO_CACHE, f.n), { force: true });
        total -= f.size;
      }
    } finally {
      trimming = false;
    }
  }

  function trackFromReq(req) {
    const t = fromId(req.params.id);
    if (!t || typeof t.f !== 'string') return null;
    const abs = resolveRel(t.f);
    if (!abs || !AUDIO_EXT.has(ext(abs))) return null;
    return { t, abs, q: req.query.q === 'eco' ? 'eco' : 'orig' };
  }

  router.get('/stream/:id', async (req, res) => {
    const r = trackFromReq(req);
    if (!r) return res.sendStatus(404);
    const fmt = target(r.t, r.q);
    if (!fmt) return sendRange(req, res, r.abs, DIRECT[ext(r.abs)]);
    try {
      const out = await prepare(r.abs, r.t, fmt);
      sendRange(req, res, out, fmt === 'flac' ? 'audio/flac' : 'audio/mp4');
    } catch (e) {
      console.error('audio transcode failed:', path.basename(r.abs), e.message);
      if (!res.headersSent) res.status(500).json({ error: 'Cannot convert this track' });
    }
  });

  // warm up the next track in the queue while the current one plays
  router.get('/prepare/:id', (req, res) => {
    const r = trackFromReq(req);
    if (!r) return res.sendStatus(404);
    const fmt = target(r.t, r.q);
    if (fmt) prepare(r.abs, r.t, fmt).catch(() => {});
    res.sendStatus(204);
  });

  // ----- covers -----
  async function findImage(dir) {
    const pick = (names) => {
      const imgs = names.filter((n) => IMAGE_EXT.has(ext(n)));
      const score = (n) => (/(cover|folder|front)/i.test(n) ? 0 : /(back|cd|disc|disk|inlay|inside|tray|booklet)/i.test(n) ? 2 : 1);
      imgs.sort((a, b) => score(a) - score(b) || natural(a, b));
      return imgs[0] || null;
    };
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    const here = pick(entries.filter((e) => e.isFile()).map((e) => e.name));
    if (here) return path.join(dir, here);
    for (const e of entries.filter((e) => e.isDirectory() && ART_DIRS.test(e.name))) {
      const sub = await fsp.readdir(path.join(dir, e.name)).catch(() => []);
      const p = pick(sub);
      if (p) return path.join(dir, e.name, p);
    }
    return null;
  }

  // folders without any art: remember for a while instead of running ffmpeg on every request
  const noCover = new Map();
  router.get('/cover', async (req, res) => {
    const rel = String(req.query.path || '');
    const dir = resolveRel(rel);
    if (!dir) return res.sendStatus(404);
    const size = Math.min(1000, Math.max(64, Number(req.query.s) || 600));
    if (Date.now() - (noCover.get(dir) || 0) < 10 * 60_000) return res.sendStatus(404);
    const miss = () => {
      noCover.set(dir, Date.now());
      if (noCover.size > 5000) noCover.clear();
      res.sendStatus(404);
    };
    try {
      // folder image, then parent folder (CD1/CD2 layouts), then art embedded in the first track
      let src = await findImage(dir);
      if (!src && dir !== ROOT) src = await findImage(path.dirname(dir));
      let embedded = false;
      if (!src) {
        const names = (await fsp.readdir(dir)).filter((f) => AUDIO_EXT.has(ext(f))).sort(natural);
        if (!names.length) return miss();
        src = path.join(dir, names[0]);
        embedded = true;
      }
      const st = await fsp.stat(src);
      const out = path.join(COVER_CACHE, sha1(`${src}:${st.mtimeMs}:${size}`) + '.jpg');
      try {
        await fsp.access(out);
        touch(out);
      } catch {
        await fsp.mkdir(COVER_CACHE, { recursive: true });
        const tmp = `${out}.${Date.now()}.tmp`;
        const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-i', src];
        if (embedded) args.push('-an', '-map', '0:v:0');
        args.push('-frames:v', '1', '-vf', `scale='min(${size},iw)':-2`, '-q:v', '4', '-f', 'mjpeg', tmp);
        try {
          await ffmpegSlot(() => run(FFMPEG, args, 30_000));
          await fsp.rename(tmp, out);
        } catch {
          await fsp.rm(tmp, { force: true });
          return miss();
        }
      }
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.type('image/jpeg').sendFile(out);
    } catch {
      res.sendStatus(404);
    }
  });

  getTree().then((t) => console.log(`music: ${t.length} folders in ${ROOT}`)).catch((e) => console.error('music scan failed:', e.message));
  return router;
}
