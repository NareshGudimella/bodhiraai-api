/**
 * Port of App\Support\Mp4Faststart: move the `moov` atom before `mdat` so
 * browsers can start playback before the whole file has downloaded (what
 * `ffmpeg -c copy -movflags +faststart` does), patching every stco/co64 chunk
 * offset by the size of the moved moov box. Works on an in-memory buffer.
 */

/** Container boxes walked to find stco/co64. */
const CONTAINERS = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'udta',
  'meta',
]);

interface Box {
  type: string;
  pos: number;
  size: number;
}

const type = (b: Buffer, at: number) => b.toString('latin1', at + 4, at + 8);
const u64 = (b: Buffer, at: number) => Number(b.readBigUInt64BE(at));

function topLevel(b: Buffer): Box[] {
  const boxes: Box[] = [];
  let pos = 0;
  while (pos + 8 <= b.length) {
    let size = b.readUInt32BE(pos);
    if (size === 1) {
      if (pos + 16 > b.length) break;
      size = u64(b, pos + 8);
    } else if (size === 0) {
      size = b.length - pos; // extends to end of file
    }
    if (size < 8) break;
    boxes.push({ type: type(b, pos), pos, size });
    pos += size;
  }
  return boxes;
}

/** Mp4Faststart::isFaststart: true when moov comes before mdat (or there's nothing to fix). */
export function isFaststart(b: Buffer): boolean {
  for (const box of topLevel(b)) {
    if (box.type === 'moov') return true;
    if (box.type === 'mdat') return false;
  }
  return true;
}

function walk(moov: Buffer, start: number, end: number, delta: number) {
  let i = start;
  while (i + 8 <= end) {
    let size = moov.readUInt32BE(i);
    let hdr = 8;
    if (size === 1) {
      size = u64(moov, i + 8);
      hdr = 16;
    }
    if (size <= 0 || i + size > end) break;
    const t = type(moov, i);
    const body = i + hdr;
    if (t === 'stco') {
      const count = moov.readUInt32BE(body + 4);
      for (let k = 0; k < count; k++) {
        const off = body + 8 + k * 4;
        // pack('N') keeps the low 32 bits.
        moov.writeUInt32BE((moov.readUInt32BE(off) + delta) >>> 0, off);
      }
    } else if (t === 'co64') {
      const count = moov.readUInt32BE(body + 4);
      for (let k = 0; k < count; k++) {
        const off = body + 8 + k * 8;
        moov.writeBigUInt64BE(moov.readBigUInt64BE(off) + BigInt(delta), off);
      }
    } else if (CONTAINERS.has(t)) {
      walk(moov, body, i + size, delta);
    }
    i += size;
  }
}

/**
 * Mp4Faststart::fix: boxes before mdat (minus moov), the patched moov, mdat,
 * then anything after mdat. Throws when there's no moov or mdat.
 */
export function faststart(b: Buffer): Buffer {
  const boxes = topLevel(b);
  const moov = boxes.find((x) => x.type === 'moov');
  const mdat = boxes.find((x) => x.type === 'mdat');
  if (!moov || !mdat)
    throw new Error('File does not contain both moov and mdat atoms');
  if (moov.pos < mdat.pos) return b;

  const patched = Buffer.from(b.subarray(moov.pos, moov.pos + moov.size));
  walk(patched, 8, patched.length, moov.size);

  const slice = (x: Box) => b.subarray(x.pos, x.pos + x.size);
  return Buffer.concat([
    ...boxes.filter((x) => x.pos < mdat.pos && x.type !== 'moov').map(slice),
    patched,
    slice(mdat),
    ...boxes.filter((x) => x.pos > mdat.pos && x.type !== 'moov').map(slice),
  ]);
}
