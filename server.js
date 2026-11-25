// Home cinema: a small streaming API for a private video folder.
// Config via environment variables (see README / .env.example).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendRange, decodeText } from './util.js';
import { createMusicRouter } from './music.js';
import { startCacheJanitor } from './cache.js';
import { probe, plan, seekPoint, streamTranscode, transcodeStatus, shiftVtt, embeddedVtt } from './transcode.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MEDIA_ROOT = path.resolve(process.env.MEDIA_ROOT || '/mnt/usb/videos');
const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '0.0.0.0';
const PASSWORD = process.env.CINEMA_PASSWORD;
// Keep CINEMA_SECRET stable, otherwise every restart logs everyone out.
const SECRET = process.env.CINEMA_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const SCAN_TTL_MS = 60_000;
// optional: folder with music; enables the "Музыка" tab
const MUSIC_ROOT = process.env.MUSIC_ROOT ? path.resolve(process.env.MUSIC_ROOT) : null;
// probe results don't need it, but extracted embedded subtitles are cached here (put it on the SSD)
const CACHE_DIR = path.resolve(process.env.CACHE_DIR || path.join(__dirname, 'cache'));

if (!PASSWORD) {
  console.error('CINEMA_PASSWORD is not set — refusing to start without a password.');
  process.exit(1);
}

// ---------- media types ----------
// Direct playback uses these MIME types; everything else goes through ffmpeg (see transcode.js).
const VIDEO_TYPES = {
  '.mp4': { mime: 'video/mp4' },
  '.m4v': { mime: 'video/mp4' },
  '.webm': { mime: 'video/webm' },
  '.mov': { mime: 'video/mp4' },
  '.mkv': { mime: 'video/x-matroska' },
  '.avi': { mime: 'video/x-msvideo' },
  '.ts': { mime: 'video/mp2t' },
  '.mpg': { mime: 'video/mpeg' },
  '.wmv': { mime: 'video/x-ms-wmv' },
};
const SUB_EXT = new Set(['.srt', '.vtt']);

// ---------- ids: base64url of the path relative to MEDIA_ROOT ----------
const toId = (rel) => Buffer.from(rel, 'utf8').toString('base64url');

function resolveId(id, allowedExt) {
  let rel;
  try {
    rel = Buffer.from(String(id), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const abs = path.resolve(MEDIA_ROOT, rel);
  // path traversal guard
  if (abs !== MEDIA_ROOT && !abs.startsWith(MEDIA_ROOT + path.sep)) return null;
  if (!allowedExt(path.extname(abs).toLowerCase())) return null;
  return abs;
}

// ---------- library scan (cached) ----------
let cache = { at: 0, data: null, pending: null };

async function walk(dir, out) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    console.warn('cannot read', dir, e.code);
    return;
  }
  const files = entries.filter((e) => e.isFile()).map((e) => e.name);
  const subs = files.filter((f) => SUB_EXT.has(path.extname(f).toLowerCase()));

  for (const name of files) {
    const ext = path.extname(name).toLowerCase();
    if (!VIDEO_TYPES[ext] || name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    const rel = path.relative(MEDIA_ROOT, abs);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) continue;
    const base = path.basename(name, path.extname(name));
    const tracks = subs
      .filter((s) => s.startsWith(base))
      .map((s) => {
        // "Movie.ru.srt" -> label "ru"; "Movie.srt" -> "Subtitles"
        const middle = path.basename(s, path.extname(s)).slice(base.length).replace(/^[._\s-]+/, '');
        return { id: toId(path.relative(MEDIA_ROOT, path.join(dir, s))), label: middle || 'Subtitles', lang: middle.slice(0, 2) || 'und' };
      });
    out.push({
      id: toId(rel),
      title: base.replace(/[._]+/g, ' ').trim(),
      file: name,
      folder: path.dirname(rel) === '.' ? '' : path.dirname(rel),
      size: st.size,
      mtime: st.mtimeMs,
      subs: tracks,
    });
  }
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && e.name !== '$RECYCLE.BIN' && e.name !== 'System Volume Information') {
      await walk(path.join(dir, e.name), out);
    }
  }
}

async function getLibrary(force = false) {
  if (!force && cache.data && Date.now() - cache.at < SCAN_TTL_MS) return cache.data;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    const out = [];
    await walk(MEDIA_ROOT, out);
    out.sort((a, b) => a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title, undefined, { numeric: true }));
    cache = { at: Date.now(), data: out, pending: null };
    return out;
  })();
  try {
    return await cache.pending;
  } finally {
    cache.pending = null;
  }
}

// ---------- auth: signed cookie ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

function makeToken() {
  const exp = String(Date.now() + SESSION_DAYS * 864e5);
  return `${exp}.${sign(exp)}`;
}
function validToken(tok) {
  if (!tok) return false;
  const [exp, sig] = tok.split('.');
  if (!exp || !sig) return false;
  const good = sign(exp);
  if (sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return false;
  return Number(exp) > Date.now();
}
function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

// naive brute-force protection: 10 failures per IP -> 15 min block
const failures = new Map();
function blocked(ip) {
  const f = failures.get(ip);
  return f && f.count >= 10 && Date.now() - f.last < 15 * 60_000;
}
function fail(ip) {
  const f = failures.get(ip) || { count: 0, last: 0 };
  if (Date.now() - f.last > 15 * 60_000) f.count = 0;
  f.count++;
  f.last = Date.now();
  failures.set(ip, f);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback, uniquelocal'); // nginx on EC2 via WireGuard
app.use(express.json({ limit: '10kb' }));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (blocked(ip)) return res.status(429).json({ error: 'Too many attempts, try later' });
  const pw = req.body?.password ?? '';
  if (!crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) {
    fail(ip);
    return setTimeout(() => res.status(401).json({ error: 'Wrong password' }), 700);
  }
  failures.delete(ip);
  res.cookie('cinema', makeToken(), {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SESSION_DAYS * 864e5,
    path: '/',
  });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('cinema', { path: '/' });
  res.json({ ok: true });
});

// everything else under /api requires a session
app.use('/api', (req, res, next) => {
  if (validToken(getCookie(req, 'cinema'))) return next();
  res.status(401).json({ error: 'Unauthorized' });
});

app.get('/api/me', (req, res) => res.json({ ok: true, music: !!MUSIC_ROOT }));

// live transcoding load, e.g. for monitoring
app.get('/api/status', (req, res) => res.json({ transcodes: transcodeStatus() }));

if (MUSIC_ROOT) {
  app.use(
    '/api/music',
    createMusicRouter({
      root: MUSIC_ROOT,
      cacheDir: CACHE_DIR,
      cacheLimitMb: Number(process.env.MUSIC_CACHE_MB || 2048),
      ecoBitrate: process.env.MUSIC_ECO_BITRATE || '192k',
    }),
  );
}

app.get('/api/videos', async (req, res) => {
  res.json(await getLibrary(req.query.refresh === '1'));
});

// The core: byte-range streaming so the browser can seek.
app.get('/api/stream/:id', async (req, res) => {
  const file = resolveId(req.params.id, (ext) => ext in VIDEO_TYPES);
  if (!file) return res.sendStatus(404);
  sendRange(req, res, file, VIDEO_TYPES[path.extname(file).toLowerCase()].mime);
});

// Subtitles: .srt converted to WebVTT on the fly; cp1251 files are handled too.
app.get('/api/subtitle/:id', async (req, res) => {
  const file = resolveId(req.params.id, (ext) => SUB_EXT.has(ext));
  if (!file) return res.sendStatus(404);
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    return res.sendStatus(404);
  }
  let text = decodeText(buf);
  if (path.extname(file).toLowerCase() === '.srt') {
    text = 'WEBVTT\n\n' + text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
  }
  res.type('text/vtt; charset=utf-8').send(shiftVtt(text, Number(req.query.offset) || 0));
});

// ---------- ffmpeg-backed endpoints ----------
const isVideo = (ext) => ext in VIDEO_TYPES;

// What's inside the file and how the player should play it.
app.get('/api/probe/:id', async (req, res) => {
  const file = resolveId(req.params.id, isVideo);
  if (!file) return res.sendStatus(404);
  try {
    const info = await probe(file);
    const plans = info.audio.length ? info.audio.map((_, i) => plan(file, info, i).mode) : [plan(file, info, 0).mode];
    res.json({ ...info, modes: plans });
  } catch (e) {
    res.status(422).json({ error: 'Cannot read this file (damaged or incomplete?)' });
  }
});

// Fragmented MP4 produced by ffmpeg; seeking = new request with ?start=<seconds>.
app.get('/api/transcode/:id', async (req, res) => {
  const file = resolveId(req.params.id, isVideo);
  if (!file) return res.sendStatus(404);
  let info;
  try {
    info = await probe(file);
  } catch {
    return res.status(422).json({ error: 'Cannot read this file' });
  }
  const start = Math.max(0, Math.min(Number(req.query.start) || 0, Math.max(0, info.duration - 1)));
  const audio = Math.max(0, Math.min(Number(req.query.audio) || 0, Math.max(0, info.audio.length - 1)));
  // ss = actual ffmpeg seek position from /api/seekpoint (slightly after the keyframe at `start`)
  let ss = Number(req.query.ss);
  if (!Number.isFinite(ss) || ss < start || ss > start + 1) ss = start;
  streamTranscode(req, res, file, info, { ss, audio, session: getCookie(req, 'cinema') || req.ip });
});

// Exact position a stream will start from (keyframe when video is copied).
app.get('/api/seekpoint/:id', async (req, res) => {
  const file = resolveId(req.params.id, isVideo);
  if (!file) return res.sendStatus(404);
  try {
    const info = await probe(file);
    const t = Math.max(0, Math.min(Number(req.query.t) || 0, Math.max(0, info.duration - 1)));
    const audio = Math.max(0, Math.min(Number(req.query.audio) || 0, Math.max(0, info.audio.length - 1)));
    res.json(await seekPoint(file, info, t, audio));
  } catch {
    res.status(422).json({ error: 'Cannot read this file' });
  }
});

// Text subtitles embedded in MKV/MP4, as WebVTT.
app.get('/api/subtitle-embedded/:id/:n', async (req, res) => {
  const file = resolveId(req.params.id, isVideo);
  const n = Number(req.params.n);
  if (!file || !Number.isInteger(n) || n < 0) return res.sendStatus(404);
  try {
    const vtt = await embeddedVtt(file, n, CACHE_DIR);
    res.type('text/vtt; charset=utf-8').send(shiftVtt(vtt, Number(req.query.offset) || 0));
  } catch (e) {
    console.error('subtitle extract failed:', e.message?.slice(0, 300));
    res.sendStatus(500);
  }
});

// ---------- static UI ----------
const DIST = path.join(__dirname, 'web', 'dist');
app.use(express.static(DIST, { index: false, maxAge: '1h' }));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(DIST, 'index.html'), (err) => err && res.status(500).send('UI not built: run `npm run build`'));
});

startCacheJanitor(CACHE_DIR, { maxAgeDays: Number(process.env.CACHE_MAX_AGE_DAYS || 90) });

app.listen(PORT, HOST, () => {
  console.log(`home-cinema on http://${HOST}:${PORT}, media: ${MEDIA_ROOT}`);
  getLibrary().then((l) => console.log(`indexed ${l.length} videos`));
});
