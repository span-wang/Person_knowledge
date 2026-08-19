import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type {
  CatalogSortDirection,
  QuestionBankQuestionsResponse,
  QuestionBankSummary,
  QuestionChapterSummary,
  QuestionCreateRequest,
  QuestionMoveRequest,
  QuestionMutationResponse,
  QuestionQuestion,
  QuestionReorderRequest,
  QuestionTrashResponse,
  QuestionType,
  QuestionUpdateRequest,
  ReviewContentNode,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

const optionKeys = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
const questionTypes = new Set<QuestionType>(['single', 'multiple', 'true_false']);
const contentTypes = new Set([
  'paragraph', 'text', 'strong', 'emphasis', 'delete', 'inlineCode', 'blockquote', 'list', 'listItem',
  'code', 'heading', 'break', 'thematicBreak', 'link', 'math', 'inlineMath', 'table', 'tableRow', 'tableCell',
]);
const contentKeys = new Set([
  'type', 'value', 'url', 'title', 'lang', 'meta', 'depth', 'ordered', 'start', 'checked', 'display',
  'align', 'rowSpan', 'colSpan', 'children',
]);

export interface QuestionSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface QuestionSqlConnection extends QuestionSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface QuestionDatabase extends QuestionSqlExecutor {
  getConnection(): Promise<QuestionSqlConnection>;
}

export class QuestionApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'QuestionApiError';
  }
}

export interface QuestionService {
  list(bankId: string): Promise<QuestionBankQuestionsResponse>;
  listTrash(bankId: string): Promise<QuestionTrashResponse>;
  create(request: QuestionCreateRequest): Promise<QuestionMutationResponse>;
  update(questionId: string, request: QuestionUpdateRequest): Promise<QuestionMutationResponse>;
  move(questionId: string, request: QuestionMoveRequest): Promise<QuestionMutationResponse>;
  reorder(questionId: string, request: QuestionReorderRequest): Promise<QuestionMutationResponse>;
  remove(questionId: string): Promise<QuestionMutationResponse>;
  restore(questionId: string): Promise<QuestionMutationResponse>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : textValue(value);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new QuestionApiError(400, `${label}无效。`);
  }
  return value.trim();
}

function readDirection(value: unknown): CatalogSortDirection {
  if (value !== 'up' && value !== 'down') {
    throw new QuestionApiError(400, '排序方向无效。');
  }
  return value;
}

function readType(value: unknown): QuestionType {
  if (typeof value !== 'string' || !questionTypes.has(value as QuestionType)) {
    throw new QuestionApiError(400, '题型无效。');
  }
  return value as QuestionType;
}

function readJson(value: unknown, label: string): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      throw new QuestionApiError(409, `${label}已损坏。`);
    }
  }
  return value;
}

function safeContentUrl(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith('//') || (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(?:https?:|mailto:)/i.test(normalized))) {
    throw new QuestionApiError(400, '正文包含不安全链接。');
  }
  return normalized;
}

function normalizeContentNode(value: unknown): ReviewContentNode {
  if (!isRecord(value) || typeof value.type !== 'string' || !contentTypes.has(value.type)) {
    throw new QuestionApiError(400, '正文包含不支持的可视化节点。');
  }
  const node: Record<string, unknown> = { type: value.type };
  for (const [key, child] of Object.entries(value)) {
    if (key === 'type' || child === undefined) continue;
    if (!contentKeys.has(key)) {
      throw new QuestionApiError(400, '正文节点属性无效。');
    }
    if (key === 'children') {
      if (!Array.isArray(child)) throw new QuestionApiError(400, '正文节点子项无效。');
      node.children = child.map(normalizeContentNode);
      continue;
    }
    if (key === 'url') {
      if (typeof child !== 'string') throw new QuestionApiError(400, '正文链接无效。');
      node.url = safeContentUrl(child);
      continue;
    }
    if (key === 'align') {
      if (!Array.isArray(child)) throw new QuestionApiError(400, '正文表格对齐方式无效。');
      node.align = child.map((item) => item === 'left' || item === 'center' || item === 'right' ? item : null);
      continue;
    }
    if (key === 'rowSpan' || key === 'colSpan') {
      if (typeof child !== 'number' || !Number.isInteger(child) || child < 1 || child > 100) {
        throw new QuestionApiError(400, '正文表格跨度无效。');
      }
      node[key] = child;
      continue;
    }
    if (typeof child !== 'string' && typeof child !== 'boolean' && typeof child !== 'number' && child !== null) {
      throw new QuestionApiError(400, '正文节点属性无效。');
    }
    node[key] = child;
  }
  return node as unknown as ReviewContentNode;
}

function normalizeContent(value: unknown, label: string, required: boolean): ReviewContentNode[] | null {
  if (value === null && !required) return null;
  if (!Array.isArray(value) || (required && value.length === 0)) {
    throw new QuestionApiError(400, `${label}不能为空。`);
  }
  const content = value.map(normalizeContentNode);
  if (JSON.stringify(content).length > 1_000_000) {
    throw new QuestionApiError(400, `${label}不能超过 100 万个字符。`);
  }
  return content;
}

function contentText(nodes: ReviewContentNode[]): string {
  return nodes.map((node) => `${node.value ?? ''}${node.children ? contentText(node.children) : ''}`).join('');
}

function normalizedQuestion(request: QuestionCreateRequest | QuestionUpdateRequest) {
  const stem = normalizeContent(request.stem, '题干', true)!;
  if (!contentText(stem).trim()) throw new QuestionApiError(400, '题干不能为空。');
  const type = readType(request.type);
  if (!Array.isArray(request.options) || request.options.length < 2 || request.options.length > 6) {
    throw new QuestionApiError(400, '选项数量必须为 2 到 6 项。');
  }
  const options = request.options.map((item, index) => {
    if (!isRecord(item) || typeof item.key !== 'string' || item.key.trim().toUpperCase() !== optionKeys[index]) {
      throw new QuestionApiError(400, '选项必须从 A 开始连续填写，不能跳号或留空。');
    }
    const content = normalizeContent(item.content, `选项${optionKeys[index]}`, true)!;
    if (!contentText(content).trim()) throw new QuestionApiError(400, `选项${optionKeys[index]}不能为空。`);
    return { key: optionKeys[index]!, content };
  });
  if (!Array.isArray(request.answer)) throw new QuestionApiError(400, '答案必须是选项字母数组。');
  const answer = request.answer.map((item) => typeof item === 'string' ? item.trim().toUpperCase() : '');
  if (!answer.length || answer.some((item) => !(optionKeys as readonly string[]).includes(item)) || new Set(answer).size !== answer.length || answer.some((item) => !options.some((option) => option.key === item))) {
    throw new QuestionApiError(400, '答案必须对应已填写的选项，且不能重复。');
  }
  if (type === 'multiple' ? answer.length < 2 : answer.length !== 1) {
    throw new QuestionApiError(400, type === 'multiple' ? '多选题至少需要两个正确选项。' : '单选题和判断题只能有一个正确选项。');
  }
  if (type === 'true_false' && (options.length !== 2 || contentText(options[0]!.content) !== '对' || contentText(options[1]!.content) !== '错' || !['A', 'B'].includes(answer[0]!))) {
    throw new QuestionApiError(400, '判断题选项必须固定为 A: 对、B: 错。');
  }
  const analysis = normalizeContent(request.analysis, '解析', false);
  const knowledgePoints = Array.isArray(request.knowledgePoints) && request.knowledgePoints.length <= 100
    ? request.knowledgePoints.map((item) => typeof item === 'string' ? item.trim() : '')
    : null;
  if (!knowledgePoints || knowledgePoints.some((item) => !item || item.length > 255)) {
    throw new QuestionApiError(400, '知识点必须是不超过 100 项的非空文本。');
  }
  return { stem, type, options, answer, analysis, knowledgePoints };
}

async function transaction<T>(database: QuestionDatabase, run: (connection: QuestionSqlConnection) => Promise<T>): Promise<T> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function activeBank(database: QuestionSqlExecutor, bankId: string, forUpdate = false) {
  const id = requiredId(bankId, '题库标识');
  const [rows] = await database.execute(`
    SELECT b.id, b.subject_id, b.kind, b.name, b.sort_order, COUNT(DISTINCT q.id) AS question_count, COUNT(DISTINCT ch.id) AS chapter_count
    FROM question_banks AS b
    LEFT JOIN questions AS q ON q.question_bank_id = b.id AND q.deleted_at IS NULL
    LEFT JOIN question_chapters AS ch ON ch.question_bank_id = b.id AND ch.deleted_at IS NULL
    WHERE b.id = ? AND b.deleted_at IS NULL
    GROUP BY b.id, b.subject_id, b.kind, b.name, b.sort_order
    LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionApiError(404, '题库不存在或已删除。');
  const kind = textValue(row.kind);
  if (kind !== 'chapter' && kind !== 'official' && kind !== 'mock') throw new QuestionApiError(409, '题库类型已损坏。');
  return {
    id, subjectId: textValue(row.subject_id), kind,
    summary: { id, subjectId: textValue(row.subject_id), kind, name: textValue(row.name), sortOrder: numberValue(row.sort_order), questionCount: numberValue(row.question_count), chapterCount: numberValue(row.chapter_count) } satisfies QuestionBankSummary,
  };
}

async function activeQuestion(database: QuestionSqlExecutor, questionId: string, forUpdate = false) {
  const id = requiredId(questionId, '题目标识');
  const [rows] = await database.execute(`SELECT id, question_bank_id, question_chapter_id, sort_order FROM questions WHERE id = ? AND deleted_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionApiError(404, '题目不存在或已删除。');
  return { id, questionBankId: textValue(row.question_bank_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), sortOrder: numberValue(row.sort_order) };
}

async function activeChapter(database: QuestionSqlExecutor, chapterId: string, forUpdate = false) {
  const id = requiredId(chapterId, '章节标识');
  const [rows] = await database.execute(`SELECT id, question_bank_id FROM question_chapters WHERE id = ? AND deleted_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionApiError(404, '章节不存在或已删除。');
  return { id, questionBankId: textValue(row.question_bank_id) };
}

async function destination(database: QuestionSqlExecutor, bankId: unknown, chapterId: unknown) {
  const bank = await activeBank(database, requiredId(bankId, '题库标识'), true);
  if (bank.kind !== 'chapter') {
    if (chapterId !== null && chapterId !== undefined) throw new QuestionApiError(400, '真题和模拟题不能归属章节。');
    return { bank, chapterId: null };
  }
  if (chapterId === null || chapterId === undefined) throw new QuestionApiError(400, '章节题必须选择章节。');
  const chapter = await activeChapter(database, requiredId(chapterId, '章节标识'), true);
  if (chapter.questionBankId !== bank.id) throw new QuestionApiError(400, '章节不属于所选题库。');
  return { bank, chapterId: chapter.id };
}

function questionFromRow(row: Record<string, unknown>): QuestionQuestion {
  const stem = normalizeContent(readJson(row.stem_json, '题干'), '题干', true)!;
  const rawOptions = readJson(row.options_json, '题目选项');
  const options = Array.isArray(rawOptions) ? rawOptions.map((item, index) => {
    if (!isRecord(item) || typeof item.key !== 'string' || item.key !== optionKeys[index]) throw new QuestionApiError(409, '题目选项已损坏。');
    return { key: item.key, content: normalizeContent(item.content, `选项${item.key}`, true)! };
  }) : [];
  const rawAnswer = readJson(row.answer_json, '题目答案');
  const answer = Array.isArray(rawAnswer) ? rawAnswer.map((item) => textValue(item).toUpperCase()) : [];
  const data = normalizedQuestion({
    questionBankId: textValue(row.question_bank_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id),
    stem, type: readType(row.question_type), options, answer,
    analysis: row.analysis_json === null ? null : normalizeContent(readJson(row.analysis_json, '解析'), '解析', false),
    knowledgePoints: readJson(row.knowledge_points_json, '题目知识点') as string[],
  });
  return { id: textValue(row.id), questionBankId: textValue(row.question_bank_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), ...data, version: numberValue(row.version), sortOrder: numberValue(row.sort_order), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) };
}

async function listFrom(database: QuestionSqlExecutor, bankId: string): Promise<QuestionBankQuestionsResponse> {
  const bank = await activeBank(database, bankId);
  const [chapterRows, questionRows] = await Promise.all([
    database.execute('SELECT id, question_bank_id, title, sort_order, (SELECT COUNT(*) FROM questions AS q WHERE q.question_chapter_id = question_chapters.id AND q.deleted_at IS NULL) AS question_count FROM question_chapters WHERE question_bank_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id', [bank.id]),
    database.execute('SELECT id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order, created_at, updated_at FROM questions WHERE question_bank_id = ? AND deleted_at IS NULL ORDER BY question_chapter_id IS NOT NULL, question_chapter_id, sort_order, created_at, id', [bank.id]),
  ]);
  const chapters: QuestionChapterSummary[] = rowsFrom(chapterRows[0]).map((row) => ({ id: textValue(row.id), questionBankId: textValue(row.question_bank_id), title: textValue(row.title), sortOrder: numberValue(row.sort_order), questionCount: numberValue(row.question_count) }));
  return { bank: bank.summary, chapters, questions: rowsFrom(questionRows[0]).map(questionFromRow) };
}

async function nextOrder(database: QuestionSqlExecutor, bankId: string, chapterId: string | null) {
  const [rows] = await database.execute(
    chapterId === null
      ? 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM questions WHERE question_bank_id = ? AND question_chapter_id IS NULL AND deleted_at IS NULL'
      : 'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM questions WHERE question_chapter_id = ? AND deleted_at IS NULL',
    [chapterId === null ? bankId : chapterId],
  );
  return numberValue(rowsFrom(rows)[0]?.next_order);
}

async function normalizeOrder(database: QuestionSqlExecutor, bankId: string, chapterId: string | null) {
  const [rows] = await database.execute(
    chapterId === null
      ? 'SELECT id FROM questions WHERE question_bank_id = ? AND question_chapter_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at, id'
      : 'SELECT id FROM questions WHERE question_chapter_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id',
    [chapterId === null ? bankId : chapterId],
  );
  for (const [index, row] of rowsFrom(rows).entries()) {
    await database.execute('UPDATE questions SET sort_order = ? WHERE id = ?', [index, textValue(row.id)]);
  }
}

function trashTitle(stem: ReviewContentNode[]): string {
  const text = contentText(stem).trim().replace(/\s+/g, ' ');
  return text.length > 64 ? `${text.slice(0, 64)}...` : text || '未命名题目';
}

export function createQuestionDatabase(pool: Pool): QuestionDatabase {
  return {
    execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        execute: (sql, values) => connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
        beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release(),
      };
    },
  };
}

export function createQuestionService(options: { database?: QuestionDatabase } = {}): QuestionService {
  const database = options.database ?? createQuestionDatabase(createDatabasePool());
  return {
    list: (bankId) => listFrom(database, bankId),
    async listTrash(bankId) {
      const bank = await activeBank(database, bankId);
      const [rows] = await database.execute(`SELECT t.entity_id, t.payload_json, t.deleted_at FROM trash_items AS t WHERE t.entity_type = 'question' AND t.restored_at IS NULL AND JSON_UNQUOTE(JSON_EXTRACT(t.payload_json, '$.questionBankId')) = ? ORDER BY t.deleted_at DESC, t.id DESC`, [bank.id]);
      return { items: rowsFrom(rows).flatMap((row) => {
        const payload = readJson(row.payload_json, '题目回收记录');
        if (!isRecord(payload)) return [];
        const stem = normalizeContent(payload.stem, '题干', true)!;
        const type = readType(payload.type);
        return [{ id: textValue(row.entity_id), questionBankId: bank.id, questionChapterId: payload.questionChapterId === null ? null : textValue(payload.questionChapterId), title: trashTitle(stem), type, deletedAt: dateValue(row.deleted_at) }];
      }) };
    },
    async create(request) {
      const data = normalizedQuestion(request);
      return transaction(database, async (connection) => {
        const target = await destination(connection, request.questionBankId, request.questionChapterId);
        const id = randomUUID();
        await connection.execute('INSERT INTO questions (id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', [
          id, target.bank.id, target.chapterId, JSON.stringify(data.stem), data.type, JSON.stringify(data.options), JSON.stringify(data.answer), data.analysis === null ? null : JSON.stringify(data.analysis), JSON.stringify(data.knowledgePoints), await nextOrder(connection, target.bank.id, target.chapterId),
        ]);
        return { questions: await listFrom(connection, target.bank.id) };
      });
    },
    async update(questionId, request) {
      const data = normalizedQuestion(request);
      return transaction(database, async (connection) => {
        const question = await activeQuestion(connection, questionId, true);
        const target = await destination(connection, request.questionBankId ?? question.questionBankId, request.questionChapterId);
        if (target.bank.subjectId !== (await activeBank(connection, question.questionBankId, true)).subjectId) {
          throw new QuestionApiError(400, '题目只能移动到同一科目的题库。');
        }
        const moved = target.bank.id !== question.questionBankId || target.chapterId !== question.questionChapterId;
        await connection.execute('UPDATE questions SET question_bank_id = ?, question_chapter_id = ?, stem_json = ?, question_type = ?, options_json = ?, answer_json = ?, analysis_json = ?, knowledge_points_json = ?, version = version + 1, sort_order = ? WHERE id = ?', [
          target.bank.id, target.chapterId, JSON.stringify(data.stem), data.type, JSON.stringify(data.options), JSON.stringify(data.answer), data.analysis === null ? null : JSON.stringify(data.analysis), JSON.stringify(data.knowledgePoints), moved ? await nextOrder(connection, target.bank.id, target.chapterId) : question.sortOrder, question.id,
        ]);
        if (moved) await normalizeOrder(connection, question.questionBankId, question.questionChapterId);
        return { questions: await listFrom(connection, target.bank.id) };
      });
    },
    async move(questionId, request) {
      return transaction(database, async (connection) => {
        const question = await activeQuestion(connection, questionId, true);
        const sourceBank = await activeBank(connection, question.questionBankId, true);
        const target = await destination(connection, request.questionBankId, request.questionChapterId);
        if (sourceBank.subjectId !== target.bank.subjectId) throw new QuestionApiError(400, '题目只能移动到同一科目的题库。');
        if (sourceBank.id !== target.bank.id || question.questionChapterId !== target.chapterId) {
          await connection.execute('UPDATE questions SET question_bank_id = ?, question_chapter_id = ?, sort_order = ? WHERE id = ?', [target.bank.id, target.chapterId, await nextOrder(connection, target.bank.id, target.chapterId), question.id]);
          await normalizeOrder(connection, sourceBank.id, question.questionChapterId);
        }
        return { questions: await listFrom(connection, target.bank.id) };
      });
    },
    async reorder(questionId, request) {
      const direction = readDirection(request.direction);
      return transaction(database, async (connection) => {
        const question = await activeQuestion(connection, questionId, true);
        const [rows] = await connection.execute(
          question.questionChapterId === null
            ? 'SELECT id, sort_order FROM questions WHERE question_bank_id = ? AND question_chapter_id IS NULL AND deleted_at IS NULL ORDER BY sort_order, created_at, id FOR UPDATE'
            : 'SELECT id, sort_order FROM questions WHERE question_chapter_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id FOR UPDATE',
          [question.questionChapterId === null ? question.questionBankId : question.questionChapterId],
        );
        const ordered = rowsFrom(rows);
        const index = ordered.findIndex((row) => textValue(row.id) === question.id);
        const other = ordered[index + (direction === 'up' ? -1 : 1)];
        if (other) {
          await connection.execute('UPDATE questions SET sort_order = ? WHERE id = ?', [numberValue(other.sort_order), question.id]);
          await connection.execute('UPDATE questions SET sort_order = ? WHERE id = ?', [question.sortOrder, textValue(other.id)]);
          await normalizeOrder(connection, question.questionBankId, question.questionChapterId);
        }
        return { questions: await listFrom(connection, question.questionBankId) };
      });
    },
    async remove(questionId) {
      return transaction(database, async (connection) => {
        const question = await activeQuestion(connection, questionId, true);
        const [rows] = await connection.execute('SELECT id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order FROM questions WHERE id = ? FOR UPDATE', [question.id]);
        const saved = questionFromRow(rowsFrom(rows)[0]!);
        await connection.execute('INSERT INTO trash_items (id, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?)', [randomUUID(), 'question', question.id, JSON.stringify(saved)]);
        await connection.execute('UPDATE questions SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [question.id]);
        await normalizeOrder(connection, question.questionBankId, question.questionChapterId);
        return { questions: await listFrom(connection, question.questionBankId) };
      });
    },
    async restore(questionId) {
      return transaction(database, async (connection) => {
        const id = requiredId(questionId, '题目标识');
        const [rows] = await connection.execute("SELECT payload_json FROM trash_items WHERE entity_type = 'question' AND entity_id = ? AND restored_at IS NULL ORDER BY deleted_at DESC LIMIT 1 FOR UPDATE", [id]);
        const row = rowsFrom(rows)[0];
        if (!row) throw new QuestionApiError(404, '题目回收记录不存在。');
        const payload = readJson(row.payload_json, '题目回收记录');
        if (!isRecord(payload)) throw new QuestionApiError(409, '题目回收记录已损坏。');
        const target = await destination(connection, payload.questionBankId, payload.questionChapterId);
        const [questionRows] = await connection.execute('SELECT id FROM questions WHERE id = ? AND deleted_at IS NOT NULL FOR UPDATE', [id]);
        if (!rowsFrom(questionRows).length) throw new QuestionApiError(404, '题目不存在或已恢复。');
        await connection.execute('UPDATE questions SET deleted_at = NULL, question_bank_id = ?, question_chapter_id = ?, sort_order = ? WHERE id = ?', [target.bank.id, target.chapterId, await nextOrder(connection, target.bank.id, target.chapterId), id]);
        await connection.execute("UPDATE trash_items SET restored_at = CURRENT_TIMESTAMP(3) WHERE entity_type = 'question' AND entity_id = ? AND restored_at IS NULL", [id]);
        return { questions: await listFrom(connection, target.bank.id) };
      });
    },
  };
}
