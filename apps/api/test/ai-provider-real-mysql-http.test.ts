import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import {
  aiProviderProfilesPath,
  type AiProviderProfilesResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createAiProviderDatabase, createAiProviderService } from '../src/ai-provider-service.js';
import { createDatabasePool } from '../src/database.js';

const testEncryptionSecret = 'ph4-01-integration-encryption-secret-must-have-at-least-thirty-two-characters';

async function startServer(pool: Pool) {
  const server = createServer(createApp(new Date(), {
    aiProviderService: createAiProviderService({
      database: createAiProviderDatabase(pool),
      encryptionSecret: testEncryptionSecret,
    }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
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

test('PH4-01 Provider 配置通过真实 MySQL + HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const runId = randomUUID();
  const names = [`OpenAI ${runId}`, `DeepSeek ${runId}`];
  let server: Server | null = null;

  try {
    const started = await startServer(pool);
    server = started.server;
    const first = await requestJson<AiProviderProfilesResponse>(started.baseUrl + aiProviderProfilesPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: names[0],
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
        apiKey: `secret-${runId}`,
        isActive: true,
      }),
    });
    assert.equal(first.response.status, 201);
    const firstProfile = first.body.profiles.find((profile) => profile.name === names[0]);
    assert.ok(firstProfile);
    assert.equal(firstProfile.hasApiKey, true);
    assert.equal(firstProfile.isActive, true);
    assert.equal('apiKey' in firstProfile, false);

    const [firstRows] = await pool.execute(
      'SELECT api_key_ciphertext FROM ai_provider_profiles WHERE id = ?',
      [firstProfile.id],
    );
    const firstCiphertext = Buffer.from((firstRows as Array<{ api_key_ciphertext: Buffer }>)[0]!.api_key_ciphertext);
    assert.equal(firstCiphertext.includes(`secret-${runId}`), false);

    const second = await requestJson<AiProviderProfilesResponse>(started.baseUrl + aiProviderProfilesPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: names[1],
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat',
        apiKey: `other-secret-${runId}`,
        isActive: false,
      }),
    });
    assert.equal(second.response.status, 201);
    const secondProfile = second.body.profiles.find((profile) => profile.name === names[1]);
    assert.ok(secondProfile);
    assert.equal(secondProfile.isActive, false);

    const enabled = await requestJson<AiProviderProfilesResponse>(
      `${started.baseUrl}${aiProviderProfilesPath}/${encodeURIComponent(secondProfile.id)}/activate`,
      { method: 'POST' },
    );
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.body.profiles.find((profile) => profile.id === firstProfile.id)?.isActive, true);
    assert.equal(enabled.body.profiles.find((profile) => profile.id === secondProfile.id)?.isActive, true);
    const firstPriority = enabled.body.profiles.find((profile) => profile.id === firstProfile.id)?.priority;
    const secondPriority = enabled.body.profiles.find((profile) => profile.id === secondProfile.id)?.priority;
    assert.ok(firstPriority !== undefined && secondPriority !== undefined);
    assert.equal(secondPriority > firstPriority, true);

    const [secondRowsBeforeUpdate] = await pool.execute(
      'SELECT api_key_ciphertext FROM ai_provider_profiles WHERE id = ?',
      [secondProfile.id],
    );
    const secondCiphertext = Buffer.from((secondRowsBeforeUpdate as Array<{ api_key_ciphertext: Buffer }>)[0]!.api_key_ciphertext);
    const updated = await requestJson<AiProviderProfilesResponse>(
      `${started.baseUrl}${aiProviderProfilesPath}/${encodeURIComponent(secondProfile.id)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: names[1],
          provider: 'deepseek',
          baseUrl: 'https://api.deepseek.com/v1',
          model: 'deepseek-reasoner',
        }),
      },
    );
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.profiles.find((profile) => profile.id === secondProfile.id)?.model, 'deepseek-reasoner');

    const [secondRowsAfterUpdate] = await pool.execute(
      'SELECT api_key_ciphertext FROM ai_provider_profiles WHERE id = ?',
      [secondProfile.id],
    );
    assert.deepEqual(
      Buffer.from((secondRowsAfterUpdate as Array<{ api_key_ciphertext: Buffer }>)[0]!.api_key_ciphertext),
      secondCiphertext,
    );

    const listed = await requestJson<AiProviderProfilesResponse>(started.baseUrl + aiProviderProfilesPath);
    assert.equal(listed.response.status, 200);
    assert.equal(listed.body.profiles.filter((profile) => profile.isActive).length >= 1, true);
  } finally {
    try {
      if (server) {
        await stopServer(server);
      }
    } finally {
      try {
        await pool.execute('DELETE FROM ai_provider_profiles WHERE name IN (?, ?)', names);
      } finally {
        await pool.end();
      }
    }
  }
});
