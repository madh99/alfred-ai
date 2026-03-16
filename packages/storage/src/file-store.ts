/**
 * File Storage Abstraction — stores user files on local disk, shared NFS, or S3/MinIO.
 * Used for inbox attachments, document uploads, exports, etc.
 */
import fs from 'node:fs';
import path from 'node:path';

export interface StoredFile {
  key: string;        // unique identifier (path or S3 key)
  fileName: string;
  userId: string;
  size: number;
  createdAt: string;
}

export interface FileStoreConfig {
  backend: 'local' | 'nfs' | 's3';
  // Local / NFS:
  basePath?: string;   // default: ./data/files
  // S3 / MinIO:
  s3Endpoint?: string;
  s3Bucket?: string;
  s3Region?: string;
  s3AccessKey?: string;
  s3SecretKey?: string;
}

export interface FileStore {
  readonly backend: string;
  save(userId: string, fileName: string, data: Buffer): Promise<StoredFile>;
  read(key: string): Promise<Buffer>;
  list(userId: string): Promise<StoredFile[]>;
  delete(key: string): Promise<boolean>;
  exists(key: string): Promise<boolean>;
}

// ── Local / NFS File Store ──────────────────────────────────

export class LocalFileStore implements FileStore {
  readonly backend: string;
  private readonly basePath: string;

  constructor(config: FileStoreConfig) {
    this.backend = config.backend === 'nfs' ? 'nfs' : 'local';
    this.basePath = config.basePath ?? path.resolve('./data/files');
    fs.mkdirSync(this.basePath, { recursive: true });
  }

  async save(userId: string, fileName: string, data: Buffer): Promise<StoredFile> {
    const userDir = path.join(this.basePath, this.sanitize(userId));
    fs.mkdirSync(userDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = this.sanitize(fileName);
    const uniqueName = `${timestamp}_${safeName}`;
    const filePath = path.join(userDir, uniqueName);

    fs.writeFileSync(filePath, data);
    const key = path.relative(this.basePath, filePath).replace(/\\/g, '/');

    return { key, fileName, userId, size: data.length, createdAt: new Date().toISOString() };
  }

  async read(key: string): Promise<Buffer> {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(path.resolve(this.basePath))) {
      throw new Error('Path traversal attempt blocked');
    }
    return fs.readFileSync(filePath);
  }

  async list(userId: string): Promise<StoredFile[]> {
    const userDir = path.join(this.basePath, this.sanitize(userId));
    if (!fs.existsSync(userDir)) return [];

    const files = fs.readdirSync(userDir);
    return files.map(f => {
      const filePath = path.join(userDir, f);
      const stat = fs.statSync(filePath);
      return {
        key: `${this.sanitize(userId)}/${f}`,
        fileName: f.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, ''),
        userId,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      };
    });
  }

  async delete(key: string): Promise<boolean> {
    const filePath = path.resolve(this.basePath, key);
    if (!filePath.startsWith(path.resolve(this.basePath))) return false;
    try { fs.unlinkSync(filePath); return true; } catch { return false; }
  }

  async exists(key: string): Promise<boolean> {
    const filePath = path.resolve(this.basePath, key);
    return filePath.startsWith(path.resolve(this.basePath)) && fs.existsSync(filePath);
  }

  private sanitize(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100);
  }
}

// ── S3 / MinIO File Store ───────────────────────────────────

export class S3FileStore implements FileStore {
  readonly backend = 's3';
  private client: any;
  private readonly bucket: string;
  private readonly endpoint?: string;

  constructor(private readonly config: FileStoreConfig) {
    this.bucket = config.s3Bucket ?? 'alfred-files';
    this.endpoint = config.s3Endpoint;
  }

  private async getClient(): Promise<any> {
    if (this.client) return this.client;
    // Dynamic import to keep S3 SDK optional
    const { S3Client } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    this.client = new S3Client({
      region: this.config.s3Region ?? 'us-east-1',
      endpoint: this.endpoint,
      forcePathStyle: !!this.endpoint, // MinIO requires path-style
      credentials: this.config.s3AccessKey ? {
        accessKeyId: this.config.s3AccessKey,
        secretAccessKey: this.config.s3SecretKey ?? '',
      } : undefined,
    });
    return this.client;
  }

  async save(userId: string, fileName: string, data: Buffer): Promise<StoredFile> {
    const client = await this.getClient();
    const { PutObjectCommand } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${userId}/${timestamp}_${fileName}`;

    await client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: data,
      ContentType: 'application/octet-stream',
    }));

    return { key, fileName, userId, size: data.length, createdAt: new Date().toISOString() };
  }

  async read(key: string): Promise<Buffer> {
    const client = await this.getClient();
    const { GetObjectCommand } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    const response = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const chunks: Buffer[] = [];
    for await (const chunk of response.Body) { chunks.push(chunk); }
    return Buffer.concat(chunks);
  }

  async list(userId: string): Promise<StoredFile[]> {
    const client = await this.getClient();
    const { ListObjectsV2Command } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    const response = await client.send(new ListObjectsV2Command({
      Bucket: this.bucket,
      Prefix: `${userId}/`,
    }));

    return (response.Contents ?? []).map((obj: any) => ({
      key: obj.Key,
      fileName: obj.Key.split('/').pop()?.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+_/, '') ?? obj.Key,
      userId,
      size: obj.Size ?? 0,
      createdAt: obj.LastModified?.toISOString() ?? new Date().toISOString(),
    }));
  }

  async delete(key: string): Promise<boolean> {
    const client = await this.getClient();
    const { DeleteObjectCommand } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    try {
      await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch { return false; }
  }

  async exists(key: string): Promise<boolean> {
    const client = await this.getClient();
    const { HeadObjectCommand } = await (Function('return import("@aws-sdk/client-s3")')() as Promise<any>);
    try {
      await client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch { return false; }
  }
}

// ── Factory ─────────────────────────────────────────────────

export function createFileStore(config: FileStoreConfig): FileStore {
  switch (config.backend) {
    case 's3':
      return new S3FileStore(config);
    case 'nfs':
    case 'local':
    default:
      return new LocalFileStore(config);
  }
}
