import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type StorageKind = 'data' | 'resources' | 'backups';

export interface StoragePaths {
  data: string;
  resources: string;
  backups: string;
}

export interface StorageCheckResult {
  kind: StorageKind;
  path: string;
  readable: true;
  writable: true;
}

const storageKinds: StorageKind[] = ['data', 'resources', 'backups'];

export async function verifyStoragePaths(paths: StoragePaths = config.storage): Promise<StorageCheckResult[]> {
  const results: StorageCheckResult[] = [];

  for (const kind of storageKinds) {
    const directory = paths[kind];
    await fs.mkdir(directory, { recursive: true });

    const probePath = path.join(directory, `.write-check-${randomUUID()}`);
    try {
      await fs.writeFile(probePath, 'ok', 'utf8');
      await fs.readFile(probePath, 'utf8');
      results.push({ kind, path: directory, readable: true, writable: true });
    } finally {
      await fs.rm(probePath, { force: true });
    }
  }

  return results;
}
