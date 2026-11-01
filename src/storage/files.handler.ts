import type { NextFunction, Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import { decodeKey, verifyFileSignature } from './file-url';
import { StorageService } from './storage.service';

/** Content types by extension for the local driver (R2 keeps the upload's type). */
const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  txt: 'text/plain; charset=utf-8',
  zip: 'application/zip',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const INVALID = { message: 'Link expired or invalid.' };

/**
 * One `Range: bytes=…` spec against `size`: {start, end}, 'unsatisfiable'
 * (416), or null to ignore the header and send the whole file (malformed or
 * several ranges, as Symfony's BinaryFileResponse does for legacy /media).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (m[2] !== '' && Number(m[2]) < start) return null;
  }
  if (start >= size || size === 0) return 'unsatisfiable';
  return { start, end };
}

/**
 * security: not in legacy. `GET|HEAD /files/<key>?exp&sig` for the local
 * driver (production serves the same route from the edge Worker and the
 * private R2 bucket). 403 for a missing/wrong/expired signature or a
 * forbidden key (invoices, `..`, …), 404 when the object is missing, byte
 * ranges (206/416) for video seeking. Mounted outside the /api/v1 prefix.
 */
export function filesHandler() {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      // req.path is still percent-encoded; it is relative to the mount point.
      const key = decodeKey(req.path.replace(/^\//, ''));
      const check =
        key === null
          ? ({ ok: false } as const)
          : verifyFileSignature(key, req.query.exp, req.query.sig);
      res.setHeader('Referrer-Policy', 'no-referrer');
      // The web app (another origin locally) embeds PDFs in a frame; in
      // production the Worker serves these on the site's own origin.
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!check.ok || key === null) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(403).json(INVALID);
        return;
      }
      const path = StorageService.privatePath(key);
      const info = path ? await stat(path).catch(() => null) : null;
      if (!path || !info?.isFile()) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).json({ message: 'Not found.' });
        return;
      }
      const ttl = Math.min(
        Math.max(0, check.exp - Math.floor(Date.now() / 1000)),
        3600,
      );
      const size = info.size;
      res.setHeader(
        'Content-Type',
        TYPES[extname(key).slice(1).toLowerCase()] ??
          'application/octet-stream',
      );
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', `private, max-age=${ttl}`);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Last-Modified', info.mtime.toUTCString());

      const range = parseRange(req.headers.range, size);
      if (range === 'unsatisfiable') {
        res.setHeader('Content-Range', `bytes */${size}`);
        res.status(416).end();
        return;
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      if (range) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      } else {
        res.status(200);
      }
      res.setHeader('Content-Length', String(size === 0 ? 0 : end - start + 1));
      if (req.method === 'HEAD' || size === 0) {
        res.end();
        return;
      }
      const stream = createReadStream(path, { start, end });
      stream.on('error', (e) => (res.headersSent ? res.destroy(e) : next(e)));
      stream.pipe(res);
    } catch (e) {
      next(e);
    }
  };
}
