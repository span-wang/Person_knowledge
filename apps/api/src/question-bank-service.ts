import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  type CatalogCourse,
  type CatalogSortDirection,
  type CatalogSubject,
  type QuestionBankCreateRequest,
  type QuestionBankDirectoryItem,
  type QuestionBankDirectoryResponse,
  type QuestionBankKind,
  type QuestionBankMoveChapterRequest,
  type QuestionBankReorderRequest,
  type QuestionBankRenameRequest,
  type QuestionChapterCreateRequest,
  type QuestionChapterReorderRequest,
  type QuestionChapterRenameRequest,
  type QuestionChapterSummary,
  type QuestionBankTrashResponse,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface QuestionBankSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface QuestionBankSqlConnection extends QuestionBankSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface QuestionBankDatabase extends QuestionBankSqlExecutor {
  getConnection(): Promise<QuestionBankSqlConnection>;
}

export class QuestionBankApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'QuestionBankApiError';
  }
}

export interface QuestionBankService {
  getDirectory(subjectId: string): Promise<QuestionBankDirectoryResponse>;
  listTrash(subjectId: string): Promise<QuestionBankTrashResponse>;
  createBank(request: QuestionBankCreateRequest): Promise<QuestionBankDirectoryResponse>;
  renameBank(bankId: string, request: QuestionBankRenameRequest): Promise<QuestionBankDirectoryResponse>;
  reorderBank(bankId: string, request: QuestionBankReorderRequest): Promise<QuestionBankDirectoryResponse>;
  deleteBank(bankId: string): Promise<QuestionBankDirectoryResponse>;
  restoreBank(bankId: string): Promise<QuestionBankDirectoryResponse>;
  createChapter(request: QuestionChapterCreateRequest): Promise<QuestionBankDirectoryResponse>;
  renameChapter(chapterId: string, request: QuestionChapterRenameRequest): Promise<QuestionBankDirectoryResponse>;
  moveChapter(chapterId: string, request: QuestionBankMoveChapterRequest): Promise<QuestionBankDirectoryResponse>;
  reorderChapter(chapterId: string, request: QuestionChapterReorderRequest): Promise<QuestionBankDirectoryResponse>;
  deleteChapter(chapterId: string): Promise<QuestionBankDirectoryResponse>;
  restoreChapter(chapterId: string): Promise<QuestionBankDirectoryResponse>;
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row)) : [];
}

function textValue(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function numberValue(value: unknown): number { const result = Number(value ?? 0); return Number.isFinite(result) ? result : 0; }
function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  }
  throw new QuestionBankApiError(409, '题库回收记录已损坏。');
}
function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new QuestionBankApiError(400, `${label}无效。`);
  return value.trim();
}
function requiredName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 255) throw new QuestionBankApiError(400, `${label}不能为空且不能超过 255 个字符。`);
  return value.trim();
}
function readKind(value: unknown): QuestionBankKind {
  if (value !== 'chapter' && value !== 'official' && value !== 'mock') throw new QuestionBankApiError(400, '题库类型无效。');
  return value;
}
function readDirection(value: unknown): CatalogSortDirection {
  if (value !== 'up' && value !== 'down') throw new QuestionBankApiError(400, '排序方向无效。');
  return value;
}
function bankFromRow(row: Record<string, unknown>): QuestionBankDirectoryItem {
  return {
    id: textValue(row.bank_id), subjectId: textValue(row.subject_id), kind: readKind(row.kind), name: textValue(row.bank_name),
    sortOrder: numberValue(row.bank_sort_order), questionCount: numberValue(row.question_count), chapterCount: numberValue(row.chapter_count), chapters: [],
  };
}
function chapterFromRow(row: Record<string, unknown>): QuestionChapterSummary {
  return { id: textValue(row.chapter_id), questionBankId: textValue(row.question_bank_id), title: textValue(row.chapter_title), sortOrder: numberValue(row.chapter_sort_order), questionCount: numberValue(row.chapter_question_count) };
}

async function transaction<T>(database: QuestionBankDatabase, run: (connection: QuestionBankSqlConnection) => Promise<T>): Promise<T> {
  const connection = await database.getConnection();
  try { await connection.beginTransaction(); const result = await run(connection); await connection.commit(); return result; }
  catch (error) { await connection.rollback().catch(() => undefined); throw error; }
  finally { connection.release(); }
}

async function activeSubject(database: QuestionBankSqlExecutor, subjectId: string): Promise<{ subject: CatalogSubject; course: CatalogCourse }> {
  const id = requiredId(subjectId, '科目标识');
  const [rows] = await database.execute(`
    SELECT s.id AS subject_id, s.course_id, s.name AS subject_name, s.sort_order AS subject_sort_order, s.is_system AS subject_is_system,
      COUNT(DISTINCT m.id) AS material_count, c.id AS course_id_value, c.name AS course_name, c.sort_order AS course_sort_order,
      c.is_system AS course_is_system, COUNT(DISTINCT s2.id) AS subject_count
    FROM subjects AS s INNER JOIN courses AS c ON c.id = s.course_id AND c.deleted_at IS NULL
    LEFT JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
    LEFT JOIN subjects AS s2 ON s2.course_id = c.id AND s2.deleted_at IS NULL
    WHERE s.id = ? AND s.deleted_at IS NULL
    GROUP BY s.id, s.course_id, s.name, s.sort_order, s.is_system, c.id, c.name, c.sort_order, c.is_system
    LIMIT 1`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionBankApiError(404, '科目不存在或已删除。');
  return {
    subject: { id: textValue(row.subject_id), courseId: textValue(row.course_id), name: textValue(row.subject_name), sortOrder: numberValue(row.subject_sort_order), isSystem: row.subject_is_system === 1 || row.subject_is_system === true, materialCount: numberValue(row.material_count) },
    course: { id: textValue(row.course_id_value), name: textValue(row.course_name), sortOrder: numberValue(row.course_sort_order), isSystem: row.course_is_system === 1 || row.course_is_system === true, subjectCount: numberValue(row.subject_count) },
  };
}

async function directoryFrom(database: QuestionBankSqlExecutor, subjectId: string): Promise<QuestionBankDirectoryResponse> {
  const { subject, course } = await activeSubject(database, subjectId);
  const [bankRows] = await database.execute(`
    SELECT b.id AS bank_id, b.subject_id, b.kind, b.name AS bank_name, b.sort_order AS bank_sort_order,
      COUNT(DISTINCT q.id) AS question_count, COUNT(DISTINCT ch.id) AS chapter_count
    FROM question_banks AS b
    LEFT JOIN questions AS q ON q.question_bank_id = b.id AND q.deleted_at IS NULL
    LEFT JOIN question_chapters AS ch ON ch.question_bank_id = b.id AND ch.deleted_at IS NULL
    WHERE b.subject_id = ? AND b.deleted_at IS NULL
    GROUP BY b.id, b.subject_id, b.kind, b.name, b.sort_order, b.created_at
    ORDER BY b.kind, b.sort_order, b.created_at, b.id`, [subject.id]);
  const banks = rowsFrom(bankRows).map(bankFromRow);
  const [chapterRows] = await database.execute(`
    SELECT ch.id AS chapter_id, ch.question_bank_id, ch.title AS chapter_title, ch.sort_order AS chapter_sort_order,
      COUNT(q.id) AS chapter_question_count
    FROM question_chapters AS ch LEFT JOIN questions AS q ON q.question_chapter_id = ch.id AND q.deleted_at IS NULL
    INNER JOIN question_banks AS b ON b.id = ch.question_bank_id AND b.deleted_at IS NULL
    WHERE b.subject_id = ? AND ch.deleted_at IS NULL
    GROUP BY ch.id, ch.question_bank_id, ch.title, ch.sort_order, ch.created_at
    ORDER BY ch.question_bank_id, ch.sort_order, ch.created_at, ch.id`, [subject.id]);
  const byBank = new Map(banks.map((bank) => [bank.id, bank]));
  for (const row of rowsFrom(chapterRows)) byBank.get(textValue(row.question_bank_id))?.chapters.push(chapterFromRow(row));
  return { course, subject, banks: { chapter: banks.filter((bank) => bank.kind === 'chapter'), official: banks.filter((bank) => bank.kind === 'official'), mock: banks.filter((bank) => bank.kind === 'mock') } };
}

async function activeBank(database: QuestionBankSqlExecutor, bankId: string, forUpdate = false) {
  const id = requiredId(bankId, '题库标识');
  const [rows] = await database.execute(`SELECT id, subject_id, kind, name, sort_order FROM question_banks WHERE id = ? AND deleted_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionBankApiError(404, '题库不存在或已删除。');
  return { id, subjectId: textValue(row.subject_id), kind: readKind(row.kind), name: textValue(row.name), sortOrder: numberValue(row.sort_order) };
}
async function activeChapter(database: QuestionBankSqlExecutor, chapterId: string, forUpdate = false) {
  const id = requiredId(chapterId, '章节标识');
  const [rows] = await database.execute(`SELECT id, question_bank_id, title, sort_order FROM question_chapters WHERE id = ? AND deleted_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new QuestionBankApiError(404, '章节不存在或已删除。');
  return { id, questionBankId: textValue(row.question_bank_id), title: textValue(row.title), sortOrder: numberValue(row.sort_order) };
}
async function nextOrder(database: QuestionBankSqlExecutor, table: 'question_banks' | 'question_chapters', parentColumn: 'subject_id' | 'question_bank_id', parentId: string, kind?: QuestionBankKind) {
  const whereKind = table === 'question_banks' ? ' AND kind = ?' : '';
  const values = kind ? [parentId, kind] : [parentId];
  const [rows] = await database.execute(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM ${table} WHERE ${parentColumn} = ?${whereKind} AND deleted_at IS NULL`, values);
  return numberValue(rowsFrom(rows)[0]?.next_order);
}
async function normalize(database: QuestionBankSqlExecutor, table: 'question_banks' | 'question_chapters', parentColumn: 'subject_id' | 'question_bank_id', parentId: string, kind?: QuestionBankKind) {
  const whereKind = table === 'question_banks' ? ' AND kind = ?' : '';
  const values = kind ? [parentId, kind] : [parentId];
  const [rows] = await database.execute(`SELECT id FROM ${table} WHERE ${parentColumn} = ?${whereKind} AND deleted_at IS NULL ORDER BY sort_order, created_at, id`, values);
  for (const [index, row] of rowsFrom(rows).entries()) await database.execute(`UPDATE ${table} SET sort_order = ? WHERE id = ?`, [index, textValue(row.id)]);
}

export function createQuestionBankDatabase(pool: Pool): QuestionBankDatabase {
  return { execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>, async getConnection() {
    const connection = await pool.getConnection();
    return { execute: (sql, values) => connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>, beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release() };
  } };
}

export function createQuestionBankService(options: { database?: QuestionBankDatabase } = {}): QuestionBankService {
  const database = options.database ?? createQuestionBankDatabase(createDatabasePool());
  return {
    getDirectory: (subjectId) => directoryFrom(database, subjectId),
    async listTrash(subjectId) {
      const normalizedSubjectId = requiredId(subjectId, '科目标识');
      await activeSubject(database, normalizedSubjectId);
      const [rows] = await database.execute(`
        SELECT t.entity_type, t.entity_id, t.payload_json, t.deleted_at
        FROM trash_items AS t
        WHERE t.restored_at IS NULL AND t.entity_type IN ('question_bank', 'question_chapter')
          AND (t.entity_type = 'question_bank' AND JSON_UNQUOTE(JSON_EXTRACT(t.payload_json, '$.subjectId')) = ?
            OR t.entity_type = 'question_chapter' AND JSON_UNQUOTE(JSON_EXTRACT(t.payload_json, '$.subjectId')) = ?)
        ORDER BY t.deleted_at DESC, t.id DESC`, [normalizedSubjectId, normalizedSubjectId]);
      return { items: rowsFrom(rows).map((row) => {
        let payload: Record<string, unknown> = {};
        try { payload = jsonRecord(row.payload_json); } catch { /* 损坏载荷仍保留回收项标识。 */ }
        return { entityType: textValue(row.entity_type) as 'question_bank' | 'question_chapter', entityId: textValue(row.entity_id), title: textValue(payload.name ?? payload.title) || '未命名题库内容', deletedAt: row.deleted_at instanceof Date ? row.deleted_at.toISOString() : textValue(row.deleted_at) };
      }) };
    },
    async createBank(request) {
      const subjectId = requiredId(request.subjectId, '科目标识'); const kind = readKind(request.kind); const name = requiredName(request.name, '题库名称');
      return transaction(database, async (connection) => { await activeSubject(connection, subjectId); const [duplicate] = await connection.execute('SELECT id FROM question_banks WHERE subject_id = ? AND kind = ? AND name = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE', [subjectId, kind, name]); if (rowsFrom(duplicate).length) throw new QuestionBankApiError(409, '同类型题库名称已存在。'); await connection.execute('INSERT INTO question_banks (id, subject_id, kind, name, sort_order) VALUES (?, ?, ?, ?, ?)', [randomUUID(), subjectId, kind, name, await nextOrder(connection, 'question_banks', 'subject_id', subjectId, kind)]); return directoryFrom(connection, subjectId); });
    },
    async renameBank(bankId, request) { const name = requiredName(request.name, '题库名称'); return transaction(database, async (connection) => { const bank = await activeBank(connection, bankId, true); const [duplicate] = await connection.execute('SELECT id FROM question_banks WHERE subject_id = ? AND kind = ? AND name = ? AND deleted_at IS NULL AND id <> ? LIMIT 1 FOR UPDATE', [bank.subjectId, bank.kind, name, bank.id]); if (rowsFrom(duplicate).length) throw new QuestionBankApiError(409, '同类型题库名称已存在。'); await connection.execute('UPDATE question_banks SET name = ? WHERE id = ?', [name, bank.id]); return directoryFrom(connection, bank.subjectId); }); },
    async reorderBank(bankId, request) { const direction = readDirection(request.direction); return transaction(database, async (connection) => { const bank = await activeBank(connection, bankId, true); const [rows] = await connection.execute('SELECT id, sort_order FROM question_banks WHERE subject_id = ? AND kind = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id FOR UPDATE', [bank.subjectId, bank.kind]); const ordered = rowsFrom(rows); const index = ordered.findIndex((row) => textValue(row.id) === bank.id); const target = ordered[index + (direction === 'up' ? -1 : 1)]; if (target) { await connection.execute('UPDATE question_banks SET sort_order = ? WHERE id = ?', [numberValue(target.sort_order), bank.id]); await connection.execute('UPDATE question_banks SET sort_order = ? WHERE id = ?', [bank.sortOrder, textValue(target.id)]); await normalize(connection, 'question_banks', 'subject_id', bank.subjectId, bank.kind); } return directoryFrom(connection, bank.subjectId); }); },
    async deleteBank(bankId) { return transaction(database, async (connection) => { const bank = await activeBank(connection, bankId, true); const [chapters] = await connection.execute('SELECT id FROM question_chapters WHERE question_bank_id = ? AND deleted_at IS NULL FOR UPDATE', [bank.id]); const [questions] = await connection.execute('SELECT id FROM questions WHERE question_bank_id = ? AND deleted_at IS NULL FOR UPDATE', [bank.id]); const chapterIds = rowsFrom(chapters).map((row) => textValue(row.id)); const questionIds = rowsFrom(questions).map((row) => textValue(row.id)); await connection.execute('INSERT INTO trash_items (id, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?)', [randomUUID(), 'question_bank', bank.id, JSON.stringify({ subjectId: bank.subjectId, kind: bank.kind, name: bank.name, sortOrder: bank.sortOrder, chapterIds, questionIds })]); if (chapterIds.length) await connection.execute(`UPDATE question_chapters SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id IN (${chapterIds.map(() => '?').join(',')})`, chapterIds); if (questionIds.length) await connection.execute(`UPDATE questions SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id IN (${questionIds.map(() => '?').join(',')})`, questionIds); await connection.execute('UPDATE question_banks SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [bank.id]); await normalize(connection, 'question_banks', 'subject_id', bank.subjectId, bank.kind); return directoryFrom(connection, bank.subjectId); }); },
    async restoreBank(bankId) { return transaction(database, async (connection) => { const id = requiredId(bankId, '题库标识'); const [rows] = await connection.execute("SELECT entity_id, payload_json FROM trash_items WHERE entity_type = 'question_bank' AND entity_id = ? AND restored_at IS NULL ORDER BY deleted_at DESC LIMIT 1 FOR UPDATE", [id]); const row = rowsFrom(rows)[0]; if (!row) throw new QuestionBankApiError(404, '题库回收记录不存在。'); const payload = jsonRecord(row.payload_json) as { subjectId?: string; kind?: QuestionBankKind; chapterIds?: string[]; questionIds?: string[] }; const subjectId = requiredId(payload.subjectId, '科目'); const kind = readKind(payload.kind); await activeSubject(connection, subjectId); const [bankRows] = await connection.execute('SELECT name FROM question_banks WHERE id = ? AND subject_id = ? AND kind = ? AND deleted_at IS NOT NULL LIMIT 1 FOR UPDATE', [id, subjectId, kind]); const deletedBank = rowsFrom(bankRows)[0]; if (!deletedBank) throw new QuestionBankApiError(404, '题库不存在或已恢复。'); const [duplicate] = await connection.execute('SELECT id FROM question_banks WHERE subject_id = ? AND kind = ? AND name = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE', [subjectId, kind, textValue(deletedBank.name)]); if (rowsFrom(duplicate).length) throw new QuestionBankApiError(409, '同类型题库名称已存在，无法恢复。'); await connection.execute('UPDATE question_banks SET deleted_at = NULL, sort_order = ? WHERE id = ?', [await nextOrder(connection, 'question_banks', 'subject_id', subjectId, kind), id]); if (payload.chapterIds?.length) await connection.execute(`UPDATE question_chapters SET deleted_at = NULL WHERE id IN (${payload.chapterIds.map(() => '?').join(',')})`, payload.chapterIds); if (payload.questionIds?.length) await connection.execute(`UPDATE questions SET deleted_at = NULL WHERE id IN (${payload.questionIds.map(() => '?').join(',')})`, payload.questionIds); await connection.execute("UPDATE trash_items SET restored_at = CURRENT_TIMESTAMP(3) WHERE entity_type = 'question_bank' AND entity_id = ? AND restored_at IS NULL", [id]); return directoryFrom(connection, subjectId); }); },
    async createChapter(request) { const bankId = requiredId(request.questionBankId, '题库标识'); const title = requiredName(request.title, '章节名称'); return transaction(database, async (connection) => { const bank = await activeBank(connection, bankId); if (bank.kind !== 'chapter') throw new QuestionBankApiError(400, '只有章节题支持章节目录。'); await connection.execute('INSERT INTO question_chapters (id, question_bank_id, title, sort_order) VALUES (?, ?, ?, ?)', [randomUUID(), bank.id, title, await nextOrder(connection, 'question_chapters', 'question_bank_id', bank.id)]); return directoryFrom(connection, bank.subjectId); }); },
    async renameChapter(chapterId, request) { const title = requiredName(request.title, '章节名称'); return transaction(database, async (connection) => { const chapter = await activeChapter(connection, chapterId, true); const bank = await activeBank(connection, chapter.questionBankId); await connection.execute('UPDATE question_chapters SET title = ? WHERE id = ?', [title, chapter.id]); return directoryFrom(connection, bank.subjectId); }); },
    async moveChapter(chapterId, request) { const bankId = requiredId(request.questionBankId, '目标题库标识'); return transaction(database, async (connection) => { const chapter = await activeChapter(connection, chapterId, true); const fromBank = await activeBank(connection, chapter.questionBankId); const toBank = await activeBank(connection, bankId, true); if (fromBank.kind !== 'chapter' || toBank.kind !== 'chapter' || fromBank.subjectId !== toBank.subjectId) throw new QuestionBankApiError(400, '章节只能在同科目的章节题库间移动。'); if (fromBank.id !== toBank.id) { await connection.execute('UPDATE question_chapters SET question_bank_id = ?, sort_order = ? WHERE id = ?', [toBank.id, await nextOrder(connection, 'question_chapters', 'question_bank_id', toBank.id), chapter.id]); await connection.execute('UPDATE questions SET question_bank_id = ? WHERE question_chapter_id = ?', [toBank.id, chapter.id]); await normalize(connection, 'question_chapters', 'question_bank_id', fromBank.id); await normalize(connection, 'question_chapters', 'question_bank_id', toBank.id); } return directoryFrom(connection, fromBank.subjectId); }); },
    async reorderChapter(chapterId, request) { const direction = readDirection(request.direction); return transaction(database, async (connection) => { const chapter = await activeChapter(connection, chapterId, true); const bank = await activeBank(connection, chapter.questionBankId); const [rows] = await connection.execute('SELECT id, sort_order FROM question_chapters WHERE question_bank_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id FOR UPDATE', [bank.id]); const ordered = rowsFrom(rows); const index = ordered.findIndex((row) => textValue(row.id) === chapter.id); const target = ordered[index + (direction === 'up' ? -1 : 1)]; if (target) { await connection.execute('UPDATE question_chapters SET sort_order = ? WHERE id = ?', [numberValue(target.sort_order), chapter.id]); await connection.execute('UPDATE question_chapters SET sort_order = ? WHERE id = ?', [chapter.sortOrder, textValue(target.id)]); await normalize(connection, 'question_chapters', 'question_bank_id', bank.id); } return directoryFrom(connection, bank.subjectId); }); },
    async deleteChapter(chapterId) { return transaction(database, async (connection) => { const chapter = await activeChapter(connection, chapterId, true); const bank = await activeBank(connection, chapter.questionBankId); const [questions] = await connection.execute('SELECT id FROM questions WHERE question_chapter_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE', [chapter.id]); if (rowsFrom(questions).length) throw new QuestionBankApiError(409, '章节仍包含题目，不能删除。'); await connection.execute('INSERT INTO trash_items (id, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?)', [randomUUID(), 'question_chapter', chapter.id, JSON.stringify({ subjectId: bank.subjectId, questionBankId: bank.id, title: chapter.title, sortOrder: chapter.sortOrder })]); await connection.execute('UPDATE question_chapters SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [chapter.id]); await normalize(connection, 'question_chapters', 'question_bank_id', bank.id); return directoryFrom(connection, bank.subjectId); }); },
    async restoreChapter(chapterId) { return transaction(database, async (connection) => { const id = requiredId(chapterId, '章节标识'); const [rows] = await connection.execute("SELECT payload_json FROM trash_items WHERE entity_type = 'question_chapter' AND entity_id = ? AND restored_at IS NULL ORDER BY deleted_at DESC LIMIT 1 FOR UPDATE", [id]); const row = rowsFrom(rows)[0]; if (!row) throw new QuestionBankApiError(404, '章节回收记录不存在。'); const payload = jsonRecord(row.payload_json) as { questionBankId?: string }; const bank = await activeBank(connection, requiredId(payload.questionBankId, '题库')); if (bank.kind !== 'chapter') throw new QuestionBankApiError(400, '只有章节题支持章节恢复。'); await connection.execute('UPDATE question_chapters SET deleted_at = NULL, sort_order = ? WHERE id = ?', [await nextOrder(connection, 'question_chapters', 'question_bank_id', bank.id), id]); await connection.execute("UPDATE trash_items SET restored_at = CURRENT_TIMESTAMP(3) WHERE entity_type = 'question_chapter' AND entity_id = ? AND restored_at IS NULL", [id]); return directoryFrom(connection, bank.subjectId); }); },
  };
}
