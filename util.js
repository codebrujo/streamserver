// Shared helpers: byte-range file responses and legacy text decoding.
import fs from 'node:fs';
import fsp from 'node:fs/promises';

// Send a file honouring HTTP Range, so players can seek.
export async function sendRange(req, res, file, mime, cache = 'private, max-age=3600') {
  let st;
  try {
    st = await fsp.stat(file);
  } catch {
    return res.sendStatus(404);
  }
  const size = st.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cache);

  const range = req.headers.range;
  let start = 0;
  let end = size - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (!m || (m[1] === '' && m[2] === '')) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.sendStatus(416);
    }
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2])); // suffix range: last N bytes
    } else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.sendStatus(416);
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(file, { start, end, highWaterMark: 1 << 20 });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

// UTF-8 if valid, otherwise Windows-1251 (old Russian .srt/.cue files).
export function decodeText(buf) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1251').decode(buf);
  }
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}
