// Music playlists stored in DATA_DIR/playlists.json (outside git).
import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const MAX_TRACKS = 5000;
const MAX_PLAYLISTS = 500;

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
const summary = (p) => ({
  id: p.id,
  name: p.name,
  count: p.tracks.length,
  duration: p.tracks.reduce((a, t) => a + (t.duration || 0), 0),
  created: p.created,
  updated: p.updated,
  // first folder gives the cover
  cover: p.tracks[0]?.folder ?? null,
});

export function createPlaylistsRouter({ dataDir, trackPath }) {
  const FILE = path.join(dataDir, 'playlists.json');
  const router = express.Router();
  let state = null; // { playlists: [...] }
  let writing = Promise.resolve();

  async function load() {
    if (state) return state;
    try {
      state = JSON.parse(await fsp.readFile(FILE, 'utf8'));
      if (!Array.isArray(state.playlists)) throw new Error('bad format');
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // keep the broken file for inspection, start empty
        console.error(`playlists: cannot read ${FILE}: ${e.message}`);
        await fsp.rename(FILE, `${FILE}.broken-${Date.now()}`).catch(() => {});
      }
      state = { playlists: [] };
    }
    return state;
  }

  // writes are serialised and atomic (tmp + rename), so a crash never leaves half a file
  function save() {
    const data = JSON.stringify(state, null, 1);
    writing = writing.then(async () => {
      await fsp.mkdir(dataDir, { recursive: true });
      const tmp = `${FILE}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, data);
      await fsp.rename(tmp, FILE);
    });
    return writing;
  }

  const find = (id) => state.playlists.find((p) => p.id === id);
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

  router.use(express.json({ limit: '5mb' }));

  router.get('/', async (req, res) => {
    await load();
    res.json(state.playlists.map(summary));
  });

  router.post('/', async (req, res) => {
    await load();
    const name = req.body?.name;
    if (badName(name)) return res.status(400).json({ error: 'Name is required (up to 100 characters)' });
    if (state.playlists.length >= MAX_PLAYLISTS) return res.status(400).json({ error: 'Too many playlists' });
    const now = new Date().toISOString();
    const tracks = validTracks(req.body?.tracks || []) || [];
    const p = { id: crypto.randomUUID(), name: name.trim(), created: now, updated: now, tracks };
    state.playlists.push(p);
    await save();
    res.status(201).json(p);
  });

  router.get('/:id', async (req, res) => {
    await load();
    const p = find(req.params.id);
    if (!p) return res.sendStatus(404);
    // mark tracks whose files disappeared from the drive (or the drive is unmounted)
    const tracks = await Promise.all(
      p.tracks.map(async (t) => {
        const abs = trackPath(t.id);
        const ok = abs && (await fsp.access(abs).then(() => true, () => false));
        return ok ? t : { ...t, missing: true };
      }),
    );
    res.json({ ...p, tracks });
  });

  router.put('/:id', async (req, res) => {
    await load();
    const p = find(req.params.id);
    if (!p) return res.sendStatus(404);
    const { name, tracks } = req.body || {};
    if (name !== undefined) {
      if (badName(name)) return res.status(400).json({ error: 'Name is required (up to 100 characters)' });
      p.name = name.trim();
    }
    if (tracks !== undefined) {
      const list = validTracks(tracks);
      if (!list) return res.status(400).json({ error: `tracks must be an array of up to ${MAX_TRACKS} tracks` });
      p.tracks = list;
    }
    p.updated = new Date().toISOString();
    await save();
    res.json(summary(p));
  });

  router.delete('/:id', async (req, res) => {
    await load();
    const i = state.playlists.findIndex((p) => p.id === req.params.id);
    if (i < 0) return res.sendStatus(404);
    state.playlists.splice(i, 1);
    await save();
    res.sendStatus(204);
  });

  router.count = () => (state ? state.playlists.length : null);
  load().then(() => console.log(`playlists: ${state.playlists.length} in ${FILE}`));
  return router;
}
