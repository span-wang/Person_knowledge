import type { LearningInsightsPeriod, LearningInsightsResponse, ReviewMasteryStatus } from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface LearningInsightsSqlExecutor { execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>; }
export class LearningInsightsApiError extends Error { constructor(readonly statusCode: number, message: string) { super(message); this.name = 'LearningInsightsApiError'; } }
export interface LearningInsightsService { get(request: { periodDays?: LearningInsightsPeriod; courseId?: string; subjectId?: string | null }): Promise<LearningInsightsResponse>; }
type Row = Record<string, unknown>;
const statuses: ReviewMasteryStatus[] = ['unassessed', 'mastered', 'familiar', 'effort'];

function rows(value: unknown): Row[] { return Array.isArray(value) ? value.filter((item): item is Row => typeof item === 'object' && item !== null && !Array.isArray(item)) : []; }
function text(value: unknown): string { return typeof value === 'string' ? value : String(value ?? ''); }
function date(value: unknown): Date | null { const parsed = value instanceof Date ? value : new Date(text(value)); return Number.isNaN(parsed.getTime()) ? null : parsed; }
function parseJson(value: unknown): unknown { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } }
function requiredOptional(value: string | undefined, label: string): string | undefined { if (value === undefined) return undefined; if (!value.trim() || value.length > 128) throw new LearningInsightsApiError(400, `${label}无效。`); return value.trim(); }
function localDateParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(value);
  return { year: Number(parts.find((part) => part.type === 'year')?.value), month: Number(parts.find((part) => part.type === 'month')?.value), day: Number(parts.find((part) => part.type === 'day')?.value) };
}
function dateKey(value: unknown): string | null {
  const parsed = date(value); if (!parsed) return null;
  const parts = localDateParts(parsed);
  return `${parts.year.toString().padStart(4, '0')}-${parts.month.toString().padStart(2, '0')}-${parts.day.toString().padStart(2, '0')}`;
}
function periodWindow(now: Date, periodDays: LearningInsightsPeriod) {
  const parts = localDateParts(now);
  // 上海全年固定为 UTC+08:00；边界先按自然日计算，再转换成 UTC 查询范围。
  const endLocal = Date.UTC(parts.year, parts.month - 1, parts.day + 1);
  const startLocal = Date.UTC(parts.year, parts.month - 1, parts.day - periodDays + 1);
  return { start: new Date(startLocal - 8 * 60 * 60 * 1000), end: new Date(endLocal - 8 * 60 * 60 * 1000), from: new Date(startLocal - 8 * 60 * 60 * 1000).toISOString(), to: new Date(endLocal - 8 * 60 * 60 * 1000).toISOString() };
}
function dayKeys(now: Date, periodDays: LearningInsightsPeriod): string[] {
  const parts = localDateParts(now);
  return Array.from({ length: periodDays }, (_, index) => {
    const current = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - periodDays + 1 + index));
    return `${current.getUTCFullYear().toString().padStart(4, '0')}-${(current.getUTCMonth() + 1).toString().padStart(2, '0')}-${current.getUTCDate().toString().padStart(2, '0')}`;
  });
}
function filterSql(courseId: string | undefined, subjectId: string | null | undefined, alias: string, values: unknown[]) {
  let clause = '';
  if (courseId) { clause += ` AND ${alias}.course_id = ?`; values.push(courseId); }
  if (subjectId) { clause += ` AND ${alias}.id = ?`; values.push(subjectId); }
  return clause;
}

export function createLearningInsightsService(options: { database?: LearningInsightsSqlExecutor; now?: Date } = {}): LearningInsightsService {
  const database = options.database ?? createDatabasePool() as unknown as LearningInsightsSqlExecutor;
  const now = options.now ?? new Date();
  return { async get(request) {
    const periodDays = request.periodDays ?? 7;
    if (periodDays !== 7 && periodDays !== 30) throw new LearningInsightsApiError(400, '统计周期无效。');
    const courseId = requiredOptional(request.courseId, '课程标识');
    const subjectId = request.subjectId === null ? null : requiredOptional(request.subjectId, '科目标识');
    const window = periodWindow(now, periodDays);
    const days = dayKeys(now, periodDays);
    const valuesFor = () => [window.start, window.end] as unknown[];
    const flashcardValues = valuesFor();
    const flashcardClause = filterSql(courseId, subjectId, 's', flashcardValues);
    const statusValues = valuesFor();
    const statusClause = filterSql(courseId, subjectId, 's', statusValues);
    const practiceValues = valuesFor();
    const practiceClause = filterSql(courseId, subjectId, 's', practiceValues);
    const [flashcardResult, statusResult, practiceResult] = await Promise.all([
      database.execute(`SELECT rr.last_viewed_at FROM review_records rr INNER JOIN cards c ON c.id = rr.card_id AND c.deleted_at IS NULL INNER JOIN sections se ON se.id = c.section_id AND se.deleted_at IS NULL INNER JOIN chapters ch ON ch.id = se.chapter_id AND ch.deleted_at IS NULL INNER JOIN materials m ON m.id = ch.material_id AND m.deleted_at IS NULL INNER JOIN subjects s ON s.id = m.subject_id AND s.deleted_at IS NULL WHERE rr.last_viewed_at >= ? AND rr.last_viewed_at < ?${flashcardClause}`, flashcardValues),
      database.execute(`SELECT h.changed_at, h.to_status FROM review_status_history h INNER JOIN cards c ON c.id = h.card_id AND c.deleted_at IS NULL INNER JOIN sections se ON se.id = c.section_id AND se.deleted_at IS NULL INNER JOIN chapters ch ON ch.id = se.chapter_id AND ch.deleted_at IS NULL INNER JOIN materials m ON m.id = ch.material_id AND m.deleted_at IS NULL INNER JOIN subjects s ON s.id = m.subject_id AND s.deleted_at IS NULL WHERE h.changed_at >= ? AND h.changed_at < ?${statusClause}`, statusValues),
      database.execute(`SELECT a.answered_at, a.result, q.knowledge_points_json FROM practice_attempts a INNER JOIN practice_sessions ps ON ps.id = a.practice_session_id AND ps.status = 'completed' INNER JOIN questions q ON q.id = a.question_id AND q.deleted_at IS NULL INNER JOIN question_banks b ON b.id = q.question_bank_id AND b.deleted_at IS NULL INNER JOIN subjects s ON s.id = b.subject_id AND s.deleted_at IS NULL WHERE a.answered_at >= ? AND a.answered_at < ? AND a.answer_json IS NOT NULL${practiceClause}`, practiceValues),
    ]);
    const flashcardDaily = new Map(days.map((day) => [day, 0]));
    let reviewedCount = 0;
    for (const row of rows(flashcardResult[0])) {
      const key = dateKey(row.last_viewed_at);
      if (!key || !flashcardDaily.has(key)) continue;
      // 当前记录只保存最近查看时间，按卡计数才不会把历史累计次数误归属到本周期。
      flashcardDaily.set(key, (flashcardDaily.get(key) ?? 0) + 1);
      reviewedCount += 1;
    }
    const statusDaily = new Map(days.map((day) => [day, 0]));
    const byStatus = Object.fromEntries(statuses.map((status) => [status, 0])) as Record<ReviewMasteryStatus, number>;
    for (const row of rows(statusResult[0])) { const key = dateKey(row.changed_at); const status = text(row.to_status) as ReviewMasteryStatus; if (key && statusDaily.has(key)) statusDaily.set(key, (statusDaily.get(key) ?? 0) + 1); if (status in byStatus) byStatus[status] += 1; }
    const practiceDaily = new Map(days.map((day) => [day, { answeredCount: 0, correctCount: 0 }]));
    const weak = new Map<string, { answeredCount: number; incorrectCount: number }>();
    let answeredCount = 0; let correctCount = 0; let incorrectCount = 0;
    for (const row of rows(practiceResult[0])) {
      const key = dateKey(row.answered_at); const result = text(row.result); if (result !== 'correct' && result !== 'incorrect') continue;
      answeredCount += 1; if (result === 'correct') correctCount += 1; else incorrectCount += 1;
      if (key && practiceDaily.has(key)) { const day = practiceDaily.get(key)!; day.answeredCount += 1; if (result === 'correct') day.correctCount += 1; }
      const points = parseJson(row.knowledge_points_json); if (!Array.isArray(points)) continue;
      for (const pointValue of points) { if (typeof pointValue !== 'string' || !pointValue.trim()) continue; const point = pointValue.trim(); const entry = weak.get(point) ?? { answeredCount: 0, incorrectCount: 0 }; entry.answeredCount += 1; if (result === 'incorrect') entry.incorrectCount += 1; weak.set(point, entry); }
    }
    const weakKnowledgePoints = [...weak.entries()].filter(([, entry]) => entry.answeredCount >= 3).map(([knowledgePoint, entry]) => ({ knowledgePoint, answeredCount: entry.answeredCount, incorrectCount: entry.incorrectCount, accuracy: Math.round(((entry.answeredCount - entry.incorrectCount) / entry.answeredCount) * 100) })).sort((left, right) => right.incorrectCount - left.incorrectCount || left.accuracy - right.accuracy || left.knowledgePoint.localeCompare(right.knowledgePoint));
    return { periodDays, timezone: 'Asia/Shanghai', from: window.from, to: window.to, flashcards: { reviewedCount, daily: days.map((date) => ({ date, count: flashcardDaily.get(date) ?? 0 })) }, masteryChanges: { total: [...statusDaily.values()].reduce((sum, count) => sum + count, 0), daily: days.map((date) => ({ date, count: statusDaily.get(date) ?? 0 })), byStatus }, practice: { answeredCount, correctCount, incorrectCount, accuracy: answeredCount ? Math.round((correctCount / answeredCount) * 100) : null, daily: days.map((date) => ({ date, ...(practiceDaily.get(date) ?? { answeredCount: 0, correctCount: 0 }) })) }, weakKnowledgePoints };
  } };
}
