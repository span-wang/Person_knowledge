import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  authLoginPath,
  questionImportApplyPath,
  questionImportPreviewPath,
  questionImportTemplatePath,
  type QuestionImportPreviewResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import { QuestionImportService, type QuestionImportDatabase } from './question-import-service.js';

class HttpDatabase implements QuestionImportDatabase {
  async execute(sql: string) {
    if (sql.includes('FROM subjects AS subject')) return [[{ id: 'subject-1' }], []];
    if (sql.includes('FROM question_banks WHERE')) return [[], []];
    return [[], []];
  }
  async getConnection() {
    const self = this;
    return {
      execute: async (sql: string) => {
        if (sql.includes('FROM subjects AS subject')) return [[{ id: 'subject-1' }], []];
        if (sql.includes('FROM question_banks WHERE')) return [[], []];
        if (sql.includes('COALESCE(MAX(sort_order)')) return [[{ next_order: 0 }], []];
        return [[], []];
      },
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const questionImportService = new QuestionImportService({ database: new HttpDatabase() });
  const app = createApp(new Date(), {
    questionImportService,
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
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function payload() {
  return Buffer.from(JSON.stringify({
    format: 'knowledge-flashcards-question-bank',
    version: 1,
    title: 'HTTP 题库',
    questions: [{ stem: '题干', type: 'single', options: { A: '一', B: '二' }, answer: 'A' }],
  }));
}

test('题库导入 HTTP 端点受认证保护并支持模板、预览、取消和应用', async () => {
  await withServer(async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}${questionImportTemplatePath}/official/json`);
    assert.equal(unauthorized.status, 401);

    const login = await fetch(`${baseUrl}${authLoginPath}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const template = await fetch(`${baseUrl}${questionImportTemplatePath}/chapter/excel`, { headers: { cookie } });
    assert.equal(template.status, 200);
    assert.match(template.headers.get('content-type') ?? '', /spreadsheetml/);

    const previewResponse = await fetch(`${baseUrl}${questionImportPreviewPath}?courseId=course-1&subjectId=subject-1&kind=official`, {
      method: 'POST',
      headers: { cookie, 'x-import-file-name': encodeURIComponent('http.json'), 'content-type': 'application/json' },
      body: payload(),
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as QuestionImportPreviewResponse;
    assert.equal(preview.valid, true);
    assert.ok(preview.previewId);

    const cancel = await fetch(`${baseUrl}${questionImportPreviewPath}/${preview.previewId}`, { method: 'DELETE', headers: { cookie } });
    assert.equal(cancel.status, 204);
    const expired = await fetch(`${baseUrl}${questionImportApplyPath}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ previewId: preview.previewId }) });
    assert.equal(expired.status, 404);
  });
});

