// helpers shared by the video and music parts of the UI
export const api = async (url, opts) => {
  const r = await fetch(url, { credentials: 'same-origin', ...opts });
  if (r.status === 401) throw Object.assign(new Error('auth'), { auth: true });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
  return r.json();
};

export const fmtSize = (b) => (b > 1 << 30 ? (b / (1 << 30)).toFixed(1) + ' ГБ' : Math.round(b / (1 << 20)) + ' МБ');
export const fmtTime = (s) => {
  s = Math.floor(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(sec).padStart(2, '0');
};

export const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

export const lsGet = (k, d) => {
  try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; }
};
export const lsSet = (k, v) => {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
};
