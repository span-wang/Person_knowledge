import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, practiceQuestionBanksPath, practiceSessionsPath, type PracticeSessionResponse, type PracticeStatisticsResponse } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { PracticeAnswerRequest, PracticeSessionStartRequest } from '@knowledge-flashcards/shared';
import type { PracticeService } from './practice-service.js';
import type { PracticeStatisticsService } from './practice-statistics-service.js';

function response(): PracticeSessionResponse {
  return {
    session: { id: 'session-1', questionBankId: 'bank-1', questionChapterId: null, mode: 'test', source: 'full', status: 'in_progress', questionCount: 1, answeredCount: 0, currentIndex: 0, startedAt: '2026-08-19T00:00:00.000Z', completedAt: null, updatedAt: '2026-08-19T00:00:00.000Z' },
    questions: [{ id: 'question-1', questionChapterId: null, stem: [{ type: 'paragraph', children: [{ type: 'text', value: '题干' }] }], type: 'single', options: [{ key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '甲' }] }] }, { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '乙' }] }] }], analysis: null, attempt: { questionId: 'question-1', questionVersion: 1, answer: null, result: 'unanswered', answeredAt: null } }],
  };
}

class HttpPracticeService implements PracticeService {
  started: PracticeSessionStartRequest | null = null;
  async listInProgress() { return { sessions: [] }; }
  async start(request: PracticeSessionStartRequest) { this.started = request; return response(); }
  async get() { return response(); }
  async answer(_sessionId: string, _questionId: string, _request: PracticeAnswerRequest) { return response(); }
  async complete() { return { ...response(), session: { ...response().session, status: 'completed', completedAt: '2026-08-19T00:00:01.000Z' } }; }
  async abandon() { return { ...response(), session: { ...response().session, status: 'abandoned', completedAt: '2026-08-19T00:00:01.000Z' } }; }
}

class HttpPracticeStatisticsService implements PracticeStatisticsService {
  async get() { return { bank: { id: 'bank-1', subjectId: 'subject-1', kind: 'chapter', name: '题库', sortOrder: 0, questionCount: 1, chapterCount: 1 }, overall: { key: 'overall', label: '总览', questionCount: 1, answeredCount: 1, unansweredCount: 0, correctCount: 1, incorrectCount: 0, accuracy: 100, latestCompletedAt: '2026-08-19T00:00:00.000Z' }, chapters: [], types: [], modes: [], aggregateWrongCount: 0 } satisfies PracticeStatisticsResponse; }
}

async function withServer(run: (baseUrl: string, service: HttpPracticeService) => Promise<void>) {
  const service = new HttpPracticeService();
  const app = createApp(new Date(), { practiceService: service, practiceStatisticsService: new HttpPracticeStatisticsService(), authService: createAuthService({ enabled: true, username: 'tester', passwordHash: hashPassword('secret'), sessionTtlMs: 60_000, failureWindowMs: 60_000, failureLimit: 3, cookieSecure: false }) });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { const address = server.address() as AddressInfo; await run(`http://127.0.0.1:${address.port}`, service); } finally { server.close(); await once(server, 'close'); }
}

test('刷题会话 HTTP 端点受认证保护并转发启动请求', async () => {
  await withServer(async (baseUrl, service) => {
    const unauthorized = await fetch(`${baseUrl}${practiceSessionsPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questionBankId: 'bank-1', questionChapterId: null, mode: 'test' }) });
    assert.equal(unauthorized.status, 401);
    const login = await fetch(`${baseUrl}${authLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const start = await fetch(`${baseUrl}${practiceSessionsPath}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ questionBankId: 'bank-1', questionChapterId: 'chapter-1', mode: 'cram' }) });
    assert.equal(start.status, 201);
    assert.deepEqual(service.started, { questionBankId: 'bank-1', questionChapterId: 'chapter-1', mode: 'cram' });
    const body = await start.json() as PracticeSessionResponse;
    assert.equal(body.session.id, 'session-1');
    const statistics = await fetch(`${baseUrl}${practiceQuestionBanksPath}/bank-1/statistics`, { headers: { cookie } });
    assert.equal(statistics.status, 200);
    assert.equal((await statistics.json() as PracticeStatisticsResponse).overall.accuracy, 100);
  });
});
