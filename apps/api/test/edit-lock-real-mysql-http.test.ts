import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import {
  reviewCardPath,
  type ErrorResponse,
  type ReviewCardContentUpdateResponse,
  type ReviewCardResponse,
  type ReviewEditLockResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createReviewDatabase, createReviewService } from '../src/review-service.js';

interface LockFixture {
  materialId: string;
  chapterId: string;
  sectionId: string;
  cardId: string;
}

async function startServer(pool: Pool) {
  const server = createServer(createApp(new Date(), {
    reviewService: createReviewService({ database: createReviewDatabase(pool) }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: 'http://127.0.0.1:' + address.port };
}

async function stopServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

async function createFixture(pool: Pool): Promise<LockFixture> {
  const runId = randomUUID();
  const fixture: LockFixture = {
    materialId: randomUUID(),
    chapterId: randomUUID(),
    sectionId: randomUUID(),
    cardId: randomUUID(),
  };
  await pool.execute(
    'INSERT INTO materials (id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?)',
    [fixture.materialId, '编辑锁验收 ' + runId, 'lock-' + runId + '.md', createHash('sha256').update(runId).digest('hex')],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.chapterId, fixture.materialId, '第一章'],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.sectionId, fixture.chapterId, '第一节'],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0)',
    [fixture.cardId, fixture.sectionId, '锁定闪卡', JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: '编辑锁正文' }] }])],
  );
  return fixture;
}

async function cleanupFixture(pool: Pool, fixture: LockFixture) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM sync_locks WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM highlights WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM review_records WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM cards WHERE id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM sections WHERE id = ?', [fixture.sectionId]);
    await connection.execute('DELETE FROM chapters WHERE id = ?', [fixture.chapterId]);
    await connection.execute('DELETE FROM materials WHERE id = ?', [fixture.materialId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

function lockHeaders(deviceId: string, lockToken?: string): HeadersInit {
  return {
    'X-Device-Id': deviceId,
    ...(lockToken ? { 'X-Editor-Lock-Token': lockToken } : {}),
  };
}

test('PH3-05 编辑锁通过真实 MySQL + HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  let fixture: LockFixture | null = null;
  let server: Server | null = null;

  try {
    fixture = await createFixture(pool);
    const started = await startServer(pool);
    server = started.server;
    const cardUrl = started.baseUrl + reviewCardPath + '/' + encodeURIComponent(fixture.cardId);
    const lockUrl = cardUrl + '/edit-lock';

    const firstLock = await requestJson<ReviewEditLockResponse>(lockUrl, {
      method: 'POST', headers: lockHeaders('desktop-device'),
    });
    assert.equal(firstLock.response.status, 201);
    assert.ok(firstLock.body.lock.lockToken);

    const repeatedLock = await requestJson<ReviewEditLockResponse>(lockUrl, {
      method: 'POST', headers: lockHeaders('desktop-device'),
    });
    assert.equal(repeatedLock.response.status, 201);
    assert.equal(repeatedLock.body.lock.lockToken, firstLock.body.lock.lockToken);

    const deniedLock = await requestJson<ErrorResponse>(lockUrl, {
      method: 'POST', headers: lockHeaders('phone-device'),
    });
    assert.equal(deniedLock.response.status, 409);
    assert.equal(deniedLock.body.error, '该闪卡正在由其他设备编辑。');

    const deniedSave = await requestJson<ErrorResponse>(cardUrl + '/content', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...lockHeaders('phone-device', 'unowned-lock') },
      body: JSON.stringify({
        title: '不应保存',
        content: [{ type: 'paragraph', children: [{ type: 'text', value: '不应保存' }] }],
      }),
    });
    assert.equal(deniedSave.response.status, 409);

    const renewedLock = await requestJson<ReviewEditLockResponse>(lockUrl, {
      method: 'PUT', headers: lockHeaders('desktop-device', firstLock.body.lock.lockToken),
    });
    assert.equal(renewedLock.response.status, 200);
    assert.equal(renewedLock.body.lock.lockToken, firstLock.body.lock.lockToken);
    assert.ok(Date.parse(renewedLock.body.lock.expiresAt) >= Date.parse(firstLock.body.lock.expiresAt));

    const releasedLock = await fetch(lockUrl, {
      method: 'DELETE', headers: lockHeaders('desktop-device', firstLock.body.lock.lockToken),
    });
    assert.equal(releasedLock.status, 204);

    const phoneLock = await requestJson<ReviewEditLockResponse>(lockUrl, {
      method: 'POST', headers: lockHeaders('phone-device'),
    });
    assert.equal(phoneLock.response.status, 201);

    const saved = await requestJson<ReviewCardContentUpdateResponse>(cardUrl + '/content', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...lockHeaders('phone-device', phoneLock.body.lock.lockToken) },
      body: JSON.stringify({
        title: '手机已保存',
        content: [{ type: 'paragraph', children: [{ type: 'text', value: '手机编辑后的正文' }] }],
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.card.title, '手机已保存');

    await pool.execute(
      'UPDATE sync_locks SET expires_at = DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 SECOND) WHERE card_id = ?',
      [fixture.cardId],
    );
    const takeoverLock = await requestJson<ReviewEditLockResponse>(lockUrl, {
      method: 'POST', headers: lockHeaders('desktop-device'),
    });
    assert.equal(takeoverLock.response.status, 201);
    assert.notEqual(takeoverLock.body.lock.lockToken, phoneLock.body.lock.lockToken);

    const reloaded = await requestJson<ReviewCardResponse>(cardUrl);
    assert.equal(reloaded.response.status, 200);
    assert.equal(reloaded.body.card.title, '手机已保存');
  } finally {
    try {
      if (server) {
        await stopServer(server);
      }
    } finally {
      try {
        if (fixture) {
          await cleanupFixture(pool, fixture);
        }
      } finally {
        await pool.end();
      }
    }
  }
});
