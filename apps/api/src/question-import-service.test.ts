import assert from 'node:assert/strict';
import test from 'node:test';
import XlsxPopulate from 'xlsx-populate';
import {
  createQuestionImportTemplate,
  InMemoryQuestionImportPreviewStore,
  QuestionImportApiError,
  QuestionImportService,
  type QuestionImportDatabase,
  type QuestionImportDatabaseConnection,
} from './question-import-service.js';

interface Statement { sql: string; values: readonly unknown[] }

class FakeConnection implements QuestionImportDatabaseConnection {
  readonly statements: Statement[] = [];
  transactionStarted = false;
  committed = false;
  rolledBack = false;

  constructor(
    private readonly duplicate: unknown[] = [],
    private readonly destination: unknown[] = [{ id: 'subject-1' }],
    private readonly failOn: string | null = null,
  ) {}

  async execute(sql: string, values: readonly unknown[] = []) {
    this.statements.push({ sql, values });
    if (this.failOn && sql.includes(this.failOn)) throw new Error('模拟数据库写入失败');
    if (sql.includes('FROM subjects AS subject')) return [this.destination, []];
    if (sql.includes('FROM question_banks WHERE')) return [this.duplicate, []];
    if (sql.includes('COALESCE(MAX(sort_order)')) return [[{ next_order: 0 }], []];
    return [[], []];
  }
  async beginTransaction() { this.transactionStarted = true; }
  async commit() { this.committed = true; }
  async rollback() { this.rolledBack = true; }
  release() {}
}

class FakeDatabase implements QuestionImportDatabase {
  readonly connection: FakeConnection;
  constructor(private readonly duplicate: unknown[] = [], destination: unknown[] = [{ id: 'subject-1' }], failOn: string | null = null) {
    this.connection = new FakeConnection(duplicate, destination, failOn);
  }
  async execute(sql: string, values: readonly unknown[] = []) {
    if (sql.includes('FROM subjects AS subject')) return [[{ id: 'subject-1' }], []];
    if (sql.includes('FROM question_banks WHERE')) return [this.duplicate, []];
    return [[], []];
  }
  async getConnection() { return this.connection; }
}

function service(database: QuestionImportDatabase) {
  return new QuestionImportService({ database, previewStore: new InMemoryQuestionImportPreviewStore() });
}

function source(overrides: Record<string, unknown> = {}) {
  return Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-question-bank',
    version: 1,
    title: '安全生产题库',
    questions: [{
      stem: '以下哪项正确？',
      type: 'single',
      options: { A: '选项一', B: '选项二' },
      answer: 'a',
      analysis: '因为选项一符合定义。',
      knowledgePoints: ['安全管理'],
      ...overrides,
    }],
  }));
}

test('题库 JSON 预览规范化答案、解析正文并事务写入', async () => {
  const database = new FakeDatabase();
  const questionImport = service(database);
  const result = await questionImport.preview('题库.json', source(), 'course-1', 'subject-1', 'official');
  assert.equal(result.valid, true);
  assert.equal(result.document?.questions[0]?.answer[0], 'A');
  assert.equal(result.document?.questions[0]?.analysisText, '因为选项一符合定义。');
  assert.ok(result.previewId);

  const applied = await questionImport.apply({ previewId: result.previewId! });
  assert.equal(applied.questionCount, 1);
  assert.equal(applied.questionChapterCount, 0);
  assert.equal(database.connection.transactionStarted, true);
  assert.equal(database.connection.committed, true);
  assert.equal(database.connection.statements.filter((item) => item.sql.includes('INSERT INTO questions')).length, 1);
});

test('题干超过 255 个字符仍可预览并应用', async () => {
  const database = new FakeDatabase();
  const questionImport = service(database);
  const stem = '题'.repeat(256);
  const preview = await questionImport.preview('长题干.json', source({ stem }), 'course-1', 'subject-1', 'official');
  assert.equal(preview.valid, true);
  assert.equal(preview.document?.questions[0]?.stemText, stem);

  const applied = await questionImport.apply({ previewId: preview.previewId! });
  assert.equal(applied.questionCount, 1);
  assert.equal(database.connection.statements.filter((item) => item.sql.includes('INSERT INTO questions')).length, 1);
});

test('Excel 导入允许超过 255 个字符的题干', async () => {
  const questionImport = service(new FakeDatabase());
  const template = await createQuestionImportTemplate('official', 'excel');
  const workbook = await XlsxPopulate.fromDataAsync(Buffer.from(template.content));
  const stem = '题'.repeat(256);
  workbook.sheet('题库').cell('B2').value(stem);

  const preview = await questionImport.preview(template.fileName, await workbook.outputAsync(), 'course-1', 'subject-1', 'official');
  assert.equal(preview.valid, true);
  assert.equal(preview.document?.questions[0]?.stemText, stem);
});

test('章节题必须按章节导入，选项不能跳号', async () => {
  const valid = await service(new FakeDatabase()).preview('章节.json', Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-question-bank', version: 1, title: '章节库', chapters: [{ title: '第一章', questions: [{ stem: '判断', type: 'true_false', options: { A: '对', B: '错' }, answer: 'A' }] }],
  })), 'course-1', 'subject-1', 'chapter');
  assert.equal(valid.valid, true);
  assert.equal(valid.document?.chapters[0]?.title, '第一章');

  const invalid = await service(new FakeDatabase()).preview('错误.json', source({ options: { A: '一', C: '三' } }), 'course-1', 'subject-1', 'official');
  assert.equal(invalid.valid, false);
  assert.equal(invalid.previewId, null);
  assert.ok(invalid.issues.some((item) => item.message.includes('连续')));
});

test('章节题和真题 Excel 模板可直接预览，且模板不保留空选项', async () => {
  const questionImport = service(new FakeDatabase());
  const chapterTemplate = await createQuestionImportTemplate('chapter', 'excel');
  const chapter = await questionImport.preview(chapterTemplate.fileName, Buffer.from(chapterTemplate.content), 'course-1', 'subject-1', 'chapter');
  assert.equal(chapter.valid, true);
  assert.equal(chapter.document?.chapters[0]?.questions.length, 3);
  assert.deepEqual(chapter.document?.chapters[0]?.questions[0]?.options.map((option) => option.key), ['A', 'B']);

  const officialTemplate = await createQuestionImportTemplate('official', 'excel');
  const official = await questionImport.preview(officialTemplate.fileName, Buffer.from(officialTemplate.content), 'course-1', 'subject-1', 'official');
  assert.equal(official.valid, true);
  assert.equal(official.document?.chapters.length, 0);
  assert.equal(official.document?.questions.length, 3);
});

test('重名题库在预览可见且应用时返回冲突，数据库失败会回滚', async () => {
  const duplicateDb = new FakeDatabase([{ id: 'bank-1', name: '安全生产题库' }]);
  const duplicateService = service(duplicateDb);
  const duplicate = await duplicateService.preview('题库.json', source(), 'course-1', 'subject-1', 'official');
  assert.equal(duplicate.valid, true);
  assert.equal(duplicate.duplicate, true);
  await assert.rejects(() => duplicateService.apply({ previewId: duplicate.previewId! }), (error: unknown) => error instanceof QuestionImportApiError && error.statusCode === 409);

  const failureDb = new FakeDatabase([], [{ id: 'subject-1' }], 'INSERT INTO questions');
  const failureService = service(failureDb);
  const preview = await failureService.preview('题库.json', source(), 'course-1', 'subject-1', 'official');
  await assert.rejects(() => failureService.apply({ previewId: preview.previewId! }), (error: unknown) => error instanceof QuestionImportApiError && error.statusCode === 500);
  assert.equal(failureDb.connection.rolledBack, true);
});
