import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DataJsonExport, DataJsonExportV2 } from '@knowledge-flashcards/shared';
import { DataGovernanceApiError, DataGovernanceServiceImpl, type DataGovernanceDatabase, type DataGovernanceSqlConnection } from './data-governance-service.js';

function fakeDatabase(handler: (sql: string, values?: readonly unknown[]) => Promise<[unknown, unknown]> | [unknown, unknown]): DataGovernanceDatabase {
  return {
    execute: async (sql, values) => handler(sql, values),
    getConnection: async () => {
      const connection: DataGovernanceSqlConnection = {
        execute: async (sql, values) => handler(sql, values),
        beginTransaction: async () => undefined,
        commit: async () => undefined,
        rollback: async () => undefined,
        release: () => undefined,
      };
      return connection;
    },
  };
}

function emptyExport(): DataJsonExport {
  return {
    format: 'knowledge-flashcards-json',
    version: 1,
    exportedAt: '2026-08-11T00:00:00.000Z',
    materials: [],
    chapters: [],
    sections: [],
    cards: [],
    resources: [],
    highlights: [],
    reviewRecords: [],
    aiExplanations: [],
    trashItems: [],
    appSettings: [],
  };
}

test('Markdown 导出保留资料层级、公式和图片路径', async () => {
  const database = fakeDatabase(async (sql) => {
    assert.match(sql, /FROM materials/);
    return [[{
      material_id: 'material-1',
      material_name: '测试资料',
      chapter_title: '第一章',
      section_title: '第一节',
      card_title: '卡片一',
      content_json: JSON.stringify([
        { type: 'paragraph', children: [{ type: 'text', value: '正文' }, { type: 'inlineMath', value: 'x^2' }] },
        { type: 'image', url: 'images/a.png', resourcePath: 'material-1/images/a.png', resourceId: 'resource-1', alt: '示例' },
      ]),
    }], {}];
  });
  const service = new DataGovernanceServiceImpl(database, path.join(os.tmpdir(), 'missing-resources'));
  const result = await service.exportMarkdown('material-1');
  assert.equal(result.fileName, '测试资料.md');
  assert.match(result.content, /# 测试资料/);
  assert.match(result.content, /#### 卡片一/);
  assert.match(result.content, /\$x\^2\$/);
  assert.match(result.content, /!\[示例\]\(images\/a\.png\)/);
});

test('JSON 导出包含资源内容且不暴露密钥字段', async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-export-'));
  try {
    const relativePath = 'material-1/images/a.png';
    const source = Buffer.from('resource-bytes');
    await fs.mkdir(path.join(tempDirectory, 'material-1', 'images'), { recursive: true });
    await fs.writeFile(path.join(tempDirectory, relativePath), source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('FROM courses')) return [[{ id: '00000000-0000-4000-8000-000000000001', name: '待整理', sort_order: 0, is_system: 1, deleted_at: null, created_at: new Date(), updated_at: new Date() }], {}];
      if (sql.includes('FROM subjects')) return [[{ id: '00000000-0000-4000-8000-000000000002', course_id: '00000000-0000-4000-8000-000000000001', name: '待整理', sort_order: 0, is_system: 1, deleted_at: null, created_at: new Date(), updated_at: new Date() }], {}];
      if (sql.includes('FROM materials')) return [[{ id: 'material-1', subject_id: '00000000-0000-4000-8000-000000000002', name: '资料', source_filename: 'a.zip', source_sha256: 'a'.repeat(64), imported_at: new Date(), deleted_at: null, created_at: new Date(), updated_at: new Date() }], {}];
      if (sql.includes('FROM chapters')) return [[], {}];
      if (sql.includes('FROM sections')) return [[], {}];
      if (sql.includes('FROM cards')) return [[], {}];
       if (sql.includes('FROM resources')) return [[{ id: 'resource-1', relative_path: relativePath, mime_type: 'image/png', width: null, height: null, sha256, created_at: new Date(), deleted_at: null }], {}];
       if (sql.includes('FROM app_settings')) return [[{ setting_key: 'review.lastCards', setting_value: JSON.stringify({ 'material-1': 'card-1' }) }], {}];
       if (sql.includes('FROM material_covers')) return [[{ id: 'cover-1', material_id: 'material-1', original_resource_id: 'resource-1', thumbnail_resource_id: 'resource-2', created_at: new Date(), updated_at: new Date() }], {}];
      if (sql.includes('FROM review_status_history')) return [[{ id: 'history-1', card_id: 'card-1', from_status: null, to_status: 'unassessed', changed_at: new Date(), source: 'import' }], {}];
      return [[], {}];
    });
    const result = await new DataGovernanceServiceImpl(database, tempDirectory).exportJson();
    assert.equal(result.resources[0]?.contentBase64, source.toString('base64'));
    assert.equal(result.materials[0]?.subjectId, '00000000-0000-4000-8000-000000000002');
    assert.deepEqual(result.courses?.map((item) => item.id), ['00000000-0000-4000-8000-000000000001']);
    assert.deepEqual(result.subjects?.map((item) => item.id), ['00000000-0000-4000-8000-000000000002']);
    assert.equal(result.materialCovers?.[0]?.thumbnailResourceId, 'resource-2');
    assert.equal(result.reviewStatusHistory?.[0]?.source, 'import');
    assert.deepEqual(result.appSettings, [{ settingKey: 'review.lastCards', settingValue: { cardIdsByMaterial: { 'material-1': 'card-1' } } }]);
    assert.equal(result.version, 2);
    assert.deepEqual(result.questionBanks, []);
    assert.deepEqual(result.practiceAttempts, []);
    assert.doesNotMatch(JSON.stringify(result), /api[_-]?key|ciphertext|password|tunnel/i);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test('JSON v2 恢复题库、题目 AI 版本和作答快照，并保留题目版本', async () => {
  const statements: string[] = [];
  const database = fakeDatabase(async (sql) => {
    statements.push(sql);
    return [[], {}];
  });
  const timestamp = '2026-08-11T00:00:00.000Z';
  const payload: DataJsonExportV2 = {
    format: 'knowledge-flashcards-json',
    version: 2,
    exportedAt: timestamp,
    materials: [], chapters: [], sections: [], cards: [], resources: [], highlights: [], reviewRecords: [], aiExplanations: [], trashItems: [], appSettings: [],
    questionBanks: [{ id: 'bank-1', subjectId: '00000000-0000-4000-8000-000000000002', kind: 'chapter', name: '章节题', sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    questionChapters: [{ id: 'question-chapter-1', questionBankId: 'bank-1', title: '第一章', sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    questions: [{ id: 'question-1', questionBankId: 'bank-1', questionChapterId: 'question-chapter-1', stem: [{ type: 'paragraph', children: [{ type: 'text', value: '题干' }] }], type: 'single', options: [{ key: 'A', content: [{ type: 'text', value: '对' }] }, { key: 'B', content: [{ type: 'text', value: '错' }] }], answer: ['A'], analysis: null, knowledgePoints: ['知识点'], version: 3, sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    questionAiExplanations: [{ id: 'question-ai-1', questionId: 'question-1', questionVersion: 3, provider: 'deepseek', model: 'model-1', promptText: '', content: '讲解', generatedAt: timestamp }],
    practiceSessions: [{ id: 'session-1', questionBankId: 'bank-1', questionChapterId: 'question-chapter-1', mode: 'test', source: 'full', scope: { questionIds: ['question-1'] }, status: 'completed', startedAt: timestamp, completedAt: timestamp, createdAt: timestamp, updatedAt: timestamp }],
    practiceAttempts: [{ id: 'attempt-1', practiceSessionId: 'session-1', questionId: 'question-1', questionVersion: 3, sortOrder: 0, snapshot: { stem: '题干', options: { A: '对', B: '错' }, answer: ['A'] }, answer: ['B'], result: 'incorrect', answeredAt: timestamp, createdAt: timestamp, updatedAt: timestamp }],
  };
  const result = await new DataGovernanceServiceImpl(database, path.join(os.tmpdir(), 'missing-resources'), path.join(os.tmpdir(), 'missing-backups')).restoreJson(payload);
  assert.deepEqual(result.questionBankCount, 1);
  assert.deepEqual(result.questionChapterCount, 1);
  assert.deepEqual(result.questionCount, 1);
  assert.deepEqual(result.questionAiExplanationCount, 1);
  assert.deepEqual(result.practiceSessionCount, 1);
  assert.deepEqual(result.practiceAttemptCount, 1);
  assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO questions')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO question_ai_explanations')));
  assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO questions')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO practice_attempts')));
});

test('JSON 恢复会校验敏感字段并执行事务替换', async () => {
  const backupsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-restore-backups-'));
  let beginCount = 0;
  let commitCount = 0;
  let deleteCount = 0;
  const database = fakeDatabase(async (sql) => {
    if (sql.includes('SELECT relative_path')) return [[], {}];
    if (sql.startsWith('DELETE FROM')) deleteCount += 1;
    return [[], {}];
  });
  database.getConnection = async () => ({
    execute: async (sql) => {
      if (sql.startsWith('DELETE FROM')) deleteCount += 1;
      return [[], {}];
    },
    beginTransaction: async () => { beginCount += 1; },
    commit: async () => { commitCount += 1; },
    rollback: async () => undefined,
    release: () => undefined,
  });
  try {
    const service = new DataGovernanceServiceImpl(database, path.join(os.tmpdir(), 'missing-resources'), backupsDirectory);
    const result = await service.restoreJson(emptyExport());
    assert.deepEqual(result, { materialCount: 0, chapterCount: 0, sectionCount: 0, cardCount: 0, resourceCount: 0, highlightCount: 0, courseCount: 1, subjectCount: 1, materialCoverCount: 0, reviewStatusHistoryCount: 0 });
    assert.equal(beginCount, 1);
    assert.equal(commitCount, 1);
    assert.ok(deleteCount >= 14);

    await assert.rejects(
      () => service.restoreJson({ ...emptyExport(), apiKey: 'do-not-restore' }),
      (error: unknown) => error instanceof DataGovernanceApiError && error.statusCode === 400,
    );
  } finally {
    await fs.rm(backupsDirectory, { recursive: true, force: true });
  }
});

test('JSON 恢复会保留课程、科目、封面和掌握状态历史的关联顺序', async () => {
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-catalog-restore-resources-'));
  const backupsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-catalog-restore-backups-'));
  const statements: string[] = [];
  const database = fakeDatabase(async (sql) => {
    if (sql.includes('SELECT relative_path')) return [[], {}];
    return [[], {}];
  });
  database.getConnection = async () => ({
    execute: async (sql) => {
      statements.push(sql);
      return [[], {}];
    },
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  });
  const timestamp = '2026-08-11T00:00:00.000Z';
  const originalCover = Buffer.from('original-cover');
  const thumbnailCover = Buffer.from('thumbnail-cover');
  const payload: DataJsonExport = {
    ...emptyExport(),
    exportedAt: timestamp,
    courses: [
      { id: '00000000-0000-4000-8000-000000000001', name: '待整理', sortOrder: 0, isSystem: true, deletedAt: null, createdAt: timestamp, updatedAt: timestamp },
      { id: 'course-1', name: '课程', sortOrder: 1, isSystem: false, deletedAt: null, createdAt: timestamp, updatedAt: timestamp },
    ],
    subjects: [
      { id: '00000000-0000-4000-8000-000000000002', courseId: '00000000-0000-4000-8000-000000000001', name: '待整理', sortOrder: 0, isSystem: true, deletedAt: null, createdAt: timestamp, updatedAt: timestamp },
      { id: 'subject-1', courseId: 'course-1', name: '科目', sortOrder: 2, isSystem: false, deletedAt: null, createdAt: timestamp, updatedAt: timestamp },
    ],
    materials: [{ id: 'material-1', subjectId: 'subject-1', name: '资料', sourceFilename: '资料.md', sourceSha256: 'a'.repeat(64), importedAt: timestamp, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    chapters: [{ id: 'chapter-1', materialId: 'material-1', title: '第一章', sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    sections: [{ id: 'section-1', chapterId: 'chapter-1', title: '第一节', sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    cards: [{ id: 'card-1', sectionId: 'section-1', title: '第一张', content: [], masteryStatus: 'mastered', sortOrder: 0, deletedAt: null, createdAt: timestamp, updatedAt: timestamp }],
    resources: [
      { id: 'resource-1', relativePath: 'covers/original.png', mimeType: 'image/png', width: 1000, height: 750, sha256: createHash('sha256').update(originalCover).digest('hex'), createdAt: timestamp, deletedAt: null, contentBase64: originalCover.toString('base64') },
      { id: 'resource-2', relativePath: 'covers/thumbnail.webp', mimeType: 'image/webp', width: 512, height: 384, sha256: createHash('sha256').update(thumbnailCover).digest('hex'), createdAt: timestamp, deletedAt: null, contentBase64: thumbnailCover.toString('base64') },
    ],
    materialCovers: [{ id: 'cover-1', materialId: 'material-1', originalResourceId: 'resource-1', thumbnailResourceId: 'resource-2', createdAt: timestamp, updatedAt: timestamp }],
    reviewStatusHistory: [{ id: 'history-1', cardId: 'card-1', fromStatus: 'unassessed', toStatus: 'mastered', changedAt: timestamp, source: 'review' }],
    appSettings: [{ settingKey: 'review.lastCards', settingValue: { cardIdsByMaterial: { 'material-1': 'card-1' } } }],
  };
  try {
    const result = await new DataGovernanceServiceImpl(database, resourcesDirectory, backupsDirectory).restoreJson(payload);
    assert.deepEqual(result, { materialCount: 1, chapterCount: 1, sectionCount: 1, cardCount: 1, resourceCount: 2, highlightCount: 0, courseCount: 2, subjectCount: 2, materialCoverCount: 1, reviewStatusHistoryCount: 1 });
    assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO courses')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO subjects')));
    assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO subjects')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO materials')));
    assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO resources')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO material_covers')));
    assert.ok(statements.some((sql) => sql.startsWith('INSERT INTO app_settings')));
    assert.ok(statements.findIndex((sql) => sql.startsWith('INSERT INTO cards')) < statements.findIndex((sql) => sql.startsWith('INSERT INTO review_status_history')));
    assert.deepEqual(await fs.readFile(path.join(resourcesDirectory, 'covers', 'original.png')), originalCover);
    assert.deepEqual(await fs.readFile(path.join(resourcesDirectory, 'covers', 'thumbnail.webp')), thumbnailCover);
  } finally {
    await fs.rm(resourcesDirectory, { recursive: true, force: true });
    await fs.rm(backupsDirectory, { recursive: true, force: true });
  }
});

test('手动备份会写入 JSON 快照、资源副本和 manifest', async () => {
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-backup-resources-'));
  const backupsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-backup-output-'));
  try {
    const relativePath = 'material-1/images/a.png';
    const source = Buffer.from('backup-resource');
    const sha256 = createHash('sha256').update(source).digest('hex');
    await fs.mkdir(path.join(resourcesDirectory, 'material-1', 'images'), { recursive: true });
    await fs.writeFile(path.join(resourcesDirectory, relativePath), source);
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('FROM materials')) return [[{ id: 'material-1', name: '资料', source_filename: 'a.zip', source_sha256: 'a'.repeat(64), imported_at: new Date(), deleted_at: null, created_at: new Date(), updated_at: new Date() }], {}];
      if (sql.includes('FROM resources')) return [[{ id: 'resource-1', relative_path: relativePath, mime_type: 'image/png', width: null, height: null, sha256, created_at: new Date(), deleted_at: null }], {}];
      return [[], {}];
    });
    const service = new DataGovernanceServiceImpl(database, resourcesDirectory, backupsDirectory);
    const result = await service.createBackup();
    assert.equal(result.backup.status, 'succeeded');
    const backupDirectory = path.join(backupsDirectory, result.backup.id);
    assert.equal(await fs.readFile(path.join(backupDirectory, 'resources', relativePath), 'utf8'), 'backup-resource');
    const manifest = JSON.parse(await fs.readFile(path.join(backupDirectory, 'manifest.json'), 'utf8')) as { files: Array<{ path: string }> };
    assert.deepEqual(manifest.files.map((file) => file.path), ['data.json', `resources/${relativePath}`]);
  } finally {
    await fs.rm(resourcesDirectory, { recursive: true, force: true });
    await fs.rm(backupsDirectory, { recursive: true, force: true });
  }
});

test('永久删除回收站闪卡会清理关联资源文件', async () => {
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-trash-resources-'));
  try {
    const relativePath = 'material-1/images/remove.png';
    await fs.mkdir(path.join(resourcesDirectory, 'material-1', 'images'), { recursive: true });
    await fs.writeFile(path.join(resourcesDirectory, relativePath), 'remove-me');
    const database = fakeDatabase(async (sql) => {
      if (sql.includes('SELECT entity_type, entity_id FROM trash_items')) return [[{ entity_type: 'card', entity_id: 'card-1' }], {}];
      if (sql.includes('SELECT id, content_json FROM cards')) return [[{ id: 'card-1', content_json: JSON.stringify([{ type: 'image', resourceId: 'resource-1' }]) }], {}];
      if (sql.includes('SELECT id, relative_path FROM resources')) return [[{ id: 'resource-1', relative_path: relativePath }], {}];
      if (sql.includes('SELECT content_json FROM cards')) return [[], {}];
      return [[], {}];
    });
    const service = new DataGovernanceServiceImpl(database, resourcesDirectory, path.join(resourcesDirectory, 'backups'));
    const result = await service.permanentlyDeleteTrashItem('trash-1');
    assert.deepEqual(result, { deletedEntityCount: 1, deletedResourceCount: 1 });
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, relativePath)));
  } finally {
    await fs.rm(resourcesDirectory, { recursive: true, force: true });
  }
});

test('永久删除带封面的资料会清理封面关联、状态历史和封面资源', async () => {
  const resourcesDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-trash-cover-'));
  try {
    const originalPath = 'covers/original.png';
    const thumbnailPath = 'covers/thumbnail.webp';
    await fs.mkdir(path.join(resourcesDirectory, 'covers'), { recursive: true });
    await fs.writeFile(path.join(resourcesDirectory, originalPath), 'original');
    await fs.writeFile(path.join(resourcesDirectory, thumbnailPath), 'thumbnail');
    const statements: string[] = [];
    const database = fakeDatabase(async (sql) => {
      statements.push(sql);
      if (sql.includes('SELECT entity_type, entity_id FROM trash_items')) return [[{ entity_type: 'material', entity_id: 'material-1' }], {}];
      if (sql === 'SELECT id FROM chapters WHERE material_id = ?') return [[{ id: 'chapter-1' }], {}];
      if (sql.includes('SELECT id FROM sections WHERE chapter_id IN')) return [[{ id: 'section-1' }], {}];
      if (sql.includes('SELECT id FROM cards WHERE section_id IN')) return [[{ id: 'card-1' }], {}];
      if (sql.includes('SELECT id, content_json FROM cards')) return [[{ id: 'card-1', content_json: '[]' }], {}];
      if (sql.includes('FROM material_covers WHERE material_id')) return [[{ original_resource_id: 'original-1', thumbnail_resource_id: 'thumbnail-1' }], {}];
      if (sql.includes('SELECT id, relative_path FROM resources')) return [[
        { id: 'original-1', relative_path: originalPath },
        { id: 'thumbnail-1', relative_path: thumbnailPath },
      ], {}];
      if (sql.includes('SELECT content_json FROM cards')) return [[], {}];
      return [[], {}];
    });
    const service = new DataGovernanceServiceImpl(database, resourcesDirectory, path.join(resourcesDirectory, 'backups'));

    const result = await service.permanentlyDeleteTrashItem('trash-1');

    assert.deepEqual(result, { deletedEntityCount: 4, deletedResourceCount: 2 });
    assert.ok(statements.some((sql) => sql.includes('DELETE FROM material_covers WHERE material_id')));
    assert.ok(statements.some((sql) => sql.includes('DELETE FROM review_status_history WHERE card_id')));
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, originalPath)));
    await assert.rejects(() => fs.access(path.join(resourcesDirectory, thumbnailPath)));
  } finally {
    await fs.rm(resourcesDirectory, { recursive: true, force: true });
  }
});
