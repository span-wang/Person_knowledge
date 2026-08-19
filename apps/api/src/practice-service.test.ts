import assert from 'node:assert/strict';
import test from 'node:test';
import { PracticeApiError, createPracticeService, type PracticeDatabase, type PracticeSqlConnection } from './practice-service.js';

type Row = Record<string, unknown>;

const paragraph = (value: string) => [{ type: 'paragraph' as const, children: [{ type: 'text' as const, value }] }];

class FakePracticeDatabase implements PracticeDatabase {
  readonly writes: string[] = [];
  private readonly sessions: Row[] = [];
  private readonly attempts: Row[] = [];
  private sequence = 0;
  constructor(private readonly bankKind: 'chapter' | 'official' = 'chapter', private readonly chapterBelongsToBank = true) {}

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    if (lower.startsWith('select id, subject_id') && lower.includes('from question_banks')) {
      return [[{ id: 'bank-1', subject_id: 'subject-1', kind: this.bankKind, name: '题库', sort_order: 0, question_count: 2, chapter_count: 1 }], []];
    }
    if (lower.startsWith('select id, question_bank_id') && lower.includes('from question_chapters')) {
      if (!this.chapterBelongsToBank) return [[], []];
      return [[{ id: 'chapter-1', question_bank_id: 'bank-1', title: '第一章', sort_order: 0, question_count: 2 }], []];
    }
    if ((lower.startsWith('select id, question_bank_id, question_chapter_id, stem_json') || lower.startsWith('select q.id, q.question_bank_id, q.question_chapter_id, q.stem_json')) && lower.includes('from questions')) {
      let rows = [this.questionRow('question-1', 0, 'A'), this.questionRow('question-2', 1, 'B')];
      if (lower.includes('a.practice_session_id = ?')) {
        const sourceSessionId = String(values[0]);
        rows = rows.filter((row) => this.attempts.some((attempt) => attempt.practice_session_id === sourceSessionId && attempt.question_id === row.id && attempt.result === 'incorrect'));
      }
      if (lower.includes('not exists')) {
        const latestByQuestion = new Map<string, Row>();
        for (const attempt of this.attempts.filter((item) => item.answer_json !== null)) latestByQuestion.set(String(attempt.question_id), attempt);
        rows = rows.filter((row) => latestByQuestion.get(String(row.id))?.result === 'incorrect');
      }
      return [rows, []];
    }
    if (lower.startsWith('insert into practice_sessions')) {
      this.writes.push(normalized);
      this.sessions.push({ id: String(values[0]), question_bank_id: values[1], question_chapter_id: values[2], mode: values[3], source: values[4], status: 'in_progress', started_at: this.nextDate(), completed_at: null, updated_at: this.nextDate() });
      return [[], []];
    }
    if (lower.startsWith('insert into practice_attempts')) {
      this.writes.push(normalized);
      this.attempts.push({ id: String(values[0]), practice_session_id: values[1], question_id: values[2], question_version: values[3], sort_order: values[4], snapshot_json: values[5], answer_json: null, result: 'unanswered', answered_at: null });
      return [[], []];
    }
    if (lower.startsWith('select id, question_bank_id, question_chapter_id, mode, source, status, started_at')) {
      const id = String(values[0]);
      return [this.sessions.filter((row) => row.id === id), []];
    }
    if (lower.startsWith('select id, question_bank_id, status from practice_sessions')) {
      const id = String(values[0]);
      return [this.sessions.filter((row) => row.id === id), []];
    }
    if (lower.startsWith('select question_id, question_version, sort_order, snapshot_json')) {
      const id = String(values[0]);
      return [this.attempts.filter((row) => row.practice_session_id === id).sort((left, right) => Number(left.sort_order) - Number(right.sort_order)), []];
    }
    if (lower.startsWith('update practice_attempts set answer_json')) {
      this.writes.push(normalized);
      const [answerJson, result, sessionId, questionId] = values;
      const attempt = this.attempts.find((row) => row.practice_session_id === sessionId && row.question_id === questionId);
      if (attempt) { attempt.answer_json = answerJson; attempt.result = result; attempt.answered_at = this.nextDate(); }
      return [[], []];
    }
    if (lower.startsWith('update practice_attempts set result')) {
      this.writes.push(normalized);
      const [result, sessionId, questionId] = values;
      const attempt = this.attempts.find((row) => row.practice_session_id === sessionId && row.question_id === questionId);
      if (attempt) attempt.result = result;
      return [[], []];
    }
    if (lower.startsWith('update practice_sessions set status')) {
      this.writes.push(normalized);
      const [sessionId] = values;
      const session = this.sessions.find((row) => row.id === sessionId);
      if (session) { session.status = normalized.includes("'abandoned'") ? 'abandoned' : 'completed'; session.completed_at = this.nextDate(); session.updated_at = session.completed_at; }
      return [[], []];
    }
    throw new Error(`未处理 SQL: ${normalized}`);
  }

  async getConnection(): Promise<PracticeSqlConnection> {
    return { execute: (sql, values) => this.execute(sql, values), beginTransaction: async () => undefined, commit: async () => undefined, rollback: async () => undefined, release: () => undefined };
  }

  private nextDate() { this.sequence += 1; return `2026-08-19T00:00:0${this.sequence}.000Z`; }
  private questionRow(id: string, sortOrder: number, correct: string): Row {
    return { id, question_bank_id: 'bank-1', question_chapter_id: 'chapter-1', stem_json: JSON.stringify(paragraph(`题干 ${id}`)), question_type: 'single', options_json: JSON.stringify([{ key: 'A', content: paragraph('甲') }, { key: 'B', content: paragraph('乙') }]), answer_json: JSON.stringify([correct]), analysis_json: JSON.stringify(paragraph(`解析 ${id}`)), version: 1, sort_order: sortOrder, created_at: '2026-08-19T00:00:00.000Z' };
  }
}

test('非法答案在写入前被拒绝', async () => {
  const database = new FakePracticeDatabase();
  const service = createPracticeService({ database });
  const session = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test' });
  const writesBefore = database.writes.length;
  await assert.rejects(() => service.answer(session.session.id, 'question-1', { answer: ['C'] }), (error: unknown) => error instanceof PracticeApiError && error.statusCode === 400);
  assert.equal(database.writes.length, writesBefore);
});

test('检测作答隐藏答案，完成后才揭示结果', async () => {
  const service = createPracticeService({ database: new FakePracticeDatabase() });
  const session = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test' });
  assert.equal(session.questions[0].correctAnswer, undefined);
  assert.equal(session.questions[0].analysis, null);
  const answered = await service.answer(session.session.id, 'question-1', { answer: ['A'] });
  assert.equal(answered.questions[0].attempt.result, 'unanswered');
  assert.equal(answered.questions[0].correctAnswer, undefined);
  const completed = await service.complete(session.session.id);
  assert.equal(completed.session.status, 'completed');
  assert.deepEqual(completed.questions[0].correctAnswer, ['A']);
  assert.equal(completed.questions[0].attempt.result, 'correct');
  assert.notEqual(completed.questions[0].analysis, null);
  assert.deepEqual(completed.result, { questionCount: 2, answeredCount: 1, unansweredCount: 1, correctCount: 1, incorrectCount: 0, accuracy: 100 });
});

test('背题提交立即返回正确答案和结果', async () => {
  const service = createPracticeService({ database: new FakePracticeDatabase() });
  const session = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'cram' });
  const answered = await service.answer(session.session.id, 'question-1', { answer: ['B'] });
  assert.equal(answered.questions[0].attempt.result, 'incorrect');
  assert.deepEqual(answered.questions[0].correctAnswer, ['A']);
  assert.notEqual(answered.questions[0].analysis, null);
});

test('本次与累计错题专项只保留最近一次仍答错的题目', async () => {
  const service = createPracticeService({ database: new FakePracticeDatabase() });
  const source = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test' });
  await service.answer(source.session.id, 'question-1', { answer: ['B'] });
  await service.complete(source.session.id);
  const currentWrong = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test', source: 'current_wrong', sourceSessionId: source.session.id });
  assert.equal(currentWrong.session.source, 'current_wrong');
  assert.deepEqual(currentWrong.questions.map((question) => question.id), ['question-1']);
  const aggregateWrong = await service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'cram', source: 'aggregate_wrong' });
  assert.deepEqual(aggregateWrong.questions.map((question) => question.id), ['question-1']);
  await service.answer(aggregateWrong.session.id, 'question-1', { answer: ['A'] });
  await service.complete(aggregateWrong.session.id);
  await assert.rejects(() => service.start({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test', source: 'aggregate_wrong' }), (error: unknown) => error instanceof PracticeApiError && error.statusCode === 409);
});

test('章节范围只允许章节题库且必须属于当前题库', async () => {
  const official = createPracticeService({ database: new FakePracticeDatabase('official') });
  await assert.rejects(() => official.start({ questionBankId: 'bank-1', questionChapterId: 'chapter-1', mode: 'test' }), (error: unknown) => error instanceof PracticeApiError && error.statusCode === 400);
  const missingChapter = createPracticeService({ database: new FakePracticeDatabase('chapter', false) });
  await assert.rejects(() => missingChapter.start({ questionBankId: 'bank-1', questionChapterId: 'chapter-1', mode: 'test' }), (error: unknown) => error instanceof PracticeApiError && error.statusCode === 404);
});
