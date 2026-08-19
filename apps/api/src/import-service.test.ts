import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import type { ImportCorrectionDocument } from '@knowledge-flashcards/shared';
import {
  ImportApiError,
  ImportService,
  type ImportDatabase,
  type ImportDatabaseConnection,
} from './import-service.js';
import { encryptAiProviderApiKey } from './ai-provider-service.js';

interface Statement {
  sql: string;
  values: readonly unknown[];
}

function duplicateRowsForQuery(sql: string, duplicateRows: unknown[]) {
  if (!sql.includes('deleted_at IS NULL')) {
    return duplicateRows;
  }
  return duplicateRows.filter((row) => {
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      return true;
    }
    return row.deleted_at === null || row.deleted_at === undefined;
  });
}

const importDestination = {
  courseId: 'course-1',
  subjectId: 'subject-1',
};

class FakeConnection implements ImportDatabaseConnection {
  readonly statements: Statement[] = [];
  transactionStarted = false;
  committed = false;
  rolledBack = false;

  constructor(
    private readonly duplicateRows: unknown[] = [],
    private readonly failureText: string | null = null,
    private readonly destinationRows: unknown[] = [{ id: importDestination.subjectId }],
  ) {}

  async execute(sql: string, values: readonly unknown[] = []) {
    this.statements.push({ sql, values });
    if (this.failureText && sql.includes(this.failureText)) {
      throw new Error('模拟数据库写入失败。');
    }
    if (sql.startsWith('SELECT id, name, imported_at')) {
      return [duplicateRowsForQuery(sql, this.duplicateRows), []];
    }
    if (sql.includes('FROM subjects AS subject')) {
      return [this.destinationRows, []];
    }
    return [[], []];
  }

  async beginTransaction() {
    this.transactionStarted = true;
  }

  async commit() {
    this.committed = true;
  }

  async rollback() {
    this.rolledBack = true;
  }

  release() {}
}

class FakeDatabase implements ImportDatabase {
  readonly statements: Statement[] = [];
  readonly connection: FakeConnection;
  private readonly duplicateRows: unknown[];

  constructor(
    duplicateRows: unknown[] = [],
    failureText: string | null = null,
    destinationRows: unknown[] = [{ id: importDestination.subjectId }],
  ) {
    this.duplicateRows = duplicateRows;
    this.connection = new FakeConnection(duplicateRows, failureText, destinationRows);
  }

  async execute(sql: string, values: readonly unknown[] = []) {
    this.statements.push({ sql, values });
    if (sql.startsWith('SELECT id, name, imported_at')) {
      return [duplicateRowsForQuery(sql, this.duplicateRows), []];
    }
    return [[], []];
  }

  async getConnection() {
    return this.connection;
  }
}

function correctionFromPreview(document: {
  title: string;
  chapters: Array<{
    title: string;
    sections: Array<{ title: string; cards: Array<{ title: string; bodyText: string }> }>;
  }>;
}): ImportCorrectionDocument {
  return {
    title: document.title,
    chapters: document.chapters.map((chapter) => ({
      title: chapter.title,
      sections: chapter.sections.map((section) => ({
        title: section.title,
        cards: section.cards.map((card) => ({ title: card.title, bodyText: card.bodyText })),
      })),
    })),
  };
}

async function createZipSource() {
  const zip = new JSZip();
  zip.file(
    'lesson.md',
    '# 原资料\n## 第一章\n### 第一节\n#### 第一个知识点\n正文内容\n\n![示意图](images/diagram.png)',
  );
  zip.file('images/diagram.png', Buffer.from([1, 2, 3, 4]));
  return zip.generateAsync({ type: 'nodebuffer' });
}

function createHighlightedJsonSource() {
  return Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '带标注资料',
    chapters: [{
      title: '第一章',
      sections: [{
        title: '第一节',
        cards: [{
          title: '第一张卡',
          body: '牛顿第二定律为 $F = ma$，[[hl:力和加速度成正比]]。',
          highlights: [{ formula: 'F = ma' }],
        }],
      }],
    }],
  }));
}

async function createService(database: ImportDatabase) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-import-'));
  const service = new ImportService({
    database,
    resourcesDirectory: path.join(root, 'resources'),
  });
  return { root, service };
}

class AiCorrectionDatabase extends FakeDatabase {
  constructor(private readonly providerRows: unknown[]) {
    super();
  }

  override async execute(sql: string, values: readonly unknown[] = []) {
    if (sql.includes('FROM ai_provider_profiles')) {
      return [this.providerRows, []];
    }
    return super.execute(sql, values);
  }
}

async function createAiCorrectionService(
  database: ImportDatabase,
  fetchImplementation: typeof fetch,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-import-ai-'));
  const service = new ImportService({
    database,
    resourcesDirectory: path.join(root, 'resources'),
    encryptionSecret: 'test-encryption-secret-at-least-32-characters',
    fetchImplementation,
  });
  return { root, service };
}

test('合法 ZIP 可以预览、修正并事务写入，资源进入资料隔离目录', async () => {
  const database = new FakeDatabase();
  const { root, service } = await createService(database);
  const source = await createZipSource();
  const originalSource = Buffer.from(source);

  try {
    const preview = await service.preview('学习资料.zip', source);

    assert.equal(preview.valid, true);
    assert.equal(preview.duplicate, false);
    assert.ok(preview.previewId);
    assert.equal(preview.resources[0]?.relativePath, 'images/diagram.png');
    assert.deepEqual(source, originalSource);

    const document = correctionFromPreview(preview.document!);
    document.title = '修正后的资料';
    document.chapters[0]!.sections[0]!.cards[0]!.title = '修正后的知识点';
    document.chapters[0]!.sections[0]!.cards[0]!.bodyText = '修正后的正文';
    const result = await service.apply({ previewId: preview.previewId!, document, ...importDestination });

    assert.equal(result.status, 'applied');
    if (result.status !== 'applied') {
      return;
    }
    assert.equal(result.materialName, '修正后的资料');
    assert.equal(result.chapterCount, 1);
    assert.equal(result.sectionCount, 1);
    assert.equal(result.cardCount, 1);
    assert.equal(result.resourceCount, 1);
    assert.equal(database.connection.transactionStarted, true);
    assert.equal(database.connection.committed, true);

    const resourcePath = path.join(root, 'resources', result.materialId, 'images', 'diagram.png');
    assert.deepEqual(await fs.readFile(resourcePath), Buffer.from([1, 2, 3, 4]));
    const cardInsert = database.connection.statements.find((statement) => statement.sql.includes('INSERT INTO cards'));
    assert.ok(cardInsert);
    assert.match(String(cardInsert?.values[3]), /修正后的正文/);
    const materialInsert = database.connection.statements.find((statement) => statement.sql.includes('INSERT INTO materials'));
    assert.ok(materialInsert);
    assert.equal(materialInsert?.values[1], importDestination.subjectId);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JSON 导入会将文本和公式高亮写入 highlights 表', async () => {
  const database = new FakeDatabase();
  const { root, service } = await createService(database);

  try {
    const preview = await service.preview('带标注.json', createHighlightedJsonSource());
    assert.equal(preview.valid, true);
    const result = await service.apply({
      previewId: preview.previewId!,
      document: correctionFromPreview(preview.document!),
      ...importDestination,
    });
    assert.equal(result.status, 'applied');
    const highlightStatements = database.connection.statements.filter((statement) => statement.sql.includes('INSERT INTO highlights'));
    assert.equal(highlightStatements.length, 2);
    assert.deepEqual(highlightStatements.map((statement) => statement.values[2]), ['text', 'formula']);
    assert.match(String(highlightStatements[0]?.values[3]), /nodePath/);
    const cardInsert = database.connection.statements.find((statement) => statement.sql.includes('INSERT INTO cards'));
    assert.equal(String(cardInsert?.values[3]).includes('[[hl:'), false);
    assert.match(String(cardInsert?.values[3]), /力和加速度成正比/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JSON 高亮在预览修正后无法匹配时会回滚应用', async () => {
  const database = new FakeDatabase();
  const { root, service } = await createService(database);

  try {
    const preview = await service.preview('带标注.json', createHighlightedJsonSource());
    const document = correctionFromPreview(preview.document!);
    document.chapters[0]!.sections[0]!.cards[0]!.bodyText = '修正后不再包含原有重点。';
    await assert.rejects(
      service.apply({ previewId: preview.previewId!, document, ...importDestination }),
      (error: unknown) => error instanceof ImportApiError && error.statusCode === 400 && /高亮无法匹配/.test(error.message),
    );
    assert.equal(database.connection.rolledBack, true);
    assert.equal(database.connection.statements.some((statement) => statement.sql.includes('INSERT INTO highlights')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('内联高亮在正文修改后只允许唯一重新定位', async () => {
  const duplicateDatabase = new FakeDatabase();
  const uniqueDatabase = new FakeDatabase();
  const duplicateService = await createService(duplicateDatabase);
  const uniqueService = await createService(uniqueDatabase);
  const source = Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-material',
    version: 1,
    title: '内联高亮资料',
    chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '[[hl:重点]]，重点。' }] }] }],
  }));

  try {
    const duplicatePreview = await duplicateService.service.preview('重复目标.json', source);
    const duplicateDocument = correctionFromPreview(duplicatePreview.document!);
    duplicateDocument.chapters[0]!.sections[0]!.cards[0]!.bodyText += ' 已修改。';
    await assert.rejects(
      duplicateService.service.apply({ previewId: duplicatePreview.previewId!, document: duplicateDocument, ...importDestination }),
      (error: unknown) => error instanceof ImportApiError && /高亮无法匹配/.test(error.message),
    );

    const uniquePreview = await uniqueService.service.preview('唯一目标.json', source);
    const uniqueDocument = correctionFromPreview(uniquePreview.document!);
    uniqueDocument.chapters[0]!.sections[0]!.cards[0]!.bodyText = '修改后只保留一个重点。';
    const result = await uniqueService.service.apply({
      previewId: uniquePreview.previewId!,
      document: uniqueDocument,
      ...importDestination,
    });
    assert.equal(result.status, 'applied');
    const highlightInsert = uniqueDatabase.connection.statements.find((statement) => statement.sql.includes('INSERT INTO highlights'));
    assert.deepEqual(JSON.parse(String(highlightInsert?.values[3])), { nodePath: '0.0', start: 8, end: 10 });
  } finally {
    await fs.rm(duplicateService.root, { recursive: true, force: true });
    await fs.rm(uniqueService.root, { recursive: true, force: true });
  }
});

test('相同源文件默认跳过，不写入新资料或资源', async () => {
  const duplicateRows = [{ id: 'existing-id', name: '已有资料', imported_at: '2026-08-10 10:00:00' }];
  const database = new FakeDatabase(duplicateRows);
  const { root, service } = await createService(database);
  const source = await createZipSource();

  try {
    const preview = await service.preview('学习资料.zip', source);
    assert.equal(preview.valid, true);
    assert.equal(preview.duplicate, true);
    assert.equal(preview.duplicateMaterial?.id, 'existing-id');

    const result = await service.apply({
      previewId: preview.previewId!,
      document: correctionFromPreview(preview.document!),
      ...importDestination,
    });

    assert.deepEqual(result, {
      status: 'skipped',
      reason: 'duplicate',
      material: {
        id: 'existing-id',
        name: '已有资料',
        importedAt: '2026-08-10 10:00:00',
      },
    });
    assert.equal(database.connection.committed, true);
    assert.equal(database.connection.statements.some((statement) => statement.sql.includes('INSERT INTO')), false);
    assert.equal(await fs.stat(path.join(root, 'resources')).catch(() => null), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('回收箱中的同源资料不会阻止重新导入', async () => {
  const duplicateRows = [{
    id: 'trashed-id',
    name: '回收箱资料',
    imported_at: '2026-08-10 10:00:00',
    deleted_at: '2026-08-11 10:00:00',
  }];
  const database = new FakeDatabase(duplicateRows);
  const { root, service } = await createService(database);
  const source = await createZipSource();

  try {
    const preview = await service.preview('学习资料.zip', source);
    assert.equal(preview.valid, true);
    assert.equal(preview.duplicate, false);
    assert.equal(preview.duplicateMaterial, null);

    const result = await service.apply({
      previewId: preview.previewId!,
      document: correctionFromPreview(preview.document!),
      ...importDestination,
    });

    assert.equal(result.status, 'applied');
    assert.equal(database.connection.statements.some((statement) => statement.sql.includes('INSERT INTO materials')), true);
    const duplicateQueries = [...database.statements, ...database.connection.statements]
      .filter((statement) => statement.sql.startsWith('SELECT id, name, imported_at'));
    assert.equal(duplicateQueries.length, 2);
    assert.equal(duplicateQueries.every((statement) => statement.sql.includes('deleted_at IS NULL')), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('数据库写入失败会回滚并清理已复制资源', async () => {
  const database = new FakeDatabase([], 'INSERT INTO cards');
  const { root, service } = await createService(database);
  const source = await createZipSource();

  try {
    const preview = await service.preview('学习资料.zip', source);
    const document = correctionFromPreview(preview.document!);
    await assert.rejects(
      service.apply({ previewId: preview.previewId!, document, ...importDestination }),
      (error: unknown) => error instanceof ImportApiError && error.statusCode === 500,
    );

    assert.equal(database.connection.rolledBack, true);
    assert.deepEqual(await fs.readdir(path.join(root, 'resources')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('应用导入必须选择归属，且科目必须属于所选课程', async () => {
  const database = new FakeDatabase([], null, []);
  const { root, service } = await createService(database);
  const source = await createZipSource();

  try {
    const preview = await service.preview('学习资料.zip', source);
    const document = correctionFromPreview(preview.document!);
    await assert.rejects(
      service.apply({ previewId: preview.previewId!, document, subjectId: importDestination.subjectId } as ImportCorrectionDocument & { previewId: string; subjectId: string }),
      (error: unknown) => error instanceof ImportApiError && error.statusCode === 400 && error.message === '请选择课程。',
    );
    await assert.rejects(
      service.apply({ previewId: preview.previewId!, document, ...importDestination }),
      (error: unknown) => error instanceof ImportApiError && error.statusCode === 400 && error.message === '所选科目不属于所选课程，请重新选择。',
    );
    assert.equal(database.connection.statements.some((statement) => statement.sql.includes('INSERT INTO materials')), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('单 Markdown 引用本地图片时必须改用 ZIP', async () => {
  const database = new FakeDatabase();
  const { root, service } = await createService(database);

  try {
    const preview = await service.preview('学习资料.md', Buffer.from(
      '# 资料\n## 章\n### 节\n#### 卡\n正文\n\n![图](images/a.png)',
    ));

    assert.equal(preview.valid, false);
    assert.equal(preview.previewId, null);
    assert.equal(preview.issues.some((issue) => issue.code === 'missing_image'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 格式修正提示 Provider 只处理格式并重新解析正文', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  let providerBody = '';
  const { root, service } = await createAiCorrectionService(database, async (_input, init) => {
    providerBody = String(init?.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({ index: 0, body: '公式 $\\frac{a}{b}$。' }) } }],
    }), { status: 200 });
  });

  try {
    const preview = await service.preview('公式.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '公式 $\\frac{a}{b$。' }] }] }],
    })));
    assert.equal(preview.valid, false);
    assert.equal(preview.aiCorrectionAvailable, true);
    assert.ok(preview.previewId);

    const corrected = await service.correctFormat({ previewId: preview.previewId!, issueIndex: 0 });
    assert.equal(corrected.valid, true);
    assert.equal(corrected.issues.length, 0);
    assert.equal(corrected.document?.chapters[0]?.sections[0]?.cards[0]?.bodyText, '公式 [公式]。');
    assert.match(providerBody, /严禁润色、改写、增删、翻译、解释或重排正文内容/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 格式修正兼容代码围栏和单项 cards 响应，并更新预览正文', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  const { root, service } = await createAiCorrectionService(database, async () => new Response(JSON.stringify({
    choices: [{ message: { content: `\`\`\`json\n${JSON.stringify({ cards: [{ index: 0, body: '公式 $\\frac{a}{b}$。' }] })}\n\`\`\`` } }],
  }), { status: 200 }));

  try {
    const preview = await service.preview('公式围栏.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '公式 $\\frac{a}{b$。' }] }] }],
    })));
    const issueIndex = preview.issues.findIndex((issue) => issue.code === 'invalid_formula');
    const corrected = await service.correctFormat({ previewId: preview.previewId!, issueIndex });
    assert.equal(corrected.issues.length, 0);
    assert.equal(corrected.valid, true);
    assert.equal(corrected.document?.chapters[0]?.sections[0]?.cards[0]?.bodyText, '公式 [公式]。');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 未修正当前问题时不写回只修正了其他格式的正文', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  const { root, service } = await createAiCorrectionService(database, async () => new Response(JSON.stringify({
    choices: [{ message: { content: '公式 $\\frac{a}{b$。\n\n正文' } }],
  }), { status: 200 }));

  try {
    const preview = await service.preview('同卡两条问题.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '公式 $\\frac{a}{b$。\n\n<span>正文</span>' }] }] }],
    })));
    const formulaIssueIndex = preview.issues.findIndex((issue) => issue.code === 'invalid_formula');
    assert.equal(preview.issues.some((issue) => issue.code === 'invalid_formula'), true);
    assert.equal(preview.issues.some((issue) => issue.code === 'unsafe_html'), true);
    await assert.rejects(
      service.correctFormat({ previewId: preview.previewId!, issueIndex: formulaIssueIndex }),
      (error: unknown) => error instanceof ImportApiError && error.statusCode === 400 && /未能完成格式修正/.test(error.message),
    );
    assert.equal(preview.issues.length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 返回改写正文时不做正文保真拦截，仍按格式问题重新解析', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  let providerBody = '';
  const { root, service } = await createAiCorrectionService(database, async (_input, init) => {
    providerBody = String(init?.body);
    return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ index: 0, body: '改写后的文字 $\\frac{a}{b}$。' }) } }],
    }), { status: 200 });
  });

  try {
    const preview = await service.preview('公式.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [{ title: '卡', body: '公式 $\\frac{a}{b$。' }] }] }],
    })));
    const corrected = await service.correctFormat({ previewId: preview.previewId!, issueIndex: 0 });
    assert.equal(corrected.valid, true);
    assert.equal(corrected.issues.length, 0);
    assert.equal(corrected.document?.chapters[0]?.sections[0]?.cards[0]?.bodyText, '改写后的文字 [公式]。');
    assert.match(providerBody, /严禁润色、改写、增删、翻译、解释或重排正文内容/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 格式修正不校验既有高亮，也允许应用更新后的预览', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  let providerBody = '';
  const { root, service } = await createAiCorrectionService(database, async (_input, init) => {
    providerBody = String(init?.body);
    return new Response(JSON.stringify({
      choices: [{ message: { content: '替换后的正文' } }],
    }), { status: 200 });
  });

  try {
    const preview = await service.preview('高亮格式问题.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [{
        title: '卡',
        body: '<span>原有重点</span>',
        highlights: [{ text: '原有重点' }],
      }] }] }],
    })));
    const issueIndex = preview.issues.findIndex((issue) => issue.code === 'unsafe_html');
    const corrected = await service.correctFormat({ previewId: preview.previewId!, issueIndex });
    assert.equal(corrected.valid, true);
    assert.equal(corrected.document?.chapters[0]?.sections[0]?.cards[0]?.bodyText, '替换后的正文');
    assert.match(providerBody, /可供既有高亮定位的文字及公式必须保持不变/);

    const result = await service.apply({
      previewId: corrected.previewId!,
      document: correctionFromPreview(corrected.document!),
      ...importDestination,
    });
    assert.equal(result.status, 'applied');
    assert.equal(database.connection.statements.filter((statement) => statement.sql.includes('INSERT INTO highlights')).length, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('AI 格式修正逐条发送对应卡片和错误，允许并发完成', async () => {
  const encryptionSecret = 'test-encryption-secret-at-least-32-characters';
  const database = new AiCorrectionDatabase([{
    id: 'provider-1',
    provider: 'openai',
    base_url: 'https://provider.example/v1',
    model: 'test-model',
    api_key_ciphertext: encryptAiProviderApiKey('test-key', encryptionSecret),
  }]);
  const requests: Array<{ body: string; responseFormat?: unknown }> = [];
  const { root, service } = await createAiCorrectionService(database, async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }>; response_format?: unknown };
    const body = request.messages[1]!.content;
    requests.push({ body, responseFormat: request.response_format });
    const correctedBody = body.includes('\\frac') ? '公式 $\\frac{a}{b}$。' : '正文';
    return new Response(JSON.stringify({
      choices: [{ message: { content: correctedBody } }],
    }), { status: 200 });
  });

  try {
    const preview = await service.preview('两条问题.json', Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '资料',
      chapters: [{ title: '章', sections: [{ title: '节', cards: [
        { title: '公式卡', body: '公式 $\\frac{a}{b$。' },
        { title: 'HTML 卡', body: '<span>正文</span>' },
      ] }] }],
    })));
    const formulaIssueIndex = preview.issues.findIndex((issue) => issue.code === 'invalid_formula');
    const htmlIssueIndex = preview.issues.findIndex((issue) => issue.code === 'unsafe_html');
    assert.ok(preview.previewId);
    assert.ok(formulaIssueIndex >= 0);
    assert.ok(htmlIssueIndex >= 0);

    const corrections = await Promise.all([
      service.correctFormat({ previewId: preview.previewId, issueIndex: formulaIssueIndex }),
      service.correctFormat({ previewId: preview.previewId, issueIndex: htmlIssueIndex }),
    ]);

    assert.equal(corrections[0].valid, false);
    assert.equal(corrections[1].valid, true);
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.body).sort(), ['<span>正文</span>', '公式 $\\frac{a}{b$。']);
    assert.equal(requests.every((request) => !request.body.includes('"card"') && !request.body.includes('"issue"')), true);
    assert.equal(requests.every((request) => request.responseFormat === undefined), true);
    assert.equal(requests.every((request) => request.body.length > 0), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('JSON 语法错误不创建 AI 格式修正预览', async () => {
  const { root, service } = await createService(new FakeDatabase());

  try {
    const preview = await service.preview('损坏.json', Buffer.from('{"format":'));
    assert.equal(preview.valid, false);
    assert.equal(preview.aiCorrectionAvailable, false);
    assert.equal(preview.previewId, null);
    assert.equal(preview.issues.some((issue) => issue.code === 'json_read_error'), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
