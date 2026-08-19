import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import {
  authLoginPath,
  authLogoutPath,
  authSessionPath,
  healthCheckPath,
  reviewDashboardPath,
  type AuthSessionResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { createAuthService, hashPassword } from './auth.js';

async function withServer<T>(run: (baseUrl: string) => Promise<T>) {
  const authService = createAuthService({
    enabled: true,
    username: 'panshimao',
    passwordHash: hashPassword('2787156534'),
    sessionTtlMs: 60_000,
    failureWindowMs: 60_000,
    failureLimit: 2,
    cookieSecure: false,
  });
  const server = createServer(createApp(new Date(), { authService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('认证门禁保留健康检查并拦截未登录业务请求', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}${healthCheckPath}`);
    assert.equal(health.status, 200);

    const session = await fetch(`${baseUrl}${authSessionPath}`);
    assert.deepEqual(await session.json(), {
      authenticated: false,
      username: null,
      expiresAt: null,
    } satisfies AuthSessionResponse);

    const dashboard = await fetch(`${baseUrl}${reviewDashboardPath}`);
    assert.equal(dashboard.status, 401);
  });
});

test('登录后会话 Cookie 可复用并支持退出', async () => {
  await withServer(async (baseUrl) => {
    const login = await fetch(`${baseUrl}${authLoginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'panshimao', password: '2787156534' }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie');
    assert.match(cookie ?? '', /kf_session=.*HttpOnly/);
    assert.match(cookie ?? '', /SameSite=Lax/);

    const session = await fetch(`${baseUrl}${authSessionPath}`, { headers: { cookie: cookie!.split(';')[0]! } });
    const body = (await session.json()) as AuthSessionResponse;
    assert.equal(body.authenticated, true);
    assert.equal(body.username, 'panshimao');

    const logout = await fetch(`${baseUrl}${authLogoutPath}`, {
      method: 'POST',
      headers: { cookie: cookie!.split(';')[0]! },
    });
    assert.equal(logout.status, 204);
    const afterLogout = await fetch(`${baseUrl}${authSessionPath}`, { headers: { cookie: cookie!.split(';')[0]! } });
    assert.equal((await afterLogout.json() as AuthSessionResponse).authenticated, false);
  });
});

test('连续失败登录触发限速', async () => {
  await withServer(async (baseUrl) => {
    const request = () => fetch(`${baseUrl}${authLoginPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'panshimao', password: 'wrong' }),
    });
    assert.equal((await request()).status, 401);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
  });
});
