import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  reviewCardPath,
  reviewCardsPath,
  reviewDashboardPath,
  reviewWorkspacePath,
  reviewStartPath,
  type ReviewCardResponse,
  type ReviewCardContentUpdateResponse,
  type ReviewCardsResponse,
  type ReviewDashboardResponse,
  type ReviewWorkspaceResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createReviewDatabase, createReviewService, type ReviewService } from '../src/review-service.js';
import { createReviewWorkspaceService, type ReviewWorkspaceService } from '../src/review-workspace-service.js';

interface StartedServer {
  baseUrl: string;
  server: Server;
}

interface ReviewFixture {
  courseId: string;
  subjectId: string;
  materialId: string;
  chapterId: string;
  sectionId: string;
  firstCardId: string;
  secondCardId: string;
  lastCardId: string;
  imageResourceId: string;
  keyword: string;
}

interface ReviewProgressSetting {
  key: string;
  value: string;
}

async function startServer(reviewService: ReviewService, reviewWorkspaceService?: ReviewWorkspaceService): Promise<StartedServer> {
  const server = createServer(createApp(new Date(), { reviewService, reviewWorkspaceService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return {
    baseUrl: 'http://127.0.0.1:' + address.port,
    server,
  };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return {
    response,
    body: await response.json() as T,
  };
}

async function readReviewProgressSettings(pool: Pool): Promise<ReviewProgressSetting[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT setting_key, CAST(setting_value AS CHAR) AS setting_value FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')",
  );
  return rows
    .filter((row) => typeof row.setting_key === 'string' && typeof row.setting_value === 'string')
    .map((row) => ({ key: row.setting_key as string, value: row.setting_value as string }));
}

async function restoreReviewProgressSettings(pool: Pool, settings: ReviewProgressSetting[]) {
  await pool.execute("DELETE FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')");
  for (const setting of settings) {
    await pool.execute(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, CAST(? AS JSON))',
      [setting.key, setting.value],
    );
  }
}

async function createFixture(pool: Pool): Promise<ReviewFixture> {
  const runId = randomUUID();
  const fixture: ReviewFixture = {
    courseId: randomUUID(),
    subjectId: randomUUID(),
    materialId: randomUUID(),
    chapterId: randomUUID(),
    sectionId: randomUUID(),
    firstCardId: randomUUID(),
    secondCardId: randomUUID(),
    lastCardId: randomUUID(),
    imageResourceId: randomUUID(),
    keyword: 'M2主链路' + runId,
  };
  const secondSectionId = randomUUID();
  const sourceSha256 = createHash('sha256').update(runId).digest('hex');
  const richContent = [
    {
      type: 'paragraph',
      children: [{ type: 'text', value: '富内容正文 ' + fixture.keyword }],
    },
    {
      type: 'table',
      children: [
        {
          type: 'tableRow',
          children: [{ type: 'tableCell', children: [{ type: 'text', value: '列名' }] }],
        },
        {
          type: 'tableRow',
          children: [{ type: 'tableCell', children: [{ type: 'text', value: '表格内容' }] }],
        },
      ],
    },
    { type: 'math', value: 'E=mc^2', display: true },
    { type: 'code', value: 'const phase = "M2";', lang: 'ts' },
  ];
  const plainContent = [{ type: 'paragraph', children: [{ type: 'text', value: fixture.keyword }] }];

  await pool.execute(
    'INSERT INTO courses (id, name, sort_order) VALUES (?, ?, ?)',
    [fixture.courseId, 'M2 验收课程 ' + runId, 1000000],
  );
  await pool.execute(
    'INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, ?)',
    [fixture.subjectId, fixture.courseId, 'M2 验收科目 ' + runId, 0],
  );
  await pool.execute(
    'INSERT INTO materials (id, subject_id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?, ?)',
    [fixture.materialId, fixture.subjectId, 'M2 验收资料 ' + runId, 'm2-' + runId + '.md', sourceSha256],
  );
  await pool.execute(
    'INSERT INTO resources (id, relative_path, mime_type, sha256) VALUES (?, ?, ?, ?)',
    [fixture.imageResourceId, 'fixtures/' + runId + '.png', 'image/png', sourceSha256],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.chapterId, fixture.materialId, '第一章'],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 1)',
    [fixture.sectionId, fixture.chapterId, '第一节', secondSectionId, fixture.chapterId, '第二节'],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, mastery_status, sort_order) VALUES (?, ?, ?, ?, ?, 0), (?, ?, ?, ?, ?, 1), (?, ?, ?, ?, ?, 0)',
    [
      fixture.firstCardId,
      fixture.sectionId,
      '第一张富内容卡',
      JSON.stringify(richContent),
      'unassessed',
      fixture.secondCardId,
      fixture.sectionId,
      '第二张待评估卡',
      JSON.stringify(plainContent),
      'unassessed',
      fixture.lastCardId,
      secondSectionId,
      '第三张努力卡',
      JSON.stringify(plainContent),
      'effort',
    ],
  );
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: ReviewFixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const cardIds = [fixture.firstCardId, fixture.secondCardId, fixture.lastCardId];
    const placeholders = cardIds.map(() => '?').join(', ');
    await connection.execute('DELETE FROM review_status_history WHERE card_id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM review_records WHERE card_id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM highlights WHERE card_id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM ai_explanations WHERE card_id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM sync_locks WHERE card_id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM cards WHERE id IN (' + placeholders + ')', cardIds);
    await connection.execute('DELETE FROM resources WHERE id = ?', [fixture.imageResourceId]);
    await connection.execute('DELETE FROM sections WHERE chapter_id = ?', [fixture.chapterId]);
    await connection.execute('DELETE FROM chapters WHERE id = ?', [fixture.chapterId]);
    await connection.execute('DELETE FROM materials WHERE id = ?', [fixture.materialId]);
    await connection.execute('DELETE FROM subjects WHERE id = ?', [fixture.subjectId]);
    await connection.execute('DELETE FROM courses WHERE id = ?', [fixture.courseId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

test('M2 连续复习主链路通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  let server: Server | null = null;
  let fixture: ReviewFixture | null = null;
  let secondFixture: ReviewFixture | null = null;
  const reviewProgressSettings = await readReviewProgressSettings(pool);

  try {
    fixture = await createFixture(pool);
    secondFixture = await createFixture(pool);
    const started = await startServer(
      createReviewService({ database: createReviewDatabase(pool) }),
      createReviewWorkspaceService({ database: pool }),
    );
    server = started.server;
    const lockUrl = started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.firstCardId) + '/edit-lock';
    const lock = await requestJson<{ lock: { lockToken: string } }>(lockUrl, {
      method: 'POST', headers: { 'X-Device-Id': 'review-integration-device' },
    });
    assert.equal(lock.response.status, 201);

    const dashboard = await requestJson<ReviewDashboardResponse>(started.baseUrl + reviewDashboardPath);
    assert.equal(dashboard.response.status, 200);
    const material = dashboard.body.materials.find((item) => item.id === fixture.materialId);
    assert.equal(material?.cardCount, 3);
    assert.equal(material?.familiarCount, 0);

    const start = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewStartPath + '?scope=all&materialId=' + encodeURIComponent(fixture.materialId),
    );
    assert.equal(start.response.status, 200);
    assert.equal(start.body.card.id, fixture.firstCardId);
    assert.equal(start.body.card.content?.some((node) => node.type === 'table'), true);
    assert.equal(start.body.card.content?.some((node) => node.type === 'math'), true);
    assert.equal(start.body.card.content?.some((node) => node.type === 'code'), true);

    const filterParams = new URLSearchParams({
      materialId: fixture.materialId,
      statuses: 'unassessed',
      cardId: fixture.firstCardId,
    });
    const filtered = await requestJson<ReviewCardsResponse>(
      started.baseUrl + reviewCardsPath + '?' + filterParams.toString(),
    );
    assert.equal(filtered.response.status, 200);
    assert.deepEqual(filtered.body.cards.map((card) => card.id), [fixture.firstCardId, fixture.secondCardId]);
    assert.deepEqual(Object.keys(filtered.body.cards[0] ?? {}), ['id']);
    assert.equal(filtered.body.currentIndex, 0);

    const opened = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.firstCardId)
        + '?' + new URLSearchParams({ materialId: fixture.materialId, statuses: 'unassessed' }).toString(),
    );
    assert.equal(opened.response.status, 200);
    assert.equal(opened.body.card.review.viewCount >= 2, true);
    assert.deepEqual(opened.body.navigation, {
      previousCardId: null,
      nextCardId: fixture.secondCardId,
      currentIndex: 0,
      total: 2,
    });

    const navigatedCard = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(opened.body.navigation.nextCardId ?? '')
        + '?' + new URLSearchParams({ materialId: fixture.materialId, statuses: 'unassessed' }).toString(),
    );
    assert.equal(navigatedCard.response.status, 200);
    assert.equal(navigatedCard.body.card.id, fixture.secondCardId);
    assert.deepEqual(navigatedCard.body.navigation, {
      previousCardId: fixture.firstCardId,
      nextCardId: null,
      currentIndex: 1,
      total: 2,
    });

    const updated = await requestJson<ReviewCardContentUpdateResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.firstCardId) + '/content',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Device-Id': 'review-integration-device',
          'X-Editor-Lock-Token': lock.body.lock.lockToken,
        },
        body: JSON.stringify({
          title: '第一张已编辑闪卡',
          content: [
            { type: 'paragraph', children: [{ type: 'text', value: '编辑后的正文 ' + fixture.keyword }] },
            {
              type: 'table',
              children: [
                {
                  type: 'tableRow',
                  children: [{ type: 'tableCell', children: [{ type: 'text', value: '编辑后列名' }] }],
                },
                {
                  type: 'tableRow',
                  children: [{ type: 'tableCell', children: [{ type: 'text', value: '编辑后表格内容' }] }],
                },
              ],
            },
            { type: 'math', value: 'a^2+b^2=c^2' },
            { type: 'image', resourceId: fixture.imageResourceId, alt: '验证图片' },
          ],
        }),
      },
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.card.title, '第一张已编辑闪卡');
    assert.equal(updated.body.invalidatedHighlightCount, 0);
    assert.equal(updated.body.card.content?.some((node) => node.type === 'image' && node.resourceId === fixture.imageResourceId), true);

    const reloaded = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.firstCardId),
    );
    assert.equal(reloaded.response.status, 200);
    assert.equal(reloaded.body.card.title, '第一张已编辑闪卡');
    assert.equal(reloaded.body.card.content?.[1]?.children?.[1]?.children?.[0]?.children?.[0]?.value, '编辑后表格内容');
    const releasedLock = await fetch(lockUrl, {
      method: 'DELETE',
      headers: {
        'X-Device-Id': 'review-integration-device',
        'X-Editor-Lock-Token': lock.body.lock.lockToken,
      },
    });
    assert.equal(releasedLock.status, 204);

    const mastered = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.firstCardId) + '/status',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'mastered' }),
      },
    );
    assert.equal(mastered.response.status, 200);
    assert.equal(mastered.body.card.masteryStatus, 'mastered');
    assert.notEqual(mastered.body.card.review.statusChangedAt, null);

    const movedOut = await requestJson<ReviewCardsResponse>(
      started.baseUrl + reviewCardsPath + '?' + filterParams.toString(),
    );
    assert.deepEqual(movedOut.body.cards.map((card) => card.id), [fixture.secondCardId]);
    assert.equal(movedOut.body.currentIndex, -1);

    const nextCard = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.secondCardId),
    );
    assert.equal(nextCard.response.status, 200);
    const nextParams = new URLSearchParams(filterParams);
    nextParams.set('cardId', fixture.secondCardId);
    const nextResult = await requestJson<ReviewCardsResponse>(
      started.baseUrl + reviewCardsPath + '?' + nextParams.toString(),
    );
    assert.equal(nextResult.body.currentIndex, 0);

    const familiar = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.secondCardId) + '/status',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'familiar' }),
      },
    );
    assert.equal(familiar.response.status, 200);
    assert.equal(familiar.body.card.masteryStatus, 'familiar');

    const dashboardAfterFamiliar = await requestJson<ReviewDashboardResponse>(started.baseUrl + reviewDashboardPath);
    assert.equal(dashboardAfterFamiliar.body.materials.find((item) => item.id === fixture.materialId)?.familiarCount, 1);

    const allParams = new URLSearchParams({ materialId: fixture.materialId, cardId: fixture.lastCardId });
    const allCards = await requestJson<ReviewCardsResponse>(
      started.baseUrl + reviewCardsPath + '?' + allParams.toString(),
    );
    assert.deepEqual(allCards.body.cards.map((card) => card.id), [
      fixture.firstCardId,
      fixture.secondCardId,
      fixture.lastCardId,
    ]);
    assert.equal(allCards.body.currentIndex, 2);
    assert.equal(allCards.body.cards[allCards.body.currentIndex + 1], undefined);

    const openedSecondMaterial = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewCardPath + '/' + encodeURIComponent(secondFixture.lastCardId),
    );
    assert.equal(openedSecondMaterial.response.status, 200);

    const resumedFirstMaterial = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewStartPath + '?scope=all&materialId=' + encodeURIComponent(fixture.materialId),
    );
    assert.equal(resumedFirstMaterial.body.card.id, fixture.secondCardId);
    const resumedSecondMaterial = await requestJson<ReviewCardResponse>(
      started.baseUrl + reviewStartPath + '?scope=all&materialId=' + encodeURIComponent(secondFixture.materialId),
    );
    assert.equal(resumedSecondMaterial.body.card.id, secondFixture.lastCardId);

    const workspace = await requestJson<ReviewWorkspaceResponse>(
      started.baseUrl + reviewWorkspacePath + '?' + new URLSearchParams({
        courseId: fixture.courseId,
        subjectId: fixture.subjectId,
      }).toString(),
    );
    assert.equal(workspace.response.status, 200);
    const workspaceMaterial = workspace.body.flashcards.materials.find((item) => item.id === fixture.materialId);
    assert.equal(workspaceMaterial?.lastCardId, fixture.secondCardId);

    const resumedDashboard = await requestJson<ReviewDashboardResponse>(started.baseUrl + reviewDashboardPath);
    assert.equal(resumedDashboard.body.materials.find((item) => item.id === fixture.materialId)?.continueCard?.id, fixture.secondCardId);
    assert.equal(resumedDashboard.body.materials.find((item) => item.id === secondFixture.materialId)?.continueCard?.id, secondFixture.lastCardId);

    const records = await pool.execute<RowDataPacket[]>(
      'SELECT first_viewed_at, last_viewed_at, status_changed_at, view_count FROM review_records WHERE card_id = ?',
      [fixture.firstCardId],
    );
    const record = records[0][0];
    assert.ok(record);
    assert.notEqual(record.first_viewed_at, null);
    assert.notEqual(record.last_viewed_at, null);
    assert.notEqual(record.status_changed_at, null);
    assert.equal(Number(record.view_count) >= 2, true);
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
        if (secondFixture) {
          await cleanupFixture(pool, secondFixture);
        }
      } finally {
        // 验收会更新资料续读位置，完成后恢复用户原有设置。
        await restoreReviewProgressSettings(pool, reviewProgressSettings);
        await pool.end();
      }
    }
  }
});
