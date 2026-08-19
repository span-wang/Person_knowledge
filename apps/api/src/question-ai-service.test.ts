import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QuestionAiApiError,
  QuestionAiServiceImpl,
  type QuestionAiSqlExecutor,
} from './question-ai-service.js';
import { encryptAiProviderApiKey } from './ai-provider-service.js';

const encryptionSecret = 'test-encryption-secret-must-have-at-least-thirty-two-characters';

class FakeQuestionAiDatabase implements QuestionAiSqlExecutor {
  readonly providerKey = 'sk-question-secret';
  readonly provider = { id: 'provider-1', provider: 'openai', baseUrl: 'https://api.example.test/v1', model: 'gpt-test', apiKeyCiphertext: encryptAiProviderApiKey(this.providerKey, encryptionSecret) };
  version = 2;
  rows: Array<Record<string, unknown>> = [];
  insertCount = 0;
  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT id, question_type')) {
      return [[{ id: 'question-1', question_type: 'single', version: this.version, stem_json: [{ type: 'paragraph', children: [{ type: 'text', value: '函数是什么？' }] }], options_json: [{ key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '映射' }] }] }, { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '集合' }] }] }], answer_json: ['A'], analysis_json: [{ type: 'paragraph', children: [{ type: 'text', value: '看定义。' }] }] }], []];
    }
    if (normalized.startsWith('SELECT id, provider, base_url')) return [[{ id: this.provider.id, provider: this.provider.provider, base_url: this.provider.baseUrl, model: this.provider.model, api_key_ciphertext: this.provider.apiKeyCiphertext }], []];
    if (normalized.startsWith('SELECT id, question_id, question_version')) return [this.rows, []];
    if (normalized.startsWith('INSERT INTO question_ai_explanations')) {
      this.insertCount += 1;
      this.rows.unshift({ id: values[0], question_id: values[1], question_version: values[2], provider: values[4], model: values[5], prompt_text: values[6], content_json: values[7], generated_at: new Date('2026-08-19T01:02:03.000Z') });
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`未处理的 SQL：${normalized}`);
  }
}

test('题目 AI 只发送当前题目和作答上下文，并追加版本', async () => {
  const database = new FakeQuestionAiDatabase();
  const requests: Array<{ body: Record<string, unknown>; authorization: string | null }> = [];
  const service = new QuestionAiServiceImpl({ database, encryptionSecret, fetchImplementation: async (_input, init) => {
    requests.push({ body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify({ choices: [{ message: { content: '先看定义，再看选项。' } }] }), { status: 200 });
  } });
  const result = await service.generate('question-1', { prompt: '说明常见误区。', attempt: { answer: ['B'], result: 'incorrect' } });
  assert.equal(result.explanation.questionVersion, 2);
  assert.equal(database.insertCount, 1);
  assert.equal(requests[0]?.authorization, `Bearer ${database.providerKey}`);
  const bodyText = JSON.stringify(requests[0]?.body);
  assert.match(bodyText, /函数是什么/);
  assert.match(bodyText, /说明常见误区/);
  assert.match(bodyText, /本次作答：B/);
  assert.doesNotMatch(bodyText, /sk-question-secret/);
  assert.equal((await service.generate('question-1')).explanation.content, '先看定义，再看选项。');
  assert.equal(database.insertCount, 2);
});

test('历史题目版本标记为过时且不会删除', async () => {
  const database = new FakeQuestionAiDatabase();
  database.rows.push({ id: 'old-1', question_id: 'question-1', question_version: 1, provider: 'openai', model: 'old', prompt_text: '', content_json: JSON.stringify({ text: '旧讲解' }), generated_at: new Date('2026-08-18T01:02:03.000Z') });
  const service = new QuestionAiServiceImpl({ database, encryptionSecret });
  const history = await service.list('question-1');
  assert.equal(history.explanations.length, 1);
  assert.equal(history.explanations[0]?.stale, true);
  assert.equal(database.rows.length, 1);
});

test('取消请求不会写入题目 AI 版本', async () => {
  const database = new FakeQuestionAiDatabase();
  const controller = new AbortController();
  let started: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => { started = resolve; });
  const service = new QuestionAiServiceImpl({ database, encryptionSecret, fetchImplementation: async (_input, init) => new Promise<Response>((_resolve, reject) => {
    started?.();
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('已取消'), { name: 'AbortError' })), { once: true });
  }) });
  const pending = service.generate('question-1', {}, { signal: controller.signal });
  await wait;
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof QuestionAiApiError && error.statusCode === 499);
  assert.equal(database.insertCount, 0);
});
