import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import test from 'node:test';
import {
  dataBackupsPath,
  hierarchyPath,
  hierarchyTrashPath,
  hierarchyTrashPermanentPath,
  type DataBackupsResponse,
  type DataJsonExport,
  type HierarchyTrashResponse,
} from '@knowledge-flashcards/shared';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createDataGovernanceDatabase, createDataGovernanceService } from '../src/data-governance-service.js';
import { createHierarchyDatabase, createHierarchyService } from '../src/hierarchy-service.js';

interface Fixture {
  courseId: string;
  subjectId: string;
  materialId: string;
  chapterId: string;
  sectionId: string;
  cardId: string;
  resourceId: string;
  resourcePath: string;
  originalCoverResourceId: string;
  originalCoverPath: string;
  thumbnailCoverResourceId: string;
  thumbnailCoverPath: string;
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

async function startServer(pool: Pool, backupsDirectory: string) {
  const dataGovernanceService = createDataGovernanceService({
    database: createDataGovernanceDatabase(pool),
    backupsDirectory,
  });
  const server = createServer(createApp(new Date(), {
    dataGovernanceService,
    hierarchyService: createHierarchyService({ database: createHierarchyDatabase(pool) }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: 'http://127.0.0.1:' + address.port };
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const runId = randomUUID();
  const fixture: Fixture = {
    courseId: randomUUID(),
    subjectId: randomUUID(),
    materialId: randomUUID(),
    chapterId: randomUUID(),
    sectionId: randomUUID(),
    cardId: randomUUID(),
    resourceId: randomUUID(),
    resourcePath: 'ph4-04/' + runId + '.bin',
    originalCoverResourceId: randomUUID(),
    originalCoverPath: 'ph5-07/' + runId + '-original.png',
    thumbnailCoverResourceId: randomUUID(),
    thumbnailCoverPath: 'ph5-07/' + runId + '-thumbnail.webp',
  };
  const source = Buffer.from('PH4-04 ' + runId);
  const originalCover = Buffer.from('PH5-07 original ' + runId);
  const thumbnailCover = Buffer.from('PH5-07 thumbnail ' + runId);
  const resourceFile = config.storage.resources + '\\' + fixture.resourcePath.replaceAll('/', '\\');
  const originalCoverFile = config.storage.resources + '\\' + fixture.originalCoverPath.replaceAll('/', '\\');
  const thumbnailCoverFile = config.storage.resources + '\\' + fixture.thumbnailCoverPath.replaceAll('/', '\\');
  await fs.mkdir(config.storage.resources + '\\ph4-04', { recursive: true });
  await fs.mkdir(config.storage.resources + '\\ph5-07', { recursive: true });
  await fs.writeFile(resourceFile, source);
  await fs.writeFile(originalCoverFile, originalCover);
  await fs.writeFile(thumbnailCoverFile, thumbnailCover);
  await pool.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, ?)', [fixture.courseId, '备份课程 ' + runId, 1000000]);
  await pool.execute('INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, ?)', [fixture.subjectId, fixture.courseId, '备份科目 ' + runId, 1000000]);
  await pool.execute(
    'INSERT INTO materials (id, subject_id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?, ?)',
    [fixture.materialId, fixture.subjectId, 'PH4-04 ' + runId, runId + '.md', createHash('sha256').update(runId).digest('hex')],
  );
  await pool.execute('INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)', [fixture.chapterId, fixture.materialId, '备份章']);
  await pool.execute('INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0)', [fixture.sectionId, fixture.chapterId, '备份节']);
  await pool.execute(
    'INSERT INTO resources (id, relative_path, mime_type, sha256) VALUES (?, ?, ?, ?), (?, ?, ?, ?), (?, ?, ?, ?)',
    [
      fixture.resourceId, fixture.resourcePath, 'application/octet-stream', createHash('sha256').update(source).digest('hex'),
      fixture.originalCoverResourceId, fixture.originalCoverPath, 'image/png', createHash('sha256').update(originalCover).digest('hex'),
      fixture.thumbnailCoverResourceId, fixture.thumbnailCoverPath, 'image/webp', createHash('sha256').update(thumbnailCover).digest('hex'),
    ],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0)',
    [fixture.cardId, fixture.sectionId, '备份卡', JSON.stringify([{ type: 'image', resourceId: fixture.resourceId }])],
  );
  await pool.execute('INSERT INTO material_covers (id, material_id, original_resource_id, thumbnail_resource_id) VALUES (?, ?, ?, ?)', [randomUUID(), fixture.materialId, fixture.originalCoverResourceId, fixture.thumbnailCoverResourceId]);
  await pool.execute("INSERT INTO review_status_history (id, card_id, from_status, to_status, source) VALUES (?, ?, NULL, 'unassessed', 'import')", [randomUUID(), fixture.cardId]);
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: Fixture, backupsDirectory: string, backupId: string | null) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [trashRows] = await connection.execute<RowDataPacket[]>('SELECT id FROM trash_items WHERE entity_id IN (?, ?, ?, ?)', [fixture.materialId, fixture.chapterId, fixture.sectionId, fixture.cardId]);
    if (trashRows.length) {
      await connection.execute('DELETE FROM trash_items WHERE id IN (' + trashRows.map(() => '?').join(', ') + ')', trashRows.map((row) => String(row.id)));
    }
    await connection.execute('DELETE FROM review_status_history WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM cards WHERE id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM sections WHERE id = ?', [fixture.sectionId]);
    await connection.execute('DELETE FROM chapters WHERE id = ?', [fixture.chapterId]);
    await connection.execute('DELETE FROM material_covers WHERE material_id = ?', [fixture.materialId]);
    await connection.execute('DELETE FROM materials WHERE id = ?', [fixture.materialId]);
    await connection.execute('DELETE FROM resources WHERE id IN (?, ?, ?)', [fixture.resourceId, fixture.originalCoverResourceId, fixture.thumbnailCoverResourceId]);
    await connection.execute('DELETE FROM subjects WHERE id = ?', [fixture.subjectId]);
    await connection.execute('DELETE FROM courses WHERE id = ?', [fixture.courseId]);
    if (backupId) {
      await connection.execute('DELETE FROM backup_records WHERE id = ?', [backupId]);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
  await fs.rm(config.storage.resources + '\\' + fixture.resourcePath.replaceAll('/', '\\'), { force: true });
  await fs.rm(config.storage.resources + '\\' + fixture.originalCoverPath.replaceAll('/', '\\'), { force: true });
  await fs.rm(config.storage.resources + '\\' + fixture.thumbnailCoverPath.replaceAll('/', '\\'), { force: true });
  await fs.rm(backupsDirectory, { recursive: true, force: true });
}

test('PH4-04 备份和回收站永久删除通过真实 MySQL 与 HTTP 验收', { timeout: 120_000 }, async () => {
  const pool = createDatabasePool();
  const backupsDirectory = config.storage.backups + '\\ph4-04-' + randomUUID();
  let fixture: Fixture | null = null;
  let server: Server | null = null;
  let backupId: string | null = null;
  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool, backupsDirectory);
    server = started.server;

    const backup = await requestJson<{ backup: { id: string; status: string; fileManifest: Array<{ path: string }> } }>(started.baseUrl + dataBackupsPath, { method: 'POST' });
    assert.equal(backup.response.status, 201);
    assert.equal(backup.body.backup.status, 'succeeded');
    const manifestPaths = backup.body.backup.fileManifest.map((item) => item.path);
    assert.equal(manifestPaths.includes('resources/' + fixture.resourcePath), true);
    assert.equal(manifestPaths.includes('resources/' + fixture.originalCoverPath), true);
    assert.equal(manifestPaths.includes('resources/' + fixture.thumbnailCoverPath), true);
    backupId = backup.body.backup.id;
    const backupPayload = JSON.parse(await fs.readFile(backupsDirectory + '\\' + backupId + '\\data.json', 'utf8')) as DataJsonExport;
    assert.equal(backupPayload.materials.find((item) => item.id === fixture!.materialId)?.subjectId, fixture.subjectId);
    assert.equal(backupPayload.courses?.some((item) => item.id === fixture!.courseId), true);
    assert.equal(backupPayload.subjects?.some((item) => item.id === fixture!.subjectId && item.sortOrder === 1000000), true);
    assert.equal(backupPayload.materialCovers?.some((item) => item.materialId === fixture!.materialId && item.originalResourceId === fixture!.originalCoverResourceId && item.thumbnailResourceId === fixture!.thumbnailCoverResourceId), true);
    assert.equal(backupPayload.reviewStatusHistory?.some((item) => item.cardId === fixture!.cardId && item.source === 'import'), true);

    const listed = await requestJson<DataBackupsResponse>(started.baseUrl + dataBackupsPath);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.backups.some((item) => item.id === backupId), true);

    const deleted = await fetch(started.baseUrl + hierarchyPath + '/card/' + fixture.cardId, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const trash = await requestJson<HierarchyTrashResponse>(started.baseUrl + hierarchyTrashPath);
    const item = trash.body.items.find((candidate) => candidate.entityId === fixture!.cardId);
    assert.ok(item);

    const permanentlyDeleted = await requestJson<{ deletedEntityCount: number; deletedResourceCount: number }>(
      started.baseUrl + hierarchyTrashPermanentPath + '/' + item.id + '/permanent',
      { method: 'DELETE' },
    );
    assert.equal(permanentlyDeleted.response.status, 200);
    assert.deepEqual(permanentlyDeleted.body, { deletedEntityCount: 1, deletedResourceCount: 1 });
    const [cardRows] = await pool.execute<RowDataPacket[]>('SELECT id FROM cards WHERE id = ?', [fixture.cardId]);
    assert.equal(cardRows.length, 0);
    const resourceFile = config.storage.resources + '\\' + fixture.resourcePath.replaceAll('/', '\\');
    assert.equal(await fs.access(resourceFile).then(() => true, () => false), false);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    if (fixture) {
      await cleanupFixture(pool, fixture, backupsDirectory, backupId);
    } else {
      await fs.rm(backupsDirectory, { recursive: true, force: true });
    }
    await pool.end();
  }
});
