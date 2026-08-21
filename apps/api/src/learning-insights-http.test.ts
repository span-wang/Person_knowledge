import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, learningInsightsPath, type LearningInsightsResponse } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { LearningInsightsService } from './learning-insights-service.js';

const response: LearningInsightsResponse = {
  periodDays: 30, timezone: 'Asia/Shanghai', from: '2026-07-22T16:00:00.000Z', to: '2026-08-21T16:00:00.000Z',
  flashcards: { reviewedCount: 0, daily: [] },
  masteryChanges: { total: 0, daily: [], byStatus: { unassessed: 0, mastered: 0, familiar: 0, effort: 0 } },
  practice: { answeredCount: 0, correctCount: 0, incorrectCount: 0, accuracy: null, daily: [] }, weakKnowledgePoints: [],
};

test('学习洞察 API 受认证保护并传递查询条件', async () => {
  let received: Parameters<LearningInsightsService['get']>[0] | undefined;
  const service: LearningInsightsService = { get: async (request) => { received = request; return response; } };
  const app = createApp(new Date(), {
    learningInsightsService: service,
    authService: createAuthService({ enabled: true, username: 'tester', passwordHash: hashPassword('secret'), sessionTtlMs: 60_000, failureWindowMs: 60_000, failureLimit: 3, cookieSecure: false }),
  });
  const server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo; const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}${learningInsightsPath}`)).status, 401);
    const login = await fetch(`${baseUrl}${authLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const result = await fetch(`${baseUrl}${learningInsightsPath}?periodDays=30&courseId=course-1&subjectId=all`, { headers: { cookie } });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), response);
    assert.deepEqual(received, { periodDays: 30, courseId: 'course-1', subjectId: null });
    const bad = await fetch(`${baseUrl}${learningInsightsPath}?periodDays=14`, { headers: { cookie } });
    assert.equal(bad.status, 400);
  } finally { server.close(); await once(server, 'close'); }
});
