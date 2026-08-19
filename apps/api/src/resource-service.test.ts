import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ResourceApiError, ResourceServiceImpl, type ResourceSqlExecutor } from './resource-service.js';

class FakeResourceDatabase implements ResourceSqlExecutor {
  constructor(private readonly row: Record<string, unknown> | null) {}

  async execute() {
    return [this.row ? [this.row] : [], []] as [unknown, unknown];
  }
}

test('资源服务仅返回资源目录内存在的文件', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-resource-'));
  const resourcePath = path.join(root, 'material-1', 'images', 'diagram.png');
  await fs.mkdir(path.dirname(resourcePath), { recursive: true });
  await fs.writeFile(resourcePath, 'image-bytes');
  const service = new ResourceServiceImpl(
    new FakeResourceDatabase({ relative_path: 'material-1/images/diagram.png', mime_type: 'image/png' }),
    root,
  );

  try {
    const resource = await service.get('resource-1');
    assert.equal(resource.absolutePath, resourcePath);
    assert.equal(resource.mimeType, 'image/png');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('资源服务拒绝穿越资源目录的数据库路径', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-resource-'));
  const service = new ResourceServiceImpl(
    new FakeResourceDatabase({ relative_path: '../outside.png', mime_type: 'image/png' }),
    root,
  );

  try {
    await assert.rejects(
      service.get('resource-1'),
      (error: unknown) => error instanceof ResourceApiError && error.statusCode === 404,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('可视化编辑上传会校验图片格式并写入受管资源目录', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-resource-'));
  const service = new ResourceServiceImpl(new FakeResourceDatabase(null), root);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  try {
    const resource = await service.upload(png, 'image/png');
    assert.match(resource.id, /^[\da-f-]{36}$/);
    assert.equal(resource.mimeType, 'image/png');
    const stored = await fs.readFile(path.join(root, 'editor', `${resource.id}.png`));
    assert.deepEqual(stored, png);
    await assert.rejects(
      service.upload(Buffer.from('not an image'), 'image/png'),
      (error: unknown) => error instanceof ResourceApiError && error.statusCode === 400,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
