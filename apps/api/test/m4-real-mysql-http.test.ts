import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import test from 'node:test';
import {
  aiProviderProfilesPath,
  dataBackupsPath,
  dataJsonExportPath,
  dataJsonRestorePath,
  dataMarkdownExportPath,
  hierarchyPath,
  hierarchyTrashPath,
  hierarchyTrashPermanentPath,
  reviewCardExplanationPath,
  reviewCardHighlightPath,
  reviewCardPath,
  type DataBackupResponse,
  type DataJsonExport,
  type DataRestoreResponse,
  type HierarchyTrashResponse,
  type ReviewAiExplanationResponse,
  type ReviewCardResponse,
} from '@knowledge-flashcards/shared';
import { config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createAiExplanationDatabase, createAiExplanationService } from '../src/ai-explanation-service.js';
import { createAiProviderDatabase, createAiProviderService } from '../src/ai-provider-service.js';
import { createDataGovernanceDatabase, createDataGovernanceService } from '../src/data-governance-service.js';
import { createHierarchyDatabase, createHierarchyService } from '../src/hierarchy-service.js';
import { createResourceService } from '../src/resource-service.js';
import { createReviewDatabase, createReviewService } from '../src/review-service.js';

const encryptionSecret = 'ph4-05-combination-test-encryption-secret-64-characters-long';
const providerApiKey = 'ph4-05-provider-key';

interface Fixture {
  materialId: string;
  chapterId: string;
  sectionId: string;
  cardId: string;
  resourceId: string;
  resourcePath: string;
  cardTitle: string;
}

interface StartedServer {
  server: Server;
  baseUrl: string;
}

interface ProviderRequest {
  authorization: string | undefined;
  body: Record<string, unknown>;
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

async function startServer(app: Parameters<typeof createServer>[0]): Promise<StartedServer> {
  const server = createServer(app);
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

async function startProviderServer(requests: ProviderRequest[]): Promise<StartedServer> {
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString('utf8');
      requests.push({
        authorization: request.headers.authorization,
        body: JSON.parse(rawBody) as Record<string, unknown>,
      });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { content: '组合验收讲解结果' } }] }));
    })().catch(() => {
      response.writeHead(500).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function createFixture(pool: Pool): Promise<Fixture> {
  const runId = randomUUID();
  const fixture: Fixture = {
    materialId: randomUUID(),
    chapterId: randomUUID(),
    sectionId: randomUUID(),
    cardId: randomUUID(),
    resourceId: randomUUID(),
    resourcePath: `ph4-05/${runId}.png`,
    cardTitle: `PH4-05 组合验收卡 ${runId}`,
  };
  const resource = Buffer.from(`PH4-05 resource ${runId}`);
  const resourceFile = path.join(config.storage.resources, fixture.resourcePath);
  const content = [
    { type: 'paragraph', children: [{ type: 'text', value: `组合验收正文 ${runId}` }] },
    { type: 'image', resourceId: fixture.resourceId, resourcePath: fixture.resourcePath, alt: '组合验收图片' },
    { type: 'math', value: 'a^2+b^2=c^2', display: true },
  ];

  await fs.mkdir(path.dirname(resourceFile), { recursive: true });
  await fs.writeFile(resourceFile, resource);
  await pool.execute(
    'INSERT INTO materials (id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?)',
    [fixture.materialId, `PH4-05 组合资料 ${runId}`, `${runId}.md`, createHash('sha256').update(runId).digest('hex')],
  );
  await pool.execute(
    'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.chapterId, fixture.materialId, '组合验收章'],
  );
  await pool.execute(
    'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0)',
    [fixture.sectionId, fixture.chapterId, '组合验收节'],
  );
  await pool.execute(
    'INSERT INTO resources (id, relative_path, mime_type, sha256) VALUES (?, ?, ?, ?)',
    [fixture.resourceId, fixture.resourcePath, 'image/png', createHash('sha256').update(resource).digest('hex')],
  );
  await pool.execute(
    'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0)',
    [fixture.cardId, fixture.sectionId, fixture.cardTitle, JSON.stringify(content)],
  );
  return fixture;
}

interface ReviewProgressSetting {
  key: string;
  value: string;
}

async function readReviewProgressSettings(pool: Pool): Promise<ReviewProgressSetting[]> {
  const [rows] = await pool.execute<RowDataPacket[]>(
    "SELECT setting_key, CAST(setting_value AS CHAR) AS setting_value FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')",
  );
  return rows
    .filter((row) => typeof row.setting_key === 'string' && typeof row.setting_value === 'string')
    .map((row) => ({ key: row.setting_key as string, value: row.setting_value as string }));
}

async function restoreReviewProgressSettings(pool: Pool, settings: ReviewProgressSetting[]) {
  await pool.execute("DELETE FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')");
  for (const setting of settings) {
    await pool.execute(
      'INSERT INTO app_settings (setting_key, setting_value) VALUES (?, CAST(? AS JSON))',
      [setting.key, setting.value],
    );
  }
}

async function cleanupFixture(
  pool: Pool,
  fixture: Fixture,
  providerId: string | null,
  backupsDirectory: string,
) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute('DELETE FROM trash_items WHERE entity_id IN (?, ?, ?, ?)', [fixture.materialId, fixture.chapterId, fixture.sectionId, fixture.cardId]);
    await connection.execute('DELETE FROM sync_locks WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM ai_explanations WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM highlights WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM review_records WHERE card_id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM cards WHERE id = ?', [fixture.cardId]);
    await connection.execute('DELETE FROM resources WHERE id = ?', [fixture.resourceId]);
    await connection.execute('DELETE FROM sections WHERE id = ?', [fixture.sectionId]);
    await connection.execute('DELETE FROM chapters WHERE id = ?', [fixture.chapterId]);
    await connection.execute('DELETE FROM materials WHERE id = ?', [fixture.materialId]);
    if (providerId) {
      await connection.execute('DELETE FROM ai_provider_profiles WHERE id = ?', [providerId]);
    }
    const [backupRows] = await connection.execute<RowDataPacket[]>('SELECT id, directory FROM backup_records');
    const backupIds = backupRows
      .filter((row) => typeof row.directory === 'string' && row.directory.startsWith(backupsDirectory))
      .map((row) => String(row.id));
    if (backupIds.length) {
      await connection.execute(`DELETE FROM backup_records WHERE id IN (${backupIds.map(() => '?').join(', ')})`, backupIds);
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
  await fs.rm(path.join(config.storage.resources, fixture.resourcePath), { force: true });
  await fs.rmdir(path.dirname(path.join(config.storage.resources, fixture.resourcePath))).catch(() => undefined);
  await fs.rm(backupsDirectory, { recursive: true, force: true });
}

test('PH4-05 M4 AI 与数据治理主链路通过真实 MySQL、资源目录与 HTTP 验收', { timeout: 120_000 }, async () => {
  const pool = createDatabasePool();
  const backupsDirectory = path.join(config.storage.backups, `ph4-05-${randomUUID()}`);
  const providerRequests: ProviderRequest[] = [];
  const reviewProgressSettings = await readReviewProgressSettings(pool);
  let fixture: Fixture | null = null;
  let providerId: string | null = null;
  let apiServer: Server | null = null;
  let providerServer: Server | null = null;

  try {
    fixture = await createFixture(pool);
    const upstream = await startProviderServer(providerRequests);
    providerServer = upstream.server;

    const api = await startServer(createApp(new Date(), {
      reviewService: createReviewService({ database: createReviewDatabase(pool) }),
      hierarchyService: createHierarchyService({ database: createHierarchyDatabase(pool) }),
      resourceService: createResourceService({
        execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
      }),
      aiProviderService: createAiProviderService({
        database: createAiProviderDatabase(pool),
        encryptionSecret,
      }),
      aiExplanationService: createAiExplanationService({
        database: createAiExplanationDatabase(pool),
        encryptionSecret,
      }),
      dataGovernanceService: createDataGovernanceService({
        database: createDataGovernanceDatabase(pool),
        resourcesDirectory: config.storage.resources,
        backupsDirectory,
      }),
    }));
    apiServer = api.server;

    const provider = await requestJson<{ profiles: Array<{ id: string; hasApiKey: boolean; isActive: boolean }> }>(
      api.baseUrl + aiProviderProfilesPath,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'PH4-05 假 Provider',
          provider: 'custom',
          baseUrl: upstream.baseUrl,
          model: 'ph4-05-model',
          apiKey: providerApiKey,
          isActive: true,
        }),
      },
    );
    assert.equal(provider.response.status, 201);
    const profile = provider.body.profiles.find((item) => item.isActive);
    assert.ok(profile);
    assert.equal(profile.hasApiKey, true);
    providerId = profile.id;
    assert.doesNotMatch(JSON.stringify(provider.body), new RegExp(providerApiKey));

    const connectionTest = await requestJson<{ message: string }>(
      `${api.baseUrl}${aiProviderProfilesPath}/${providerId}/test`,
      { method: 'POST' },
    );
    assert.equal(connectionTest.response.status, 200);
    assert.deepEqual(connectionTest.body, { message: '连接成功' });

    const generated = await requestJson<ReviewAiExplanationResponse>(
      `${api.baseUrl}${reviewCardExplanationPath}/${fixture.cardId}/explanation`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: '补充一个最小例子。' }),
      },
    );
    assert.equal(generated.response.status, 200);
    assert.equal(generated.body.explanation.content, '组合验收讲解结果');
    assert.match(generated.body.explanation.promptText, /最小例子/);
    assert.equal(providerRequests.length, 2);
    assert.equal(providerRequests.every((request) => request.authorization === `Bearer ${providerApiKey}`), true);

    const highlighted = await requestJson<{ highlight: { kind: string } }>(
      `${api.baseUrl}${reviewCardHighlightPath}/${fixture.cardId}/highlights`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'text', anchor: { nodePath: '0.0', start: 0, end: 4 } }),
      },
    );
    assert.equal(highlighted.response.status, 201);
    assert.equal(highlighted.body.highlight.kind, 'text');

    const status = await requestJson<ReviewCardResponse>(
      `${api.baseUrl}${reviewCardPath}/${fixture.cardId}/status`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'familiar' }),
      },
    );
    assert.equal(status.response.status, 200);
    assert.equal(status.body.card.masteryStatus, 'familiar');

    const card = await requestJson<ReviewCardResponse>(`${api.baseUrl}${reviewCardPath}/${fixture.cardId}`);
    assert.equal(card.response.status, 200);
    assert.equal(card.body.card.aiExplanation?.content, '组合验收讲解结果');
    assert.equal(card.body.card.highlights?.length, 1);
    assert.equal(card.body.card.review.viewCount >= 1, true);

    const markdown = await fetch(`${api.baseUrl}${dataMarkdownExportPath}/${fixture.materialId}`);
    assert.equal(markdown.status, 200);
    const markdownText = await markdown.text();
    assert.match(markdownText, /组合验收章/);
    assert.match(markdownText, /a\^2\+b\^2=c\^2/);
    assert.match(markdownText, new RegExp(fixture.resourcePath.replaceAll('\\', '/')));

    const exported = await fetch(api.baseUrl + dataJsonExportPath);
    assert.equal(exported.status, 200);
    const exportText = await exported.text();
    assert.doesNotMatch(exportText, /api[_-]?key|ciphertext|password|tunnel|secret/i);
    const payload = JSON.parse(exportText) as DataJsonExport;
    assert.equal(payload.cards.some((item) => item.id === fixture!.cardId && item.masteryStatus === 'familiar'), true);
    assert.equal(payload.highlights.some((item) => item.cardId === fixture!.cardId), true);
    assert.equal(payload.aiExplanations.some((item) => item.cardId === fixture!.cardId && item.content === '组合验收讲解结果'), true);
    assert.equal(payload.resources.some((item) => item.id === fixture!.resourceId && item.contentBase64), true);

    const backup = await requestJson<DataBackupResponse>(api.baseUrl + dataBackupsPath, { method: 'POST' });
    assert.equal(backup.response.status, 201);
    assert.equal(backup.body.backup.status, 'succeeded');
    assert.deepEqual(backup.body.backup.fileManifest.map((item) => item.path), ['data.json', 'resources/' + fixture.resourcePath]);

    await pool.execute('UPDATE cards SET title = ? WHERE id = ?', ['JSON 恢复前临时标题', fixture.cardId]);
    const restoredJson = await requestJson<DataRestoreResponse>(api.baseUrl + dataJsonRestorePath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(restoredJson.response.status, 200);
    assert.equal(restoredJson.body.cardCount >= 1, true);
    const afterJsonRestore = await requestJson<ReviewCardResponse>(`${api.baseUrl}${reviewCardPath}/${fixture.cardId}`);
    assert.equal(afterJsonRestore.body.card.title, fixture.cardTitle);

    await pool.execute('UPDATE cards SET title = ? WHERE id = ?', ['备份恢复前临时标题', fixture.cardId]);
    const restoredBackup = await requestJson<DataRestoreResponse>(
      `${api.baseUrl}${dataBackupsPath}/${backup.body.backup.id}/restore`,
      { method: 'POST' },
    );
    assert.equal(restoredBackup.response.status, 200);
    const afterBackupRestore = await requestJson<ReviewCardResponse>(`${api.baseUrl}${reviewCardPath}/${fixture.cardId}`);
    assert.equal(afterBackupRestore.body.card.title, fixture.cardTitle);
    assert.equal(afterBackupRestore.body.card.aiExplanation?.content, '组合验收讲解结果');

    const deleted = await fetch(`${api.baseUrl}${hierarchyPath}/card/${fixture.cardId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    const trash = await requestJson<HierarchyTrashResponse>(api.baseUrl + hierarchyTrashPath);
    const item = trash.body.items.find((candidate) => candidate.entityId === fixture!.cardId);
    assert.ok(item);
    const permanentlyDeleted = await requestJson<{ deletedEntityCount: number; deletedResourceCount: number }>(
      `${api.baseUrl}${hierarchyTrashPermanentPath}/${item.id}/permanent`,
      { method: 'DELETE' },
    );
    assert.equal(permanentlyDeleted.response.status, 200);
    assert.deepEqual(permanentlyDeleted.body, { deletedEntityCount: 1, deletedResourceCount: 1 });
    const [cardRows] = await pool.execute<RowDataPacket[]>('SELECT id FROM cards WHERE id = ?', [fixture.cardId]);
    assert.equal(cardRows.length, 0);
    assert.equal(await fs.access(path.join(config.storage.resources, fixture.resourcePath)).then(() => true, () => false), false);
  } finally {
    if (apiServer) {
      await stopServer(apiServer);
    }
    if (providerServer) {
      await stopServer(providerServer);
    }
    if (fixture) {
      await cleanupFixture(pool, fixture, providerId, backupsDirectory);
    } else {
      await fs.rm(backupsDirectory, { recursive: true, force: true });
    }
    await restoreReviewProgressSettings(pool, reviewProgressSettings);
    await pool.end();
  }
});
