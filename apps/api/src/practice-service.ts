import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type {
  PracticeAnswerRequest,
  PracticeAnswerResponse,
  PracticeAttemptView,
  PracticeMode,
  PracticeQuestionView,
  PracticeResultSummary,
  PracticeSource,
  PracticeSessionListResponse,
  PracticeSessionResponse,
  PracticeSessionStartRequest,
  PracticeFavoriteSessionStartRequest,
  PracticeSessionOptions,
  WrongAnswerPracticeStartRequest,
  PracticeSessionStatus,
  PracticeSessionSummary,
  QuestionBankSummary,
  QuestionChapterSummary,
  QuestionOptionContent,
  QuestionReviewNote,
  QuestionType,
  ReviewContentNode,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';
import { normalizeHandwrittenStrokes } from './card-review-note-service.js';

export interface PracticeSqlExecutor { execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>; }
export interface PracticeSqlConnection extends PracticeSqlExecutor { beginTransaction(): Promise<void>; commit(): Promise<void>; rollback(): Promise<void>; release(): void; }
export interface PracticeDatabase extends PracticeSqlExecutor { getConnection(): Promise<PracticeSqlConnection>; }

export class PracticeApiError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); this.name = 'PracticeApiError'; }
}

export interface PracticeService {
  listInProgress(bankId: string): Promise<PracticeSessionListResponse>;
  start(request: PracticeSessionStartRequest): Promise<PracticeSessionResponse>;
  startFavorite(request: PracticeFavoriteSessionStartRequest): Promise<PracticeSessionResponse>;
  startWrong(request: WrongAnswerPracticeStartRequest): Promise<PracticeSessionResponse>;
  get(sessionId: string): Promise<PracticeSessionResponse>;
  answer(sessionId: string, questionId: string, request: PracticeAnswerRequest): Promise<PracticeAnswerResponse>;
  complete(sessionId: string): Promise<PracticeSessionResponse>;
  abandon(sessionId: string): Promise<PracticeSessionResponse>;
}

async function answerRows(database: PracticeSqlExecutor, sessionId: string, questionId: string) {
  const id = requiredId(sessionId, '会话标识');
  const question = requiredId(questionId, '题目标识');
  const [sessionResult, attemptResult] = await Promise.all([
    database.execute('SELECT id, question_bank_id, subject_id, question_chapter_id, mode, source, status, started_at, completed_at, updated_at FROM practice_sessions WHERE id = ? LIMIT 1', [id]),
    database.execute('SELECT a.question_id, a.question_version, a.sort_order, a.snapshot_json, a.answer_json, a.result, a.answered_at, n.note_text, n.ink_json, n.updated_at AS note_updated_at FROM practice_attempts AS a LEFT JOIN question_review_notes AS n ON n.question_id = a.question_id WHERE a.practice_session_id = ? AND a.question_id = ? LIMIT 1', [id, question]),
  ]);
  const session = rowsFrom(sessionResult[0])[0];
  const attempt = rowsFrom(attemptResult[0])[0];
  if (!session || !attempt) throw new PracticeApiError(404, '作答题目不存在。');
  return { session, attempt };
}

async function answerResponseRows(database: PracticeSqlExecutor, sessionId: string, questionId: string, mode: PracticeMode): Promise<PracticeAnswerResponse> {
  const loaded = await answerRows(database, sessionId, questionId);
  const response = viewFromRows(loaded.session, [loaded.attempt], mode, 'in_progress');
  return { session: response.session, question: response.questions[0]! };
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function rowsFrom(value: unknown): Array<Record<string, unknown>> { return Array.isArray(value) ? value.filter(isRecord) : []; }
function textValue(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function numberValue(value: unknown): number { const parsed = Number(value ?? 0); return Number.isFinite(parsed) ? parsed : 0; }
function dateValue(value: unknown): string { return value instanceof Date ? value.toISOString() : textValue(value); }
function requiredId(value: unknown, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new PracticeApiError(400, `${label}无效。`); return value.trim(); }
function readMode(value: unknown): PracticeMode { if (value !== 'cram' && value !== 'test') throw new PracticeApiError(400, '刷题模式无效。'); return value; }
function readSource(value: unknown): PracticeSource { if (value !== 'full' && value !== 'current_wrong' && value !== 'aggregate_wrong') throw new PracticeApiError(400, '刷题来源无效。'); return value; }
function readPracticeOptions(value: PracticeSessionOptions): Required<PracticeSessionOptions> {
  const rawCount = value.questionCount;
  if (rawCount !== undefined && rawCount !== null && (!Number.isInteger(rawCount) || rawCount < 1 || rawCount > 1000)) throw new PracticeApiError(400, '题目数量必须是 1 到 1000 之间的整数。');
  if (value.shuffle !== undefined && typeof value.shuffle !== 'boolean') throw new PracticeApiError(400, '乱序设置无效。');
  if (value.unattemptedOnly !== undefined && typeof value.unattemptedOnly !== 'boolean') throw new PracticeApiError(400, '未做筛选设置无效。');
  return { questionCount: rawCount ?? null, shuffle: value.shuffle === true, unattemptedOnly: value.unattemptedOnly === true };
}
function selectPracticeQuestions(rows: Array<Record<string, unknown>>, options: Required<PracticeSessionOptions>): Array<Record<string, unknown>> {
  const selected = [...rows];
  if (options.shuffle) {
    for (let index = selected.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(Math.random() * (index + 1));
      [selected[index], selected[swapIndex]] = [selected[swapIndex]!, selected[index]!];
    }
  }
  return options.questionCount === null ? selected : selected.slice(0, options.questionCount);
}
function readJson(value: unknown, label: string): unknown { if (typeof value === 'string') { try { return JSON.parse(value) as unknown; } catch { throw new PracticeApiError(409, `${label}已损坏。`); } } return value; }
function content(value: unknown, label: string): ReviewContentNode[] { if (!Array.isArray(value)) throw new PracticeApiError(409, `${label}已损坏。`); return value as ReviewContentNode[]; }
function questionOptions(value: unknown): QuestionOptionContent[] { if (!Array.isArray(value)) throw new PracticeApiError(409, '题目选项已损坏。'); return value as QuestionOptionContent[]; }
function answer(value: unknown): string[] { if (!Array.isArray(value)) throw new PracticeApiError(409, '题目答案已损坏。'); return value.map((item) => textValue(item).toUpperCase()); }
function equalAnswers(left: string[], right: string[]): boolean { return left.length === right.length && left.every((item, index) => item === right[index]); }
function roundAccuracy(correctCount: number, answeredCount: number): number | null { return answeredCount ? Math.round((correctCount / answeredCount) * 1000) / 10 : null; }
function resultSummary(attemptRows: Array<Record<string, unknown>>): PracticeResultSummary {
  let answeredCount = 0; let correctCount = 0; let incorrectCount = 0;
  for (const row of attemptRows) {
    if (row.answer_json === null || textValue(row.result) === 'unanswered') continue;
    answeredCount += 1;
    if (textValue(row.result) === 'correct') correctCount += 1;
    if (textValue(row.result) === 'incorrect') incorrectCount += 1;
  }
  return { questionCount: attemptRows.length, answeredCount, unansweredCount: Math.max(0, attemptRows.length - answeredCount), correctCount, incorrectCount, accuracy: roundAccuracy(correctCount, answeredCount) };
}
function validAnswer(value: unknown, type: QuestionType, optionList: QuestionOptionContent[]): string[] {
  if (!Array.isArray(value)) throw new PracticeApiError(400, '答案必须是选项字母数组。');
  const keys = optionList.map((item) => item.key);
  const result = value.map((item) => typeof item === 'string' ? item.trim().toUpperCase() : '');
  if (!result.length || result.some((item) => !keys.includes(item)) || new Set(result).size !== result.length) throw new PracticeApiError(400, '答案必须对应题目选项且不能重复。');
  if (type === 'multiple' ? result.length < 2 : result.length !== 1) throw new PracticeApiError(400, type === 'multiple' ? '多选题至少需要两个答案。' : '该题只能选择一个答案。');
  return result;
}

async function transaction<T>(database: PracticeDatabase, run: (connection: PracticeSqlConnection) => Promise<T>): Promise<T> {
  const connection = await database.getConnection();
  try { await connection.beginTransaction(); const result = await run(connection); await connection.commit(); return result; }
  catch (error) { await connection.rollback().catch(() => undefined); throw error; }
  finally { connection.release(); }
}

async function activeBank(database: PracticeSqlExecutor, bankId: string) {
  const id = requiredId(bankId, '题库标识');
  const [rows] = await database.execute('SELECT id, subject_id, kind, name, sort_order, (SELECT COUNT(*) FROM questions WHERE question_bank_id = question_banks.id AND deleted_at IS NULL) AS question_count, (SELECT COUNT(*) FROM question_chapters WHERE question_bank_id = question_banks.id AND deleted_at IS NULL) AS chapter_count FROM question_banks WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new PracticeApiError(404, '题库不存在或已删除。');
  const kind = textValue(row.kind);
  if (kind !== 'chapter' && kind !== 'official' && kind !== 'mock') throw new PracticeApiError(409, '题库类型已损坏。');
  return { id, subjectId: textValue(row.subject_id), kind, summary: { id, subjectId: textValue(row.subject_id), kind, name: textValue(row.name), sortOrder: numberValue(row.sort_order), questionCount: numberValue(row.question_count), chapterCount: numberValue(row.chapter_count) } satisfies QuestionBankSummary };
}

async function activeSubject(database: PracticeSqlExecutor, subjectId: string) {
  const id = requiredId(subjectId, '科目标识');
  const [rows] = await database.execute('SELECT id FROM subjects WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
  if (!rowsFrom(rows)[0]) throw new PracticeApiError(404, '科目不存在或已删除。');
  return id;
}

async function activeChapter(database: PracticeSqlExecutor, chapterId: string, bankId: string) {
  const id = requiredId(chapterId, '章节标识');
  const [rows] = await database.execute('SELECT id, question_bank_id, title, sort_order, (SELECT COUNT(*) FROM questions WHERE question_chapter_id = question_chapters.id AND deleted_at IS NULL) AS question_count FROM question_chapters WHERE id = ? AND question_bank_id = ? AND deleted_at IS NULL LIMIT 1', [id, bankId]);
  const row = rowsFrom(rows)[0];
  if (!row) throw new PracticeApiError(404, '章节不存在或不属于该题库。');
  return { id, questionBankId: bankId, title: textValue(row.title), sortOrder: numberValue(row.sort_order), questionCount: numberValue(row.question_count) } satisfies QuestionChapterSummary;
}

function snapshotFromQuestion(row: Record<string, unknown>) {
  const type = textValue(row.question_type) as QuestionType;
  return {
    questionId: textValue(row.id), questionVersion: numberValue(row.version), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id),
    isFavorite: row.is_favorite === true || row.is_favorite === 1,
    stem: content(readJson(row.stem_json, '题干'), '题干'), type, options: questionOptions(readJson(row.options_json, '选项')), answer: answer(readJson(row.answer_json, '答案')),
    analysis: row.analysis_json === null ? null : content(readJson(row.analysis_json, '解析'), '解析'),
  };
}

function sessionSummary(row: Record<string, unknown>, questionCount: number, answeredCount: number, currentIndex: number): PracticeSessionSummary {
  return { id: textValue(row.id), questionBankId: row.question_bank_id === null ? null : textValue(row.question_bank_id), subjectId: row.subject_id === null ? null : textValue(row.subject_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), mode: textValue(row.mode) as PracticeMode, source: textValue(row.source) as PracticeSource, status: textValue(row.status) as PracticeSessionStatus, questionCount, answeredCount, currentIndex, startedAt: dateValue(row.started_at), completedAt: row.completed_at === null ? null : dateValue(row.completed_at), updatedAt: dateValue(row.updated_at) };
}

function viewFromRows(session: Record<string, unknown>, attemptRows: Array<Record<string, unknown>>, mode: PracticeMode, status: PracticeSessionStatus): PracticeSessionResponse {
  const questions: PracticeQuestionView[] = attemptRows.map((row) => {
    const snapshot = readJson(row.snapshot_json, '题目快照');
    if (!isRecord(snapshot)) throw new PracticeApiError(409, '题目快照已损坏。');
    const type = textValue(snapshot.type) as QuestionType;
    const snapshotOptions = questionOptions(snapshot.options);
    const savedAnswer = row.answer_json === null ? null : answer(readJson(row.answer_json, '作答答案'));
    const attempt: PracticeAttemptView = { questionId: textValue(row.question_id), questionVersion: numberValue(row.question_version), answer: savedAnswer, result: textValue(row.result) as 'unanswered' | 'correct' | 'incorrect', answeredAt: row.answered_at === null ? null : dateValue(row.answered_at) };
    const answered = attempt.answer !== null;
    const reveal = status === 'completed' || (mode === 'cram' && answered);
    const reviewNote: QuestionReviewNote | null = !reveal || row.note_text === null || row.note_text === undefined
      ? null
      : {
          questionId: textValue(row.question_id),
          noteText: textValue(row.note_text),
          strokes: normalizeHandwrittenStrokes(row.ink_json === null || row.ink_json === undefined ? [] : readJson(row.ink_json, '题目手写备注'), (message) => new PracticeApiError(409, `已保存的${message}`)),
          updatedAt: dateValue(row.note_updated_at),
        };
    return { id: textValue(row.question_id), questionChapterId: snapshot.questionChapterId === null ? null : textValue(snapshot.questionChapterId), isFavorite: snapshot.isFavorite === true, stem: content(snapshot.stem, '题干'), type, options: snapshotOptions, analysis: reveal ? (snapshot.analysis === null ? null : content(snapshot.analysis, '解析')) : null, reviewNote, attempt, ...(reveal ? { correctAnswer: answer(snapshot.answer) } : {}) };
  });
  const answeredCount = questions.filter((question) => question.attempt.answer !== null).length;
  const currentIndex = Math.max(0, questions.findIndex((question) => question.attempt.answer === null));
  const summary = sessionSummary(session, questions.length, answeredCount, currentIndex === -1 ? Math.max(0, questions.length - 1) : currentIndex);
  return { session: summary, questions, ...(status === 'completed' ? { result: resultSummary(attemptRows) } : {}) };
}

async function sessionRows(database: PracticeSqlExecutor, sessionId: string) {
  const id = requiredId(sessionId, '会话标识');
  const [sessionResult, attemptResult] = await Promise.all([
    database.execute('SELECT id, question_bank_id, subject_id, question_chapter_id, mode, source, status, started_at, completed_at, updated_at FROM practice_sessions WHERE id = ? LIMIT 1', [id]),
    database.execute('SELECT a.question_id, a.question_version, a.sort_order, a.snapshot_json, a.answer_json, a.result, a.answered_at, n.note_text, n.ink_json, n.updated_at AS note_updated_at FROM practice_attempts AS a LEFT JOIN question_review_notes AS n ON n.question_id = a.question_id WHERE a.practice_session_id = ? ORDER BY a.sort_order, a.id', [id]),
  ]);
  const session = rowsFrom(sessionResult[0])[0];
  if (!session) throw new PracticeApiError(404, '刷题会话不存在。');
  return { session, attempts: rowsFrom(attemptResult[0]) };
}

export function createPracticeDatabase(pool: Pool): PracticeDatabase {
  return { execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>, async getConnection() { const connection = await pool.getConnection(); return { execute: (sql, values) => connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>, beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(), rollback: () => connection.rollback(), release: () => connection.release() }; } };
}

export function createPracticeService(options: { database?: PracticeDatabase } = {}): PracticeService {
  const database = options.database ?? createPracticeDatabase(createDatabasePool());
  return {
    async listInProgress(bankId) {
      const bank = await activeBank(database, bankId);
      const [rows] = await database.execute('SELECT s.id, s.question_bank_id, s.subject_id, s.question_chapter_id, s.mode, s.source, s.status, s.started_at, s.completed_at, s.updated_at, COUNT(a.id) AS question_count, SUM(a.answer_json IS NOT NULL) AS answered_count, COALESCE(MIN(CASE WHEN a.answer_json IS NULL THEN a.sort_order END), MAX(a.sort_order), 0) AS current_index FROM practice_sessions AS s INNER JOIN practice_attempts AS a ON a.practice_session_id = s.id WHERE s.question_bank_id = ? AND s.status = \'in_progress\' GROUP BY s.id ORDER BY s.updated_at DESC, s.id DESC', [bank.id]);
      return { sessions: rowsFrom(rows).map((row) => sessionSummary(row, numberValue(row.question_count), numberValue(row.answered_count), numberValue(row.current_index))) };
    },
    async start(request) {
      const mode = readMode(request.mode);
      const source = readSource(request.source ?? 'full');
      const options = readPracticeOptions(request);
      if (source !== 'full' && options.unattemptedOnly) throw new PracticeApiError(400, '未做筛选不适用于错题练习。');
      return transaction(database, async (connection) => {
        const bank = await activeBank(connection, request.questionBankId);
        let chapterId: string | null = null;
        if (request.questionChapterId !== null && request.questionChapterId !== undefined) {
          if (bank.kind !== 'chapter') throw new PracticeApiError(400, '真题和模拟题不支持章节范围。');
          chapterId = (await activeChapter(connection, request.questionChapterId, bank.id)).id;
        }
        let questionSql = 'SELECT q.id, q.question_bank_id, q.question_chapter_id, q.stem_json, q.question_type, q.options_json, q.answer_json, q.analysis_json, q.is_favorite, q.version FROM questions AS q';
        let questionValues: unknown[];
        if (source === 'full') {
          questionSql += ' WHERE q.question_bank_id = ? AND q.deleted_at IS NULL';
          questionValues = [bank.id];
        } else if (source === 'current_wrong') {
          const sourceSessionId = requiredId(request.sourceSessionId, '错题会话标识');
          const [sourceRows] = await connection.execute('SELECT id, question_bank_id, status FROM practice_sessions WHERE id = ? LIMIT 1', [sourceSessionId]);
          const sourceSession = rowsFrom(sourceRows)[0];
          if (!sourceSession || textValue(sourceSession.question_bank_id) !== bank.id) throw new PracticeApiError(404, '错题会话不存在或不属于当前题库。');
          if (textValue(sourceSession.status) !== 'completed') throw new PracticeApiError(409, '只有已完成会话才能开始本次错题。');
          questionSql += ' INNER JOIN practice_attempts AS a ON a.question_id = q.id AND a.practice_session_id = ? AND a.result = \'incorrect\' WHERE q.question_bank_id = ? AND q.deleted_at IS NULL';
          questionValues = [sourceSessionId, bank.id];
        } else {
          questionSql += ' INNER JOIN practice_attempts AS a ON a.question_id = q.id INNER JOIN practice_sessions AS s ON s.id = a.practice_session_id AND s.status = \'completed\' AND s.question_bank_id = ? WHERE q.question_bank_id = ? AND q.deleted_at IS NULL AND a.result = \'incorrect\' AND NOT EXISTS (SELECT 1 FROM practice_attempts AS newer_a INNER JOIN practice_sessions AS newer_s ON newer_s.id = newer_a.practice_session_id AND newer_s.status = \'completed\' AND newer_s.question_bank_id = ? WHERE newer_a.question_id = a.question_id AND (newer_a.answered_at > a.answered_at OR (newer_a.answered_at = a.answered_at AND newer_a.id > a.id)))';
          questionValues = [bank.id, bank.id, bank.id];
        }
        if (chapterId) { questionSql += ' AND q.question_chapter_id = ?'; questionValues.push(chapterId); }
        if (options.unattemptedOnly) questionSql += ' AND NOT EXISTS (SELECT 1 FROM practice_attempts AS previous_attempt WHERE previous_attempt.question_id = q.id AND previous_attempt.answer_json IS NOT NULL)';
        questionSql += ' ORDER BY q.sort_order, q.created_at, q.id';
        const [questionRows] = await connection.execute(questionSql, questionValues);
        const questions = selectPracticeQuestions(rowsFrom(questionRows), options);
        if (!questions.length) throw new PracticeApiError(409, '当前范围没有可练习的题目。');
        const sessionId = randomUUID();
        await connection.execute('INSERT INTO practice_sessions (id, question_bank_id, subject_id, question_chapter_id, mode, source, scope_json, status) VALUES (?, ?, NULL, ?, ?, ?, ?, \'in_progress\')', [sessionId, bank.id, chapterId, mode, source, JSON.stringify({ questionIds: questions.map((row) => textValue(row.id)), sourceSessionId: request.sourceSessionId ?? null, questionCount: options.questionCount, shuffle: options.shuffle, unattemptedOnly: options.unattemptedOnly })]);
        for (const [index, row] of questions.entries()) {
          const snapshot = snapshotFromQuestion(row);
          await connection.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result) VALUES (?, ?, ?, ?, ?, ?, NULL, \'unanswered\')', [randomUUID(), sessionId, snapshot.questionId, snapshot.questionVersion, index, JSON.stringify(snapshot)]);
        }
        const loaded = await sessionRows(connection, sessionId);
        return viewFromRows(loaded.session, loaded.attempts, mode, 'in_progress');
      });
    },
    async startFavorite(request) {
      const mode = readMode(request.mode);
      const options = readPracticeOptions(request);
      const subjectId = await activeSubject(database, request.subjectId);
      return transaction(database, async (connection) => {
        const [questionRows] = await connection.execute(`
          SELECT q.id, q.question_bank_id, q.question_chapter_id, q.stem_json, q.question_type, q.options_json, q.answer_json, q.analysis_json, q.is_favorite, q.version
          FROM questions AS q
          INNER JOIN question_banks AS b ON b.id = q.question_bank_id AND b.deleted_at IS NULL
          WHERE b.subject_id = ? AND q.is_favorite = 1 AND q.deleted_at IS NULL${options.unattemptedOnly ? ' AND NOT EXISTS (SELECT 1 FROM practice_attempts AS previous_attempt WHERE previous_attempt.question_id = q.id AND previous_attempt.answer_json IS NOT NULL)' : ''}
          ORDER BY FIELD(b.kind, 'chapter', 'official', 'mock'), b.sort_order, q.question_chapter_id IS NOT NULL, q.question_chapter_id, q.sort_order, q.created_at, q.id
        `, [subjectId]);
        const questions = selectPracticeQuestions(rowsFrom(questionRows), options);
        if (!questions.length) throw new PracticeApiError(409, '当前科目没有收藏题。');
        const sessionId = randomUUID();
        await connection.execute('INSERT INTO practice_sessions (id, question_bank_id, subject_id, question_chapter_id, mode, source, scope_json, status) VALUES (?, NULL, ?, NULL, ?, \'favorite\', ?, \'in_progress\')', [sessionId, subjectId, mode, JSON.stringify({ subjectId, questionIds: questions.map((row) => textValue(row.id)), questionCount: options.questionCount, shuffle: options.shuffle, unattemptedOnly: options.unattemptedOnly })]);
        for (const [index, row] of questions.entries()) {
          const snapshot = snapshotFromQuestion(row);
          await connection.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result) VALUES (?, ?, ?, ?, ?, ?, NULL, \'unanswered\')', [randomUUID(), sessionId, snapshot.questionId, snapshot.questionVersion, index, JSON.stringify(snapshot)]);
        }
        const loaded = await sessionRows(connection, sessionId);
        return viewFromRows(loaded.session, loaded.attempts, mode, 'in_progress');
      });
    },
    async startWrong(request) {
      const mode = readMode(request.mode);
      const options = readPracticeOptions(request);
      if (options.unattemptedOnly) throw new PracticeApiError(400, '未做筛选不适用于累计错题。');
      const subjectId = await activeSubject(database, request.subjectId);
      return transaction(database, async (connection) => {
        const values: unknown[] = [subjectId];
        const filters: string[] = [];
        if (request.knowledgePoint?.trim()) { filters.push('JSON_CONTAINS(q.knowledge_points_json, JSON_QUOTE(?))'); values.push(request.knowledgePoint.trim()); }
        if (request.type) { filters.push('q.question_type = ?'); values.push(request.type); }
        if (request.since) { const since = new Date(request.since); if (Number.isNaN(since.getTime())) throw new PracticeApiError(400, '最近错误时间无效。'); filters.push('latest.latest_wrong_at >= ?'); values.push(since); }
        const [questionRows] = await connection.execute(`SELECT q.id, q.question_bank_id, q.question_chapter_id, q.stem_json, q.question_type, q.options_json, q.answer_json, q.analysis_json, q.is_favorite, q.version FROM questions q INNER JOIN question_banks b ON b.id=q.question_bank_id AND b.deleted_at IS NULL INNER JOIN (SELECT a.question_id, MAX(a.answered_at) latest_wrong_at FROM practice_attempts a INNER JOIN practice_sessions ps ON ps.id=a.practice_session_id AND ps.status='completed' WHERE a.result='incorrect' AND a.answered_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM practice_attempts newer_a INNER JOIN practice_sessions newer_ps ON newer_ps.id=newer_a.practice_session_id AND newer_ps.status='completed' WHERE newer_a.question_id=a.question_id AND (newer_a.answered_at>a.answered_at OR (newer_a.answered_at=a.answered_at AND newer_a.id>a.id))) GROUP BY a.question_id) latest ON latest.question_id=q.id WHERE b.subject_id=? AND q.deleted_at IS NULL ${filters.length ? `AND ${filters.join(' AND ')}` : ''} ORDER BY latest.latest_wrong_at DESC, q.id`, values);
        const questions = selectPracticeQuestions(rowsFrom(questionRows), options); if (!questions.length) throw new PracticeApiError(409, '当前筛选没有累计错题。');
        const sessionId = randomUUID();
        await connection.execute('INSERT INTO practice_sessions (id, question_bank_id, subject_id, question_chapter_id, mode, source, scope_json, status) VALUES (?, NULL, ?, NULL, ?, \'aggregate_wrong\', ?, \'in_progress\')', [sessionId, subjectId, mode, JSON.stringify({ subjectId, questionIds: questions.map((row) => textValue(row.id)), knowledgePoint: request.knowledgePoint ?? null, type: request.type ?? null, since: request.since ?? null, questionCount: options.questionCount, shuffle: options.shuffle })]);
        for (const [index, row] of questions.entries()) { const snapshot = snapshotFromQuestion(row); await connection.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result) VALUES (?, ?, ?, ?, ?, ?, NULL, \'unanswered\')', [randomUUID(), sessionId, snapshot.questionId, snapshot.questionVersion, index, JSON.stringify(snapshot)]); }
        const loaded = await sessionRows(connection, sessionId); return viewFromRows(loaded.session, loaded.attempts, mode, 'in_progress');
      });
    },
    async get(sessionId) { const loaded = await sessionRows(database, sessionId); return viewFromRows(loaded.session, loaded.attempts, textValue(loaded.session.mode) as PracticeMode, textValue(loaded.session.status) as PracticeSessionStatus); },
    async answer(sessionId, questionId, request) {
      return transaction(database, async (connection) => {
        const loaded = await answerRows(connection, sessionId, questionId);
        const session = loaded.session;
        if (textValue(session.status) !== 'in_progress') throw new PracticeApiError(409, '会话已结束，不能继续作答。');
        const attempt = loaded.attempt;
        const snapshot = readJson(attempt.snapshot_json, '题目快照');
        if (!isRecord(snapshot)) throw new PracticeApiError(409, '题目快照已损坏。');
        const type = textValue(snapshot.type) as QuestionType;
        const selected = validAnswer(request.answer, type, questionOptions(snapshot.options));
        const correct = answer(snapshot.answer);
        const mode = textValue(session.mode) as PracticeMode;
        const result = mode === 'cram' ? (equalAnswers(selected, correct) ? 'correct' : 'incorrect') : 'unanswered';
        await connection.execute('UPDATE practice_attempts SET answer_json = ?, result = ?, answered_at = CURRENT_TIMESTAMP(3) WHERE practice_session_id = ? AND question_id = ?', [JSON.stringify(selected), result, textValue(session.id), textValue(attempt.question_id)]);
        const next = await answerResponseRows(connection, sessionId, textValue(attempt.question_id), mode);
        const [summaryRows] = await connection.execute('SELECT COUNT(*) AS question_count, SUM(answer_json IS NOT NULL) AS answered_count, COALESCE(MIN(CASE WHEN answer_json IS NULL THEN sort_order END), MAX(sort_order), 0) AS current_index FROM practice_attempts WHERE practice_session_id = ?', [textValue(session.id)]);
        const summary = rowsFrom(summaryRows)[0];
        return { ...next, session: sessionSummary(session, numberValue(summary?.question_count), numberValue(summary?.answered_count), numberValue(summary?.current_index)) };
      });
    },
    async complete(sessionId) {
      return transaction(database, async (connection) => {
        const loaded = await sessionRows(connection, sessionId);
        if (textValue(loaded.session.status) !== 'in_progress') return viewFromRows(loaded.session, loaded.attempts, textValue(loaded.session.mode) as PracticeMode, textValue(loaded.session.status) as PracticeSessionStatus);
        if (textValue(loaded.session.mode) === 'test') {
          for (const attempt of loaded.attempts) {
            if (attempt.answer_json === null) continue;
            const snapshot = readJson(attempt.snapshot_json, '题目快照');
            if (!isRecord(snapshot)) throw new PracticeApiError(409, '题目快照已损坏。');
            const selected = answer(readJson(attempt.answer_json, '作答答案'));
            const result = equalAnswers(selected, answer(snapshot.answer)) ? 'correct' : 'incorrect';
            await connection.execute('UPDATE practice_attempts SET result = ? WHERE practice_session_id = ? AND question_id = ?', [result, textValue(loaded.session.id), textValue(attempt.question_id)]);
          }
        }
        await connection.execute('UPDATE practice_sessions SET status = \'completed\', completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [textValue(loaded.session.id)]);
        const next = await sessionRows(connection, sessionId);
        return viewFromRows(next.session, next.attempts, textValue(next.session.mode) as PracticeMode, 'completed');
      });
    },
    async abandon(sessionId) {
      return transaction(database, async (connection) => {
        const loaded = await sessionRows(connection, sessionId);
        if (textValue(loaded.session.status) === 'in_progress') await connection.execute('UPDATE practice_sessions SET status = \'abandoned\', completed_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [textValue(loaded.session.id)]);
        const next = await sessionRows(connection, sessionId);
        return viewFromRows(next.session, next.attempts, textValue(next.session.mode) as PracticeMode, textValue(next.session.status) as PracticeSessionStatus);
      });
    },
  };
}
