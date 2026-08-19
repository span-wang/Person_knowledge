import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiExplanationApiError,
  AiExplanationServiceImpl,
  type AiExplanationSqlExecutor,
} from './ai-explanation-service.js';
import { encryptAiProviderApiKey } from './ai-provider-service.js';

const encryptionSecret = 'test-encryption-secret-must-have-at-least-thirty-two-characters';

class FakeAiExplanationDatabase implements AiExplanationSqlExecutor {
  readonly providerKey = 'sk-test-secret';
  readonly provider = {
    id: 'provider-1',
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    apiKeyCiphertext: encryptAiProviderApiKey(this.providerKey, encryptionSecret),
  };
  explanation: Record<string, unknown> | null = null;

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT c.title, c.content_json')) {
      return [[{ title: '函数闪卡', content_json: [{ type: 'paragraph', children: [{ type: 'text', value: '函数是映射。' }] }] }], []];
    }
    if (normalized.startsWith('SELECT id, provider, base_url, model')) {
      return [[{
        id: this.provider.id,
        provider: this.provider.provider,
        base_url: this.provider.baseUrl,
        model: this.provider.model,
        api_key_ciphertext: this.provider.apiKeyCiphertext,
      }], []];
    }
    if (normalized.startsWith('INSERT INTO ai_explanations')) {
      this.explanation = {
        provider: values[2],
        model: values[3],
        prompt_text: values[4],
        content_json: values[5],
        generated_at: new Date('2026-08-11T01:02:03.000Z'),
      };
      return [{ affectedRows: 1 }, []];
    }
    if (normalized.startsWith('SELECT provider, model, prompt_text')) {
      return [this.explanation ? [this.explanation] : [], []];
    }
    throw new Error(`未处理的 SQL：${normalized}`);
  }
}

test('默认和临时提示词会调用当前 Provider，并覆盖保存当前讲解', async () => {
  const database = new FakeAiExplanationDatabase();
  const requests: Array<{ url: string; body: Record<string, unknown>; authorization: string | null }> = [];
  let answer = '第一版讲解';
  const service = new AiExplanationServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (input, init) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });

  const first = await service.generate('card-1', { prompt: '给出一个反例。' });
  assert.equal(first.explanation.content, '第一版讲解');
  assert.equal(requests[0]?.url, 'https://api.example.test/v1/chat/completions');
  assert.equal(requests[0]?.authorization, `Bearer ${database.providerKey}`);
  assert.match(String((requests[0]?.body.messages as Array<{ content: string }>)[1]?.content), /给出一个反例/);
  assert.doesNotMatch(JSON.stringify(requests[0]?.body), /sk-test-secret/);

  answer = '覆盖后的讲解';
  const second = await service.generate('card-1');
  assert.equal(second.explanation.content, '覆盖后的讲解');
  assert.equal(database.explanation?.content_json, JSON.stringify({ text: '覆盖后的讲解' }));
});

test('Provider 返回错误时不会写入讲解', async () => {
  const database = new FakeAiExplanationDatabase();
  const service = new AiExplanationServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async () => new Response('{"error":"upstream"}', { status: 429 }),
  });

  await assert.rejects(
    service.generate('card-1'),
    (error: unknown) => error instanceof AiExplanationApiError && error.statusCode === 502,
  );
  assert.equal(database.explanation, null);
});

test('取消生成会中止 Provider 请求且不写入半成品', async () => {
  const database = new FakeAiExplanationDatabase();
  const requestController = new AbortController();
  let providerStarted: (() => void) | undefined;
  let providerAborted = false;
  const started = new Promise<void>((resolve) => {
    providerStarted = resolve;
  });
  const service = new AiExplanationServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (_input, init) => new Promise<Response>((_resolve, reject) => {
      providerStarted?.();
      init?.signal?.addEventListener('abort', () => {
        providerAborted = true;
        reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
      }, { once: true });
    }),
  });

  const pending = service.generate('card-1', {}, { signal: requestController.signal });
  await started;
  requestController.abort();

  await assert.rejects(
    pending,
    (error: unknown) => error instanceof AiExplanationApiError && error.statusCode === 499,
  );
  assert.equal(providerAborted, true);
  assert.equal(database.explanation, null);
});
