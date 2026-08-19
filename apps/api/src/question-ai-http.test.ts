import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, questionAiExplanationsPath, type QuestionAiExplanationHistoryResponse, type QuestionAiExplanationResponse } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { QuestionAiService } from './question-ai-service.js';

class HttpQuestionAiService implements QuestionAiService {
  async list(questionId: string): Promise<QuestionAiExplanationHistoryResponse> { return { questionId, currentQuestionVersion: 1, explanations: [] }; }
  async generate(questionId: string): Promise<QuestionAiExplanationResponse> { return { explanation: { id: 'ai-1', questionId, questionVersion: 1, provider: 'openai', model: 'test', promptText: '', content: '讲解', generatedAt: '2026-08-19T00:00:00.000Z', stale: false } }; }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = createApp(new Date(), { questionAiService: new HttpQuestionAiService(), authService: createAuthService({ enabled: true, username: 'tester', passwordHash: hashPassword('secret'), sessionTtlMs: 60_000, failureWindowMs: 60_000, failureLimit: 3, cookieSecure: false }) });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { const address = server.address() as AddressInfo; await run(`http://127.0.0.1:${address.port}`); } finally { server.close(); await once(server, 'close'); }
}

test('题目 AI 历史和生成端点受认证保护', async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}${questionAiExplanationsPath}/question-1`);
    assert.equal(unauthorized.status, 401);
    const login = await fetch(`${baseUrl}${authLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const history = await fetch(`${baseUrl}${questionAiExplanationsPath}/question-1`, { headers: { cookie } });
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json() as QuestionAiExplanationHistoryResponse).explanations, []);
    const generated = await fetch(`${baseUrl}${questionAiExplanationsPath}/question-1`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '举例' }) });
    assert.equal(generated.status, 200);
    assert.equal((await generated.json() as QuestionAiExplanationResponse).explanation.content, '讲解');
  });
});
