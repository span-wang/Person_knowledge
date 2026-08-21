import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, studyAssistantPath, type StudyAssistantAskRequest } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { StudyAssistantService } from './study-assistant-service.js';

class HttpStudyAssistantService implements StudyAssistantService {
  flashcardRequest: { cardId: string; request: StudyAssistantAskRequest } | null = null;
  practiceRequest: { sessionId: string; questionId: string; request: StudyAssistantAskRequest } | null = null;
  private releaseFlashcardSecondChunk: (() => void) | null = null;

  async *streamFlashcard(cardId: string, request: StudyAssistantAskRequest): AsyncGenerator<string> {
    this.flashcardRequest = { cardId, request };
    yield '第一';
    await new Promise<void>((resolve) => { this.releaseFlashcardSecondChunk = resolve; });
    yield '段';
  }

  async *streamPractice(sessionId: string, questionId: string, request: StudyAssistantAskRequest): AsyncGenerator<string> {
    this.practiceRequest = { sessionId, questionId, request };
    yield '第二段';
  }

  releaseSecondFlashcardChunk() {
    this.releaseFlashcardSecondChunk?.();
    this.releaseFlashcardSecondChunk = null;
  }
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, matcher: RegExp): Promise<string> {
  const decoder = new TextDecoder();
  let content = '';
  while (!matcher.test(content)) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('未在预期时间内收到 SSE 分段。')), 500)),
    ]);
    if (next.done) break;
    content += decoder.decode(next.value, { stream: true });
  }
  return content;
}

async function withServer(run: (baseUrl: string, service: HttpStudyAssistantService) => Promise<void>) {
  const service = new HttpStudyAssistantService();
  const app = createApp(new Date(), {
    studyAssistantService: service,
    authService: createAuthService({
      enabled: true,
      username: 'tester',
      passwordHash: hashPassword('secret'),
      sessionTtlMs: 60_000,
      failureWindowMs: 60_000,
      failureLimit: 3,
      cookieSecure: false,
    }),
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`, service);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('悬浮问答接口在认证后以 SSE 转发闪卡和刷题分段', async () => {
  await withServer(async (baseUrl, service) => {
    const unauthorized = await fetch(`${baseUrl}${studyAssistantPath}/cards/card-1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '函数是什么？' }),
    });
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${baseUrl}${authLoginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'tester', password: 'secret' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    const flashcard = await fetch(`${baseUrl}${studyAssistantPath}/cards/card-1`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '函数是什么？' }),
    });
    assert.equal(flashcard.status, 200);
    assert.match(flashcard.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(flashcard.headers.get('x-accel-buffering'), 'no');
    const reader = flashcard.body!.getReader();
    const first = await readUntil(reader, /"content":"第一"/);
    assert.doesNotMatch(first, /"content":"段"/);
    service.releaseSecondFlashcardChunk();
    const rest = await readUntil(reader, /"type":"done"/);
    assert.match(rest, /"content":"段"/);
    assert.match(rest, /"type":"done"/);
    assert.deepEqual(service.flashcardRequest, { cardId: 'card-1', request: { prompt: '函数是什么？' } });

    const practice = await fetch(`${baseUrl}${studyAssistantPath}/practice-sessions/session-1/questions/question-1`, {
      method: 'POST',
      headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '解释概念' }),
    });
    assert.equal(practice.status, 200);
    assert.equal(await practice.text(), ': stream-ready\n\ndata: {"type":"delta","content":"第二段"}\n\ndata: {"type":"done"}\n\n');
    assert.deepEqual(service.practiceRequest, { sessionId: 'session-1', questionId: 'question-1', request: { prompt: '解释概念' } });
  });
});
