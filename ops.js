// Operations: version, health check, Prometheus metrics, start notification to chatguru.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';

const startedAt = Date.now();

const run = (cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: 10_000 }, (err, stdout) => resolve(err ? null : String(stdout).trim()));
  });

// "1.0.0 (3f2a1bc)"
export async function getVersion(appDir) {
  let version = '0.0.0';
  try {
    version = JSON.parse(await fsp.readFile(path.join(appDir, 'package.json'), 'utf8')).version;
  } catch {}
  const commit = await run('git', ['rev-parse', '--short', 'HEAD'], appDir);
  return { version, commit: commit || '' , label: commit ? `${version} (${commit})` : version };
}

export async function checkFfmpeg() {
  const [ff, fp] = await Promise.all([run(process.env.FFMPEG || 'ffmpeg', ['-version']), run(process.env.FFPROBE || 'ffprobe', ['-version'])]);
  return !!ff && !!fp;
}

// Only answer details to direct LAN requests (monitoring), not to the internet via the EC2 proxy.
export function isDirectLan(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false;
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd])/.test(ip);
}

async function dirSize(dir) {
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * deps: {
 *   mediaRoot, musicRoot, cacheDir, version,
 *   videoCount(): number|null, musicFolders(): number|null,
 *   transcodes(): { video: {active,max}, audio: {active,max} },
 *   ffmpegOk(): boolean
 * }
 */
export function createOps(deps) {
  const reachable = async (dir) => !!dir && (await fsp.readdir(dir).then((l) => l.length > 0, () => false));

  async function health() {
    const problems = [];
    const media = await reachable(deps.mediaRoot);
    if (!media) problems.push(`media folder is not available: ${deps.mediaRoot} (USB drive unmounted?)`);
    let music = null;
    if (deps.musicRoot) {
      music = await reachable(deps.musicRoot);
      if (!music) problems.push(`music folder is not available: ${deps.musicRoot}`);
    }
    if (!deps.ffmpegOk()) problems.push('ffmpeg/ffprobe not found');
    return {
      status: problems.length ? 'degraded' : 'ok',
      problems,
      version: deps.version.label,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      videos: deps.videoCount(),
      musicFolders: deps.musicFolders(),
      transcodes: deps.transcodes(),
    };
  }

  // cache size is a directory walk: refresh at most every 5 minutes
  let cacheBytes = { at: 0, value: 0 };
  async function getCacheBytes() {
    if (Date.now() - cacheBytes.at > 5 * 60_000) cacheBytes = { at: Date.now(), value: await dirSize(deps.cacheDir) };
    return cacheBytes.value;
  }

  async function metrics() {
    const h = await health();
    const t = h.transcodes;
    const lines = [];
    const metric = (name, help, type, samples) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
    };
    const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    metric('streamserver_up', '1 if healthy, 0 if degraded', 'gauge', [['', h.status === 'ok' ? 1 : 0]]);
    metric('streamserver_info', 'Version information', 'gauge', [[`{version="${esc(deps.version.version)}",commit="${esc(deps.version.commit)}"}`, 1]]);
    metric('streamserver_uptime_seconds', 'Seconds since start', 'gauge', [['', h.uptimeSec]]);
    metric('streamserver_media_available', 'Library folder is readable', 'gauge', [
      ['{library="video"}', h.problems.some((p) => p.startsWith('media')) ? 0 : 1],
      ...(deps.musicRoot ? [['{library="music"}', h.problems.some((p) => p.startsWith('music')) ? 0 : 1]] : []),
    ]);
    if (h.videos != null) metric('streamserver_videos', 'Indexed video files', 'gauge', [['', h.videos]]);
    if (h.musicFolders != null) metric('streamserver_music_folders', 'Folders with audio', 'gauge', [['', h.musicFolders]]);
    metric('streamserver_transcodes_active', 'Running ffmpeg streams', 'gauge', [
      ['{kind="audio"}', t.audio.active],
      ['{kind="video"}', t.video.active],
    ]);
    metric('streamserver_transcodes_max', 'ffmpeg stream limit', 'gauge', [
      ['{kind="audio"}', t.audio.max],
      ['{kind="video"}', t.video.max],
    ]);
    metric('streamserver_cache_bytes', 'Size of the cache directory', 'gauge', [['', await getCacheBytes()]]);
    return lines.join('\n') + '\n';
  }

  function routes(app) {
    // polled by monitoring-mcp-bot: 200 when fine, 503 when something it can't fix itself is broken
    app.get('/health', async (req, res) => {
      const h = await health();
      res.status(h.status === 'ok' ? 200 : 503);
      res.setHeader('Cache-Control', 'no-store');
      res.json(isDirectLan(req) ? h : { status: h.status });
    });
    app.get('/metrics', async (req, res) => {
      if (!isDirectLan(req)) return res.sendStatus(404);
      res.type('text/plain; version=0.0.4').send(await metrics());
    });
  }

  return { health, metrics, routes };
}

// Same message format and API as rag-server / aikrishna: POST {CHATGURU_URL}message to the service channel.
export async function notifyOnServerStart(text) {
  console.log(text);
  const base = process.env.CHATGURU_URL;
  if (!base) return console.log('CHATGURU_URL is not set, start notification skipped');
  const url = (base.endsWith('/') ? base : base + '/') + 'message';
  const channelId = process.env.CHATGURU_SERVICE_CHANNEL || 'ito';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-app-validation': process.env.CHATGURU_APP_TOKEN || '',
        'x-app-s2s-token': process.env.CHATGURU_TOKEN || '',
      },
      body: JSON.stringify({ channelId, messages: [{ text, timestamp: new Date().toISOString() }] }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) console.error(`start notification failed: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  } catch (e) {
    console.error(`start notification failed: ${e.message}`);
  }
}
