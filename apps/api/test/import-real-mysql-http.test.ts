import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import {
  importApplyPath,
  importPreviewPath,
  type ErrorResponse,
  type ImportApplyRequest,
  type ImportApplyResponse,
  type ImportCorrectionDocument,
  type ImportPreviewDocument,
  type ImportPreviewResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createHierarchyService } from '../src/hierarchy-service.js';
import { createImportDatabase, ImportService } from '../src/import-service.js';

interface StartedServer {
  baseUrl: string;
  server: Server;
}

interface SourceSnapshot {
  content: Buffer;
  filePath: string;
  mtimeMs: number;
  sha256: string;
}

function sha256(value: Buffer) {
  return createHash('sha256').update(value).digest('hex');
}

function correctionFromPreview(document: ImportPreviewDocument): ImportCorrectionDocument {
  return {
    title: document.title,
    chapters: document.chapters.map((chapter) => ({
      title: chapter.title,
      sections: chapter.sections.map((section) => ({
        title: section.title,
        cards: section.cards.map((card) => ({
          title: card.title,
          bodyText: card.bodyText,
        })),
      })),
    })),
  };
}

async function startServer(importService: ImportService): Promise<StartedServer> {
  const server = createServer(createApp(new Date(), { importService }));
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

async function previewImport(
  baseUrl: string,
  fileName: string,
  content: Buffer,
): Promise<ImportPreviewResponse> {
  const response = await fetch(baseUrl + importPreviewPath, {
    method: 'POST',
    headers: {
      'Content-Type': path.extname(fileName).toLowerCase() === '.zip'
        ? 'application/zip'
        : 'text/markdown',
      'X-Import-File-Name': encodeURIComponent(fileName),
    },
    body: new Uint8Array(content),
  });
  assert.equal(response.status, 200);
  return (await response.json()) as ImportPreviewResponse;
}

async function requestApply(baseUrl: string, request: unknown) {
  const response = await fetch(baseUrl + importApplyPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return {
    body: (await response.json()) as ImportApplyResponse | ErrorResponse,
    response,
  };
}

async function writeSource(
  directory: string,
  fileName: string,
  content: Buffer,
): Promise<SourceSnapshot> {
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, content);
  const stat = await fs.stat(filePath);
  return {
    content,
    filePath,
    mtimeMs: stat.mtimeMs,
    sha256: sha256(content),
  };
}

async function assertSourceUnchanged(snapshot: SourceSnapshot) {
  const [content, stat] = await Promise.all([
    fs.readFile(snapshot.filePath),
    fs.stat(snapshot.filePath),
  ]);
  assert.deepEqual(content, snapshot.content);
  assert.equal(sha256(content), snapshot.sha256);
  assert.equal(stat.mtimeMs, snapshot.mtimeMs);
}

async function assertSchemaReady(pool: Pool) {
  const [migrationRows] = await pool.execute<RowDataPacket[]>(
    'SELECT version FROM schema_migrations WHERE version = ?',
    ['001_initial_schema.sql'],
  );
  assert.equal(migrationRows.length, 1, '请先执行 npm run db:migrate。');

  const expectedTables = [
    'materials',
    'chapters',
    'sections',
    'cards',
    'resources',
    'highlights',
    'review_records',
    'ai_provider_profiles',
    'ai_explanations',
    'sync_locks',
    'backup_records',
    'trash_items',
    'app_settings',
    'courses',
    'subjects',
  ];
  const [tableRows] = await pool.query<RowDataPacket[]>('SHOW TABLES');
  const existingTables = new Set(
    tableRows.map((row) => String(Object.values(row)[0])),
  );
  for (const table of expectedTables) {
    assert.equal(existingTables.has(table), true, '缺少数据表：' + table);
  }
}

async function materialCount(pool: Pool, sourceSha256: string) {
  const [rows] = await pool.execute<RowDataPacket[]>(
    'SELECT COUNT(*) AS count FROM materials WHERE source_sha256 = ?',
    [sourceSha256],
  );
  return Number(rows[0]?.count ?? 0);
}

async function importDestination(pool: Pool): Promise<Pick<ImportApplyRequest, 'courseId' | 'subjectId'>> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT course.id AS course_id, subject.id AS subject_id
     FROM subjects AS subject
     INNER JOIN courses AS course ON course.id = subject.course_id
     WHERE course.deleted_at IS NULL AND subject.deleted_at IS NULL
     ORDER BY course.is_system DESC, course.sort_order, subject.sort_order
     LIMIT 1`,
  );
  const row = rows[0];
  assert.ok(row, '请先执行 npm run db:migrate 以创建默认课程和科目。');
  return { courseId: String(row.course_id), subjectId: String(row.subject_id) };
}

async function deleteByIds(
  connection: PoolConnection,
  table: string,
  column: string,
  ids: string[],
) {
  if (ids.length === 0) {
    return;
  }
  const placeholders = ids.map(() => '?').join(', ');
  await connection.execute(
    'DELETE FROM ' + table + ' WHERE ' + column + ' IN (' + placeholders + ')',
    ids,
  );
}

async function cleanupImportedMaterials(pool: Pool, sourceSha256s: string[]) {
  if (sourceSha256s.length === 0) {
    return;
  }
  const placeholders = sourceSha256s.map(() => '?').join(', ');
  const [materialRows] = await pool.execute<RowDataPacket[]>(
    'SELECT id FROM materials WHERE source_sha256 IN (' + placeholders + ')',
    sourceSha256s,
  );
  const materialIds = materialRows.map((row) => String(row.id));
  if (materialIds.length === 0) {
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const materialPlaceholders = materialIds.map(() => '?').join(', ');
    const [cardRows] = await connection.execute<RowDataPacket[]>(
      'SELECT cards.id FROM cards '
        + 'INNER JOIN sections ON sections.id = cards.section_id '
        + 'INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id IN (' + materialPlaceholders + ')',
      materialIds,
    );
    const [sectionRows] = await connection.execute<RowDataPacket[]>(
      'SELECT sections.id FROM sections '
        + 'INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id IN (' + materialPlaceholders + ')',
      materialIds,
    );
    const cardIds = cardRows.map((row) => String(row.id));
    const sectionIds = sectionRows.map((row) => String(row.id));
    const [chapterRows] = await connection.execute<RowDataPacket[]>(
      'SELECT id FROM chapters WHERE material_id IN (' + materialPlaceholders + ')',
      materialIds,
    );
    const chapterIds = chapterRows.map((row) => String(row.id));

    // 只按本次夹具生成的主键清理，避免影响用户已有资料。
    await deleteByIds(connection, 'trash_items', 'entity_id', [...materialIds, ...chapterIds, ...sectionIds, ...cardIds]);
    await deleteByIds(connection, 'highlights', 'card_id', cardIds);
    await deleteByIds(connection, 'review_records', 'card_id', cardIds);
    await deleteByIds(connection, 'ai_explanations', 'card_id', cardIds);
    await deleteByIds(connection, 'sync_locks', 'card_id', cardIds);
    await deleteByIds(connection, 'cards', 'id', cardIds);
    await deleteByIds(connection, 'sections', 'id', sectionIds);
    await deleteByIds(connection, 'chapters', 'material_id', materialIds);
    for (const materialId of materialIds) {
      await connection.execute('DELETE FROM resources WHERE relative_path LIKE ?', [materialId + '/%']);
    }
    await deleteByIds(connection, 'materials', 'id', materialIds);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function decodeContent(value: unknown) {
  if (typeof value === 'string') {
    return JSON.parse(value);
  }
  return value;
}

function createHighlightedJsonSource(runId: string) {
  return Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: 'M1 JSON 高亮资料 ' + runId,
    chapters: [{
      title: '第一章',
      sections: [{
        title: '第一节',
        cards: [{
          title: '牛顿第二定律',
          body: '牛顿第二定律为 $F = ma$，[[hl:力和加速度成正比]]。',
          highlights: [{ formula: 'F = ma' }],
        }],
      }],
    }],
  }));
}

async function createZipSource(runId: string, image: Buffer) {
  const archive = new JSZip();
  const title = 'M1 ZIP 资料 ' + runId;
  archive.file(
    'lesson.md',
    [
      '# ' + title,
      '## 第一章',
      '### 第一节',
      '#### 第一个知识点',
      '第一张原始正文。',
      '',
      '#### 第二个知识点',
      '第二张正文。',
      '',
      '## 第二章',
      '### 第二节',
      '#### 图示知识点',
      '第三张正文。',
      '',
      '![示意图](images/diagram.png)',
    ].join('\n'),
  );
  archive.file('images/diagram.png', image);
  return {
    content: await archive.generateAsync({ type: 'nodebuffer' }),
    title,
  };
}

async function createMissingImageZip(runId: string) {
  const archive = new JSZip();
  archive.file(
    'broken.md',
    [
      '# 缺图资料 ' + runId,
      '## 第一章',
      '### 第一节',
      '#### 知识点',
      '![缺失图片](images/missing.png)',
    ].join('\n'),
  );
  return archive.generateAsync({ type: 'nodebuffer' });
}

async function createTraversalZip(runId: string) {
  const archive = new JSZip();
  archive.file(
    'traversal.md',
    [
      '# 越界资料 ' + runId,
      '## 第一章',
      '### 第一节',
      '#### 知识点',
      '正文。',
    ].join('\n'),
  );
  archive.file('../outside.txt', '不应被读取');
  return archive.generateAsync({ type: 'nodebuffer' });
}

test('M1 资料导入主链路通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const runId = randomUUID();
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-m1-'));
  const sourceDirectory = path.join(temporaryRoot, 'sources');
  const resourcesDirectory = path.join(temporaryRoot, 'resources');
  const sourceSha256s: string[] = [];
  let pool: Pool | null = null;
  let server: Server | null = null;

  try {
    await fs.mkdir(sourceDirectory, { recursive: true });
    const image = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
    ]);
    const zipFixture = await createZipSource(runId, image);
    const zipSource = await writeSource(
      sourceDirectory,
      'm1-' + runId + '.zip',
      zipFixture.content,
    );
    const markdownSource = await writeSource(
      sourceDirectory,
      'm1-' + runId + '.md',
      Buffer.from(
        [
          '# M1 Markdown 资料 ' + runId,
          '## 第一章',
          '### 第一节',
          '#### 公式与表格',
          '公式 $E=mc^2$。',
          '',
          '| 名称 | 数值 |',
          '| --- | --- |',
          '| 光速 | c |',
        ].join('\n'),
      ),
    );
    const highlightedJsonSource = await writeSource(
      sourceDirectory,
      'highlighted-' + runId + '.json',
      createHighlightedJsonSource(runId),
    );
    sourceSha256s.push(zipSource.sha256, markdownSource.sha256, highlightedJsonSource.sha256);

    pool = createDatabasePool();
    await assertSchemaReady(pool);
    const destination = await importDestination(pool);
    const database = createImportDatabase(pool);
    const started = await startServer(
      new ImportService({
        database,
        resourcesDirectory,
      }),
    );
    server = started.server;

    const zipFileName = path.basename(zipSource.filePath);
    const zipPreview = await previewImport(started.baseUrl, zipFileName, zipSource.content);
    assert.equal(zipPreview.valid, true);
    assert.equal(zipPreview.previewId === null, false);
    assert.equal(zipPreview.sourceSha256, zipSource.sha256);
    assert.equal(zipPreview.resources.length, 1);
    assert.equal(zipPreview.resources[0]?.relativePath, 'images/diagram.png');
    assert.equal(zipPreview.document?.chapters.length, 2);

    if (!zipPreview.document || !zipPreview.previewId) {
      throw new Error('合法 ZIP 没有返回可应用预览。');
    }
    const zipCorrection = correctionFromPreview(zipPreview.document);
    zipCorrection.title = zipFixture.title + '（修正）';
    zipCorrection.chapters[0]!.sections[0]!.cards[0]!.title = '修正后的知识点';
    zipCorrection.chapters[0]!.sections[0]!.cards[0]!.bodyText = '修正后的正文。';
    const zipApply = await requestApply(started.baseUrl, {
      previewId: zipPreview.previewId,
      document: zipCorrection,
      ...destination,
    });
    assert.equal(zipApply.response.status, 200);
    const zipResult = zipApply.body as ImportApplyResponse;
    assert.equal(zipResult.status, 'applied');
    if (zipResult.status !== 'applied') {
      throw new Error('合法 ZIP 未写入数据库。');
    }
    assert.equal(zipResult.chapterCount, 2);
    assert.equal(zipResult.sectionCount, 2);
    assert.equal(zipResult.cardCount, 3);
    assert.equal(zipResult.resourceCount, 1);

    const [zipMaterials] = await pool.execute<RowDataPacket[]>(
      'SELECT id, subject_id, name, source_filename, source_sha256 FROM materials WHERE id = ?',
      [zipResult.materialId],
    );
    assert.equal(zipMaterials.length, 1);
    assert.equal(zipMaterials[0]?.subject_id, destination.subjectId);
    assert.equal(zipMaterials[0]?.name, zipCorrection.title);
    assert.equal(zipMaterials[0]?.source_filename, zipFileName);
    assert.equal(zipMaterials[0]?.source_sha256, zipSource.sha256);

    const [chapters] = await pool.execute<RowDataPacket[]>(
      'SELECT title, sort_order FROM chapters WHERE material_id = ? ORDER BY sort_order',
      [zipResult.materialId],
    );
    assert.deepEqual(
      chapters.map((chapter) => [chapter.title, Number(chapter.sort_order)]),
      [['第一章', 0], ['第二章', 1]],
    );
    const [sections] = await pool.execute<RowDataPacket[]>(
      'SELECT sections.title, sections.sort_order, chapters.sort_order AS chapter_sort_order '
        + 'FROM sections INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id = ? ORDER BY chapters.sort_order, sections.sort_order',
      [zipResult.materialId],
    );
    assert.deepEqual(
      sections.map((section) => [
        section.title,
        Number(section.chapter_sort_order),
        Number(section.sort_order),
      ]),
      [['第一节', 0, 0], ['第二节', 1, 0]],
    );
    const [zipCards] = await pool.execute<RowDataPacket[]>(
      'SELECT cards.title, cards.content_json, cards.sort_order, '
        + 'sections.sort_order AS section_sort_order, chapters.sort_order AS chapter_sort_order '
        + 'FROM cards INNER JOIN sections ON sections.id = cards.section_id '
        + 'INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id = ? '
        + 'ORDER BY chapters.sort_order, sections.sort_order, cards.sort_order',
      [zipResult.materialId],
    );
    assert.deepEqual(
      zipCards.map((card) => [
        card.title,
        Number(card.chapter_sort_order),
        Number(card.section_sort_order),
        Number(card.sort_order),
      ]),
      [
        ['修正后的知识点', 0, 0, 0],
        ['第二个知识点', 0, 0, 1],
        ['图示知识点', 1, 0, 0],
      ],
    );
    assert.match(JSON.stringify(decodeContent(zipCards[0]?.content_json)), /修正后的正文/);

    const [resources] = await pool.execute<RowDataPacket[]>(
      'SELECT id, relative_path, mime_type, sha256 FROM resources WHERE relative_path LIKE ?',
      [zipResult.materialId + '/%'],
    );
    assert.equal(resources.length, 1);
    const resource = resources[0];
    assert.ok(resource);
    assert.equal(resource.relative_path, zipResult.materialId + '/images/diagram.png');
    assert.equal(resource.mime_type, 'image/png');
    assert.equal(resource.sha256, sha256(image));
    assert.deepEqual(
      await fs.readFile(path.join(resourcesDirectory, String(resource.relative_path))),
      image,
    );
    const imageContent = JSON.stringify(decodeContent(zipCards[2]?.content_json));
    assert.equal(imageContent.includes(String(resource.id)), true);
    assert.equal(imageContent.includes(String(resource.relative_path)), true);

    const markdownFileName = path.basename(markdownSource.filePath);
    const markdownPreview = await previewImport(
      started.baseUrl,
      markdownFileName,
      markdownSource.content,
    );
    assert.equal(markdownPreview.valid, true);
    assert.equal(markdownPreview.resources.length, 0);
    if (!markdownPreview.document || !markdownPreview.previewId) {
      throw new Error('合法 Markdown 没有返回可应用预览。');
    }
    const markdownApply = await requestApply(started.baseUrl, {
      previewId: markdownPreview.previewId,
      document: correctionFromPreview(markdownPreview.document),
      ...destination,
    });
    assert.equal(markdownApply.response.status, 200);
    const markdownResult = markdownApply.body as ImportApplyResponse;
    assert.equal(markdownResult.status, 'applied');
    if (markdownResult.status !== 'applied') {
      throw new Error('合法 Markdown 未写入数据库。');
    }
    assert.equal(markdownResult.resourceCount, 0);
    const [markdownCards] = await pool.execute<RowDataPacket[]>(
      'SELECT cards.content_json FROM cards '
        + 'INNER JOIN sections ON sections.id = cards.section_id '
        + 'INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id = ?',
      [markdownResult.materialId],
    );
    const markdownContent = JSON.stringify(decodeContent(markdownCards[0]?.content_json));
    assert.equal(markdownContent.includes('table'), true);
    assert.match(markdownContent, /math/i);

    const highlightedJsonPreview = await previewImport(
      started.baseUrl,
      path.basename(highlightedJsonSource.filePath),
      highlightedJsonSource.content,
    );
    assert.equal(highlightedJsonPreview.valid, true);
    if (!highlightedJsonPreview.document || !highlightedJsonPreview.previewId) {
      throw new Error('合法 JSON 高亮资料没有返回可应用预览。');
    }
    const highlightedJsonApply = await requestApply(started.baseUrl, {
      previewId: highlightedJsonPreview.previewId,
      document: correctionFromPreview(highlightedJsonPreview.document),
      ...destination,
    });
    assert.equal(highlightedJsonApply.response.status, 200);
    const highlightedJsonResult = highlightedJsonApply.body as ImportApplyResponse;
    assert.equal(highlightedJsonResult.status, 'applied');
    if (highlightedJsonResult.status !== 'applied') {
      throw new Error('合法 JSON 高亮资料未写入数据库。');
    }
    const [highlightRows] = await pool.execute<RowDataPacket[]>(
      'SELECT highlights.kind, highlights.anchor_json FROM highlights '
        + 'INNER JOIN cards ON cards.id = highlights.card_id '
        + 'INNER JOIN sections ON sections.id = cards.section_id '
        + 'INNER JOIN chapters ON chapters.id = sections.chapter_id '
        + 'WHERE chapters.material_id = ? ORDER BY highlights.kind',
      [highlightedJsonResult.materialId],
    );
    assert.deepEqual(highlightRows.map((row) => row.kind), ['text', 'formula']);
    assert.deepEqual(decodeContent(highlightRows[0]?.anchor_json), { nodePath: '0.2', start: 1, end: 9 });
    assert.deepEqual(decodeContent(highlightRows[1]?.anchor_json), { nodePath: '0.1' });

    const duplicatePreview = await previewImport(started.baseUrl, zipFileName, zipSource.content);
    assert.equal(duplicatePreview.valid, true);
    assert.equal(duplicatePreview.duplicate, true);
    assert.equal(duplicatePreview.duplicateMaterial?.id, zipResult.materialId);
    if (!duplicatePreview.document || !duplicatePreview.previewId) {
      throw new Error('重复资料没有返回可处理预览。');
    }
    const duplicateApply = await requestApply(started.baseUrl, {
      previewId: duplicatePreview.previewId,
      document: correctionFromPreview(duplicatePreview.document),
      ...destination,
    });
    assert.equal(duplicateApply.response.status, 200);
    assert.deepEqual(duplicateApply.body, {
      status: 'skipped',
      reason: 'duplicate',
      material: duplicatePreview.duplicateMaterial,
    });
    assert.equal(await materialCount(pool, zipSource.sha256), 1);
    const [duplicateResources] = await pool.execute<RowDataPacket[]>(
      'SELECT COUNT(*) AS count FROM resources WHERE relative_path LIKE ?',
      [zipResult.materialId + '/%'],
    );
    assert.equal(Number(duplicateResources[0]?.count ?? 0), 1);

    await createHierarchyService({ database }).softDelete('material', zipResult.materialId);
    const trashedPreview = await previewImport(started.baseUrl, zipFileName, zipSource.content);
    assert.equal(trashedPreview.valid, true);
    assert.equal(trashedPreview.duplicate, false);
    assert.equal(trashedPreview.duplicateMaterial, null);
    if (!trashedPreview.document || !trashedPreview.previewId) {
      throw new Error('回收箱同源资料没有返回可应用预览。');
    }
    const trashedApply = await requestApply(started.baseUrl, {
      previewId: trashedPreview.previewId,
      document: correctionFromPreview(trashedPreview.document),
      ...destination,
    });
    assert.equal(trashedApply.response.status, 200);
    const trashedResult = trashedApply.body as ImportApplyResponse;
    assert.equal(trashedResult.status, 'applied');
    assert.equal(await materialCount(pool, zipSource.sha256), 2);

    const resourcesBeforeInvalidPreviews = await fs.readdir(resourcesDirectory);
    const invalidHierarchy = await writeSource(
      sourceDirectory,
      'invalid-' + runId + '.md',
      Buffer.from('# 错误资料 ' + runId + '\n#### 无父级闪卡\n正文。'),
    );
    sourceSha256s.push(invalidHierarchy.sha256);
    const invalidHierarchyPreview = await previewImport(
      started.baseUrl,
      path.basename(invalidHierarchy.filePath),
      invalidHierarchy.content,
    );
    assert.equal(invalidHierarchyPreview.valid, false);
    assert.equal(invalidHierarchyPreview.previewId, null);
    assert.equal(invalidHierarchyPreview.issues.some((issue) => issue.code === 'missing_parent'), true);
    assert.equal(invalidHierarchyPreview.issues[0]?.location.line, 2);
    assert.equal(await materialCount(pool, invalidHierarchy.sha256), 0);

    const missingImage = await writeSource(
      sourceDirectory,
      'missing-image-' + runId + '.zip',
      await createMissingImageZip(runId),
    );
    sourceSha256s.push(missingImage.sha256);
    const missingImagePreview = await previewImport(
      started.baseUrl,
      path.basename(missingImage.filePath),
      missingImage.content,
    );
    assert.equal(missingImagePreview.valid, false);
    assert.equal(missingImagePreview.previewId, null);
    const missingImageIssue = missingImagePreview.issues.find((issue) => issue.code === 'missing_image');
    assert.ok(missingImageIssue);
    assert.equal(missingImageIssue.location.line, 5);
    assert.equal(await materialCount(pool, missingImage.sha256), 0);

    const traversal = await writeSource(
      sourceDirectory,
      'traversal-' + runId + '.zip',
      await createTraversalZip(runId),
    );
    sourceSha256s.push(traversal.sha256);
    const traversalPreview = await previewImport(
      started.baseUrl,
      path.basename(traversal.filePath),
      traversal.content,
    );
    assert.equal(traversalPreview.valid, false);
    assert.equal(traversalPreview.previewId, null);
    const traversalIssue = traversalPreview.issues.find((issue) => issue.code === 'archive_path_traversal');
    assert.ok(traversalIssue);
    assert.equal(traversalIssue.location.fileName, path.basename(traversal.filePath));
    assert.equal(await materialCount(pool, traversal.sha256), 0);
    assert.deepEqual(await fs.readdir(resourcesDirectory), resourcesBeforeInvalidPreviews);

    const cancelled = await writeSource(
      sourceDirectory,
      'cancelled-' + runId + '.md',
      Buffer.from('# 取消资料 ' + runId + '\n## 第一章\n### 第一节\n#### 知识点\n正文。'),
    );
    sourceSha256s.push(cancelled.sha256);
    const cancelledPreview = await previewImport(
      started.baseUrl,
      path.basename(cancelled.filePath),
      cancelled.content,
    );
    if (!cancelledPreview.document || !cancelledPreview.previewId) {
      throw new Error('取消场景没有返回可应用预览。');
    }
    const cancelResponse = await fetch(
      started.baseUrl + importPreviewPath + '/' + encodeURIComponent(cancelledPreview.previewId),
      { method: 'DELETE' },
    );
    assert.equal(cancelResponse.status, 204);
    const cancelledApply = await requestApply(started.baseUrl, {
      previewId: cancelledPreview.previewId,
      document: correctionFromPreview(cancelledPreview.document),
      ...destination,
    });
    assert.equal(cancelledApply.response.status, 404);
    assert.equal(
      (cancelledApply.body as ErrorResponse).error,
      '导入预览已失效，请重新选择文件。',
    );

    const restart = await writeSource(
      sourceDirectory,
      'restart-' + runId + '.md',
      Buffer.from('# 重启资料 ' + runId + '\n## 第一章\n### 第一节\n#### 知识点\n正文。'),
    );
    sourceSha256s.push(restart.sha256);
    const restartPreview = await previewImport(
      started.baseUrl,
      path.basename(restart.filePath),
      restart.content,
    );
    if (!restartPreview.document || !restartPreview.previewId) {
      throw new Error('重启场景没有返回可应用预览。');
    }
    await stopServer(server);
    server = null;
    // 新建 ImportService 模拟 API 重启后进程内预览令牌丢失。
    const restarted = await startServer(
      new ImportService({
        database,
        resourcesDirectory,
      }),
    );
    server = restarted.server;
    const restartApply = await requestApply(restarted.baseUrl, {
      previewId: restartPreview.previewId,
      document: correctionFromPreview(restartPreview.document),
      ...destination,
    });
    assert.equal(restartApply.response.status, 404);
    assert.equal(
      (restartApply.body as ErrorResponse).error,
      '导入预览已失效，请重新选择文件。',
    );

    await Promise.all([
      assertSourceUnchanged(zipSource),
      assertSourceUnchanged(markdownSource),
      assertSourceUnchanged(highlightedJsonSource),
      assertSourceUnchanged(cancelled),
      assertSourceUnchanged(restart),
    ]);
  } finally {
    try {
      if (server) {
        await stopServer(server);
      }
    } finally {
      try {
        if (pool) {
          await cleanupImportedMaterials(pool, sourceSha256s);
        }
      } finally {
        if (pool) {
          await pool.end();
        }
        await fs.rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  }
});
