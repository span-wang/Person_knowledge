import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  healthCheckPath,
  importPreviewPath,
  importAiCorrectionPath,
  importTemplatePath,
  reviewCardPath,
  reviewResourcePath,
  type ErrorResponse,
  type HealthResponse,
  type ReviewCardResponse,
} from '@knowledge-flashcards/shared';
import { createApp, type AppDependencies } from './app.js';
import type { ImportService } from './import-service.js';
import type { ResourceService } from './resource-service.js';
import type { ReviewService } from './review-service.js';

async function withServer<T>(run: (baseUrl: string) => Promise<T>, dependencies: AppDependencies = {}) {
  const server = createServer(createApp(new Date('2026-08-10T00:00:00.000Z'), dependencies));
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

test('健康检查返回共享契约', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${healthCheckPath}`);
    const body = (await response.json()) as HealthResponse;

    assert.equal(response.status, 200);
    assert.equal(body.service, 'api');
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.timestamp, 'string');
  });
});

test('未知路由返回统一错误', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/missing`);
    const body = (await response.json()) as ErrorResponse;

    assert.equal(response.status, 404);
    assert.equal(body.error, '未找到请求的资源。');
  });
});

test('导入模板端点提供 JSON 和 Excel 下载', async () => {
  await withServer(async (baseUrl) => {
    const jsonResponse = await fetch(`${baseUrl}${importTemplatePath}/json`);
    const json = await jsonResponse.json() as { format: string; version: number; title: string };
    assert.equal(jsonResponse.status, 200);
    assert.match(jsonResponse.headers.get('content-disposition') ?? '', /knowledge-flashcards-template\.json/);
    assert.deepEqual({
      format: json.format,
      version: json.version,
      title: json.title,
    }, {
      format: 'knowledge-flashcards-material',
      version: 1,
      title: '示例资料',
    });

    const excelResponse = await fetch(`${baseUrl}${importTemplatePath}/excel`);
    assert.equal(excelResponse.status, 200);
    assert.match(excelResponse.headers.get('content-type') ?? '', /spreadsheetml/);
    assert.ok((await excelResponse.arrayBuffer()).byteLength > 0);
  });
});

test('JSON 资料上传保留原始文件内容供导入服务解析', async () => {
  let received: { fileName: string; source: Buffer } | null = null;
  const importService = {
    preview: async (fileName: string, source: Buffer) => {
      received = { fileName, source };
      return {
        previewId: null,
        sourceFileName: fileName,
        sourceType: 'json',
        markdownFileName: null,
        sourceSha256: 'test',
        valid: false,
        duplicate: false,
        duplicateMaterial: null,
        document: null,
        resources: [],
        issues: [],
      };
    },
  } as unknown as ImportService;

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${importPreviewPath}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Import-File-Name': encodeURIComponent('lesson.json'),
      },
      body: JSON.stringify({ format: 'knowledge-flashcards-material', version: 1 }),
    });
    assert.equal(response.status, 200);
  }, { importService });

  assert.equal(received?.fileName, 'lesson.json');
  assert.equal(received?.source.toString('utf8'), '{"format":"knowledge-flashcards-material","version":1}');
});

test('导入 AI 格式修正接口将预览标识和问题索引交给导入服务', async () => {
  let previewId = '';
  let issueIndex = -1;
  const importService = {
    correctFormat: async (request: { previewId: string; issueIndex: number }) => {
      previewId = request.previewId;
      issueIndex = request.issueIndex;
      return {
        previewId: request.previewId,
        revision: 1,
        sourceFileName: 'lesson.md',
        sourceType: 'markdown',
        markdownFileName: 'lesson.md',
        sourceSha256: 'test',
        valid: true,
        duplicate: false,
        duplicateMaterial: null,
        document: null,
        resources: [],
        issues: [],
        aiCorrectionAvailable: false,
      };
    },
  } as unknown as ImportService;

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${importAiCorrectionPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ previewId: 'preview-1', issueIndex: 2 }),
    });
    assert.equal(response.status, 200);
  }, { importService });

  assert.equal(previewId, 'preview-1');
  assert.equal(issueIndex, 2);
});

test('掌握状态接口会调用复习服务并返回更新后的闪卡', async () => {
  const calls: Array<{ cardId: string; status: string }> = [];
  const response: ReviewCardResponse = {
    card: {
      id: 'card-1',
      title: '闪卡一',
      materialName: '资料一',
      chapterTitle: '第一章',
      sectionTitle: '第一节',
      bodyText: '正文',
      masteryStatus: 'mastered',
      review: {
        firstViewedAt: null,
        lastViewedAt: null,
        statusChangedAt: '2026-08-10T00:00:00.000Z',
        viewCount: 0,
      },
    },
  };
  const reviewService: ReviewService = {
    dashboard: async () => ({
      counts: { materialCount: 0, cardCount: 0, unassessedCount: 0, effortCount: 0 },
      continueCard: null,
      materials: [],
    }),
    start: async () => response,
    getCard: async () => response,
    listCards: async () => ({ cards: [], currentIndex: -1 }),
    updateStatus: async (cardId, status) => {
      calls.push({ cardId, status });
      return response;
    },
    updateContent: async () => ({ card: response.card, invalidatedHighlightCount: 0 }),
    createHighlight: async (_cardId, request) => ({
      highlight: { id: 'highlight-1', kind: request.kind, anchor: request.anchor },
    }),
    deleteHighlight: async () => undefined,
  };

  await withServer(async (baseUrl) => {
    const httpResponse = await fetch(`${baseUrl}${reviewCardPath}/card-1/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'mastered' }),
    });
    const body = (await httpResponse.json()) as ReviewCardResponse;

    assert.equal(httpResponse.status, 200);
    assert.equal(body.card.masteryStatus, 'mastered');
    assert.deepEqual(calls, [{ cardId: 'card-1', status: 'mastered' }]);
  }, { reviewService });
});

test('高亮接口创建和删除当前闪卡的结构化锚点', async () => {
  const calls: Array<{ action: 'create' | 'delete'; cardId: string; highlightId?: string }> = [];
  const reviewService: ReviewService = {
    dashboard: async () => ({
      counts: { materialCount: 0, cardCount: 0, unassessedCount: 0, effortCount: 0 },
      continueCard: null,
      materials: [],
    }),
    start: async () => ({ card: {} as never }),
    getCard: async () => ({ card: {} as never }),
    listCards: async () => ({ cards: [], currentIndex: -1 }),
    updateStatus: async () => ({ card: {} as never }),
    updateContent: async () => ({ card: {} as never, invalidatedHighlightCount: 0 }),
    createHighlight: async (cardId, request) => {
      calls.push({ action: 'create', cardId });
      return { highlight: { id: 'highlight-1', kind: request.kind, anchor: request.anchor } };
    },
    deleteHighlight: async (cardId, highlightId) => {
      calls.push({ action: 'delete', cardId, highlightId });
    },
  };

  await withServer(async (baseUrl) => {
    const created = await fetch(`${baseUrl}/api/review/cards/card-1/highlights`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', anchor: { nodePath: '0.0', start: 0, end: 2 } }),
    });
    assert.equal(created.status, 201);
    assert.equal((await created.json() as { highlight: { id: string } }).highlight.id, 'highlight-1');

    const deleted = await fetch(`${baseUrl}/api/review/cards/card-1/highlights/highlight-1`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
  }, { reviewService });

  assert.deepEqual(calls, [
    { action: 'create', cardId: 'card-1' },
    { action: 'delete', cardId: 'card-1', highlightId: 'highlight-1' },
  ]);
});

test('正文编辑接口将结构化内容交给复习服务', async () => {
  const calls: Array<{ cardId: string; title: string }> = [];
  const reviewService: ReviewService = {
    dashboard: async () => ({
      counts: { materialCount: 0, cardCount: 0, unassessedCount: 0, effortCount: 0 },
      continueCard: null,
      materials: [],
    }),
    start: async () => ({ card: {} as never }),
    getCard: async () => ({ card: {} as never }),
    listCards: async () => ({ cards: [], currentIndex: -1 }),
    updateStatus: async () => ({ card: {} as never }),
    updateContent: async (cardId, request) => {
      calls.push({ cardId, title: request.title });
      return {
        card: {
          id: cardId,
          title: request.title,
          materialName: '资料一',
          chapterTitle: '第一章',
          sectionTitle: '第一节',
          bodyText: '修改后的正文',
          content: request.content,
          masteryStatus: 'unassessed',
          review: { firstViewedAt: null, lastViewedAt: null, statusChangedAt: null, viewCount: 0 },
        },
        invalidatedHighlightCount: 1,
      };
    },
    createHighlight: async () => ({ highlight: {} as never }),
    deleteHighlight: async () => undefined,
  };

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${reviewCardPath}/card-1/content`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': 'test-device',
        'X-Editor-Lock-Token': 'test-lock-token',
      },
      body: JSON.stringify({
        title: '编辑后标题',
        content: [{ type: 'paragraph', children: [{ type: 'text', value: '修改后的正文' }] }],
      }),
    });
    const body = await response.json() as { invalidatedHighlightCount: number; card: { title: string } };
    assert.equal(response.status, 200);
    assert.equal(body.card.title, '编辑后标题');
    assert.equal(body.invalidatedHighlightCount, 1);
  }, { reviewService });

  assert.deepEqual(calls, [{ cardId: 'card-1', title: '编辑后标题' }]);
});

test('资源接口按服务返回的安全文件和 MIME 类型响应', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-http-resource-'));
  const resourcePath = path.join(root, 'diagram.png');
  await fs.writeFile(resourcePath, 'image-bytes');
  const calls: string[] = [];
  const resourceService: ResourceService = {
    get: async (resourceId) => {
      calls.push(resourceId);
      return { absolutePath: resourcePath, mimeType: 'image/png' };
    },
    upload: async () => ({ id: 'resource-uploaded', mimeType: 'image/png' }),
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${reviewResourcePath}/resource-1`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'image/png');
      assert.equal(await response.text(), 'image-bytes');
    }, { resourceService });
    assert.deepEqual(calls, ['resource-1']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('图片上传接口将二进制内容交给受管资源服务', async () => {
  let uploaded: Buffer | null = null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-flashcards-http-resource-'));
  const resourcePath = path.join(root, 'placeholder.png');
  await fs.writeFile(resourcePath, 'image-bytes');
  const resourceService: ResourceService = {
    get: async () => ({ absolutePath: resourcePath, mimeType: 'image/png' }),
    upload: async (source, mimeType) => {
      uploaded = source;
      assert.equal(mimeType, 'image/png');
      return { id: 'resource-uploaded', mimeType: 'image/png' };
    },
  };

  try {
    await withServer(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${reviewResourcePath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'image/png' },
        body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(await response.json(), { resource: { id: 'resource-uploaded', mimeType: 'image/png' } });
    }, { resourceService });
    assert.deepEqual(uploaded, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
