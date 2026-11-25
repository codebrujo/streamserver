import React, { useEffect, useMemo, useRef, useState } from 'react';

import { api, fmtSize, fmtTime } from './lib.js';
import { MusicProvider, MusicLibrary, MiniPlayer } from './Music.jsx';

// watch progress lives in localStorage (per browser)
const PROGRESS_KEY = 'cinema.progress';
const loadProgress = () => {
  try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {}; } catch { return {}; }
};
const saveProgress = (id, t, d) => {
  try {
    const p = loadProgress();
    if (d && t / d > 0.95) delete p[id];
    else p[id] = { t, d, at: Date.now() };
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
  } catch {}
};

// tiny hash router: #/ or #/watch/<id>
const useHash = () => {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const h = () => setHash(location.hash);
    addEventListener('hashchange', h);
    return () => removeEventListener('hashchange', h);
  }, []);
  return hash;
};

// ---------- components ----------
function Login({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pw }) });
      onDone();
    } catch (e) {
      setErr(e.auth ? 'Неверный пароль' : e.message);
    } finally { setBusy(false); }
  };
  return (
    <form className="login" onSubmit={submit}>
      <h1>🎬 Кинотеатр</h1>
      <input type="password" autoFocus placeholder="Пароль" value={pw} onChange={(e) => setPw(e.target.value)} />
      <button disabled={busy || !pw}>Войти</button>
      {err && <p className="err">{err}</p>}
    </form>
  );
}

function Card({ v, progress }) {
  const pct = progress?.d ? Math.min(100, (progress.t / progress.d) * 100) : 0;
  return (
    <a className="card" href={`#/watch/${v.id}`}>
      <div className="poster"><span>{v.title.slice(0, 1).toUpperCase()}</span>
        {pct > 0 && <i style={{ width: pct + '%' }} />}
      </div>
      <div className="meta">
        <b title={v.file}>{v.title}</b>
        <small>
          {fmtSize(v.size)}
          {v.subs.length > 0 && ' · CC'}
        </small>
      </div>
    </a>
  );
}

// compact row for folder contents and search results
function Row({ v, progress }) {
  const pct = progress?.d ? Math.min(100, (progress.t / progress.d) * 100) : 0;
  return (
    <a className="row" href={`#/watch/${v.id}`}>
      <span className="play">▶</span>
      <span className="rtitle" title={v.file}>{v.title}</span>
      <span className="rmeta">{v.subs.length > 0 && 'CC · '}{fmtSize(v.size)}</span>
      {pct > 0 && <i style={{ width: pct + '%' }} />}
    </a>
  );
}

const Chevron = () => (
  <svg className="chev" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

// ---------- folder tree ----------
function buildTree(videos) {
  const root = { name: '', path: '', children: new Map(), videos: [], count: 0 };
  for (const v of videos) {
    let node = root;
    node.count++;
    if (v.folder) {
      let p = '';
      for (const part of v.folder.split(/[\\/]/)) {
        p = p ? p + '/' + part : part;
        if (!node.children.has(part)) node.children.set(part, { name: part, path: p, children: new Map(), videos: [], count: 0 });
        node = node.children.get(part);
        node.count++;
      }
    }
    node.videos.push(v);
  }
  return root;
}
const sortedChildren = (node) =>
  [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

// expanded folders are remembered, so coming back from the player keeps the same view
const OPEN_KEY = 'cinema.open';
const loadOpen = () => {
  try { return new Set(JSON.parse(localStorage.getItem(OPEN_KEY)) || []); } catch { return new Set(); }
};

function Folder({ node, depth, open, toggle, progress }) {
  const isOpen = open.has(node.path);
  const watching = useMemo(() => {
    const walk = (n) => n.videos.some((v) => progress[v.id]) || [...n.children.values()].some(walk);
    return walk(node);
  }, [node, progress]);
  return (
    <div className="folder" style={{ '--depth': depth }}>
      <button className={'folder-head' + (isOpen ? ' open' : '')} onClick={() => toggle(node.path)} aria-expanded={isOpen}>
        <Chevron />
        <span className="fname">{node.name}</span>
        {watching && <span className="dot" title="Есть начатые" />}
        <span className="count">{node.count}</span>
      </button>
      {isOpen && (
        <div className="folder-body">
          {sortedChildren(node).map((c) => (
            <Folder key={c.path} node={c} depth={depth + 1} open={open} toggle={toggle} progress={progress} />
          ))}
          {node.videos.length > 0 && (
            <div className="rows">{node.videos.map((v) => <Row key={v.id} v={v} progress={progress[v.id]} />)}</div>
          )}
        </div>
      )}
    </div>
  );
}

function Library({ videos, onRefresh, onLogout, tabs }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(loadOpen);
  const progress = loadProgress();

  const toggle = (p) => {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(p)) {
        // closing a folder also closes everything inside it
        for (const x of [...next]) if (x === p || x.startsWith(p + '/')) next.delete(x);
      } else next.add(p);
      try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch {}
      return next;
    });
  };
  const collapseAll = () => {
    setOpen(new Set());
    try { localStorage.removeItem(OPEN_KEY); } catch {}
  };

  const tree = useMemo(() => buildTree(videos), [videos]);
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? videos.filter((v) => (v.title + ' ' + v.folder).toLowerCase().includes(s)) : [];
  }, [q, videos]);
  const groups = useMemo(() => {
    const m = new Map();
    for (const v of filtered) {
      if (!m.has(v.folder)) m.set(v.folder, []);
      m.get(v.folder).push(v);
    }
    return [...m];
  }, [filtered]);
  const cont = videos
    .filter((v) => progress[v.id])
    .sort((a, b) => progress[b.id].at - progress[a.id].at)
    .slice(0, 8);

  return (
    <div className="lib">
      <header>
        {tabs}
        <input type="search" placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ghost" onClick={onRefresh} title="Пересканировать диск">⟳</button>
        <button className="ghost" onClick={onLogout} title="Выйти">⎋</button>
      </header>

      {q ? (
        <>
          {groups.map(([folder, list]) => (
            <section key={folder}>
              <h2>{folder || 'Без папки'}</h2>
              <div className="rows">{list.map((v) => <Row key={v.id} v={v} progress={progress[v.id]} />)}</div>
            </section>
          ))}
          {filtered.length === 0 && <p className="empty">Ничего не найдено</p>}
        </>
      ) : (
        <>
          {cont.length > 0 && (
            <section>
              <h2>Продолжить просмотр</h2>
              <div className="grid">{cont.map((v) => <Card key={v.id} v={v} progress={progress[v.id]} />)}</div>
            </section>
          )}
          {videos.length > 0 && (
            <section className="tree">
              <h2>
                Папки
                {open.size > 0 && <button className="link" onClick={collapseAll}>свернуть все</button>}
              </h2>
              {sortedChildren(tree).map((c) => (
                <Folder key={c.path} node={c} depth={0} open={open} toggle={toggle} progress={progress} />
              ))}
              {tree.videos.length > 0 && (
                <Folder
                  node={{ name: 'Без папки', path: '\u0000root', children: new Map(), videos: tree.videos, count: tree.videos.length }}
                  depth={0} open={open} toggle={toggle} progress={progress}
                />
              )}
            </section>
          )}
        </>
      )}
      {videos.length === 0 && <p className="empty">Видео не найдено. Проверьте MEDIA_ROOT.</p>}
    </div>
  );
}

const MODE_LABEL = {
  direct: 'оригинал',
  audio: 'перекодирование звука',
  video: 'перекодирование видео',
};

// remember chosen audio/subtitle language so the next episode picks the same
const PREFS_KEY = 'cinema.prefs';
const loadPrefs = () => {
  try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || {}; } catch { return {}; }
};
const savePrefs = (patch) => {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...loadPrefs(), ...patch })); } catch {}
};
const pickByPref = (items, pref) => {
  if (!pref) return -1;
  let i = items.findIndex((x) => x.title && x.title === pref.title && x.lang === pref.lang);
  if (i < 0 && pref.lang) i = items.findIndex((x) => x.lang === pref.lang);
  return i;
};

const seekPointOf = (id, t, a) => api(`/api/seekpoint/${id}?t=${t.toFixed(3)}&audio=${a}`);

const audioLabel = (a) =>
  [a.lang && a.lang.toUpperCase(), a.title, a.codec, a.channels ? a.channels + 'ch' : ''].filter(Boolean).join(' · ');

function Player({ v, list }) {
  const ref = useRef(null);
  const wrap = useRef(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [audio, setAudio] = useState(0);
  const [sub, setSub] = useState('off');
  const [offset, setOffset] = useState(0); // where the current ffmpeg stream starts
  const [ss, setSs] = useState(0); // exact ffmpeg seek position for that start
  const [nonce, setNonce] = useState(0); // forces a new request even for the same start
  const [notice, setNotice] = useState('');
  const retries = useRef(0);
  const watchdog = useRef(null);
  const [cur, setCur] = useState(0);
  const [paused, setPaused] = useState(true);
  const [seekVal, setSeekVal] = useState(null);
  const [waiting, setWaiting] = useState(false);
  const seekTimer = useRef(null);

  const idx = list.findIndex((x) => x.id === v.id);
  const next = idx >= 0 && list[idx + 1] && list[idx + 1].folder === v.folder ? list[idx + 1] : null;

  // 1. find out what is inside the file
  useEffect(() => {
    let cancelled = false;
    setInfo(null); setError(''); setNotice(''); setCur(0); retries.current = 0;
    dispatchEvent(new Event('cinema:video'));
    api(`/api/probe/${v.id}`)
      .then((i) => {
        if (cancelled) return;
        const prefs = loadPrefs();
        let a = pickByPref(i.audio, prefs.audio);
        if (a < 0) a = Math.max(0, i.audio.findIndex((x) => x.default));
        setAudio(a);
        const subs = [
          ...v.subs.map((s) => ({ key: 'ext:' + s.id, lang: s.lang, title: s.label })),
          ...i.subs.map((s) => ({ key: 'emb:' + s.index, lang: s.lang, title: s.title })),
        ];
        const si = prefs.sub === 'off' ? -1 : pickByPref(subs, prefs.sub);
        setSub(si >= 0 ? subs[si].key : 'off');
        const saved = loadProgress()[v.id];
        const want = saved && saved.t > 5 ? saved.t - 3 : 0;
        const streaming = (i.modes[a] || i.modes[0]) !== 'direct';
        return (streaming && want > 0 ? seekPointOf(v.id, want, a) : Promise.resolve({ start: want, ss: want })).then((p) => {
          if (cancelled) return;
          setOffset(p.start);
          setSs(p.ss);
          setInfo(i);
        });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [v.id]);

  const mode = info ? info.modes[audio] || info.modes[0] : null;
  const streamMode = !!mode && mode !== 'direct';
  const duration = info?.duration || 0;
  const pos = streamMode ? offset + cur : cur;
  const subOffset = streamMode ? offset : 0;

  const src = !info ? null : streamMode
    ? `/api/transcode/${v.id}?start=${offset.toFixed(3)}&ss=${ss.toFixed(3)}&audio=${audio}&n=${nonce}`
    : `/api/stream/${v.id}`;

  const posRef = useRef(0);
  posRef.current = pos;

  // 2. wire up the <video> element for the current source
  useEffect(() => {
    const el = ref.current;
    if (!el || !src) return;
    setError('');
    let last = 0;
    // transcoded streams can break (dropped connection, server restart): resume from the current position
    const recover = (why) => {
      clearTimeout(watchdog.current);
      if (retries.current >= 4) {
        setNotice('');
        setError('Поток прерывается. Попробуйте позже или перемотайте вручную.');
        return;
      }
      retries.current++;
      console.warn('stream recover:', why, 'at', posRef.current);
      setNotice('Переподключение…');
      restartAt(posRef.current);
    };
    const onMeta = () => { if (!streamMode && offset > 0) el.currentTime = offset; };
    const onTime = () => {
      setCur(el.currentTime);
      if (el.currentTime > 5) retries.current = 0;
      if (Date.now() - last > 5000) { last = Date.now(); saveProgress(v.id, posRef.current, duration); }
    };
    const onPlay = () => { setPaused(false); setWaiting(false); setNotice(''); };
    const onPause = () => { setPaused(true); saveProgress(v.id, posRef.current, duration); };
    const onWait = () => {
      setWaiting(true);
      clearTimeout(watchdog.current);
      if (streamMode) watchdog.current = setTimeout(() => recover('stalled'), 15000);
    };
    const onPlaying = () => { setWaiting(false); setNotice(''); clearTimeout(watchdog.current); };
    const onEnded = () => {
      if (streamMode && duration && posRef.current < duration - 5) return recover('ended early');
      saveProgress(v.id, duration, duration);
      if (next) location.hash = `#/watch/${next.id}`;
    };
    const onErr = async () => {
      if (!streamMode) return setError('Браузер не смог воспроизвести файл.');
      // all slots taken by other viewers: say so instead of hammering the server with retries
      const st = await api('/api/status').catch(() => null);
      const slot = st?.transcodes?.[mode];
      if (slot && slot.active >= slot.max) {
        clearTimeout(watchdog.current);
        setNotice('');
        setError(`Сейчас заняты все потоки перекодирования (${slot.active} из ${slot.max}) — их смотрят другие. Попробуйте чуть позже.`);
        return;
      }
      recover('error ' + (el.error?.code ?? ''));
    };
    const evs = { loadedmetadata: onMeta, timeupdate: onTime, play: onPlay, pause: onPause, waiting: onWait, playing: onPlaying, ended: onEnded, error: onErr };
    for (const [k, f] of Object.entries(evs)) el.addEventListener(k, f);
    return () => {
      clearTimeout(watchdog.current);
      saveProgress(v.id, posRef.current, duration);
      for (const [k, f] of Object.entries(evs)) el.removeEventListener(k, f);
    };
  }, [src]);

  // show the single rendered subtitle track
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const t = setTimeout(() => { for (const tr of el.textTracks) tr.mode = 'showing'; }, 50);
    return () => clearTimeout(t);
  }, [sub, subOffset, src]);

  const restartAt = async (t, a = audio) => {
    const want = Math.max(0, Math.min(t, duration - 1));
    setWaiting(true);
    const p = await seekPointOf(v.id, want, a).catch(() => ({ start: want, ss: want }));
    setCur(0);
    setAudio(a);
    setOffset(p.start);
    setSs(p.ss);
    setNonce((n) => n + 1);
  };

  const seek = (t) => {
    if (!streamMode) { ref.current.currentTime = t; return; }
    restartAt(t);
  };
  const onSeekInput = (e) => {
    const t = Number(e.target.value);
    setSeekVal(t);
    clearTimeout(seekTimer.current);
    seekTimer.current = setTimeout(() => { setSeekVal(null); seek(t); }, 350);
  };

  const chooseAudio = (i) => {
    const a = info.audio[i];
    savePrefs({ audio: { lang: a.lang, title: a.title } });
    const at = posRef.current;
    if ((info.modes[i] || 'direct') === 'direct') { setAudio(i); setCur(0); setOffset(at); setSs(at); }
    else restartAt(at, i);
  };
  const subsList = info ? [
    ...v.subs.map((s) => ({ key: 'ext:' + s.id, lang: s.lang, title: s.label, label: s.label + ' (файл)' })),
    ...info.subs.map((s) => ({ key: 'emb:' + s.index, lang: s.lang, title: s.title, label: [s.lang.toUpperCase(), s.title].filter(Boolean).join(' · ') || `Дорожка ${s.index + 1}` })),
  ] : [];
  const chooseSub = (key) => {
    setSub(key);
    const s = subsList.find((x) => x.key === key);
    savePrefs({ sub: s ? { lang: s.lang, title: s.title } : 'off' });
  };
  const subSrc = sub.startsWith('ext:')
    ? `/api/subtitle/${sub.slice(4)}?offset=${subOffset.toFixed(1)}`
    : sub.startsWith('emb:')
      ? `/api/subtitle-embedded/${v.id}/${sub.slice(4)}?offset=${subOffset.toFixed(1)}`
      : null;

  const togglePlay = () => { const el = ref.current; el.paused ? el.play() : el.pause(); };
  const fullscreen = () => {
    if (document.fullscreenElement) return document.exitFullscreen();
    if (wrap.current.requestFullscreen) wrap.current.requestFullscreen();
    else ref.current.webkitEnterFullscreen?.();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || !ref.current) return;
      if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
      if (e.code === 'ArrowRight') seek(Math.min(duration - 1, posRef.current + 10));
      if (e.code === 'ArrowLeft') seek(Math.max(0, posRef.current - 10));
      if (e.code === 'KeyF') fullscreen();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  return (
    <div className="player">
      <header>
        <a className="ghost" href="#/">← Назад</a>
        <h1 title={v.file}>{v.title}</h1>
        {next && <a className="ghost" href={`#/watch/${next.id}`}>Далее →</a>}
      </header>

      <div className="stage" ref={wrap}>
        {src && (
          <video
            key={src}
            ref={ref}
            src={src}
            autoPlay
            playsInline
            preload="metadata"
            controls={!streamMode}
            onClick={streamMode ? togglePlay : undefined}
          >
            {subSrc && <track key={subSrc} kind="subtitles" label="sub" srcLang="und" src={subSrc} default />}
          </video>
        )}
        {!info && !error && <p className="empty">Читаю файл…</p>}
        {streamMode && waiting && <div className="spinner">⏳</div>}

        {streamMode && (
          <div className="bar">
            <button className="ghost" onClick={togglePlay}>{paused ? '▶' : '❚❚'}</button>
            <span className="time">{fmtTime(seekVal ?? pos)}</span>
            <input type="range" min="0" max={Math.floor(duration)} step="1" value={Math.floor(seekVal ?? pos)} onChange={onSeekInput} />
            <span className="time">{fmtTime(duration)}</span>
            <button className="ghost" onClick={fullscreen}>⛶</button>
          </div>
        )}
      </div>

      {info && (
        <div className="opts">
          {info.audio.length > 1 && (
            <label>Звук
              <select value={audio} onChange={(e) => chooseAudio(Number(e.target.value))}>
                {info.audio.map((a) => <option key={a.index} value={a.index}>{audioLabel(a)}</option>)}
              </select>
            </label>
          )}
          {subsList.length > 0 && (
            <label>Субтитры
              <select value={sub} onChange={(e) => chooseSub(e.target.value)}>
                <option value="off">Выкл</option>
                {subsList.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </label>
          )}
          <span className="mode">{MODE_LABEL[mode]}</span>
        </div>
      )}
      {notice && !error && <p className="hint">{notice}</p>}
      {error && <p className="err">{error}</p>}
      <p className="hint">{v.folder ? v.folder + ' / ' : ''}{v.file} · {fmtSize(v.size)}</p>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState('loading'); // loading | login | ready | error
  const [videos, setVideos] = useState([]);
  const [music, setMusic] = useState(false);
  const [err, setErr] = useState('');
  const hash = useHash();

  const load = async (refresh) => {
    try {
      const [list, me] = await Promise.all([api('/api/videos' + (refresh ? '?refresh=1' : '')), api('/api/me')]);
      setVideos(list);
      setMusic(!!me.music);
      setState('ready');
    } catch (e) {
      if (e.auth) setState('login');
      else { setErr(e.message); setState('error'); }
    }
  };
  useEffect(() => { load(); }, []);

  const logout = async () => { await fetch('/api/logout', { method: 'POST' }); setState('login'); };

  if (state === 'loading') return <p className="empty">Загрузка…</p>;
  if (state === 'login') return <Login onDone={() => load()} />;
  if (state === 'error') return <p className="err">Ошибка: {err}</p>;

  const isMusic = hash.startsWith('#/music');
  const tabs = music ? (
    <nav className="tabs">
      <a className={isMusic ? '' : 'on'} href="#/">🎬 Кино</a>
      <a className={isMusic ? 'on' : ''} href="#/music">🎵 Музыка</a>
    </nav>
  ) : <h1>🎬 Кинотеатр</h1>;

  let page;
  const m = hash.match(/^#\/watch\/(.+)$/);
  const v = m && videos.find((x) => x.id === m[1]);
  if (v) page = <Player v={v} list={videos} />;
  else if (isMusic && music) page = <MusicLibrary tabs={tabs} onLogout={logout} />;
  else page = <Library videos={videos} onRefresh={() => load(true)} onLogout={logout} tabs={tabs} />;

  return (
    <MusicProvider enabled={music}>
      <div className="page">{page}</div>
      {!v && <MiniPlayer />}
    </MusicProvider>
  );
}
