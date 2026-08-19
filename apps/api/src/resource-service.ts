import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { config } from './config.js';
import { createDatabasePool } from './database.js';

export interface ResourceSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface ResourceFile {
  absolutePath: string;
  mimeType: string;
}

export interface ResourceService {
  get(resourceId: string): Promise<ResourceFile>;
  upload(source: Buffer, declaredMimeType: string | undefined): Promise<{ id: string; mimeType: string }>;
}

export class ResourceApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ResourceApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function isPathInside(parent: string, target: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

const maxEditorImageBytes = 5 * 1024 * 1024;

function imageMimeType(source: Buffer): { mimeType: string; extension: string } | null {
  if (source.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (source.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (source.subarray(0, 6).equals(Buffer.from('GIF87a')) || source.subarray(0, 6).equals(Buffer.from('GIF89a'))) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (source.subarray(0, 4).equals(Buffer.from('RIFF')) && source.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

export class ResourceServiceImpl implements ResourceService {
  constructor(
    private readonly database: ResourceSqlExecutor,
    private readonly resourcesDirectory = config.storage.resources,
  ) {}

  async get(resourceId: string): Promise<ResourceFile> {
    const normalizedId = resourceId.trim();
    if (!normalizedId) {
      throw new ResourceApiError(400, '资源 ID 无效。');
    }
    const [rows] = await this.database.execute(
      'SELECT relative_path, mime_type FROM resources WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [normalizedId],
    );
    const row = rowsFrom(rows)[0];
    const relativePath = typeof row?.relative_path === 'string' ? row.relative_path : null;
    const mimeType = typeof row?.mime_type === 'string' ? row.mime_type : null;
    if (!relativePath || !mimeType) {
      throw new ResourceApiError(404, '资源不存在或已删除。');
    }
    const absolutePath = path.resolve(this.resourcesDirectory, relativePath);
    if (!isPathInside(this.resourcesDirectory, absolutePath)) {
      throw new ResourceApiError(404, '资源不存在或已删除。');
    }
    try {
      const stat = await fs.stat(absolutePath);
      if (!stat.isFile()) {
        throw new Error('resource is not a file');
      }
    } catch {
      throw new ResourceApiError(404, '资源文件不可用。');
    }
    return { absolutePath, mimeType };
  }

  async upload(source: Buffer, declaredMimeType: string | undefined) {
    if (!Buffer.isBuffer(source) || source.length === 0 || source.length > maxEditorImageBytes) {
      throw new ResourceApiError(400, '图片需为 5MB 以内的有效文件。');
    }
    const detected = imageMimeType(source);
    const normalizedDeclaredMimeType = declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase();
    if (!detected || (normalizedDeclaredMimeType && normalizedDeclaredMimeType !== detected.mimeType)) {
      throw new ResourceApiError(400, '图片格式无效。');
    }

    const id = randomUUID();
    const relativePath = `editor/${id}.${detected.extension}`;
    const absolutePath = path.resolve(this.resourcesDirectory, relativePath);
    if (!isPathInside(this.resourcesDirectory, absolutePath)) {
      throw new ResourceApiError(400, '图片保存路径无效。');
    }
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, source, { flag: 'wx' });
    try {
      await this.database.execute(
        'INSERT INTO resources (id, relative_path, mime_type, sha256) VALUES (?, ?, ?, ?)',
        [id, relativePath, detected.mimeType, createHash('sha256').update(source).digest('hex')],
      );
      return { id, mimeType: detected.mimeType };
    } catch (error) {
      await fs.rm(absolutePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

export function createResourceService(
  database?: ResourceSqlExecutor,
): ResourceService {
  const pool = database ? null : createDatabasePool();
  return new ResourceServiceImpl(
    database ?? {
      execute: (sql: string, values?: readonly unknown[]) =>
        pool!.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
    },
  );
}
