import assert from 'node:assert/strict';
import test from 'node:test';
import { GlobalSearchApiError, GlobalSearchServiceImpl, type GlobalSearchSqlExecutor } from './global-search-service.js';

class FakeSearchDatabase implements GlobalSearchSqlExecutor {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = [];

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.calls.push({ sql, values });
    if (sql.includes('FROM materials AS m')) return [[{ material_id: 'material-1', material_name: '函数资料', course_id: 'course-1', course_name: '数学', subject_id: 'subject-1', subject_name: '高数', card_count: 2 }], {}];
    if (sql.includes('FROM cards AS c')) return [[{ card_id: 'card-1', card_title: '函数定义', content_json: [{ type: 'paragraph', children: [{ type: 'text', value: '函数是两个集合之间的对应关系。' }] }], material_id: 'material-1', course_id: 'course-1', course_name: '数学', subject_id: 'subject-1', subject_name: '高数' }], {}];
    if (sql.includes('FROM questions AS q')) return [[{ question_id: 'question-1', stem_json: [{ type: 'paragraph', children: [{ type: 'text', value: '下列哪个关系是函数？' }] }], question_bank_id: 'bank-1', question_bank_name: '函数练习', question_chapter_title: '第一章', course_id: 'course-1', course_name: '数学', subject_id: 'subject-1', subject_name: '高数' }], {}];
    return [[], {}];
  }
}

test('全局检索只返回受控摘要和可定位目标', async () => {
  const database = new FakeSearchDatabase();
  const service = new GlobalSearchServiceImpl(database);
  const response = await service.search({ query: '函数', courseId: 'course-1', subjectId: 'subject-1' });

  assert.equal(response.results.length, 3);
  assert.deepEqual(response.results.map((result) => result.type), ['material', 'card', 'question']);
  assert.equal(response.results[1]?.summary, '函数是两个集合之间的对应关系。');
  assert.equal(response.results[1]?.materialId, 'material-1');
  assert.equal(response.results[2]?.questionBankId, 'bank-1');
  assert.equal(response.results[2]?.questionId, 'question-1');
  assert.match(database.calls[1]?.sql ?? '', /MATCH\(c\.title, c\.search_text\)/);
  assert.deepEqual(database.calls[1]?.values, ['+函数*', 'course-1', 'subject-1', '+函数*']);
});

test('全局检索拒绝过短检索词和未知内容类型', async () => {
  const service = new GlobalSearchServiceImpl(new FakeSearchDatabase());
  await assert.rejects(() => service.search({ query: '函' }), (error: unknown) => error instanceof GlobalSearchApiError && error.statusCode === 400);
  await assert.rejects(() => service.search({ query: '函数', types: ['other'] as never }), (error: unknown) => error instanceof GlobalSearchApiError && error.message.includes('内容类型'));
});
