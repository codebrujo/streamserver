import React, { useEffect, useMemo, useRef, useState } from 'react';

// ---------- helpers ----------
const api = async (url, opts) => {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

const fmtSize = (b) => (b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' ГБ' : Math.round(b / (1 << 20)) + ' МБ');
const fmtTime = (s) => {
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};

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
          {v.play !== 'yes' && <em className={v.play}>{v.play === 'no' ? ' · не играет' : ' · может не играть'}</em>}
        </small>
      </div>
    </a>
  );
}

function Library({ videos, onRefresh, onLogout }) {
  const [q, setQ] = useState('');
  const progress = loadProgress();
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? videos.filter((v) => (v.title + ' ' + v.folder).toLowerCase().includes(s)) : videos;
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
        <h1>🎬 Кинотеатр</h1>
        <input type="search" placeholder="Поиск…" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="ghost" onClick={onRefresh} title="Пересканировать диск">⟳</button>
        <button className="ghost" onClick={onLogout} title="Выйти">⎋</button>
      </header>
      {!q && cont.length > 0 && (
        <section>
          <h2>Продолжить просмотр</h2>
          <div className="grid">{cont.map((v) => <Card key={v.id} v={v} progress={progress[v.id]} />)}</div>
        </section>
      )}
      {groups.map(([folder, list]) => (
        <section key={folder}>
          <h2>{folder || 'Корень'}</h2>
          <div className="grid">{list.map((v) => <Card key={v.id} v={v} progress={progress[v.id]} />)}</div>
        </section>
      ))}
      {videos.length > 0 && filtered.length === 0 && <p className="empty">Ничего не найдено</p>}
      {videos.length === 0 && <p className="empty">Видео не найдено. Проверьте MEDIA_ROOT.</p>}
    </div>
  );
}

function Player({ v, list }) {
  const ref = useRef(null);
  const [error, setError] = useState('');
  const idx = list.findIndex((x) => x.id === v.id);
  const next = idx >= 0 && list[idx + 1] && list[idx + 1].folder === v.folder ? list[idx + 1] : null;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setError('');
    const saved = loadProgress()[v.id];
    const onMeta = () => { if (saved && saved.t > 5) el.currentTime = saved.t - 3; };
    let last = 0;
    const onTime = () => {
      if (Date.now() - last > 5000) { last = Date.now(); saveProgress(v.id, el.currentTime, el.duration); }
    };
    const onPause = () => saveProgress(v.id, el.currentTime, el.duration);
    const onEnded = () => { saveProgress(v.id, el.duration, el.duration); if (next) location.hash = `#/watch/${next.id}`; };
    const onErr = () => setError('Браузер не может воспроизвести этот файл (кодек/контейнер). См. README: перепаковка через ffmpeg.');
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('pause', onPause);
    el.addEventListener('ended', onEnded);
    el.addEventListener('error', onErr);
    return () => {
      onPause();
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('pause', onPause);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('error', onErr);
    };
  }, [v.id]);

  return (
    <div className="player">
      <header>
        <a className="ghost" href="#/">← Назад</a>
        <h1 title={v.file}>{v.title}</h1>
        {next && <a className="ghost" href={`#/watch/${next.id}`}>Далее →</a>}
      </header>
      <video key={v.id} ref={ref} controls autoPlay playsInline preload="metadata" src={`/api/stream/${v.id}`}>
        {v.subs.map((s) => (
          <track key={s.id} kind="subtitles" label={s.label} srcLang={s.lang} src={`/api/subtitle/${s.id}`} />
        ))}
      </video>
      {error && <p className="err">{error}</p>}
      <p className="hint">{v.folder ? v.folder + ' / ' : ''}{v.file} · {fmtSize(v.size)}</p>
    </div>
  );
}

export default function App() {
  const [state, setState] = useState('loading'); // loading | login | ready | error
  const [videos, setVideos] = useState([]);
  const [err, setErr] = useState('');
  const hash = useHash();

  const load = async (refresh) => {
    try {
      const list = await api('/api/videos' + (refresh ? '?refresh=1' : ''));
      setVideos(list);
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

  const m = hash.match(/^#\/watch\/(.+)$/);
  if (m) {
    const v = videos.find((x) => x.id === m[1]);
    if (v) return <Player v={v} list={videos} />;
  }
  return <Library videos={videos} onRefresh={() => load(true)} onLogout={logout} />;
}
