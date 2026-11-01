import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileKeyOf, FILES_PREFIX } from './file-url';
import { strRandom, strSlug } from './laravel-str';
import { faststart, isFaststart } from './mp4-faststart';
import {
  checkUpload,
  type IncomingFile,
  type UploadCategory,
} from './upload-rules';

/** S3 client for R2 from the R2_* variables (also used by the files:make-private script). */
export function createR2Client(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint:
      process.env.R2_ENDPOINT ||
      `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    },
  });
}

export interface StoreOptions {
  /** security: not in legacy. Store in the private bucket and return `/files/<key>`. */
  private?: boolean;
}

/**
 * File storage for uploads (port of FileUploadService::store / storeCloud / delete).
 *
 * STORAGE_DRIVER=r2 (production): Cloudflare R2 through its S3-compatible API.
 *   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, and
 *   R2_PUBLIC_URL (the bucket's public domain, e.g. https://files.bodhira.ai).
 *   R2_ENDPOINT overrides the endpoint (tests use a local MinIO).
 * STORAGE_DRIVER=local (default for development): files under LOCAL_UPLOAD_DIR,
 *   served by this API at /uploads/*.
 *
 * Stored URLs are absolute, so the legacy app can render files uploaded here.
 *
 * Private files (invoices) never get a public URL: R2_PRIVATE_BUCKET in r2
 * mode, LOCAL_PRIVATE_DIR (not served) locally. Read them back with getPrivate().
 *
 * security: not in legacy. Uploads for private columns (avatars, school logos,
 * lesson files and thumbnails, assignment attachments and submissions) pass
 * `{ private: true }`: the bytes go to the private bucket under the same key
 * layout and the call returns `/files/<key>`, which responses sign
 * (file-url.ts). Invoices share the bucket but are never signable.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3: S3Client | null = null;

  get driver(): 'r2' | 'local' {
    return process.env.STORAGE_DRIVER === 'r2' ? 'r2' : 'local';
  }

  /** Public base URL that stored keys are appended to. */
  get publicBase(): string {
    const base =
      this.driver === 'r2'
        ? (process.env.R2_PUBLIC_URL ?? '')
        : `${process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`}/uploads`;
    return base.replace(/\/$/, '');
  }

  static localDir() {
    return resolve(process.env.LOCAL_UPLOAD_DIR ?? 'storage/uploads');
  }

  static privateDir() {
    return resolve(process.env.LOCAL_PRIVATE_DIR ?? 'storage/private');
  }

  private privateBucket() {
    const bucket = process.env.R2_PRIVATE_BUCKET;
    // Never fall back to the public bucket: keys like invoice numbers are guessable.
    if (!bucket) throw new Error('R2_PRIVATE_BUCKET is not set');
    return bucket;
  }

  private client(): S3Client {
    this.s3 ??= createR2Client();
    return this.s3;
  }

  /** `<slug>-<8 random>.<ext>` from the client file name (legacy naming). */
  private fileName(file: IncomingFile, ext: string) {
    const base = file.originalname.replace(/\.[^.]*$/, '');
    return `${strSlug(base) || 'file'}-${strRandom(8)}.${ext}`;
  }

  private async put(
    key: string,
    file: IncomingFile,
    contentType: string,
    opts: StoreOptions = {},
  ) {
    if (opts.private) {
      await this.putPrivate(key, file.buffer, contentType);
      return `${FILES_PREFIX}${key}`;
    }
    if (this.driver === 'r2') {
      await this.client().send(
        new PutObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: key,
          Body: file.buffer,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
    } else {
      const path = join(StorageService.localDir(), key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.buffer);
    }
    return `${this.publicBase}/${key}`;
  }

  /** FileUploadService::store: validated upload under `<folder>/`. Returns the public URL. */
  async store(
    file: IncomingFile,
    category: UploadCategory,
    folder: string,
    opts: StoreOptions = {},
  ) {
    const { ext, contentType } = checkUpload(file, category);
    // Post-process MP4s so browsers can start playback immediately.
    if (category === 'video' && ext === 'mp4' && !isFaststart(file.buffer)) {
      try {
        file = { ...file, buffer: faststart(file.buffer) };
      } catch (e) {
        // Don't fail the upload over post-processing (legacy logs a warning too).
        this.logger.warn(`Mp4Faststart failed: ${String(e)}`);
      }
    }
    return this.put(
      `${folder.replace(/^\/|\/$/g, '')}/${this.fileName(file, ext)}`,
      file,
      contentType,
      opts,
    );
  }

  /** Storage::disk('public')->put($path, $bytes) for already-validated bytes. Returns the public URL. */
  async putBytes(
    key: string,
    bytes: Buffer,
    contentType: string,
    opts: StoreOptions = {},
  ) {
    return this.put(
      key,
      { buffer: bytes, size: bytes.length, originalname: key },
      contentType,
      opts,
    );
  }

  /** FileUploadService::storeCloud: date-bucketed `cloud/YYYY/MM/DD/` (avatars, images). */
  async storeCloud(
    file: IncomingFile,
    category: UploadCategory = 'image',
    opts: StoreOptions = {},
  ) {
    const { ext, contentType } = checkUpload(file, category);
    const day = new Date().toISOString().slice(0, 10).replace(/-/g, '/');
    return this.put(
      `cloud/${day}/${this.fileName(file, ext)}`,
      file,
      contentType,
      opts,
    );
  }

  /**
   * Delete a file this service stored. URLs elsewhere (legacy `/cloud/…` or
   * `/media/…` files on the old server) are left alone; the legacy app owns them.
   * security: not in legacy: `/files/<key>` values delete from the private bucket
   * (never an invoice: fileKeyOf refuses forbidden keys).
   */
  async delete(url: string | null | undefined) {
    const privateKey = fileKeyOf(url);
    if (privateKey !== null) return this.deletePrivate(privateKey);
    if (!url || !this.publicBase || !url.startsWith(`${this.publicBase}/`))
      return;
    const key = url.slice(this.publicBase.length + 1);
    try {
      if (this.driver === 'r2') {
        await this.client().send(
          new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }),
        );
      } else {
        await unlink(join(StorageService.localDir(), key));
      }
    } catch (e) {
      this.logger.warn(`Could not delete ${key}: ${String(e)}`);
    }
  }

  /** Remove a private object (best-effort, logged like delete()). */
  async deletePrivate(key: string) {
    try {
      if (this.driver === 'r2') {
        await this.client().send(
          new DeleteObjectCommand({ Bucket: this.privateBucket(), Key: key }),
        );
      } else {
        const path = StorageService.privatePath(key);
        if (path) await unlink(path);
      }
    } catch (e) {
      this.logger.warn(`Could not delete private ${key}: ${String(e)}`);
    }
  }

  /** Absolute path of a private key inside LOCAL_PRIVATE_DIR, or null when it escapes it. */
  static privatePath(key: string): string | null {
    const root = StorageService.privateDir();
    const path = resolve(root, key);
    return path.startsWith(`${root}${sep}`) ? path : null;
  }

  /** Store bytes at `key` without a public URL (Storage::disk('public')->put for files only the API serves). */
  async putPrivate(key: string, bytes: Buffer, contentType: string) {
    if (this.driver === 'r2') {
      await this.client().send(
        new PutObjectCommand({
          Bucket: this.privateBucket(),
          Key: key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
      return;
    }
    const path = join(StorageService.privateDir(), key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
  }

  /** A private file's bytes, or null when it doesn't exist. */
  async getPrivate(key: string): Promise<Buffer | null> {
    try {
      if (this.driver === 'r2') {
        const res = await this.client().send(
          new GetObjectCommand({ Bucket: this.privateBucket(), Key: key }),
        );
        return res.Body
          ? Buffer.from(await res.Body.transformToByteArray())
          : null;
      }
      const root = StorageService.privateDir();
      const path = resolve(root, key);
      if (!path.startsWith(`${root}/`)) return null;
      return await readFile(path);
    } catch (e) {
      const code = (e as { name?: string; code?: string }).name ?? '';
      if (code === 'NoSuchKey' || (e as { code?: string }).code === 'ENOENT')
        return null;
      throw e;
    }
  }
}
