import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  CatalogApiError,
  createCatalogService,
  type CatalogDatabase,
  type CatalogSqlConnection,
} from './catalog-service.js';

class FakeCatalogDatabase implements CatalogDatabase, CatalogSqlConnection {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
  courseRows = [{ id: 'course-1', name: '课程一', sort_order: 0, is_system: 0, subject_count: 1 }];
  subjectRows = [{ id: 'subject-1', course_id: 'course-1', name: '科目一', sort_order: 0, is_system: 0, material_count: 1 }];
  materialRows = [{
    material_id: 'material-1', material_name: '资料一', card_count: 2, cover_id: 'cover-1',
    original_resource_id: 'original-1', original_mime_type: 'image/png', original_width: 1024, original_height: 768, original_sha256: 'a'.repeat(64),
    thumbnail_resource_id: 'thumbnail-1', thumbnail_mime_type: 'image/webp', thumbnail_width: 512, thumbnail_height: 384, thumbnail_sha256: 'b'.repeat(64),
  }];
  detailMaterialRows = [{
    material_id: 'material-1', material_name: '资料一', course_id: 'course-1', subject_id: 'subject-1', card_count: 2, cover_id: 'cover-1',
    original_resource_id: 'original-1', original_mime_type: 'image/png', original_width: 1024, original_height: 768, original_sha256: 'a'.repeat(64),
    thumbnail_resource_id: 'thumbnail-1', thumbnail_mime_type: 'image/webp', thumbnail_width: 512, thumbnail_height: 384, thumbnail_sha256: 'b'.repeat(64),
  }];
  chapterRows = [
    { chapter_id: 'chapter-1', chapter_title: '第一章', chapter_sort_order: 0, section_id: 'section-1', section_title: '第一节', section_sort_order: 0, card_id: 'card-1', card_title: '第一张', card_sort_order: 0 },
    { chapter_id: 'chapter-1', chapter_title: '第一章', chapter_sort_order: 0, section_id: 'section-1', section_title: '第一节', section_sort_order: 0, card_id: 'card-2', card_title: '第二张', card_sort_order: 1 },
  ];
  cardStatusRows = [{ card_id: 'card-1', mastery_status: 'mastered' }, { card_id: 'card-2', mastery_status: 'effort' }];
  historyRows = [
    { card_id: 'card-1', to_status: 'unassessed', changed_at: new Date('2026-08-10T12:00:00.000Z') },
    { card_id: 'card-1', to_status: 'mastered', changed_at: '2026-08-10 20:00:00.000' },
  ];
  coverRows: Array<Record<string, unknown>> = [];
  materialIsPresent = false;

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.statements.push({ sql, values });
    if (sql.includes('FROM courses AS c')) return [this.courseRows, []];
    if (sql.includes('FROM subjects AS s') && sql.includes('WHERE s.id = ?')) return [this.subjectRows, []];
    if (sql.includes('FROM subjects AS s') && sql.includes('WHERE s.course_id = ?')) return [this.subjectRows, []];
    if (sql.includes('FROM review_status_history AS history')) return [this.historyRows, []];
    if (sql.includes('SELECT card.id AS card_id, card.mastery_status')) return [this.cardStatusRows, []];
    if (sql.includes('FROM chapters AS ch')) return [this.chapterRows, []];
    if (sql.includes('FROM material_covers AS mc')) return [this.coverRows, []];
    if (sql.includes('FROM materials AS m') && sql.includes('WHERE m.id = ?')) return [this.detailMaterialRows, []];
    if (sql.includes('FROM materials AS m')) return [this.materialRows, []];
    if (sql.startsWith('SELECT id FROM materials WHERE id = ?')) return [[{ id: 'material-1' }], []];
    if (sql.includes('SELECT COALESCE(MAX(sort_order)') && sql.includes('FROM courses')) return [[{ next_order: 1 }], []];
    if (sql.includes('SELECT COALESCE(MAX(sort_order)') && sql.includes('FROM subjects')) return [[{ next_order: 1 }], []];
    if (sql.includes('SELECT id FROM subjects WHERE course_id')) return [[], []];
    if (sql.includes('SELECT id FROM materials WHERE subject_id')) return [this.materialIsPresent ? [{ id: 'material-1' }] : [], []];
    if (sql.startsWith('SELECT id FROM courses WHERE')) return [[{ id: 'course-1' }], []];
    if (sql.startsWith('SELECT id FROM subjects WHERE')) return [[{ id: 'subject-1' }], []];
    return [[], []];
  }

  async getConnection(): Promise<CatalogSqlConnection> {
    return this;
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

test('科目资料读取返回封面元数据和有效闪卡数量', async () => {
  const service = createCatalogService({ database: new FakeCatalogDatabase() });

  const result = await service.getSubject('subject-1');

  assert.equal(result.course.name, '课程一');
  assert.equal(result.subject.materialCount, 1);
  assert.deepEqual(result.materials, [{
    id: 'material-1', courseId: 'course-1', subjectId: 'subject-1', name: '资料一', cardCount: 2,
    cover: {
      id: 'cover-1',
      original: { id: 'original-1', mimeType: 'image/png', width: 1024, height: 768, sha256: 'a'.repeat(64) },
      thumbnail: { id: 'thumbnail-1', mimeType: 'image/webp', width: 512, height: 384, sha256: 'b'.repeat(64) },
    },
  }]);
});

test('资料详情按上海自然日返回连续趋势，并为无历史闪卡回退未评估', async () => {
  const service = createCatalogService({
    database: new FakeCatalogDatabase(),
    now: () => new Date('2026-08-11T04:00:00.000Z'),
  });

  const result = await service.getMaterial('material-1');

  assert.equal(result.material.chapters[0]?.sections[0]?.cards.length, 2);
  assert.deepEqual(result.material.masteryDistribution, { mastered: 1, familiar: 0, effort: 1, unassessed: 0 });
  assert.equal(result.material.statusTrend.length, 30);
  assert.deepEqual(result.material.statusTrend[0], { date: '2026-07-13', mastered: 0, familiar: 0, effort: 0, unassessed: 2 });
  assert.deepEqual(result.material.statusTrend.at(-2), { date: '2026-08-10', mastered: 1, familiar: 0, effort: 0, unassessed: 1 });
  assert.deepEqual(result.material.statusTrend.at(-1), { date: '2026-08-11', mastered: 1, familiar: 0, effort: 0, unassessed: 1 });
});

test('新建课程追加到活动课程末尾', async () => {
  const database = new FakeCatalogDatabase();
  const service = createCatalogService({ database });

  await service.createCourse({ name: '新增课程' });

  const insert = database.statements.find((statement) => statement.sql.includes('INSERT INTO courses'));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(1), ['新增课程', 1]);
});

test('非空科目和系统课程均拒绝删除', async () => {
  const database = new FakeCatalogDatabase();
  database.materialIsPresent = true;
  const service = createCatalogService({ database });

  await assert.rejects(
    () => service.removeSubject('subject-1'),
    (error: unknown) => error instanceof CatalogApiError && error.statusCode === 409,
  );

  database.courseRows[0] = { ...database.courseRows[0]!, is_system: 1 };
  await assert.rejects(
    () => service.removeCourse('course-1'),
    (error: unknown) => error instanceof CatalogApiError && error.statusCode === 400,
  );
});

test('科目移动会写入目标课程末尾并整理两个课程的排序', async () => {
  const database = new FakeCatalogDatabase();
  database.courseRows = [
    { id: 'course-1', name: '课程一', sort_order: 0, is_system: 0, subject_count: 1 },
    { id: 'course-2', name: '课程二', sort_order: 1, is_system: 0, subject_count: 0 },
  ];
  const service = createCatalogService({ database });

  await service.moveSubject('subject-1', { courseId: 'course-2' });

  const update = database.statements.find((statement) => statement.sql.includes('UPDATE subjects SET course_id'));
  assert.ok(update);
  assert.deepEqual(update.values, ['course-2', 1, 'subject-1']);
  assert.ok(database.statements.some((statement) => statement.sql.includes('SELECT id FROM subjects WHERE course_id = ?') && statement.values[0] === 'course-1'));
  assert.ok(database.statements.some((statement) => statement.sql.includes('SELECT id FROM subjects WHERE course_id = ?') && statement.values[0] === 'course-2'));
});

test('课程上移会交换相邻课程并整理排序', async () => {
  const database = new FakeCatalogDatabase();
  database.courseRows = [
    { id: 'course-1', name: '课程一', sort_order: 0, is_system: 0, subject_count: 0 },
    { id: 'course-2', name: '课程二', sort_order: 1, is_system: 0, subject_count: 0 },
  ];
  const service = createCatalogService({ database });

  await service.reorderCourse('course-2', { direction: 'up' });

  const swaps = database.statements.filter((statement) => statement.sql === 'UPDATE courses SET sort_order = ? WHERE id = ?');
  assert.deepEqual(swaps.slice(0, 2).map((statement) => statement.values), [[0, 'course-2'], [1, 'course-1']]);
});

test('资料名称更新通过目录服务持久化', async () => {
  const database = new FakeCatalogDatabase();
  const service = createCatalogService({ database });

  await service.renameMaterial('material-1', { name: '更新后的资料' });

  const update = database.statements.find((statement) => statement.sql.startsWith('UPDATE materials SET name'));
  assert.ok(update);
  assert.deepEqual(update.values, ['更新后的资料', 'material-1']);
});

test('资料封面生成缩略图，并在替换和移除时清理旧资源', async () => {
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-catalog-cover-'));
  try {
    const database = new FakeCatalogDatabase();
    database.coverRows = [{
      cover_id: 'cover-old',
      original_resource_id: 'original-old', original_relative_path: 'covers/original-old.png', original_mime_type: 'image/png', original_width: 600, original_height: 400, original_sha256: 'a'.repeat(64),
      thumbnail_resource_id: 'thumbnail-old', thumbnail_relative_path: 'covers/thumbnail-old.webp', thumbnail_mime_type: 'image/webp', thumbnail_width: 512, thumbnail_height: 341, thumbnail_sha256: 'b'.repeat(64),
    }];
    await fs.mkdir(path.join(resourcesDirectory, 'covers'), { recursive: true });
    await fs.writeFile(path.join(resourcesDirectory, 'covers', 'original-old.png'), 'old-original');
    await fs.writeFile(path.join(resourcesDirectory, 'covers', 'thumbnail-old.webp'), 'old-thumbnail');
    const service = createCatalogService({ database, resourcesDirectory });
    const source = await sharp({ create: { width: 1600, height: 800, channels: 3, background: '#cc4422' } }).png().toBuffer();

    const cover = await service.replaceMaterialCover('material-1', source, 'image/png');

    assert.equal(cover.original.mimeType, 'image/png');
    assert.equal(cover.original.width, 1600);
    assert.equal(cover.thumbnail.mimeType, 'image/webp');
    assert.ok(Math.max(cover.thumbnail.width ?? 0, cover.thumbnail.height ?? 0) <= 512);
    assert.equal((await sharp(await fs.readFile(path.join(resourcesDirectory, `covers/${cover.thumbnail.id}.webp`))).metadata()).format, 'webp');
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, 'covers', 'original-old.png')));
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, 'covers', 'thumbnail-old.webp')));

    database.coverRows = [{
      cover_id: cover.id,
      original_resource_id: cover.original.id, original_relative_path: `covers/${cover.original.id}.png`, original_mime_type: cover.original.mimeType, original_width: cover.original.width, original_height: cover.original.height, original_sha256: cover.original.sha256,
      thumbnail_resource_id: cover.thumbnail.id, thumbnail_relative_path: `covers/${cover.thumbnail.id}.webp`, thumbnail_mime_type: cover.thumbnail.mimeType, thumbnail_width: cover.thumbnail.width, thumbnail_height: cover.thumbnail.height, thumbnail_sha256: cover.thumbnail.sha256,
    }];
    await service.removeMaterialCover('material-1');

    await assert.rejects(() => fs.access(path.join(resourcesDirectory, `covers/${cover.original.id}.png`)));
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, `covers/${cover.thumbnail.id}.webp`)));
    assert.ok(database.statements.some((statement) => statement.sql === 'DELETE FROM material_covers WHERE material_id = ?'));
  } finally {
    await fs.rm(resourcesDirectory, { recursive: true, force: true });
  }
});
