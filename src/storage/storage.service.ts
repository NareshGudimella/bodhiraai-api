import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger } from '@nestjs/common';
import { IntegrationSettingsService } from '../integrations/integration-settings.service';
import type { StorageConfig } from '../integrations/integrations';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileKeyOf, FILES_PREFIX, signFileKey } from './file-url';
import { strRandom, strSlug } from './laravel-str';
import { faststart, isFaststart } from './mp4-faststart';
import {
  checkUpload,
  type IncomingFile,
  type UploadCategory,
} from './upload-rules';

/**
 * S3 client for R2 from the Integrations → Storage settings (also used by the
 * files:make-private script). R2_ENDPOINT (test-only knob, env) overrides the
 * endpoint: tests use a local stub or MinIO.
 */
export function createR2Client(cfg: StorageConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint:
      process.env.R2_ENDPOINT ||
      `https://${cfg.account_id}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
    credentials: {
      accessKeyId: cfg.access_key_id ?? '',
      secretAccessKey: cfg.secret_access_key ?? '',
    },
  });
}

/** The public base URL that stored keys are appended to. */
export function publicBaseOf(
  driver: 'r2' | 'local',
  cfg: StorageConfig | null,
): string {
  const base =
    driver === 'r2'
      ? (cfg?.public_url ?? '')
      : `${process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4000}`}/uploads`;
  return base.replace(/\/$/, '');
}

export interface StoreOptions {
  /** security: not in legacy. Store in the private bucket and return `/files/<key>`. */
  private?: boolean;
}

/**
 * File storage for uploads (port of FileUploadService::store / storeCloud / delete).
 *
 * STORAGE_DRIVER=r2 (production): Cloudflare R2 through its S3-compatible API.
 *   not in legacy (2026-11-25): account id, keys, buckets and the public URL
 *   (the bucket's public domain, e.g. https://files.bodhira.ai) come from
 *   Integrations → Storage, read on every use; the S3 client is rebuilt when
 *   they change, so a save applies without a restart. R2_ENDPOINT (env, tests).
 * STORAGE_DRIVER=local (default for development): files under LOCAL_UPLOAD_DIR,
 *   served by this API at /uploads/*.
 *
 * Stored URLs are absolute, so the legacy app can render files uploaded here.
 *
 * Private files (invoices) never get a public URL: the private bucket in r2
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
  private s3: { key: string; client: S3Client } | null = null;

  constructor(private readonly settings: IntegrationSettingsService) {}

  /** STORAGE_DRIVER stays in the environment (deployment shape, and tests). */
  get driver(): 'r2' | 'local' {
    return process.env.STORAGE_DRIVER === 'r2' ? 'r2' : 'local';
  }

  /** R2 settings in effect (null with the local driver). */
  async r2Config(): Promise<StorageConfig | null> {
    return this.driver === 'r2' ? this.settings.get('storage') : null;
  }

  /** Public base URL that stored keys are appended to. */
  async publicBase(): Promise<string> {
    return publicBaseOf(this.driver, await this.r2Config());
  }

  static localDir() {
    return resolve(process.env.LOCAL_UPLOAD_DIR ?? 'storage/uploads');
  }

  static privateDir() {
    return resolve(process.env.LOCAL_PRIVATE_DIR ?? 'storage/private');
  }

  private privateBucket(cfg: StorageConfig) {
    // Never fall back to the public bucket: keys like invoice numbers are guessable.
    if (!cfg.private_bucket)
      throw new Error('The private R2 bucket is not configured');
    return cfg.private_bucket;
  }

  /** The S3 client for these settings; rebuilt when they change. */
  private client(cfg: StorageConfig): S3Client {
    const key = JSON.stringify([
      cfg.account_id,
      cfg.access_key_id,
      cfg.secret_access_key,
    ]);
    if (this.s3?.key !== key) {
      this.s3?.client.destroy();
      this.s3 = { key, client: createR2Client(cfg) };
    }
    return this.s3.client;
  }

  /** R2 settings and client, for an r2-mode operation. */
  private async r2() {
    const cfg = await this.settings.get('storage');
    return { cfg, s3: this.client(cfg) };
  }

  /**
   * not in legacy: the super admin's "Test" for storage: HeadBucket on each
   * configured bucket with the saved settings. Throws on the first failure.
   */
  async testBuckets(): Promise<string[]> {
    const { cfg, s3 } = await this.r2();
    const buckets = [cfg.bucket, cfg.private_bucket, cfg.legacy_bucket].filter(
      (b): b is string => !!b,
    );
    if (!buckets.length) throw new Error('No bucket is configured.');
    for (const Bucket of buckets) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
      } catch (e) {
        const name = (e as { name?: string }).name ?? 'Error';
        throw new Error(`Bucket ${Bucket}: ${name}`, { cause: e });
      }
    }
    return buckets;
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
      const { cfg, s3 } = await this.r2();
      await s3.send(
        new PutObjectCommand({
          Bucket: cfg.bucket ?? '',
          Key: key,
          Body: file.buffer,
          ContentType: contentType,
          CacheControl: 'public, max-age=31536000, immutable',
        }),
      );
      return `${publicBaseOf('r2', cfg)}/${key}`;
    }
    const path = join(StorageService.localDir(), key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.buffer);
    return `${publicBaseOf('local', null)}/${key}`;
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
    if (!url) return;
    const cfg = await this.r2Config();
    const base = publicBaseOf(this.driver, cfg);
    if (!base || !url.startsWith(`${base}/`)) return;
    const key = url.slice(base.length + 1);
    try {
      if (cfg) {
        await this.client(cfg).send(
          new DeleteObjectCommand({ Bucket: cfg.bucket ?? '', Key: key }),
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
        const { cfg, s3 } = await this.r2();
        await s3.send(
          new DeleteObjectCommand({
            Bucket: this.privateBucket(cfg),
            Key: key,
          }),
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
      const { cfg, s3 } = await this.r2();
      await s3.send(
        new PutObjectCommand({
          Bucket: this.privateBucket(cfg),
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

  /**
   * not in legacy: a time-limited link to a private object for an outside
   * service to fetch (VdoCipher's importUrl): presigned in r2 mode, else our
   * signed `/files/` link. Never stored or shown to users.
   */
  async presignPrivate(key: string, ttl: number): Promise<string> {
    if (this.driver === 'r2') {
      const { cfg, s3 } = await this.r2();
      return getSignedUrl(
        s3,
        new GetObjectCommand({ Bucket: this.privateBucket(cfg), Key: key }),
        { expiresIn: ttl },
      );
    }
    return signFileKey(key, { ttl });
  }

  /** A private file's bytes, or null when it doesn't exist. */
  async getPrivate(key: string): Promise<Buffer | null> {
    try {
      if (this.driver === 'r2') {
        const { cfg, s3 } = await this.r2();
        const res = await s3.send(
          new GetObjectCommand({ Bucket: this.privateBucket(cfg), Key: key }),
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
