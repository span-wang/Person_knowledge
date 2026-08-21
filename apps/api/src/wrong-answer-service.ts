import type { QuestionQuestion, QuestionType, WrongAnswerFilterRequest, WrongAnswerFilterResponse } from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface WrongAnswerSqlExecutor { execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>; }
export class WrongAnswerApiError extends Error { constructor(readonly statusCode: number, message: string) { super(message); this.name = 'WrongAnswerApiError'; } }
export interface WrongAnswerService { list(request: WrongAnswerFilterRequest): Promise<WrongAnswerFilterResponse>; }
function rows(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item)) : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function date(value: unknown): string { return value instanceof Date ? value.toISOString() : text(value); }
function json(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
function required(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new WrongAnswerApiError(400, `${label}无效。`); return value.trim(); }
function question(row: Record<string, unknown>): QuestionQuestion {
  const parse = (key: string) => json(row[key]);
  return { id: text(row.id), questionBankId: text(row.question_bank_id), questionChapterId: row.question_chapter_id == null ? null : text(row.question_chapter_id), stem: parse('stem_json') as QuestionQuestion['stem'], type: text(row.question_type) as QuestionType, options: parse('options_json') as QuestionQuestion['options'], answer: parse('answer_json') as string[], analysis: row.analysis_json == null ? null : parse('analysis_json') as QuestionQuestion['analysis'], knowledgePoints: parse('knowledge_points_json') as string[], isFavorite: Boolean(row.is_favorite), version: Number(row.version ?? 1), sortOrder: Number(row.sort_order ?? 0), createdAt: date(row.created_at), updatedAt: date(row.updated_at), reviewNote: row.note_text == null ? null : text(row.note_text) };
}
export function createWrongAnswerService(options: { database?: WrongAnswerSqlExecutor } = {}): WrongAnswerService {
  const database = options.database ?? createDatabasePool() as unknown as WrongAnswerSqlExecutor;
  return { async list(request) {
    const subjectId = required(request.subjectId, '科目标识');
    const values: unknown[] = [subjectId];
    const filters: string[] = [];
    if (request.knowledgePoint?.trim()) { filters.push('JSON_CONTAINS(q.knowledge_points_json, JSON_QUOTE(?))'); values.push(request.knowledgePoint.trim()); }
    if (request.type) { filters.push('q.question_type = ?'); values.push(request.type); }
    if (request.since) { const since = new Date(request.since); if (Number.isNaN(since.getTime())) throw new WrongAnswerApiError(400, '最近错误时间无效。'); filters.push('latest.latest_wrong_at >= ?'); values.push(since); }
    const [result] = await database.execute(`SELECT q.id, q.question_bank_id, q.question_chapter_id, q.stem_json, q.question_type, q.options_json, q.answer_json, q.analysis_json, q.knowledge_points_json, q.is_favorite, q.version, q.sort_order, q.created_at, q.updated_at, n.note_text, n.ink_json, n.updated_at AS note_updated_at, latest.latest_wrong_at
      FROM questions q INNER JOIN question_banks b ON b.id = q.question_bank_id AND b.deleted_at IS NULL INNER JOIN subjects s ON s.id = b.subject_id AND s.deleted_at IS NULL
      INNER JOIN (SELECT a.question_id, MAX(a.answered_at) latest_wrong_at FROM practice_attempts a INNER JOIN practice_sessions ps ON ps.id = a.practice_session_id AND ps.status = 'completed' WHERE a.result = 'incorrect' AND a.answered_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM practice_attempts newer_a INNER JOIN practice_sessions newer_ps ON newer_ps.id = newer_a.practice_session_id AND newer_ps.status = 'completed' WHERE newer_a.question_id = a.question_id AND (newer_a.answered_at > a.answered_at OR (newer_a.answered_at = a.answered_at AND newer_a.id > a.id))) GROUP BY a.question_id) latest ON latest.question_id = q.id
      LEFT JOIN question_review_notes n ON n.question_id = q.id WHERE q.deleted_at IS NULL AND s.id = ? ${filters.length ? `AND ${filters.join(' AND ')}` : ''} ORDER BY latest.latest_wrong_at DESC, q.id`, values);
    return { subjectId, items: rows(result).map((row) => ({ question: question(row), knowledgePoints: (json(row.knowledge_points_json) as string[]) ?? [], latestWrongAt: date(row.latest_wrong_at), note: row.note_text == null ? null : { questionId: text(row.id), noteText: text(row.note_text), strokes: Array.isArray(json(row.ink_json)) ? json(row.ink_json) as never : [], updatedAt: date(row.note_updated_at) } })) };
  } };
}
