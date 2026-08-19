import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  hierarchyPath,
  hierarchyTrashPath,
  type HierarchyResponse,
  type HierarchyTrashResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createHierarchyDatabase, createHierarchyService } from '../src/hierarchy-service.js';

interface HierarchyFixture {
  materialIds: [string, string];
  chapterIds: [string, string, string];
  sectionIds: [string, string];
  cardIds: [string, string];
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

async function startServer(pool: Pool) {
  const server = createServer(createApp(new Date(), {
    hierarchyService: createHierarchyService({ database: createHierarchyDatabase(pool) }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: 'http://127.0.0.1:' + address.port };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function createFixture(pool: Pool): Promise<HierarchyFixture> {
  const runId = randomUUID();
  const fixture: HierarchyFixture = {
    materialIds: [randomUUID(), randomUUID()],
    chapterIds: [randomUUID(), randomUUID(), randomUUID()],
    sectionIds: [randomUUID(), randomUUID()],
    cardIds: [randomUUID(), randomUUID()],
  };
  const hash = createHash('sha256').update(runId).digest('hex');
  const content = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: 'PH3-04 ' + runId }] }]);

  await pool.execute(
    'INSERT INTO materials (id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    [
      fixture.materialIds[0], '层级验收资料一 ' + runId, 'hierarchy-one-' + runId + '.md', hash,
      fixture.materialIds[1], '层级验收资料二 ' + runId, 'hierarchy-two-' + runId + '.md', createHash('sha256').update(runId + '-2').digest('hex'),
    ],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 1), (?, ?, ?, 0)',
    [
      fixture.chapterIds[0], fixture.materialIds[0], '第一章',
      fixture.chapterIds[1], fixture.materialIds[0], '第二章',
      fixture.chapterIds[2], fixture.materialIds[1], '另一资料章节',
    ],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 1)',
    [fixture.sectionIds[0], fixture.chapterIds[0], '第一节', fixture.sectionIds[1], fixture.chapterIds[0], '第二节'],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)',
    [fixture.cardIds[0], fixture.sectionIds[0], '第一张', content, fixture.cardIds[1], fixture.sectionIds[0], '第二张', content],
  );
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: HierarchyFixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const materialPlaceholders = fixture.materialIds.map(() => '?').join(', ');
    const [chapterRows] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM chapters WHERE material_id IN (${materialPlaceholders})`,
      fixture.materialIds,
    );
    const chapterIds = chapterRows.map((row) => String(row.id));
    const chapterPlaceholders = chapterIds.map(() => '?').join(', ');
    const [sectionRows] = chapterIds.length
      ? await connection.execute<RowDataPacket[]>(`SELECT id FROM sections WHERE chapter_id IN (${chapterPlaceholders})`, chapterIds)
      : [[] as RowDataPacket[], []] as unknown as [RowDataPacket[], unknown];
    const sectionIds = sectionRows.map((row) => String(row.id));
    const sectionPlaceholders = sectionIds.map(() => '?').join(', ');
    const [cardRows] = sectionIds.length
      ? await connection.execute<RowDataPacket[]>(`SELECT id FROM cards WHERE section_id IN (${sectionPlaceholders})`, sectionIds)
      : [[] as RowDataPacket[], []] as unknown as [RowDataPacket[], unknown];
    const entityIds = [...fixture.materialIds, ...chapterIds, ...sectionIds, ...cardRows.map((row) => String(row.id))];
    if (entityIds.length) {
      await connection.execute(`DELETE FROM trash_items WHERE entity_id IN (${entityIds.map(() => '?').join(', ')})`, entityIds);
    }
    if (sectionIds.length) {
      await connection.execute(`DELETE FROM cards WHERE section_id IN (${sectionPlaceholders})`, sectionIds);
    }
    if (chapterIds.length) {
      await connection.execute(`DELETE FROM sections WHERE chapter_id IN (${chapterPlaceholders})`, chapterIds);
    }
    await connection.execute(`DELETE FROM chapters WHERE material_id IN (${materialPlaceholders})`, fixture.materialIds);
    await connection.execute(`DELETE FROM materials WHERE id IN (${materialPlaceholders})`, fixture.materialIds);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

test('PH3-04 层级维护通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  let fixture: HierarchyFixture | null = null;
  let server: Server | null = null;

  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool);
    server = started.server;

    const initial = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath);
    assert.equal(initial.response.status, 200);
    const firstMaterial = initial.body.materials.find((item) => item.id === fixture.materialIds[0]);
    assert.deepEqual(firstMaterial?.chapters.map((chapter) => chapter.id), [fixture.chapterIds[0], fixture.chapterIds[1]]);

    const created = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityType: 'chapter', parentId: fixture.materialIds[0], title: '新增章' }),
    });
    assert.equal(created.response.status, 201);
    const createdChapter = created.body.materials.find((item) => item.id === fixture!.materialIds[0])?.chapters.at(-1);
    assert.equal(createdChapter?.title, '新增章');
    assert.ok(createdChapter);

    const renamed = await requestJson<HierarchyResponse>(`${started.baseUrl}${hierarchyPath}/section/${fixture.sectionIds[0]}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '已改名节' }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.materials.find((item) => item.id === fixture!.materialIds[0])?.chapters[0]?.sections[0]?.title, '已改名节');

    const reordered = await requestJson<HierarchyResponse>(`${started.baseUrl}${hierarchyPath}/card/${fixture.cardIds[1]}/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
    });
    assert.equal(reordered.response.status, 200);
    assert.deepEqual(reordered.body.materials.find((item) => item.id === fixture!.materialIds[0])?.chapters[0]?.sections[0]?.cards.map((card) => card.id), [fixture.cardIds[1], fixture.cardIds[0]]);

    const moved = await requestJson<HierarchyResponse>(`${started.baseUrl}${hierarchyPath}/section/${fixture.sectionIds[0]}/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ parentId: fixture.chapterIds[1] }),
    });
    assert.equal(moved.response.status, 200);
    const movedSection = moved.body.materials.find((item) => item.id === fixture!.materialIds[0])?.chapters[1]?.sections[0];
    assert.equal(movedSection?.id, fixture.sectionIds[0]);
    assert.deepEqual(movedSection?.cards.map((card) => card.id), [fixture.cardIds[1], fixture.cardIds[0]]);

    const deleted = await requestJson<HierarchyResponse>(`${started.baseUrl}${hierarchyPath}/chapter/${fixture.chapterIds[1]}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.materials.find((item) => item.id === fixture!.materialIds[0])?.chapters.some((chapter) => chapter.id === fixture.chapterIds[1]), false);

    const trash = await requestJson<HierarchyTrashResponse>(started.baseUrl + hierarchyTrashPath);
    assert.equal(trash.response.status, 200);
    const deletedIds = new Set(trash.body.items.map((item) => item.entityId));
    assert.equal(deletedIds.has(fixture.chapterIds[1]), true);
    assert.equal(deletedIds.has(fixture.sectionIds[0]), true);
    assert.equal(deletedIds.has(fixture.cardIds[0]), true);
    assert.equal(deletedIds.has(fixture.cardIds[1]), true);
  } finally {
    try {
      if (server) {
        await stopServer(server);
      }
    } finally {
      try {
        if (fixture) {
          await cleanupFixture(pool, fixture);
        }
      } finally {
        await pool.end();
      }
    }
  }
});
