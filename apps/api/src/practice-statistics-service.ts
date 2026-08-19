import type { Pool } from 'mysql2/promise';
import type {
  PracticeMode,
  PracticeResultSummary,
  PracticeStatisticsLine,
  PracticeStatisticsResponse,
  QuestionBankKind,
  QuestionBankSummary,
  QuestionType,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface PracticeStatisticsSqlExecutor { execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>; }
export interface PracticeStatisticsDatabase extends PracticeStatisticsSqlExecutor {}

export class PracticeStatisticsApiError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'PracticeStatisticsApiError'; }
}

export interface PracticeStatisticsService { get(bankId: string): Promise<PracticeStatisticsResponse>; }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function rowsFrom(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(isRecord) : []; }
function textValue(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function numberValue(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function dateValue(value: unknown): string { return value instanceof Date ? value.toISOString() : textValue(value); }
function requiredId(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new PracticeStatisticsApiError(400, `${label}无效。`); return value.trim(); }
function readJson(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value) as unknown; } catch { return null; } }
function roundAccuracy(correctCount: number, answeredCount: number): number | null { return answeredCount ? Math.round((correctCount / answeredCount) * 1000) / 10 : null; }

interface QuestionMeta { id: string; chapterId: string | null; chapterTitle: string | null; type: QuestionType; }
interface AttemptMeta { questionId: string; mode: PracticeMode; result: 'unanswered' | 'correct' | 'incorrect'; completedAt: string; answered: boolean; chapterId: string | null; type: QuestionType; }
interface Accumulator { questionCount: number; statuses: Map<string, 'correct' | 'incorrect' | 'unanswered'>; latestCompletedAt: string | null; }

function createAccumulator(questionCount: number): Accumulator { return { questionCount, statuses: new Map(), latestCompletedAt: null }; }
function updateAccumulator(accumulator: Accumulator, attempt: AttemptMeta) {
  if (attempt.answered || !accumulator.statuses.has(attempt.questionId)) accumulator.statuses.set(attempt.questionId, attempt.answered ? attempt.result : 'unanswered');
  if (!accumulator.latestCompletedAt || attempt.completedAt > accumulator.latestCompletedAt) accumulator.latestCompletedAt = attempt.completedAt;
}
function line(key: string, label: string, accumulator: Accumulator): PracticeStatisticsLine {
  let correctCount = 0; let incorrectCount = 0; let answeredCount = 0;
  for (const result of accumulator.statuses.values()) {
    if (result === 'correct') { correctCount += 1; answeredCount += 1; }
    else if (result === 'incorrect') { incorrectCount += 1; answeredCount += 1; }
  }
  const unansweredCount = Math.max(0, accumulator.questionCount - answeredCount);
  return { key, label, questionCount: accumulator.questionCount, answeredCount, unansweredCount, correctCount, incorrectCount, accuracy: roundAccuracy(correctCount, answeredCount), latestCompletedAt: accumulator.latestCompletedAt };
}

function snapshotMeta(row: Record<string, unknown>, fallback: QuestionMeta | undefined): { chapterId: string | null; type: QuestionType } {
  const snapshot = readJson(row.snapshot_json);
  if (isRecord(snapshot)) {
    const chapterId = snapshot.questionChapterId === null || snapshot.questionChapterId === undefined ? null : textValue(snapshot.questionChapterId);
    const type = textValue(snapshot.type) as QuestionType;
    if (type === 'single' || type === 'multiple' || type === 'true_false') return { chapterId, type };
  }
  return { chapterId: fallback?.chapterId ?? null, type: fallback?.type ?? 'single' };
}

function resultSummaryFromAttempts(attempts: AttemptMeta[], questionCount: number): PracticeResultSummary {
  const statuses = new Map<string, 'correct' | 'incorrect' | 'unanswered'>();
  for (const attempt of attempts) statuses.set(attempt.questionId, attempt.answered ? attempt.result : 'unanswered');
  let correctCount = 0; let incorrectCount = 0; let answeredCount = 0;
  for (const result of statuses.values()) {
    if (result === 'correct') { correctCount += 1; answeredCount += 1; }
    if (result === 'incorrect') { incorrectCount += 1; answeredCount += 1; }
  }
  return { questionCount, answeredCount, unansweredCount: Math.max(0, questionCount - answeredCount), correctCount, incorrectCount, accuracy: roundAccuracy(correctCount, answeredCount) };
}

export function createPracticeStatisticsDatabase(pool: Pool): PracticeStatisticsDatabase {
  return { execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]> };
}

export function createPracticeStatisticsService(options: { database?: PracticeStatisticsDatabase } = {}): PracticeStatisticsService {
  const database = options.database ?? createPracticeStatisticsDatabase(createDatabasePool());
  return {
    async get(bankId) {
      const id = requiredId(bankId, '题库标识');
      const [bankRows] = await database.execute('SELECT id, subject_id, kind, name, sort_order, (SELECT COUNT(*) FROM questions WHERE question_bank_id = question_banks.id AND deleted_at IS NULL) AS question_count, (SELECT COUNT(*) FROM question_chapters WHERE question_bank_id = question_banks.id AND deleted_at IS NULL) AS chapter_count FROM question_banks WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
      const bankRow = rowsFrom(bankRows)[0];
      if (!bankRow) throw new PracticeStatisticsApiError(404, '题库不存在或已删除。');
      const kind = textValue(bankRow.kind) as QuestionBankKind;
      if (!['chapter', 'official', 'mock'].includes(kind)) throw new PracticeStatisticsApiError(409, '题库类型已损坏。');
      const bank: QuestionBankSummary = { id, subjectId: textValue(bankRow.subject_id), kind, name: textValue(bankRow.name), sortOrder: numberValue(bankRow.sort_order), questionCount: numberValue(bankRow.question_count), chapterCount: numberValue(bankRow.chapter_count) };
      const [questionRows] = await database.execute('SELECT q.id, q.question_chapter_id, q.question_type, ch.title AS chapter_title FROM questions AS q LEFT JOIN question_chapters AS ch ON ch.id = q.question_chapter_id AND ch.deleted_at IS NULL WHERE q.question_bank_id = ? AND q.deleted_at IS NULL ORDER BY q.sort_order, q.created_at, q.id', [id]);
      const questionMeta = rowsFrom(questionRows).map((row) => ({ id: textValue(row.id), chapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), chapterTitle: row.chapter_title === null || row.chapter_title === undefined ? null : textValue(row.chapter_title), type: textValue(row.question_type) as QuestionType } satisfies QuestionMeta));
      const metaById = new Map(questionMeta.map((item) => [item.id, item]));
      const [attemptRows] = await database.execute('SELECT a.question_id, a.result, a.answer_json, a.snapshot_json, s.mode, s.completed_at FROM practice_attempts AS a INNER JOIN practice_sessions AS s ON s.id = a.practice_session_id WHERE s.question_bank_id = ? AND s.status = \'completed\' ORDER BY s.completed_at, s.id, a.id', [id]);
      const attempts: AttemptMeta[] = rowsFrom(attemptRows).filter((row) => metaById.has(textValue(row.question_id))).map((row) => { const meta = snapshotMeta(row, metaById.get(textValue(row.question_id))); return { questionId: textValue(row.question_id), mode: textValue(row.mode) as PracticeMode, result: textValue(row.result) as AttemptMeta['result'], completedAt: dateValue(row.completed_at), answered: row.answer_json !== null && textValue(row.result) !== 'unanswered', chapterId: meta.chapterId, type: meta.type }; });
      const overall = createAccumulator(questionMeta.length);
      const chapters = new Map<string, Accumulator>();
      const types = new Map<QuestionType, Accumulator>();
      const modes = new Map<PracticeMode, Accumulator>();
      for (const question of questionMeta) {
        if (question.chapterId) { if (!chapters.has(question.chapterId)) chapters.set(question.chapterId, createAccumulator(0)); chapters.get(question.chapterId)!.questionCount += 1; }
        if (!types.has(question.type)) types.set(question.type, createAccumulator(0)); types.get(question.type)!.questionCount += 1;
        for (const mode of ['cram', 'test'] as const) { if (!modes.has(mode)) modes.set(mode, createAccumulator(questionMeta.length)); }
      }
      for (const attempt of attempts) {
        updateAccumulator(overall, attempt);
        if (attempt.chapterId && chapters.has(attempt.chapterId)) updateAccumulator(chapters.get(attempt.chapterId)!, attempt);
        if (types.has(attempt.type)) updateAccumulator(types.get(attempt.type)!, attempt);
        if (modes.has(attempt.mode)) updateAccumulator(modes.get(attempt.mode)!, attempt);
      }
      const chapterLabels = new Map(questionMeta.filter((item) => item.chapterId && item.chapterTitle).map((item) => [item.chapterId!, item.chapterTitle!]));
      const chapterLines = [...chapters.entries()].map(([chapterId, accumulator]) => ({ id: chapterId, ...line(chapterId, chapterLabels.get(chapterId) ?? '章节', accumulator) }));
      const typeLabels: Record<QuestionType, string> = { single: '单选', multiple: '多选', true_false: '判断' };
      const typeLines = [...types.entries()].map(([type, accumulator]) => ({ type, ...line(type, typeLabels[type], accumulator) }));
      const modeLabels: Record<PracticeMode, string> = { cram: '背题', test: '检测' };
      const modeLines = [...modes.entries()].map(([mode, accumulator]) => ({ mode, ...line(mode, modeLabels[mode], accumulator) }));
      const latestByQuestion = new Map<string, AttemptMeta>();
      for (const attempt of attempts) if (attempt.answered) latestByQuestion.set(attempt.questionId, attempt);
      const aggregateWrongCount = [...latestByQuestion.values()].filter((attempt) => attempt.result === 'incorrect' && metaById.has(attempt.questionId)).length;
      return { bank, overall: line('overall', '总览', overall), chapters: chapterLines, types: typeLines, modes: modeLines, aggregateWrongCount };
    },
  };
}

export { resultSummaryFromAttempts };
