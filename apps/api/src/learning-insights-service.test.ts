import assert from 'node:assert/strict';
import test from 'node:test';
import { createLearningInsightsService, type LearningInsightsSqlExecutor } from './learning-insights-service.js';

class FakeInsightsDatabase implements LearningInsightsSqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];
  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql, values });
    if (sql.includes('FROM review_records')) return [[
      { last_viewed_at: '2026-08-14T16:30:00.000Z', view_count: 2 },
      { last_viewed_at: '2026-08-19T16:30:00.000Z', view_count: 1 },
    ], {}];
    if (sql.includes('FROM review_status_history')) return [[
      { changed_at: '2026-08-19T16:30:00.000Z', to_status: 'mastered' },
      { changed_at: '2026-08-20T00:30:00.000Z', to_status: 'familiar' },
    ], {}];
    return [[
      { answered_at: '2026-08-19T16:30:00.000Z', result: 'correct', knowledge_points_json: JSON.stringify(['函数']) },
      { answered_at: '2026-08-19T17:30:00.000Z', result: 'incorrect', knowledge_points_json: JSON.stringify(['函数']) },
      { answered_at: '2026-08-19T18:30:00.000Z', result: 'incorrect', knowledge_points_json: JSON.stringify(['函数']) },
      { answered_at: '2026-08-19T19:30:00.000Z', result: 'incorrect', knowledge_points_json: JSON.stringify(['极限']) },
      { answered_at: '2026-08-19T20:30:00.000Z', result: 'skipped', knowledge_points_json: JSON.stringify(['函数']) },
    ], {}];
  }
}

test('学习洞察按上海自然日聚合并过滤薄弱知识点样本量', async () => {
  const database = new FakeInsightsDatabase();
  const response = await createLearningInsightsService({ database, now: new Date('2026-08-20T02:00:00.000Z') }).get({ periodDays: 7, courseId: 'course-1', subjectId: null });

  assert.equal(response.periodDays, 7);
  assert.equal(response.timezone, 'Asia/Shanghai');
  assert.equal(response.flashcards.reviewedCount, 2);
  assert.equal(response.flashcards.daily.find((day) => day.date === '2026-08-15')?.count, 1);
  assert.equal(response.masteryChanges.total, 2);
  assert.equal(response.masteryChanges.byStatus.mastered, 1);
  assert.equal(response.practice.answeredCount, 4);
  assert.equal(response.practice.correctCount, 1);
  assert.equal(response.practice.accuracy, 25);
  assert.deepEqual(response.weakKnowledgePoints, [{ knowledgePoint: '函数', answeredCount: 3, incorrectCount: 2, accuracy: 33 }]);
  assert.deepEqual(database.calls[0]?.values, [new Date('2026-08-13T16:00:00.000Z'), new Date('2026-08-20T16:00:00.000Z'), 'course-1']);
});

test('学习洞察拒绝非法周期', async () => {
  const service = createLearningInsightsService({ database: new FakeInsightsDatabase() });
  await assert.rejects(() => service.get({ periodDays: 14 as never }), /统计周期无效/);
});
