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
  reviewCardPath,
  reviewCardsPath,
  type HierarchyResponse,
  type HierarchyTrashResponse,
  type ReviewCardContentUpdateResponse,
  type ReviewCardResponse,
  type ReviewCardsResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createHierarchyDatabase, createHierarchyService } from '../src/hierarchy-service.js';
import { createReviewDatabase, createReviewService, type ReviewService } from '../src/review-service.js';

interface M3Fixture {
  materialIds: [string, string];
  chapterIds: [string, string, string];
  sectionIds: [string, string];
  cardIds: [string, string];
  keyword: string;
}

async function startServer(pool: Pool) {
  const reviewService: ReviewService = createReviewService({ database: createReviewDatabase(pool) });
  const server = createServer(createApp(new Date(), {
    reviewService,
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

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  const body = response.status === 204 ? null : await response.json() as T;
  return { response, body };
}

async function createFixture(pool: Pool): Promise<M3Fixture> {
  const runId = randomUUID();
  const fixture: M3Fixture = {
    materialIds: [randomUUID(), randomUUID()],
    chapterIds: [randomUUID(), randomUUID(), randomUUID()],
    sectionIds: [randomUUID(), randomUUID()],
    cardIds: [randomUUID(), randomUUID()],
    keyword: 'M3组合回归-' + runId,
  };
  const sourceHash = createHash('sha256').update(runId).digest('hex');
  const content = JSON.stringify([
    { type: 'paragraph', children: [{ type: 'text', value: '重点正文 ' + fixture.keyword }] },
    {
      type: 'table',
      children: [
        { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: '表格重点' }] }] },
        { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: '表格普通' }] }] },
      ],
    },
    { type: 'math', value: 'E=mc^2', display: true },
  ]);
  const plainContent = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: fixture.keyword }] }]);

  await pool.execute(
    'INSERT INTO materials (id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?), (?, ?, ?, ?)',
    [
      fixture.materialIds[0], 'M3回归资料一 ' + runId, 'm3-one-' + runId + '.md', sourceHash,
      fixture.materialIds[1], 'M3回归资料二 ' + runId, 'm3-two-' + runId + '.md', createHash('sha256').update(runId + '-2').digest('hex'),
    ],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 1), (?, ?, ?, 0)',
    [
      fixture.chapterIds[0], fixture.materialIds[0], '第一章',
      fixture.chapterIds[1], fixture.materialIds[0], '第二章',
      fixture.chapterIds[2], fixture.materialIds[1], '另一资料章',
    ],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 0)',
    [fixture.sectionIds[0], fixture.chapterIds[0], '第一节', fixture.sectionIds[1], fixture.chapterIds[1], '第二节'],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)',
    [fixture.cardIds[0], fixture.sectionIds[0], '富内容卡', content, fixture.cardIds[1], fixture.sectionIds[0], '普通卡', plainContent],
  );
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: M3Fixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const materialPlaceholders = fixture.materialIds.map(() => '?').join(', ');
    const [chapters] = await connection.execute<RowDataPacket[]>(
      `SELECT id FROM chapters WHERE material_id IN (${materialPlaceholders})`,
      fixture.materialIds,
    );
    const chapterIds = chapters.map((row) => String(row.id));
    const chapterPlaceholders = chapterIds.map(() => '?').join(', ');
    const [sections] = chapterIds.length
      ? await connection.execute<RowDataPacket[]>(`SELECT id FROM sections WHERE chapter_id IN (${chapterPlaceholders})`, chapterIds)
      : [[] as RowDataPacket[], []] as unknown as [RowDataPacket[], unknown];
    const sectionIds = sections.map((row) => String(row.id));
    const sectionPlaceholders = sectionIds.map(() => '?').join(', ');
    const [cards] = sectionIds.length
      ? await connection.execute<RowDataPacket[]>(`SELECT id FROM cards WHERE section_id IN (${sectionPlaceholders})`, sectionIds)
      : [[] as RowDataPacket[], []] as unknown as [RowDataPacket[], unknown];
    const cardIds = cards.map((row) => String(row.id));
    const entityIds = [...fixture.materialIds, ...chapterIds, ...sectionIds, ...cardIds];
    if (entityIds.length) {
      const entityPlaceholders = entityIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM trash_items WHERE entity_id IN (${entityPlaceholders})`, entityIds);
    }
    if (cardIds.length) {
      const cardPlaceholders = cardIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM highlights WHERE card_id IN (${cardPlaceholders})`, cardIds);
      await connection.execute(`DELETE FROM review_records WHERE card_id IN (${cardPlaceholders})`, cardIds);
      await connection.execute(`DELETE FROM sync_locks WHERE card_id IN (${cardPlaceholders})`, cardIds);
      await connection.execute(`DELETE FROM cards WHERE id IN (${cardPlaceholders})`, cardIds);
    }
    if (sectionIds.length) {
      const sectionPlaceholders = sectionIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM sections WHERE id IN (${sectionPlaceholders})`, sectionIds);
    }
    if (chapterIds.length) {
      const chapterPlaceholders = chapterIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM chapters WHERE id IN (${chapterPlaceholders})`, chapterIds);
    }
    if (fixture.materialIds.length) {
      const materialPlaceholders = fixture.materialIds.map(() => '?').join(', ');
      await connection.execute(`DELETE FROM materials WHERE id IN (${materialPlaceholders})`, fixture.materialIds);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function jsonHeaders(deviceId: string): HeadersInit {
  return { 'Content-Type': 'application/json', 'X-Device-Id': deviceId };
}

test('PH3-06 M3 标注、编辑、层级和双设备访问通过真实 MySQL + HTTP 回归', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  let fixture: M3Fixture | null = null;
  let server: Server | null = null;

  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool);
    server = started.server;
    const cardUrl = started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.cardIds[0]);
    const acquiredLock = await requestJson<{ lock: { lockToken: string } }>(cardUrl + '/edit-lock', {
      method: 'POST', headers: { 'X-Device-Id': 'device-a' },
    });
    assert.equal(acquiredLock.response.status, 201);

    const initial = await requestJson<ReviewCardResponse>(cardUrl, { headers: { 'X-Device-Id': 'device-a' } });
    assert.equal(initial.response.status, 200);
    assert.equal(initial.body.card.content?.some((node) => node.type === 'table'), true);
    assert.equal(initial.body.card.content?.some((node) => node.type === 'math'), true);

    const textHighlight = await requestJson<{ highlight: { kind: string } }>(cardUrl + '/highlights', {
      method: 'POST', headers: jsonHeaders('device-a'),
      body: JSON.stringify({ kind: 'text', anchor: { nodePath: '0.0', start: 3, end: 5 } }),
    });
    const tableHighlight = await requestJson<{ highlight: { kind: string } }>(cardUrl + '/highlights', {
      method: 'POST', headers: jsonHeaders('device-a'),
      body: JSON.stringify({ kind: 'text', anchor: { nodePath: '1.0.0.0', start: 0, end: 4 } }),
    });
    const formulaHighlight = await requestJson<{ highlight: { kind: string } }>(cardUrl + '/highlights', {
      method: 'POST', headers: jsonHeaders('device-a'),
      body: JSON.stringify({ kind: 'formula', anchor: { nodePath: '2' } }),
    });
    assert.equal(textHighlight.response.status, 201);
    assert.equal(tableHighlight.response.status, 201);
    assert.equal(formulaHighlight.response.status, 201);

    const [deviceA, deviceB] = await Promise.all([
      requestJson<ReviewCardResponse>(cardUrl, { headers: { 'X-Device-Id': 'device-a' } }),
      requestJson<ReviewCardResponse>(cardUrl, { headers: { 'X-Device-Id': 'device-b' } }),
    ]);
    assert.equal(deviceA.response.status, 200);
    assert.equal(deviceB.response.status, 200);
    assert.deepEqual(deviceA.body.card.highlights?.map((highlight) => highlight.kind).sort(), ['formula', 'text', 'text']);
    assert.deepEqual(deviceB.body.card.highlights, deviceA.body.card.highlights);

    const edited = await requestJson<ReviewCardContentUpdateResponse>(cardUrl + '/content', {
      method: 'PATCH', headers: {
        ...jsonHeaders('device-a'),
        'X-Editor-Lock-Token': acquiredLock.body.lock.lockToken,
      },
      body: JSON.stringify({
        title: '编辑后富内容卡',
        content: [
          { type: 'paragraph', children: [{ type: 'text', value: '正文已编辑 ' + fixture.keyword }] },
          {
            type: 'table',
            children: [
              { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: '表格重点' }] }] },
              { type: 'tableRow', children: [{ type: 'tableCell', children: [{ type: 'text', value: '表格普通' }] }] },
            ],
          },
          { type: 'math', value: 'E=mc^2', display: true },
        ],
      }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.invalidatedHighlightCount, 1);
    assert.deepEqual(edited.body.card.highlights?.map((highlight) => highlight.kind).sort(), ['formula', 'text']);
    const releasedLock = await requestJson<null>(cardUrl + '/edit-lock', {
      method: 'DELETE',
      headers: {
        'X-Device-Id': 'device-a',
        'X-Editor-Lock-Token': acquiredLock.body.lock.lockToken,
      },
    });
    assert.equal(releasedLock.response.status, 204);

    const [afterEditA, afterEditB] = await Promise.all([
      requestJson<ReviewCardResponse>(cardUrl, { headers: { 'X-Device-Id': 'device-a' } }),
      requestJson<ReviewCardResponse>(cardUrl, { headers: { 'X-Device-Id': 'device-b' } }),
    ]);
    assert.equal(afterEditA.body.card.title, '编辑后富内容卡');
    assert.deepEqual(
      {
        title: afterEditB.body.card.title,
        bodyText: afterEditB.body.card.bodyText,
        content: afterEditB.body.card.content,
        highlights: afterEditB.body.card.highlights,
      },
      {
        title: afterEditA.body.card.title,
        bodyText: afterEditA.body.card.bodyText,
        content: afterEditA.body.card.content,
        highlights: afterEditA.body.card.highlights,
      },
    );
    const cards = await requestJson<ReviewCardsResponse>(started.baseUrl + reviewCardsPath + '?materialId=' + encodeURIComponent(fixture.materialIds[0]));
    assert.deepEqual(cards.body.cards.map((card) => card.id), fixture.cardIds);

    const initialHierarchy = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath);
    assert.equal(initialHierarchy.response.status, 200);
    assert.ok(initialHierarchy.body.materials.some((material) => material.id === fixture.materialIds[0]));

    const createdCard = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath, {
      method: 'POST', headers: jsonHeaders('device-a'),
      body: JSON.stringify({ entityType: 'card', parentId: fixture.sectionIds[1], title: '新增卡' }),
    });
    const createdSection = createdCard.body.materials
      .flatMap((material) => material.chapters)
      .flatMap((chapter) => chapter.sections)
      .find((section) => section.id === fixture.sectionIds[1]);
    const createdCardId = createdSection?.cards[0]?.id;
    assert.equal(createdCard?.response.status, 201);
    assert.ok(createdCardId);

    const renamed = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath + '/chapter/' + fixture.chapterIds[1], {
      method: 'PATCH', headers: jsonHeaders('device-b'), body: JSON.stringify({ title: '已改名第二章' }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.materials.flatMap((material) => material.chapters).find((chapter) => chapter.id === fixture.chapterIds[1])?.title, '已改名第二章');

    const movedCard = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath + '/card/' + fixture.cardIds[1] + '/move', {
      method: 'POST', headers: jsonHeaders('device-a'), body: JSON.stringify({ parentId: fixture.sectionIds[1] }),
    });
    assert.equal(movedCard.response.status, 200);
    const movedSection = movedCard.body.materials.flatMap((material) => material.chapters).flatMap((chapter) => chapter.sections).find((section) => section.id === fixture.sectionIds[1]);
    assert.deepEqual(movedSection?.cards.map((card) => card.id), [createdCardId, fixture.cardIds[1]]);

    const reordered = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath + '/card/' + fixture.cardIds[1] + '/reorder', {
      method: 'POST', headers: jsonHeaders('device-b'), body: JSON.stringify({ direction: 'up' }),
    });
    assert.equal(reordered.response.status, 200);
    const reorderedSection = reordered.body.materials.flatMap((material) => material.chapters).flatMap((chapter) => chapter.sections).find((section) => section.id === fixture.sectionIds[1]);
    assert.deepEqual(reorderedSection?.cards.map((card) => card.id), [fixture.cardIds[1], createdCardId]);

    const movedChapter = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath + '/chapter/' + fixture.chapterIds[1] + '/move', {
      method: 'POST', headers: jsonHeaders('device-a'), body: JSON.stringify({ parentId: fixture.materialIds[1] }),
    });
    assert.equal(movedChapter.response.status, 200);
    assert.equal(movedChapter.body.materials.find((material) => material.id === fixture.materialIds[1])?.chapters.some((chapter) => chapter.id === fixture.chapterIds[1]), true);

    const deleted = await requestJson<HierarchyResponse>(started.baseUrl + hierarchyPath + '/chapter/' + fixture.chapterIds[0], {
      method: 'DELETE', headers: { 'X-Device-Id': 'device-b' },
    });
    assert.equal(deleted.response.status, 200);
    assert.equal(deleted.body.materials.flatMap((material) => material.chapters).some((chapter) => chapter.id === fixture.chapterIds[0]), false);
    assert.equal(deleted.body.materials.flatMap((material) => material.chapters).flatMap((chapter) => chapter.sections).flatMap((section) => section.cards).some((card) => card.id === fixture.cardIds[0]), false);

    const trash = await requestJson<HierarchyTrashResponse>(started.baseUrl + hierarchyTrashPath);
    assert.equal(trash.response.status, 200);
    assert.equal(trash.body.items.some((item) => item.entityId === fixture.chapterIds[0] && item.entityType === 'chapter'), true);
    assert.equal(trash.body.items.some((item) => item.entityId === fixture.cardIds[0] && item.entityType === 'card'), true);
    assert.equal(trash.body.items.some((item) => item.entityId === fixture.cardIds[1]), false);
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
