import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import {
  reviewCardExplanationPath,
  type ReviewAiExplanation,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import type { AiExplanationService } from '../src/ai-explanation-service.js';
import type { AiProviderService } from '../src/ai-provider-service.js';

test('卡片 AI 讲解 HTTP 接口只返回当前讲解', async () => {
  const calls: Array<{ cardId: string; prompt: string | undefined; canCancel: boolean }> = [];
  const explanation: ReviewAiExplanation = {
    provider: 'openai',
    model: 'gpt-test',
    promptText: '系统提示词与卡片正文',
    content: '安全的讲解结果',
    generatedAt: '2026-08-11T01:02:03.000Z',
  };
  const aiExplanationService: AiExplanationService = {
    generate: async (cardId, request, options) => {
      calls.push({ cardId, prompt: request?.prompt, canCancel: options?.signal instanceof AbortSignal });
      return { explanation };
    },
  };
  const server = createServer(createApp(new Date(), { aiExplanationService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}${reviewCardExplanationPath}/card-1/explanation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '补一个例子。' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { explanation });
    assert.deepEqual(calls, [{ cardId: 'card-1', prompt: '补一个例子。', canCancel: true }]);
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('断开卡片 AI 讲解 HTTP 请求会中止服务请求', async () => {
  let resolveStarted: (() => void) | undefined;
  let resolveCancelled: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    resolveCancelled = resolve;
  });
  const aiExplanationService: AiExplanationService = {
    generate: async (_cardId, _request, options) => {
      const signal = options?.signal;
      if (!signal) {
        throw new Error('缺少取消信号。');
      }
      resolveStarted?.();
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          resolveCancelled?.();
          reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
        }, { once: true });
      });
      throw new Error('不应继续生成。');
    },
  };
  const server = createServer(createApp(new Date(), { aiExplanationService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${address.port}${reviewCardExplanationPath}/card-1/explanation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
      signal: controller.signal,
    });
    await started;
    controller.abort();
    await assert.rejects(response, (error: unknown) => error instanceof Error && error.name === 'AbortError');
    await cancelled;
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('Provider 连接测试 HTTP 接口只返回短状态', async () => {
  const aiProviderService: AiProviderService = {
    list: async () => ({ profiles: [] }),
    create: async () => ({ profiles: [] }),
    update: async () => ({ profiles: [] }),
    activate: async () => ({ profiles: [] }),
    remove: async () => ({ profiles: [] }),
    testConnection: async (profileId) => {
      assert.equal(profileId, 'provider-1');
      return { message: '连接成功' };
    },
  };
  const server = createServer(createApp(new Date(), { aiProviderService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/api/settings/ai-providers/provider-1/test`, { method: 'POST' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { message: '连接成功' });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
