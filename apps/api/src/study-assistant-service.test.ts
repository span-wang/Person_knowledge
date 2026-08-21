import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptAiProviderApiKey } from './ai-provider-service.js';
import { StudyAssistantServiceImpl, type StudyAssistantSqlExecutor } from './study-assistant-service.js';

const encryptionSecret = 'test-encryption-secret-must-have-at-least-thirty-two-characters';

class FakeStudyAssistantDatabase implements StudyAssistantSqlExecutor {
  readonly providerKey = 'sk-study-assistant-secret';
  readonly provider = {
    id: 'provider-1',
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    apiKeyCiphertext: encryptAiProviderApiKey(this.providerKey, encryptionSecret),
  };
  readonly fallbackProvider = {
    id: 'provider-2',
    provider: 'deepseek',
    baseUrl: 'https://fallback.example.test/v1',
    model: 'deepseek-test',
    apiKeyCiphertext: encryptAiProviderApiKey('sk-study-assistant-fallback-secret', encryptionSecret),
  };
  providerRows: Array<Record<string, unknown>>;
  practiceStatus = 'in_progress';
  practiceMode = 'test';

  constructor() {
    this.providerRows = [{
      id: this.provider.id,
      provider: this.provider.provider,
      base_url: this.provider.baseUrl,
      model: this.provider.model,
      api_key_ciphertext: this.provider.apiKeyCiphertext,
    }];
  }

  async execute(sql: string): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT c.title, c.content_json')) {
      return [[{ title: '函数定义', content_json: [{ type: 'paragraph', children: [{ type: 'text', value: '函数是一种映射。' }] }] }], []];
    }
    if (normalized.startsWith('SELECT s.mode, s.status, a.snapshot_json')) {
      return [[{
        mode: this.practiceMode,
        status: this.practiceStatus,
        snapshot_json: {
          type: 'single',
          stem: [{ type: 'paragraph', children: [{ type: 'text', value: '下列哪项是函数？' }] }],
          options: [
            { key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '映射' }] }] },
            { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '集合' }] }] },
          ],
          answer: ['A'],
          analysis: [{ type: 'paragraph', children: [{ type: 'text', value: '按定义判断。' }] }],
        },
      }], []];
    }
    if (normalized.startsWith('SELECT id, provider, base_url')) {
      return [this.providerRows, []];
    }
    throw new Error(`未处理的 SQL：${normalized}`);
  }
}

function streamedResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk)));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

function delayedStreamedResponse(chunks: Array<{ content: string; delayMs: number }>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      let delay = 0;
      chunks.forEach((chunk, index) => {
        delay += chunk.delayMs;
        setTimeout(() => {
          controller.enqueue(encoder.encode(chunk.content));
          if (index === chunks.length - 1) controller.close();
        }, delay);
      });
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } });
}

async function collected(stream: AsyncIterable<string>): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks.join('');
}

function serviceWithRequests(database: FakeStudyAssistantDatabase) {
  const requests: Array<Record<string, unknown>> = [];
  const service = new StudyAssistantServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return streamedResponse([
        'data: {"choices":[{"delta":{"content":"这是',
        '回答。"}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    },
  });
  return { service, requests };
}

test('闪卡悬浮助手只发送当前闪卡和本轮问题，并拼接流式分段', async () => {
  const database = new FakeStudyAssistantDatabase();
  const { service, requests } = serviceWithRequests(database);
  const result = await collected(service.streamFlashcard('card-1', { prompt: '函数与关系有什么区别？' }));
  assert.equal(result, '这是回答。');
  const body = JSON.stringify(requests[0]);
  assert.match(body, /"stream":true/);
  assert.match(body, /函数定义/);
  assert.match(body, /函数与关系有什么区别/);
  assert.doesNotMatch(body, /sk-study-assistant-secret/);
});

test('未完成检测题的悬浮助手不发送答案或解析', async () => {
  const database = new FakeStudyAssistantDatabase();
  const { service, requests } = serviceWithRequests(database);
  await collected(service.streamPractice('session-1', 'question-1', { prompt: '什么是映射？' }));
  const body = JSON.stringify(requests[0]);
  assert.match(body, /当前题目仍处于检测中/);
  assert.match(body, /不得给出、推荐、排除或暗示任何选项/);
  assert.match(body, /下列哪项是函数/);
  assert.doesNotMatch(body, /标准答案：A/);
  assert.doesNotMatch(body, /按定义判断/);
});

test('Provider 未返回 SSE 时拒绝非流式回退', async () => {
  const service = new StudyAssistantServiceImpl({
    database: new FakeStudyAssistantDatabase(),
    encryptionSecret,
    fetchImplementation: async () => new Response(JSON.stringify({ choices: [{ message: { content: '完整回答' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  });
  await assert.rejects(
    () => collected(service.streamFlashcard('card-1', { prompt: '函数是什么？' })),
    (error: unknown) => error instanceof Error && error.message.includes('未返回流式响应'),
  );
});

test('首字输出后按流空闲时间计时，不使用总时长截断', async () => {
  const service = new StudyAssistantServiceImpl({
    database: new FakeStudyAssistantDatabase(),
    encryptionSecret,
    firstTokenTimeoutMs: 20,
    streamIdleTimeoutMs: 150,
    fetchImplementation: async () => delayedStreamedResponse([
      { content: 'data: {"choices":[{"delta":{"content":"先"}}]}\n\n', delayMs: 0 },
      { content: 'data: {"choices":[{"delta":{"content":"后"}}]}\n\ndata: [DONE]\n\n', delayMs: 50 },
    ]),
  });
  assert.equal(await collected(service.streamFlashcard('card-1', { prompt: '函数是什么？' })), '先后');
});

test('首字等待超时会结束流并返回明确错误', async () => {
  const service = new StudyAssistantServiceImpl({
    database: new FakeStudyAssistantDatabase(),
    encryptionSecret,
    firstTokenTimeoutMs: 20,
    streamIdleTimeoutMs: 100,
    fetchImplementation: async () => new Response(new ReadableStream<Uint8Array>({ start() {} }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
  });
  await assert.rejects(
    () => collected(service.streamFlashcard('card-1', { prompt: '函数是什么？' })),
    (error: unknown) => error instanceof Error && error.message === '等待 AI 开始输出超时。',
  );
});

test('首选 Provider 在首字前失败时自动降级到下一渠道', async () => {
  const database = new FakeStudyAssistantDatabase();
  database.providerRows.push({
    id: database.fallbackProvider.id,
    provider: database.fallbackProvider.provider,
    base_url: database.fallbackProvider.baseUrl,
    model: database.fallbackProvider.model,
    api_key_ciphertext: database.fallbackProvider.apiKeyCiphertext,
  });
  const calls: string[] = [];
  const service = new StudyAssistantServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (input) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response('{"error":"upstream"}', { status: 503 });
      return streamedResponse(['data: {"choices":[{"delta":{"content":"备用回答"}}]}\n\n', 'data: [DONE]\n\n']);
    },
  });
  assert.equal(await collected(service.streamFlashcard('card-1', { prompt: '函数是什么？' })), '备用回答');
  assert.deepEqual(calls, [
    'https://api.example.test/v1/chat/completions',
    'https://fallback.example.test/v1/chat/completions',
  ]);
});

test('流式回答已输出内容后发生中断时不会切换 Provider', async () => {
  const database = new FakeStudyAssistantDatabase();
  database.providerRows.push({
    id: database.fallbackProvider.id,
    provider: database.fallbackProvider.provider,
    base_url: database.fallbackProvider.baseUrl,
    model: database.fallbackProvider.model,
    api_key_ciphertext: database.fallbackProvider.apiKeyCiphertext,
  });
  const calls: string[] = [];
  const service = new StudyAssistantServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (input) => {
      calls.push(String(input));
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"首段"}}]}\n\n'));
          setTimeout(() => controller.error(new Error('连接中断')), 0);
        },
      }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    },
  });
  await assert.rejects(
    () => collected(service.streamFlashcard('card-1', { prompt: '函数是什么？' })),
    (error: unknown) => error instanceof Error && error.message === 'AI 输出中断。',
  );
  assert.deepEqual(calls, ['https://api.example.test/v1/chat/completions']);
});
