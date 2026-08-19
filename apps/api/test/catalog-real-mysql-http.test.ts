import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import sharp from 'sharp';
import {
  catalogCoursesPath,
  catalogMaterialsPath,
  catalogSubjectsPath,
  reviewCardStatusPath,
  type CatalogCoursesResponse,
  type CatalogCourseSubjectsResponse,
  type CatalogMaterialResponse,
  type CatalogMaterialCoverUploadResponse,
  type CatalogSubjectResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createCatalogDatabase, createCatalogService } from '../src/catalog-service.js';
import { createDatabasePool } from '../src/database.js';
import { createReviewDatabase, createReviewService } from '../src/review-service.js';

interface CatalogFixture {
  courseAId: string;
  courseBId: string;
  subjectAId: string;
  subjectBId: string;
  materialId: string;
  chapterId: string;
  sectionId: string;
  cardIds: [string, string];
  resourceIds: [string, string];
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

async function startServer(pool: Pool, resourcesDirectory?: string) {
  const server = createServer(createApp(new Date(), {
    catalogService: createCatalogService({ database: createCatalogDatabase(pool), resourcesDirectory }),
    reviewService: createReviewService({ database: createReviewDatabase(pool) }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function createFixture(pool: Pool): Promise<CatalogFixture> {
  const runId = randomUUID();
  const fixture: CatalogFixture = {
    courseAId: randomUUID(),
    courseBId: randomUUID(),
    subjectAId: randomUUID(),
    subjectBId: randomUUID(),
    materialId: randomUUID(),
    chapterId: randomUUID(),
    sectionId: randomUUID(),
    cardIds: [randomUUID(), randomUUID()],
    resourceIds: [randomUUID(), randomUUID()],
  };
  const sourceHash = createHash('sha256').update(runId).digest('hex');
  await pool.execute(
    'INSERT INTO courses (id, name, sort_order) VALUES (?, ?, ?), (?, ?, ?)',
    [fixture.courseAId, `目录验收课程 A ${runId}`, 1000000, fixture.courseBId, `目录验收课程 B ${runId}`, 1000001],
  );
  await pool.execute(
    'INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, 0), (?, ?, ?, 1)',
    [fixture.subjectAId, fixture.courseAId, `目录验收科目 A ${runId}`, fixture.subjectBId, fixture.courseAId, `目录验收科目 B ${runId}`],
  );
  await pool.execute(
    'INSERT INTO materials (id, subject_id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?, ?)',
    [fixture.materialId, fixture.subjectAId, `目录验收资料 ${runId}`, `catalog-${runId}.md`, sourceHash],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.chapterId, fixture.materialId, '第一章'],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.sectionId, fixture.chapterId, '第一节'],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, mastery_status, sort_order) VALUES (?, ?, ?, ?, ?, 0), (?, ?, ?, ?, ?, 1)',
    [
      fixture.cardIds[0], fixture.sectionId, '第一张', JSON.stringify([]), 'mastered',
      fixture.cardIds[1], fixture.sectionId, '第二张', JSON.stringify([]), 'unassessed',
    ],
  );
  await pool.execute(
    `INSERT INTO review_status_history (id, card_id, from_status, to_status, changed_at, source)
     VALUES (?, ?, NULL, 'unassessed', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 DAY), 'import'),
            (?, ?, 'unassessed', 'mastered', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY), 'review')`,
    [randomUUID(), fixture.cardIds[0], randomUUID(), fixture.cardIds[0]],
  );
  await pool.execute(
    'INSERT INTO resources (id, relative_path, mime_type, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
    [
      fixture.resourceIds[0], `catalog/${runId}/original.png`, 'image/png', 1000, 750, createHash('sha256').update(`${runId}:original`).digest('hex'),
      fixture.resourceIds[1], `catalog/${runId}/thumbnail.webp`, 'image/webp', 512, 384, createHash('sha256').update(`${runId}:thumbnail`).digest('hex'),
    ],
  );
  await pool.execute(
    'INSERT INTO material_covers (id, material_id, original_resource_id, thumbnail_resource_id) VALUES (?, ?, ?, ?)',
    [randomUUID(), fixture.materialId, fixture.resourceIds[0], fixture.resourceIds[1]],
  );
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: CatalogFixture, extraCourseIds: string[], extraSubjectIds: string[]) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const materialIds = [fixture.materialId];
    const cardIds = fixture.cardIds;
    await connection.execute(`DELETE FROM review_status_history WHERE card_id IN (${cardIds.map(() => '?').join(', ')})`, cardIds);
    await connection.execute(`DELETE FROM review_records WHERE card_id IN (${cardIds.map(() => '?').join(', ')})`, cardIds);
    await connection.execute(`DELETE FROM cards WHERE id IN (${cardIds.map(() => '?').join(', ')})`, cardIds);
    await connection.execute('DELETE FROM sections WHERE id = ?', [fixture.sectionId]);
    await connection.execute('DELETE FROM chapters WHERE id = ?', [fixture.chapterId]);
    await connection.execute(`DELETE FROM material_covers WHERE material_id IN (${materialIds.map(() => '?').join(', ')})`, materialIds);
    await connection.execute(`DELETE FROM materials WHERE id IN (${materialIds.map(() => '?').join(', ')})`, materialIds);
    await connection.execute(`DELETE FROM resources WHERE id IN (${fixture.resourceIds.map(() => '?').join(', ')})`, fixture.resourceIds);
    const subjectIds = [fixture.subjectAId, fixture.subjectBId, ...extraSubjectIds];
    await connection.execute(`DELETE FROM subjects WHERE id IN (${subjectIds.map(() => '?').join(', ')})`, subjectIds);
    const courseIds = [fixture.courseAId, fixture.courseBId, ...extraCourseIds];
    await connection.execute(`DELETE FROM courses WHERE id IN (${courseIds.map(() => '?').join(', ')})`, courseIds);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

test('PH5-07 目录 API 通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  let fixture: CatalogFixture | null = null;
  let server: Server | null = null;
  const extraCourseIds: string[] = [];
  const extraSubjectIds: string[] = [];

  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool);
    server = started.server;

    const courses = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogCoursesPath}`);
    assert.equal(courses.response.status, 200);
    assert.equal(courses.body.courses.find((course) => course.id === fixture.courseAId)?.subjectCount, 2);

    const subjects = await requestJson<CatalogCourseSubjectsResponse>(`${started.baseUrl}${catalogCoursesPath}/${fixture.courseAId}/subjects`);
    assert.equal(subjects.response.status, 200);
    assert.deepEqual(subjects.body.subjects.map((subject) => subject.id), [fixture.subjectAId, fixture.subjectBId]);

    const grid = await requestJson<CatalogSubjectResponse>(`${started.baseUrl}${catalogSubjectsPath}/${fixture.subjectAId}`);
    assert.equal(grid.response.status, 200);
    assert.equal(grid.body.materials[0]?.cardCount, 2);
    assert.equal(grid.body.materials[0]?.cover?.thumbnail.id, fixture.resourceIds[1]);

    const detail = await requestJson<CatalogMaterialResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.material.chapters[0]?.sections[0]?.cards.length, 2);
    assert.deepEqual(detail.body.material.masteryDistribution, { mastered: 1, familiar: 0, effort: 0, unassessed: 1 });
    assert.equal(detail.body.material.statusTrend.length, 30);
    const latestTrend = detail.body.material.statusTrend.at(-1);
    assert.ok(latestTrend);
    assert.deepEqual(latestTrend, { date: latestTrend.date, mastered: 1, familiar: 0, effort: 0, unassessed: 1 });

    const statusUpdate = await requestJson<{ card: { masteryStatus: string } }>(`${started.baseUrl}${reviewCardStatusPath}/${fixture.cardIds[1]}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'familiar' }),
    });
    assert.equal(statusUpdate.response.status, 200);
    assert.equal(statusUpdate.body.card.masteryStatus, 'familiar');
    const [historyRows] = await pool.execute(
      'SELECT from_status, to_status, source FROM review_status_history WHERE card_id = ? ORDER BY changed_at, id',
      [fixture.cardIds[1]],
    );
    assert.deepEqual(historyRows, [{ from_status: 'unassessed', to_status: 'familiar', source: 'review' }]);

    const detailAfterStatus = await requestJson<CatalogMaterialResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}`);
    assert.deepEqual(detailAfterStatus.body.material.masteryDistribution, { mastered: 1, familiar: 1, effort: 0, unassessed: 0 });
    const latestTrendAfterStatus = detailAfterStatus.body.material.statusTrend.at(-1);
    assert.ok(latestTrendAfterStatus);
    assert.deepEqual(latestTrendAfterStatus, { date: latestTrendAfterStatus.date, mastered: 1, familiar: 1, effort: 0, unassessed: 0 });

    const reordered = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogSubjectsPath}/${fixture.subjectBId}/reorder`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction: 'up' }),
    });
    assert.equal(reordered.response.status, 200);
    const reorderedSubjects = await requestJson<CatalogCourseSubjectsResponse>(`${started.baseUrl}${catalogCoursesPath}/${fixture.courseAId}/subjects`);
    assert.deepEqual(reorderedSubjects.body.subjects.map((subject) => subject.id), [fixture.subjectBId, fixture.subjectAId]);

    const createdCourseName = `新增目录课程 ${fixture.courseAId}`;
    const createdCourse = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogCoursesPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: createdCourseName }),
    });
    assert.equal(createdCourse.response.status, 201);
    const newCourse = createdCourse.body.courses.find((course) => course.name === createdCourseName);
    assert.ok(newCourse);
    extraCourseIds.push(newCourse.id);

    const createdSubjectName = `新增目录科目 ${fixture.courseAId}`;
    const createdSubject = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogSubjectsPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: newCourse.id, name: createdSubjectName }),
    });
    assert.equal(createdSubject.response.status, 201);
    const newCourseSubjects = await requestJson<CatalogCourseSubjectsResponse>(`${started.baseUrl}${catalogCoursesPath}/${newCourse.id}/subjects`);
    const newSubject = newCourseSubjects.body.subjects.find((subject) => subject.name === createdSubjectName);
    assert.ok(newSubject);
    extraSubjectIds.push(newSubject.id);

    const moved = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogSubjectsPath}/${fixture.subjectBId}/move`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: fixture.courseBId }),
    });
    assert.equal(moved.response.status, 200);
    const destination = await requestJson<CatalogCourseSubjectsResponse>(`${started.baseUrl}${catalogCoursesPath}/${fixture.courseBId}/subjects`);
    assert.equal(destination.body.subjects.some((subject) => subject.id === fixture!.subjectBId), true);

    const nonEmptyDelete = await requestJson<{ error: string }>(`${started.baseUrl}${catalogSubjectsPath}/${fixture.subjectAId}`, { method: 'DELETE' });
    assert.equal(nonEmptyDelete.response.status, 409);

    const emptyDelete = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogSubjectsPath}/${newSubject.id}`, { method: 'DELETE' });
    assert.equal(emptyDelete.response.status, 200);
    extraSubjectIds.splice(extraSubjectIds.indexOf(newSubject.id), 1);

    const deletedCourse = await requestJson<CatalogCoursesResponse>(`${started.baseUrl}${catalogCoursesPath}/${newCourse.id}`, { method: 'DELETE' });
    assert.equal(deletedCourse.response.status, 200);
    extraCourseIds.splice(extraCourseIds.indexOf(newCourse.id), 1);
  } finally {
    try {
      if (server) await stopServer(server);
    } finally {
      try {
        if (fixture) await cleanupFixture(pool, fixture, extraCourseIds, extraSubjectIds);
      } finally {
        await pool.end();
      }
    }
  }
});

test('PH5-07 资料名称与封面通过真实 MySQL、HTTP 和资源目录验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-catalog-cover-integration-'));
  let fixture: CatalogFixture | null = null;
  let server: Server | null = null;

  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool, resourcesDirectory);
    server = started.server;

    const renamed = await requestJson<CatalogMaterialResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '封面验收资料' }),
    });
    assert.equal(renamed.response.status, 200);
    assert.equal(renamed.body.material.name, '封面验收资料');

    const source = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#3976bc' } }).png().toBuffer();
    const uploaded = await requestJson<CatalogMaterialCoverUploadResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}/cover`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: source,
    });
    assert.equal(uploaded.response.status, 201);
    assert.equal(uploaded.body.cover.original.mimeType, 'image/png');
    assert.ok(Math.max(uploaded.body.cover.thumbnail.width ?? 0, uploaded.body.cover.thumbnail.height ?? 0) <= 512);
    await fs.access(path.join(resourcesDirectory, 'covers', `${uploaded.body.cover.original.id}.png`));
    await fs.access(path.join(resourcesDirectory, 'covers', `${uploaded.body.cover.thumbnail.id}.webp`));

    const detail = await requestJson<CatalogMaterialResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}`);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body.material.cover?.thumbnail.id, uploaded.body.cover.thumbnail.id);

    const removed = await fetch(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}/cover`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, 'covers', `${uploaded.body.cover.original.id}.png`)));
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, 'covers', `${uploaded.body.cover.thumbnail.id}.webp`)));
    const detailAfterRemoval = await requestJson<CatalogMaterialResponse>(`${started.baseUrl}${catalogMaterialsPath}/${fixture.materialId}`);
    assert.equal(detailAfterRemoval.body.material.cover, null);
  } finally {
    try {
      if (server) await stopServer(server);
    } finally {
      try {
        if (fixture) await cleanupFixture(pool, fixture, [], []);
      } finally {
        await pool.end();
        await fs.rm(resourcesDirectory, { recursive: true, force: true });
      }
    }
  }
});
