import assert from 'node:assert/strict';
import test from 'node:test';
import { createWrongAnswerService, WrongAnswerApiError, type WrongAnswerSqlExecutor } from './wrong-answer-service.js';

class FakeWrongAnswerDatabase implements WrongAnswerSqlExecutor {
  sql = '';
  values: readonly unknown[] = [];
  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.sql = sql.replace(/\s+/g, ' ').trim();
    this.values = values;
    return [[{
      id: 'question-1', question_bank_id: 'bank-1', question_chapter_id: 'chapter-1',
      stem_json: JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: '题干' }] }]),
      question_type: 'single', options_json: JSON.stringify([]), answer_json: JSON.stringify(['A']),
      analysis_json: null, knowledge_points_json: JSON.stringify(['函数']), is_favorite: 0,
      version: 2, sort_order: 1, created_at: new Date('2026-08-19T00:00:00Z'), updated_at: new Date('2026-08-19T00:00:00Z'),
      note_text: '注意定义域', note_updated_at: new Date('2026-08-19T01:00:00Z'), latest_wrong_at: new Date('2026-08-19T02:00:00Z'),
    }], []];
  }
}

test('错题查询只返回最近一次仍为错误的有效题目并传递筛选条件', async () => {
  const database = new FakeWrongAnswerDatabase();
  const result = await createWrongAnswerService({ database }).list({ subjectId: 'subject-1', knowledgePoint: '函数', type: 'single', since: '2026-08-18T00:00:00.000Z' });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.question.reviewNote, '注意定义域');
  assert.equal(result.items[0]?.note?.noteText, '注意定义域');
  assert.match(database.sql, /NOT EXISTS/);
  assert.match(database.sql, /q\.deleted_at IS NULL/);
  assert.deepEqual(database.values, ['subject-1', '函数', 'single', new Date('2026-08-18T00:00:00.000Z')]);
});

test('错题查询拒绝空科目和非法日期且不访问数据库', async () => {
  const database = new FakeWrongAnswerDatabase();
  const service = createWrongAnswerService({ database });
  await assert.rejects(() => service.list({ subjectId: '' }), (error: unknown) => error instanceof WrongAnswerApiError && error.statusCode === 400);
  await assert.rejects(() => service.list({ subjectId: 'subject-1', since: 'bad-date' }), (error: unknown) => error instanceof WrongAnswerApiError && error.statusCode === 400);
  assert.equal(database.sql, '');
});
