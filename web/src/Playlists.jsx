import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtTime, lsGet, lsSet } from './lib.js';
import { useMusic, coverUrl, buildTree, kids, Chevron, getMusicTree, getFolder } from './Music.jsx';

const send = (url, method, body) =>
  api(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const plural = (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'трек' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'трека' : 'треков'}`;

export function PlaylistsPage({ tabs, onLogout, editId }) {
  return editId ? <PlaylistEditor id={editId} /> : <PlaylistList tabs={tabs} onLogout={onLogout} />;
}

// ================= list =================
function PlaylistList({ tabs, onLogout }) {
  const m = useMusic();
  const [list, setList] = useState(null);
  const [err, setErr] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [confirm, setConfirm] = useState(null); // id waiting for delete confirmation
  const [open, setOpen] = useState(null); // expanded playlist id
  const [details, setDetails] = useState({}); // id -> playlist with tracks

  const load = () => api('/api/playlists').then(setList).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const getDetails = async (id) => {
    if (details[id]) return details[id];
    const d = await api(`/api/playlists/${id}`);
    setDetails((x) => ({ ...x, [id]: d }));
    return d;
  };

  const create = async (e) => {
    e.preventDefault();
    try {
      const p = await send('/api/playlists', 'POST', { name: newName });
      location.hash = `#/playlists/${p.id}/edit`; // straight to picking tracks
    } catch (e) {
      setErr(e.message);
    }
  };
  const remove = async (id) => {
    await send(`/api/playlists/${id}`, 'DELETE').catch(() => {}); // 204 has no JSON body
    setConfirm(null);
    load();
  };
  const playAll = async (id, start = 0) => {
    const d = await getDetails(id);
    const tracks = d.tracks.filter((t) => !t.missing);
    if (tracks.length) m.playQueue(tracks, Math.min(start, tracks.length - 1));
  };
  const toggle = (id) => {
    setOpen(open === id ? null : id);
    if (open !== id) getDetails(id).catch(() => {});
  };

  return (
    <div className="lib">
      <header>
        {tabs}
        <span className="spacer" />
        <button className="ghost" onClick={onLogout} title="Выйти">⎋</button>
      </header>
      <section className="tree">
        <h2>
          Плейлисты
          {!creating && <button className="link" onClick={() => { setCreating(true); setNewName(''); }}>+ новый</button>}
        </h2>
        {creating && (
          <form className="pl-new" onSubmit={create}>
            <input autoFocus placeholder="Название плейлиста" value={newName} maxLength={100} onChange={(e) => setNewName(e.target.value)} />
            <button className="chip on" disabled={!newName.trim()}>Создать</button>
            <button type="button" className="chip" onClick={() => setCreating(false)}>Отмена</button>
          </form>
        )}
        {err && <p className="err">{err}</p>}
        {!list && !err && <p className="empty">Загрузка…</p>}
        {list && !list.length && !creating && <p className="empty">Плейлистов пока нет. Нажмите «+ новый».</p>}
        {list?.map((p) => (
          <div className="folder" key={p.id}>
            {confirm === p.id ? (
              <div className="pl-head confirm">
                <span className="fname">Удалить «{p.name}»?</span>
                <button className="chip danger" onClick={() => remove(p.id)}>Удалить</button>
                <button className="chip" onClick={() => setConfirm(null)}>Отмена</button>
              </div>
            ) : (
              <div className={'pl-head' + (open === p.id ? ' open' : '')}>
                <button className="pl-toggle" onClick={() => toggle(p.id)} aria-expanded={open === p.id}>
                  <Chevron />
                  <span className="fname">{p.name}</span>
                  <span className="count">{p.count}</span>
                </button>
                <button className="icon" title="Играть" aria-label="Играть" disabled={!p.count} onClick={() => playAll(p.id)}>▶</button>
                <a className="icon" title="Редактировать" aria-label="Редактировать" href={`#/playlists/${p.id}/edit`}>✎</a>
                <button className="icon" title="Удалить" aria-label="Удалить" onClick={() => setConfirm(p.id)}>🗑</button>
              </div>
            )}
            {open === p.id && (
              <div className="folder-body">
                <small className="hint">{plural(p.count)} · {fmtTime(p.duration)}</small>
                {!details[p.id] ? <p className="hint">Загрузка…</p> : !details[p.id].tracks.length ? (
                  <p className="hint">Пусто. <a href={`#/playlists/${p.id}/edit`}>Добавить треки</a></p>
                ) : (
                  <div className="rows">
                    {details[p.id].tracks.map((t, i) => {
                      const isCur = m.current?.id === t.id;
                      const playable = details[p.id].tracks.filter((x) => !x.missing);
                      return (
                        <button
                          key={t.id}
                          className={'row track' + (isCur ? ' cur' : '') + (t.missing ? ' missing' : '')}
                          disabled={t.missing}
                          onClick={() => playAll(p.id, playable.findIndex((x) => x.id === t.id))}
                        >
                          <span className="tn">{isCur && m.playing ? '♪' : i + 1}</span>
                          <span className="rtitle">
                            {t.title}
                            {t.artist && <small> — {t.artist}</small>}
                            {t.missing && <small> · файл не найден</small>}
                          </span>
                          <span className="rmeta">{fmtTime(t.duration)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </section>
    </div>
  );
}

// ================= editor =================
function PlaylistEditor({ id }) {
  const [pl, setPl] = useState(null);
  const [name, setName] = useState('');
  const [tracks, setTracks] = useState([]);
  const [tab, setTab] = useState('content');
  const [saveState, setSaveState] = useState('saved'); // saved | pending | saving | error
  const [err, setErr] = useState('');
  const loaded = useRef(false);

  useEffect(() => {
    api(`/api/playlists/${id}`)
      .then((p) => { setPl(p); setName(p.name); setTracks(p.tracks); loaded.current = true; })
      .catch((e) => setErr(e.message === 'Not Found' ? 'Плейлист не найден' : e.message));
  }, [id]);

  // autosave every change shortly after the last edit
  useEffect(() => {
    if (!loaded.current) return;
    if (!name.trim()) { setSaveState('error'); return; }
    setSaveState('pending');
    const t = setTimeout(async () => {
      setSaveState('saving');
      try {
        await send(`/api/playlists/${id}`, 'PUT', { name, tracks: tracks.map(({ missing, ...t }) => t) });
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    }, 600);
    return () => clearTimeout(t);
  }, [name, tracks]);

  const selected = useMemo(() => new Set(tracks.map((t) => t.id)), [tracks]);
  const setInPlaylist = (list, on) =>
    setTracks((cur) => {
      if (on) {
        const have = new Set(cur.map((t) => t.id));
        return [...cur, ...list.filter((t) => !have.has(t.id))];
      }
      const drop = new Set(list.map((t) => t.id));
      return cur.filter((t) => !drop.has(t.id));
    });

  if (err) return <div className="lib"><header><a className="ghost" href="#/playlists">← Назад</a></header><p className="err">{err}</p></div>;
  if (!pl) return <p className="empty">Загрузка…</p>;

  const status = { saved: 'Сохранено', pending: '…', saving: 'Сохраняю…', error: !name.trim() ? 'Нужно название' : 'Ошибка сохранения' }[saveState];
  return (
    <div className="lib">
      <header>
        <a className="ghost" href="#/playlists">← Назад</a>
        <input className="pl-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Название плейлиста" />
        <span className={'save ' + saveState}>{status}</span>
      </header>
      <nav className="subtabs">
        <button className={tab === 'content' ? 'on' : ''} onClick={() => setTab('content')}>Состав <span className="count">{tracks.length}</span></button>
        <button className={tab === 'order' ? 'on' : ''} onClick={() => setTab('order')}>Порядок</button>
      </nav>
      {tab === 'content'
        ? <ContentTab selected={selected} setInPlaylist={setInPlaylist} />
        : <OrderTab tracks={tracks} setTracks={setTracks} />}
    </div>
  );
}

// ----- "Состав": the music tree with checkboxes -----
const PL_OPEN_KEY = 'cinema.pl.open';

function ContentTab({ selected, setInPlaylist }) {
  const [folders, setFolders] = useState(null);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(() => new Set(lsGet(PL_OPEN_KEY, [])));
  useEffect(() => { getMusicTree().then(setFolders).catch((e) => setErr(e.message)); }, []);

  const toggle = (p) => setOpen((prev) => {
    const n = new Set(prev);
    if (n.has(p)) { for (const x of [...n]) if (x === p || x.startsWith(p + '/')) n.delete(x); } else n.add(p);
    lsSet(PL_OPEN_KEY, [...n]);
    return n;
  });
  const tree = useMemo(() => (folders ? buildTree(folders) : null), [folders]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !folders) return [];
    return folders
      .filter((f) => f.path.toLowerCase().includes(s) || f.files.some((x) => x.toLowerCase().includes(s)))
      .slice(0, 100)
      .map((f) => ({ name: f.path, path: f.path, children: new Map(), own: f, count: f.count }));
  }, [q, folders]);

  if (err) return <p className="err">{err}</p>;
  if (!tree) return <p className="empty">Сканирую фонотеку…</p>;
  const props = { open, toggle, selected, setInPlaylist };
  return (
    <section className="tree">
      <input className="pl-search" type="search" placeholder="Найти папку или файл…" value={q} onChange={(e) => setQ(e.target.value)} />
      {q
        ? matches.map((n) => <PickFolder key={n.path} node={n} {...props} />)
        : kids(tree).map((c) => <PickFolder key={c.path} node={c} {...props} />)}
      {!q && tree.own && <PickFolder node={{ ...tree, children: new Map(), path: '' }} label="Без папки" {...props} />}
      {q && !matches.length && <p className="empty">Ничего не найдено</p>}
    </section>
  );
}

function PickFolder({ node, label, open, toggle, selected, setInPlaylist }) {
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
          {kids(node).map((c) => (
            <PickFolder key={c.path} node={c} open={open} toggle={toggle} selected={selected} setInPlaylist={setInPlaylist} />
          ))}
          {node.own && <PickTracks path={node.path} selected={selected} setInPlaylist={setInPlaylist} />}
        </div>
      )}
    </div>
  );
}

function PickTracks({ path, selected, setInPlaylist }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { getFolder(path).then(setData).catch(() => setErr('Не удалось прочитать папку')); }, [path]);
  const tracks = useMemo(() => (data ? data.tracks.map((t) => ({ ...t, folder: path })) : []), [data, path]);
  const all = useRef(null);
  const nSel = tracks.filter((t) => selected.has(t.id)).length;
  useEffect(() => { if (all.current) all.current.indeterminate = nSel > 0 && nSel < tracks.length; }, [nSel, tracks.length]);

  if (err) return <p className="err">{err}</p>;
  if (!data) return <p className="hint">Читаю теги…</p>;
  if (!tracks.length) return <p className="hint">Нет воспроизводимых файлов</p>;
  return (
    <div className="rows pick">
      <label className="row check all">
        <input ref={all} type="checkbox" checked={nSel === tracks.length} onChange={(e) => setInPlaylist(tracks, e.target.checked)} />
        <span className="rtitle">Все треки папки</span>
        <span className="rmeta">{nSel}/{tracks.length}</span>
      </label>
      {tracks.map((t, i) => (
        <label key={t.id} className={'row check' + (selected.has(t.id) ? ' on' : '')}>
          <input type="checkbox" checked={selected.has(t.id)} onChange={(e) => setInPlaylist([t], e.target.checked)} />
          <span className="tn">{t.n || i + 1}</span>
          <span className="rtitle">{t.title}{t.artist && <small> — {t.artist}</small>}</span>
          {t.quality && <span className="fmt">{t.quality}</span>}
          <span className="rmeta">{fmtTime(t.duration)}</span>
        </label>
      ))}
    </div>
  );
}

// ----- "Порядок": drag and drop with pointer events (mouse and touch) -----
function OrderTab({ tracks, setTracks }) {
  const listRef = useRef(null);
  const [drag, setDrag] = useState(null); // { from, over, dy, h }
  const geo = useRef(null); // row centres in page coordinates, captured when the drag starts
  const scrollTimer = useRef(null);

  const overIndex = (from, centre) => {
    const c = geo.current.centres;
    let i = 0;
    while (i < c.length - 1 && centre > (c[i] + c[i + 1]) / 2) i++;
    return i;
  };

  const start = (e, i) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const rows = [...listRef.current.children];
    geo.current = {
      centres: rows.map((r) => { const b = r.getBoundingClientRect(); return b.top + window.scrollY + b.height / 2; }),
      startY: e.clientY + window.scrollY,
      h: rows[i].getBoundingClientRect().height + 2,
      lastClientY: e.clientY,
    };
    setDrag({ from: i, over: i, dy: 0, h: geo.current.h });
  };
  const update = (clientY) => {
    if (!geo.current) return;
    geo.current.lastClientY = clientY;
    const y = clientY + window.scrollY;
    const dy = y - geo.current.startY;
    setDrag((d) => d && { ...d, dy, over: overIndex(d.from, geo.current.centres[d.from] + dy) });
  };
  const move = (e) => {
    if (!drag) return;
    update(e.clientY);
    // scroll the page when dragging near the top or the bottom (mini player) edge
    clearInterval(scrollTimer.current);
    const edge = e.clientY < 80 ? -12 : e.clientY > window.innerHeight - 160 ? 12 : 0;
    if (edge) scrollTimer.current = setInterval(() => { window.scrollBy(0, edge); update(geo.current.lastClientY); }, 30);
  };
  const end = () => {
    clearInterval(scrollTimer.current);
    if (!drag) return;
    const { from, over } = drag;
    setDrag(null);
    geo.current = null;
    if (from !== over) setTracks((cur) => { const a = [...cur]; const [x] = a.splice(from, 1); a.splice(over, 0, x); return a; });
  };
  useEffect(() => () => clearInterval(scrollTimer.current), []);

  const shift = (i) => {
    if (!drag || i === drag.from) return 0;
    if (drag.from < drag.over && i > drag.from && i <= drag.over) return -drag.h;
    if (drag.from > drag.over && i < drag.from && i >= drag.over) return drag.h;
    return 0;
  };
  const moveBy = (i, d) => setTracks((cur) => {
    const j = i + d;
    if (j < 0 || j >= cur.length) return cur;
    const a = [...cur]; [a[i], a[j]] = [a[j], a[i]]; return a;
  });

  if (!tracks.length) return <p className="empty">Плейлист пуст — отметьте треки на вкладке «Состав».</p>;
  const total = tracks.reduce((a, t) => a + (t.duration || 0), 0);
  return (
    <section className="tree">
      <p className="hint">{plural(tracks.length)} · {fmtTime(total)} · перетаскивайте за ⠿</p>
      <div className={'order' + (drag ? ' dragging' : '')} ref={listRef}>
        {tracks.map((t, i) => (
          <div
            key={t.id}
            className={'orow' + (drag?.from === i ? ' lifted' : '') + (t.missing ? ' missing' : '')}
            style={{ transform: `translateY(${drag?.from === i ? drag.dy : shift(i)}px)` }}
          >
            <span
              className="handle" title="Перетащить" aria-label={`Переместить «${t.title}»`}
              role="button" tabIndex={0}
              onPointerDown={(e) => start(e, i)} onPointerMove={move} onPointerUp={end} onPointerCancel={end}
              onKeyDown={(e) => {
                if (e.key === 'ArrowUp') { e.preventDefault(); moveBy(i, -1); }
                if (e.key === 'ArrowDown') { e.preventDefault(); moveBy(i, 1); }
              }}
            >⠿</span>
            <img className="ocover" src={coverUrl(t.folder, 120)} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
            <span className="otext">
              <b>{t.title}</b>
              <small>{[t.artist, t.album].filter(Boolean).join(' · ') || t.folder}{t.missing ? ' · файл не найден' : ''}</small>
            </span>
            <span className="rmeta">{fmtTime(t.duration)}</span>
            <button className="icon" title="Убрать из плейлиста" aria-label="Убрать" onClick={() => setTracks((cur) => cur.filter((x) => x.id !== t.id))}>✕</button>
          </div>
        ))}
      </div>
    </section>
  );
}
