// Daily cache cleanup: leftovers of interrupted conversions and entries nobody used for a long time.
// "Last used" = file mtime; every cache hit touches the file (see touch()).
import fsp from 'node:fs/promises';
import path from 'node:path';

const DAY = 24 * 3600 * 1000;
const TMP_GRACE = 3600 * 1000; // a .tmp younger than this may still be being written

export async function touch(file) {
  const now = new Date();
  await fsp.utimes(file, now, now).catch(() => {});
}

async function* walk(dir) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}

export async function cleanCache(dir, { maxAgeDays = 90, now = Date.now() } = {}) {
  let files = 0;
  let bytes = 0;
  for await (const f of walk(dir)) {
    const st = await fsp.stat(f).catch(() => null);
    if (!st) continue;
    const age = now - st.mtimeMs;
    const stale = f.endsWith('.tmp') ? age > TMP_GRACE : age > maxAgeDays * DAY;
    if (stale && (await fsp.rm(f, { force: true }).then(() => true, () => false))) {
      files++;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

export function startCacheJanitor(dir, { maxAgeDays = 90, firstRunMs = 60_000 } = {}) {
  const run = async () => {
    try {
      const { files, bytes } = await cleanCache(dir, { maxAgeDays });
      if (files) console.log(`cache cleanup: removed ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);
    } catch (e) {
      console.error('cache cleanup failed:', e.message);
    }
  };
  setTimeout(run, firstRunMs).unref(); // shortly after start, then once a day
  setInterval(run, DAY).unref();
}
