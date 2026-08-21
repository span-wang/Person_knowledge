import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { authLoginPath, globalSearchPath, type GlobalSearchResponse } from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';
import type { GlobalSearchService } from './global-search-service.js';

const response: GlobalSearchResponse = {
  query: '函数', resultLimitPerType: 20,
  results: [{ type: 'card', id: 'card-1', title: '函数定义', summary: '函数是对应关系。', course: { id: 'course-1', name: '数学' }, subject: { id: 'subject-1', name: '高数' }, materialId: 'material-1', cardId: 'card-1', questionBankId: null, questionId: null }],
};

const searchService: GlobalSearchService = { search: async (filters) => ({ ...response, query: filters.query }) };

test('全局检索 API 受认证保护并传递筛选条件', async () => {
  const app = createApp(new Date(), {
    globalSearchService: searchService,
    authService: createAuthService({ enabled: true, username: 'tester', passwordHash: hashPassword('secret'), sessionTtlMs: 60_000, failureWindowMs: 60_000, failureLimit: 3, cookieSecure: false }),
  });
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${baseUrl}${globalSearchPath}?q=%E5%87%BD%E6%95%B0`)).status, 401);
    const login = await fetch(`${baseUrl}${authLoginPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'tester', password: 'secret' }) });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const result = await fetch(`${baseUrl}${globalSearchPath}?q=%E5%87%BD%E6%95%B0&courseId=course-1&types=card`, { headers: { cookie } });
    assert.equal(result.status, 200);
    const body = await result.json() as GlobalSearchResponse;
    assert.equal(body.results[0]?.cardId, 'card-1');
  } finally {
    server.close();
    await once(server, 'close');
  }
});
