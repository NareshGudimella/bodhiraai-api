/**
 * Upload rules ported from App\Services\FileUploadService: per-category
 * extension allowlist, permitted content types, and size caps. The content
 * type is sniffed from the file's bytes (legacy used finfo), never trusted
 * from the client.
 */

export type UploadCategory = 'video' | 'pdf' | 'image' | 'doc';

export const ALLOWED: Record<UploadCategory, string[]> = {
  video: ['mp4', 'mov', 'webm', 'mkv'],
  pdf: ['pdf'],
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp'],
  doc: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'zip'],
};

export const MAX_SIZE_MB: Record<UploadCategory, number> = {
  video: 200,
  pdf: 50,
  image: 10,
  doc: 50,
};

/** Sniffed families each category accepts (finfo MIME types, grouped by container). */
const ACCEPTS: Record<UploadCategory, Kind[]> = {
  video: ['mp4', 'matroska'],
  pdf: ['pdf'],
  image: ['jpeg', 'png', 'gif', 'webp'],
  doc: ['pdf', 'ole', 'zip', 'text'],
};

export type Kind =
  | 'bmp'
  | 'jpeg'
  | 'png'
  | 'gif'
  | 'webp'
  | 'pdf'
  | 'zip'
  | 'ole'
  | 'mp4'
  | 'matroska'
  | 'text'
  | 'unknown';

const MIME: Record<Kind, string> = {
  bmp: 'image/bmp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  ole: 'application/msword',
  mp4: 'video/mp4',
  matroska: 'video/webm',
  text: 'text/plain',
  unknown: 'application/octet-stream',
};

const starts = (b: Buffer, sig: number[], at = 0) =>
  sig.every((x, i) => b[at + i] === x);

/** Identify a file from its leading bytes. */
export function sniff(b: Buffer): Kind {
  if (starts(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (starts(b, [0x42, 0x4d]) && b.length > 26) return 'bmp';
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (
    b.subarray(0, 6).toString('latin1') === 'GIF87a' ||
    b.subarray(0, 6).toString('latin1') === 'GIF89a'
  )
    return 'gif';
  if (
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'webp';
  if (b.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  if (
    starts(b, [0x50, 0x4b, 0x03, 0x04]) ||
    starts(b, [0x50, 0x4b, 0x05, 0x06])
  )
    return 'zip'; // zip, docx, xlsx, pptx
  if (starts(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'ole'; // doc, xls, ppt
  if (b.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4'; // mp4, mov
  if (starts(b, [0x1a, 0x45, 0xdf, 0xa3])) return 'matroska'; // webm, mkv
  const head = b.subarray(0, 4096);
  if (
    b.length > 0 &&
    !head.includes(0) &&
    Buffer.from(head.toString('utf8'), 'utf8').equals(head)
  )
    return 'text';
  return 'unknown';
}

export class UploadRejected extends Error {}

export interface IncomingFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

/** FileUploadService::validate(). Returns the extension and the content type to store. */
export function checkUpload(
  file: IncomingFile,
  category: UploadCategory,
): { ext: string; contentType: string } {
  const ext = (file.originalname.split('.').pop() ?? '').toLowerCase();
  if (!file.originalname.includes('.') || !ALLOWED[category].includes(ext)) {
    throw new UploadRejected(`Extension .${ext} not allowed for ${category}.`);
  }
  const kind = sniff(file.buffer);
  if (!ACCEPTS[category].includes(kind)) {
    throw new UploadRejected(
      `MIME type ${MIME[kind]} does not match a permitted ${category} type.`,
    );
  }
  if (file.size > MAX_SIZE_MB[category] * 1024 * 1024) {
    throw new UploadRejected(`File exceeds ${MAX_SIZE_MB[category]}MB limit.`);
  }
  return {
    ext,
    contentType:
      kind === 'text' ? 'text/plain; charset=utf-8' : contentTypeFor(ext, kind),
  };
}

/** Content-Type for storage, by extension within the sniffed family. */
function contentTypeFor(ext: string, kind: Kind): string {
  const byExt: Record<string, string> = {
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    xls: 'application/vnd.ms-excel',
    ppt: 'application/vnd.ms-powerpoint',
    mov: 'video/quicktime',
    mkv: 'video/x-matroska',
    jpg: 'image/jpeg',
  };
  return byExt[ext] ?? MIME[kind];
}
