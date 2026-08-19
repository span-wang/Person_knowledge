import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { verifyStoragePaths, type StoragePaths } from './storage.js';

test('存储路径检查会创建并验证三类目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-'));
  const storagePaths: StoragePaths = {
    data: path.join(root, 'data'),
    resources: path.join(root, 'resources'),
    backups: path.join(root, 'backups'),
  };

  try {
    const results = await verifyStoragePaths(storagePaths);

    assert.deepEqual(
      results.map((result) => result.kind),
      ['data', 'resources', 'backups'],
    );
    for (const result of results) {
      const stats = await fs.stat(result.path);
      assert.equal(stats.isDirectory(), true);
      assert.equal(result.readable, true);
      assert.equal(result.writable, true);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
