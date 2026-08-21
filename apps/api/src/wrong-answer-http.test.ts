import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, wrongAnswerReviewPath, type PracticeSessionResponse, type WrongAnswerFilterResponse } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { WrongAnswerService } from './wrong-answer-service.js';
import type { PracticeService } from './practice-service.js';

const session: PracticeSessionResponse = {
  session: { id: 'session-1', questionBankId: null, subjectId: 'subject-1', questionChapterId: null, mode: 'test', source: 'aggregate_wrong', status: 'in_progress', questionCount: 1, answeredCount: 0, currentIndex: 0, startedAt: '2026-08-20T00:00:00.000Z', completedAt: null, updatedAt: '2026-08-20T00:00:00.000Z' },
  questions: [],
};
const wrongAnswerService: WrongAnswerService = { list: async (request) => ({ subjectId: request.subjectId, items: [] }) };
const practiceService = { startWrong: async (request: { subjectId: string; mode: 'cram' | 'test' }) => ({ ...session, session: { ...session.session, subjectId: request.subjectId, mode: request.mode } }) } as unknown as PracticeService;

test('错题筛选和复练端点受认证保护并转发请求', async () => {
  const app = createApp(new Date(), { wrongAnswerService, practiceService, authService: createAuthService({ enabled: true, username: 'tester', passwordHash: hashPassword('secret'), sessionTtlMs: 60_000, failureWindowMs: 60_000, failureLimit: 3, cookieSecure: false }) });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${baseUrl}${wrongAnswerReviewPath}?subjectId=subject-1`)).status, 401);
    const login = await fetch(`${baseUrl}${authLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const listed = await fetch(`${baseUrl}${wrongAnswerReviewPath}?subjectId=subject-1&knowledgePoint=%E5%87%BD%E6%95%B0&type=single`, { headers: { cookie } });
    assert.equal(listed.status, 200);
    assert.equal((await listed.json() as WrongAnswerFilterResponse).subjectId, 'subject-1');
    const started = await fetch(`${baseUrl}${wrongAnswerReviewPath}/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ subjectId: 'subject-1', mode: 'cram', knowledgePoint: '函数' }) });
    assert.equal(started.status, 201);
    assert.equal((await started.json() as PracticeSessionResponse).session.mode, 'cram');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
