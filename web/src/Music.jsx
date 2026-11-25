import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, natural, lsGet, lsSet } from './lib.js';

// ================= player state (lives above the routes so music keeps playing) =================
const Ctx = createContext(null);
export const useMusic = () => useContext(Ctx);

const STATE_KEY = 'cinema.music';
// at home stream lossless as-is; elsewhere save mobile data and EC2 traffic
const IS_LAN = /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
export const coverUrl = (folder, s = 300) => `/api/music/cover?path=${encodeURIComponent(folder)}&s=${s}`;
const shuffled = (n, first) => {
  const rest = [...Array(n).keys()].filter((i) => i !== first);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
};

export function MusicProvider({ enabled, children }) {
  const saved = useMemo(() => lsGet(STATE_KEY, {}), []);
  const audio = useRef(null);
  const [queue, setQueue] = useState(saved.queue || []);
  const [order, setOrder] = useState(saved.order || []);
  const [pos, setPos] = useState(saved.pos || 0);
  const [shuffle, setShuffle] = useState(!!saved.shuffle);
  // playlist play order 'loop': after the last track start over; otherwise stop at the end
  const [loop, setLoop] = useState(!!saved.loop);
  const [quality, setQualityState] = useState(saved.quality || (IS_LAN ? 'orig' : 'eco'));
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState(saved.time || 0);
  const [dur, setDur] = useState(0);
  const [error, setError] = useState('');

  const autoplay = useRef(false);
  const resumeAt = useRef(saved.time || 0);
  const errorsInRow = useRef(0);
  const prefetched = useRef('');

  const current = queue[order[pos]] || null;
  const nextPos = pos + 1 < order.length ? pos + 1 : loop && order.length ? 0 : -1;
  const nextTrack = nextPos >= 0 ? queue[order[nextPos]] || null : null;
  const src = current ? `/api/music/stream/${current.id}?q=${quality}` : '';

  // persist (without the time, which is saved separately and more often)
  useEffect(() => {
    lsSet(STATE_KEY, { ...lsGet(STATE_KEY, {}), queue: queue.slice(0, 500), order: order.slice(0, 500), pos, shuffle, quality, loop });
  }, [queue, order, pos, shuffle, quality, loop]);

  const go = useCallback((p) => {
    if (p < 0 || p >= order.length) return;
    autoplay.current = true;
    resumeAt.current = 0;
    setPos(p);
  }, [order.length]);
  const next = useCallback(() => {
    if (nextPos < 0) return; // linear: the queue is over, stay stopped on the last track
    if (nextPos === pos) {
      // looping a single track: same position, so just start it again
      const a = audio.current;
      a.currentTime = 0;
      a.play().catch(() => {});
      return;
    }
    go(nextPos);
  }, [go, pos, nextPos]);
  const prev = useCallback(() => {
    const a = audio.current;
    if (a && a.currentTime > 3) a.currentTime = 0;
    else if (pos === 0 && loop) go(order.length - 1);
    else go(pos - 1);
  }, [go, pos, loop, order.length]);

  // load the current track
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    if (!src) { a.removeAttribute('src'); a.load(); return; }
    setError('');
    setLoading(true);
    setTime(resumeAt.current);
    setDur(current?.duration || 0);
    prefetched.current = '';
    a.src = src;
    if (autoplay.current) a.play().catch(() => {});
  }, [src]);

  // <audio> events
  useEffect(() => {
    const a = audio.current;
    if (!a) return;
    let lastSave = 0;
    const ev = {
      loadedmetadata: () => {
        if (resumeAt.current > 0) a.currentTime = resumeAt.current;
        resumeAt.current = 0;
        if (Number.isFinite(a.duration)) setDur(a.duration);
      },
      timeupdate: () => {
        setTime(a.currentTime);
        if (Date.now() - lastSave > 5000) {
          lastSave = Date.now();
          lsSet(STATE_KEY, { ...lsGet(STATE_KEY, {}), time: a.currentTime });
        }
      },
      play: () => setPlaying(true),
      pause: () => { setPlaying(false); lsSet(STATE_KEY, { ...lsGet(STATE_KEY, {}), time: a.currentTime }); },
      waiting: () => setLoading(true),
      playing: () => { setLoading(false); errorsInRow.current = 0; },
      canplay: () => setLoading(false),
      ended: () => next(),
      error: () => {
        setLoading(false);
        if (!a.getAttribute('src')) return;
        errorsInRow.current++;
        setError('Не удалось воспроизвести трек');
        if (errorsInRow.current < 3) setTimeout(() => next(), 1500); // skip broken files
      },
    };
    for (const [k, f] of Object.entries(ev)) a.addEventListener(k, f);
    return () => { for (const [k, f] of Object.entries(ev)) a.removeEventListener(k, f); };
  }, [next]);

  // get the next track ready (CUE cut / lossless -> AAC) while this one plays
  useEffect(() => {
    if (!nextTrack || time < 5 || prefetched.current === nextTrack.id + quality) return;
    prefetched.current = nextTrack.id + quality;
    fetch(`/api/music/prepare/${nextTrack.id}?q=${quality}`, { credentials: 'same-origin' }).catch(() => {});
  }, [time, nextTrack, quality]);

  // lock screen / headset controls
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist || '',
      album: current.album || current.folder.split('/').pop(),
      artwork: [{ src: coverUrl(current.folder, 512), sizes: '512x512', type: 'image/jpeg' }],
    });
  }, [current]);
  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const a = audio.current;
    const h = {
      play: () => a.play(),
      pause: () => a.pause(),
      previoustrack: prev,
      nexttrack: next,
      seekto: (d) => { a.currentTime = d.seekTime; },
      seekbackward: () => { a.currentTime = Math.max(0, a.currentTime - 10); },
      seekforward: () => { a.currentTime = a.currentTime + 10; },
    };
    for (const [k, f] of Object.entries(h)) { try { ms.setActionHandler(k, f); } catch {} }
  }, [prev, next]);
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [playing]);

  // a video started: be quiet
  useEffect(() => {
    const stop = () => audio.current?.pause();
    addEventListener('cinema:video', stop);
    return () => removeEventListener('cinema:video', stop);
  }, []);

  const playQueue = useCallback((tracks, start, folder, opts = {}) => {
    const q = tracks.map((t) => ({ ...t, folder: folder ?? t.folder }));
    setLoop(!!opts.loop);
    const o = shuffle ? shuffled(q.length, start) : [...q.keys()];
    autoplay.current = true;
    resumeAt.current = 0;
    errorsInRow.current = 0;
    setQueue(q);
    setOrder(o);
    setPos(shuffle ? 0 : start);
    if (q[o[shuffle ? 0 : start]]?.id === current?.id) audio.current.currentTime = 0;
  }, [shuffle, current]);

  const toggle = () => {
    const a = audio.current;
    if (!a || !current) return;
    if (a.paused) { autoplay.current = true; a.play().catch(() => {}); } else a.pause();
  };
  const seek = (t) => { if (audio.current) audio.current.currentTime = t; };
  const toggleShuffle = () => {
    const on = !shuffle;
    setShuffle(on);
    if (!queue.length) return;
    const cur = order[pos];
    const o = on ? shuffled(queue.length, cur) : [...queue.keys()];
    setOrder(o);
    setPos(o.indexOf(cur));
  };
  const setQuality = (q) => {
    if (q === quality) return;
    resumeAt.current = audio.current?.currentTime || 0;
    autoplay.current = playing;
    setQualityState(q);
  };

  const value = {
    enabled, current, queue, order, pos, playing, loading, time, dur, error, shuffle, quality,
    playQueue, toggle, next, prev, seek, toggleShuffle, setQuality, hasNext: !!nextTrack, loop,
  };
  return (
    <Ctx.Provider value={value}>
      {children}
      <audio ref={audio} preload="auto" />
    </Ctx.Provider>
  );
}

// "FLAC 24/96 → AAC 192"; nothing when the file goes as-is or lossless stays the same codec (CUE cut)
const deliverNote = (c, q) => {
  const d = c.deliver?.[q];
  if (!d || d === (c.quality || '').split(' ')[0]) return '';
  return ` → ${d}`;
};

// ================= mini player =================
export function MiniPlayer() {
  const m = useMusic();
  const [seekVal, setSeekVal] = useState(null);
  const [noCover, setNoCover] = useState(false);
  useEffect(() => setNoCover(false), [m?.current?.folder]);
  if (!m?.enabled || !m.current) return null;
  const c = m.current;
  const shown = seekVal ?? m.time;
  return (
    <div className="mplayer">
      <input
        className="mseek" type="range" min="0" step="1"
        max={Math.max(1, Math.floor(m.dur))} value={Math.floor(shown)}
        onChange={(e) => setSeekVal(Number(e.target.value))}
        onPointerUp={() => { if (seekVal != null) { m.seek(seekVal); setSeekVal(null); } }}
        onKeyUp={() => { if (seekVal != null) { m.seek(seekVal); setSeekVal(null); } }}
        style={{ '--p': (m.dur ? (shown / m.dur) * 100 : 0) + '%' }}
      />
      <div className="mrow">
        {noCover
          ? <div className="mcover none">♪</div>
          : <img className="mcover" src={coverUrl(c.folder, 120)} alt="" onError={() => setNoCover(true)} />}
        <div className="minfo">
          <b title={c.title}>{c.title}</b>
          <small>{[c.artist, c.album].filter(Boolean).join(' · ') || c.folder}</small>
        </div>
        <button className="mbtn" onClick={m.prev} aria-label="Предыдущий">⏮</button>
        <button className="mbtn big" onClick={m.toggle} aria-label={m.playing ? 'Пауза' : 'Играть'}>
          {m.loading && m.playing ? '…' : m.playing ? '❚❚' : '▶'}
        </button>
        <button className="mbtn" onClick={m.next} disabled={!m.hasNext} aria-label="Следующий">⏭</button>
      </div>
      <div className="mrow2">
        <span className="mtime">{fmtTime(shown)} / {fmtTime(m.dur)}</span>
        {c.quality && (
          <span className="mfmt" title="Формат файла → что передаётся сейчас">
            {c.quality}{deliverNote(c, m.quality)}
          </span>
        )}
        {m.error && <span className="merr">{m.error}</span>}
        {m.loop && <span className="chip on loopmark" title="Плейлист по кругу: после последнего трека начнётся сначала">🔁</span>}
        <button className={'chip' + (m.shuffle ? ' on' : '')} onClick={m.toggleShuffle} title="Перемешать" aria-label="Перемешать" aria-pressed={m.shuffle}>🔀</button>
        <button
          className="chip"
          onClick={() => m.setQuality(m.quality === 'orig' ? 'eco' : 'orig')}
          title="Оригинал — lossless как есть; Экономно — AAC для мобильного интернета"
        >
          {m.quality === 'orig' ? 'Оригинал' : 'Экономно'}
        </button>
      </div>
    </div>
  );
}

// ================= library =================
let treeCache = null;
const folderCache = new Map();

// shared with the playlist editor
export async function getMusicTree(refresh) {
  if (treeCache && !refresh) return treeCache;
  treeCache = await api('/api/music/tree' + (refresh ? '?refresh=1' : ''));
  return treeCache;
}
export async function getFolder(path) {
  if (!folderCache.has(path)) folderCache.set(path, await api(`/api/music/folder?path=${encodeURIComponent(path)}`));
  return folderCache.get(path);
}
const OPEN_KEY = 'cinema.music.open';

export function buildTree(folders) {
  const root = { name: '', path: '', children: new Map(), own: null, count: 0 };
  for (const f of folders) {
    let node = root;
    node.count += f.count;
    if (f.path) {
      let p = '';
      for (const part of f.path.split('/')) {
        p = p ? p + '/' + part : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path: p, children: new Map(), own: null, count: 0 });
        node = node.children.get(part);
        node.count += f.count;
      }
    }
    node.own = f;
  }
  return root;
}
export const kids = (n) => [...n.children.values()].sort((a, b) => natural(a.name, b.name));

export const Chevron = () => (
  <svg className="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function Album({ path }) {
  const m = useMusic();
  const [data, setData] = useState(folderCache.get(path) || null);
  const [err, setErr] = useState('');
  const [noCover, setNoCover] = useState(false);
  useEffect(() => {
    if (data) return;
    api(`/api/music/folder?path=${encodeURIComponent(path)}`)
      .then((d) => { folderCache.set(path, d); setData(d); })
      .catch(() => setErr('Не удалось прочитать папку'));
  }, [path]);
  if (err) return <p className="err">{err}</p>;
  if (!data) return <p className="hint">Читаю теги…</p>;
  const t = data.tracks;
  if (!t.length) return <p className="hint">Нет воспроизводимых файлов</p>;

  const albumArtist = t[0].artist;
  const album = t[0].album;
  const total = t.reduce((a, x) => a + (x.duration || 0), 0);
  const quals = [...new Set(t.map((x) => x.quality || x.format.toUpperCase()))];
  const formats = quals.length <= 2 ? quals.join(', ') : [...new Set(t.map((x) => x.format.toUpperCase()))].join(', ');
  return (
    <div className="album">
      <div className="album-head">
        {noCover
          ? <div className="acover none">♪</div>
          : <img className="acover" src={coverUrl(path, 300)} alt="" loading="lazy" onError={() => setNoCover(true)} />}
        <div className="ainfo">
          {album && <b>{album}</b>}
          {albumArtist && <span>{albumArtist}</span>}
          <small>{t.length} тр. · {fmtTime(total)} · {formats}</small>
          <div className="abtns">
            <button className="chip on" onClick={() => m.playQueue(t, 0, path)}>▶ Играть</button>
          </div>
        </div>
      </div>
      <div className="rows">
        {t.map((x, i) => {
          const isCur = m.current?.id === x.id;
          return (
            <button key={x.id} className={'row track' + (isCur ? ' cur' : '')} onClick={() => m.playQueue(t, i, path)}>
              <span className="tn">{isCur && m.playing ? '♪' : x.n || i + 1}</span>
              <span className="rtitle">
                {x.title}
                {x.artist && x.artist !== albumArtist && <small> — {x.artist}</small>}
              </span>
              {x.quality && <span className="fmt">{x.quality}</span>}
              <span className="rmeta">{fmtTime(x.duration)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MFolder({ node, open, toggle, label }) {
  const isOpen = open.has(node.path);
  return (
    <div className="folder">
      <button className={'folder-head' + (isOpen ? ' open' : '')} onClick={() => toggle(node.path)} aria-expanded={isOpen}>
        <Chevron />
        <span className="fname">{label || node.name}</span>
        <span className="count">{node.count}</span>
      </button>
      {isOpen && (
        <div className="folder-body">
          {kids(node).map((c) => <MFolder key={c.path} node={c} open={open} toggle={toggle} />)}
          {node.own && <Album path={node.path} />}
        </div>
      )}
    </div>
  );
}

export function MusicLibrary({ tabs, onLogout }) {
  const [folders, setFolders] = useState(treeCache);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set(lsGet(OPEN_KEY, [])));

  const load = (refresh) => {
    setErr('');
    if (refresh) { folderCache.clear(); setFolders(null); }
    api('/api/music/tree' + (refresh ? '?refresh=1' : ''))
      .then((d) => { treeCache = d; setFolders(d); })
      .catch((e) => setErr(e.message));
  };
  useEffect(() => { if (!treeCache) load(); }, []);

  const toggle = (p) => setOpen((prev) => {
    const n = new Set(prev);
    if (n.has(p)) { for (const x of [...n]) if (x === p || x.startsWith(p + '/')) n.delete(x); } else n.add(p);
    lsSet(OPEN_KEY, [...n]);
    return n;
  });
  const collapseAll = () => { setOpen(new Set()); lsSet(OPEN_KEY, []); };

  const tree = useMemo(() => (folders ? buildTree(folders) : null), [folders]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !folders) return [];
    return folders
      .filter((f) => f.path.toLowerCase().includes(s) || f.files.some((x) => x.toLowerCase().includes(s)))
      .slice(0, 100)
      .map((f) => ({ name: f.path, path: f.path, children: new Map(), own: f, count: f.count }));
  }, [q, folders]);

  return (
    <div className="lib">
      <header>
        {tabs}
        <input type="search" placeholder="Исполнитель, альбом, трек…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ghost" onClick={() => load(true)} title="Пересканировать">⟳</button>
        <button className="ghost" onClick={onLogout} title="Выйти">⎋</button>
      </header>
      {err && <p className="err">{err}</p>}
      {!folders && !err && <p className="empty">Сканирую фонотеку…</p>}
      {tree && (q ? (
        <section className="tree">
          {matches.map((n) => <MFolder key={n.path} node={n} open={open} toggle={toggle} />)}
          {!matches.length && <p className="empty">Ничего не найдено</p>}
        </section>
      ) : (
        <section className="tree">
          <h2>
            Папки
            {open.size > 0 && <button className="link" onClick={collapseAll}>свернуть все</button>}
          </h2>
          {kids(tree).map((c) => <MFolder key={c.path} node={c} open={open} toggle={toggle} />)}
          {tree.own && <MFolder node={{ ...tree, children: new Map(), path: '' }} label="Без папки" open={open} toggle={toggle} />}
          {!folders.length && <p className="empty">Музыка не найдена. Проверьте MUSIC_ROOT.</p>}
        </section>
      ))}
    </div>
  );
}
