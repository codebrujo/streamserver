// Music playlists: one file per playlist in DATA_DIR/playlists/<id>.jsonl (outside git).
//
// File format (JSON Lines):
//   line 1   {"id","name","created","updated","count","duration","cover"}  — the header
//   line 2.. one track per line
// At start only the header line of every file is read, so the list lives in memory without the tracks;
// the whole file is read when a playlist is opened.
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TRACKS = 5000;
const MAX_PLAYLISTS = 500;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// only what the UI needs to show and play a track without re-reading tags
const TRACK_FIELDS = ['id', 'title', 'artist', 'album', 'duration', 'n', 'folder', 'format', 'quality', 'deliver'];
function cleanTrack(t) {
  const out = {};
  for (const k of TRACK_FIELDS) if (t[k] !== undefined) out[k] = t[k];
  out.title = String(out.title ?? '').slice(0, 300);
  out.artist = String(out.artist ?? '').slice(0, 300);
  out.album = String(out.album ?? '').slice(0, 300);
  out.folder = String(out.folder ?? '').slice(0, 1000);
  out.duration = Number(out.duration) || 0;
  return out;
}

// play order: 'linear' — play to the end and stop; 'loop' — start over after the last track
const ORDERS = ['linear', 'loop'];
const orderOf = (o) => (o === 'loop' ? 'loop' : 'linear'); // files from before v1.4 have no order: linear

const headerOf = (p) => ({
  id: p.id,
  name: p.name,
  order: orderOf(p.order),
  created: p.created,
  updated: p.updated,
  count: p.tracks.length,
  duration: p.tracks.reduce((a, t) => a + (t.duration || 0), 0),
  cover: p.tracks[0]?.folder ?? null, // first track's folder gives the cover
});

// Read just the first line of a file (the header), without loading the tracks.
async function readHeader(file) {
  const fh = await fs.open(file, 'r');
  try {
    let text = '';
    const buf = Buffer.alloc(16 * 1024);
    for (let pos = 0; pos < 1024 * 1024; ) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (!bytesRead) break;
      text += buf.subarray(0, bytesRead).toString('utf8');
      const nl = text.indexOf('\n');
      if (nl >= 0) return JSON.parse(text.slice(0, nl));
      pos += bytesRead;
    }
    return JSON.parse(text); // a playlist without tracks has no newline
  } finally {
    await fh.close();
  }
}

export function createPlaylistsRouter({ dataDir, trackPath }) {
  const DIR = path.join(dataDir, 'playlists');
  const LEGACY = path.join(dataDir, 'playlists.json'); // single-file storage of v1.1
  const fileOf = (id) => path.join(DIR, `${id}.jsonl`);
  const index = new Map(); // id -> header
  const queues = new Map(); // id -> promise chain: writes to one file never overlap
  const router = express.Router();

  const serial = (id, fn) => {
    const run = (queues.get(id) || Promise.resolve()).then(fn, fn);
    queues.set(id, run.catch(() => {}));
    return run;
  };

  async function readPlaylist(id) {
    const lines = (await fs.readFile(fileOf(id), 'utf8')).split('\n').filter((l) => l.trim());
    const header = JSON.parse(lines[0]);
    const tracks = [];
    for (const l of lines.slice(1)) {
      try {
        tracks.push(JSON.parse(l));
      } catch {} // a damaged line costs one track, not the playlist
    }
    return { ...header, order: orderOf(header.order), tracks };
  }

  // atomic: write a temp file, then rename over the old one
  async function writePlaylist(p) {
    await fs.mkdir(DIR, { recursive: true });
    const header = headerOf(p);
    const body = [JSON.stringify(header), ...p.tracks.map((t) => JSON.stringify(t))].join('\n') + '\n';
    const tmp = `${fileOf(p.id)}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, fileOf(p.id));
    index.set(p.id, header);
    return header;
  }

  // v1.1 kept everything in playlists.json: split it into files once, keep the old file as .migrated
  async function migrateLegacy() {
    let legacy;
    try {
      legacy = JSON.parse(await fs.readFile(LEGACY, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') console.error(`playlists: cannot read ${LEGACY}: ${e.message}`);
      return;
    }
    let n = 0;
    for (const p of legacy.playlists || []) {
      if (!ID_RE.test(p.id || '') || !Array.isArray(p.tracks)) continue;
      await writePlaylist({ ...p, tracks: p.tracks.map(cleanTrack) });
      n++;
    }
    await fs.rename(LEGACY, `${LEGACY}.migrated`);
    console.log(`playlists: migrated ${n} from playlists.json to ${DIR}/`);
  }

  async function loadIndex() {
    await migrateLegacy();
    const names = await fs.readdir(DIR).catch(() => []);
    for (const f of names) {
      if (f.endsWith('.tmp')) {
        await fs.rm(path.join(DIR, f), { force: true }); // leftover of an interrupted write
        continue;
      }
      const id = f.replace(/\.jsonl$/, '');
      if (!f.endsWith('.jsonl') || !ID_RE.test(id)) continue;
      try {
        const h = await readHeader(path.join(DIR, f));
        index.set(id, { ...h, id, order: orderOf(h.order) });
      } catch (e) {
        console.error(`playlists: skipping ${f}: ${e.message}`);
      }
    }
    console.log(`playlists: ${index.size} in ${DIR}`);
    return index.size;
  }
  const ready = loadIndex().catch((e) => {
    console.error('playlists: cannot read the folder:', e.message);
    return null;
  });

  const badName = (n) => typeof n !== 'string' || !n.trim() || n.length > 100;
  function validTracks(list) {
    if (!Array.isArray(list) || list.length > MAX_TRACKS) return null;
    const seen = new Set();
    const out = [];
    for (const t of list) {
      if (!t || typeof t.id !== 'string' || !trackPath(t.id) || seen.has(t.id)) continue; // drop invalid and duplicates
      seen.add(t.id);
      out.push(cleanTrack(t));
    }
    return out;
  }
  const known = (req, res, next) => (ID_RE.test(req.params.id) && index.has(req.params.id) ? next() : res.sendStatus(404));

  router.use(async (req, res, next) => {
    await ready;
    next();
  });
  router.use(express.json({ limit: '5mb' }));

  // the list comes from memory, no file is read
  router.get('/', (req, res) => {
    res.json([...index.values()].sort((a, b) => String(a.created).localeCompare(String(b.created))));
  });

  router.post('/', async (req, res) => {
    const name = req.body?.name;
    if (badName(name)) return res.status(400).json({ error: 'Name is required (up to 100 characters)' });
    if (index.size >= MAX_PLAYLISTS) return res.status(400).json({ error: 'Too many playlists' });
    const now = new Date().toISOString();
    if (req.body?.order !== undefined && !ORDERS.includes(req.body.order)) return res.status(400).json({ error: 'order must be linear or loop' });
    const p = { id: crypto.randomUUID(), name: name.trim(), order: orderOf(req.body?.order), created: now, updated: now, tracks: validTracks(req.body?.tracks || []) || [] };
    await serial(p.id, () => writePlaylist(p));
    res.status(201).json(p);
  });

  router.get('/:id', known, async (req, res) => {
    let p;
    try {
      p = await serial(req.params.id, () => readPlaylist(req.params.id));
    } catch (e) {
      console.error(`playlists: cannot read ${req.params.id}: ${e.message}`);
      return res.status(500).json({ error: 'Cannot read the playlist file' });
    }
    // mark tracks whose files disappeared from the drive (or the drive is unmounted)
    const tracks = await Promise.all(
      p.tracks.map(async (t) => {
        const abs = trackPath(t.id);
        const ok = abs && (await fs.access(abs).then(() => true, () => false));
        return ok ? t : { ...t, missing: true };
      }),
    );
    res.json({ ...p, tracks });
  });

  router.put('/:id', known, async (req, res) => {
    const { name, tracks, order } = req.body || {};
    if (name !== undefined && badName(name)) return res.status(400).json({ error: 'Name is required (up to 100 characters)' });
    if (order !== undefined && !ORDERS.includes(order)) return res.status(400).json({ error: 'order must be linear or loop' });
    const list = tracks === undefined ? undefined : validTracks(tracks);
    if (list === null) return res.status(400).json({ error: `tracks must be an array of up to ${MAX_TRACKS} tracks` });
    try {
      const header = await serial(req.params.id, async () => {
        const p = await readPlaylist(req.params.id);
        if (name !== undefined) p.name = name.trim();
        if (list !== undefined) p.tracks = list;
        if (order !== undefined) p.order = order;
        p.updated = new Date().toISOString();
        return writePlaylist(p);
      });
      res.json(header);
    } catch (e) {
      console.error(`playlists: cannot update ${req.params.id}: ${e.message}`);
      res.status(500).json({ error: 'Cannot save the playlist' });
    }
  });

  router.delete('/:id', known, async (req, res) => {
    await serial(req.params.id, () => fs.rm(fileOf(req.params.id), { force: true }));
    index.delete(req.params.id);
    queues.delete(req.params.id);
    res.sendStatus(204);
  });

  router.ready = ready; // resolves to the number of playlists (null if the folder could not be read)
  return router;
}
