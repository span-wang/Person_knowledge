import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import {
  dataBackupsPath,
  dataJsonExportPath,
  dataJsonRestorePath,
  dataMarkdownExportPath,
  type DataJsonExport,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import type { DataGovernanceService } from '../src/data-governance-service.js';

const exportPayload: DataJsonExport = {
  format: 'knowledge-flashcards-json',
  version: 1,
  exportedAt: '2026-08-11T00:00:00.000Z',
  materials: [],
  chapters: [],
  sections: [],
  cards: [],
  resources: [],
  highlights: [],
  reviewRecords: [],
  aiExplanations: [],
  trashItems: [],
  appSettings: [],
};

test('数据导出与恢复 HTTP 接口返回稳定契约且不下发秘密', async () => {
  let restored: unknown;
  const dataGovernanceService: DataGovernanceService = {
    exportMarkdown: async () => ({ fileName: '资料.md', content: '# 资料\n' }),
    exportJson: async () => exportPayload,
    restoreJson: async (value) => {
      restored = value;
      return { materialCount: 0, chapterCount: 0, sectionCount: 0, cardCount: 0, resourceCount: 0, highlightCount: 0 };
    },
    listBackups: async () => ({ backups: [] }),
    createBackup: async () => ({ backup: { id: 'backup-1', startedAt: '2026-08-11T00:00:00.000Z', finishedAt: '2026-08-11T00:00:01.000Z', status: 'succeeded', fileManifest: [], errorMessage: null } }),
    ensureDailyBackup: async () => null,
    restoreBackup: async () => ({ materialCount: 0, chapterCount: 0, sectionCount: 0, cardCount: 0, resourceCount: 0, highlightCount: 0 }),
    permanentlyDeleteTrashItem: async () => ({ deletedEntityCount: 0, deletedResourceCount: 0 }),
  };
  const server = createServer(createApp(new Date(), { dataGovernanceService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const markdown = await fetch(`${baseUrl}${dataMarkdownExportPath}/material-1`);
    assert.equal(markdown.status, 200);
    assert.match(markdown.headers.get('content-type') ?? '', /text\/markdown/);
    assert.equal(await markdown.text(), '# 资料\n');

    const json = await fetch(`${baseUrl}${dataJsonExportPath}`);
    assert.equal(json.status, 200);
    assert.doesNotMatch(await json.text(), /api[_-]?key|ciphertext|password|tunnel/i);

    const backups = await fetch(`${baseUrl}${dataBackupsPath}`);
    assert.equal(backups.status, 200);
    assert.deepEqual(await backups.json(), { backups: [] });

    const restore = await fetch(`${baseUrl}${dataJsonRestorePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(exportPayload),
    });
    assert.equal(restore.status, 200);
    assert.deepEqual(await restore.json(), { materialCount: 0, chapterCount: 0, sectionCount: 0, cardCount: 0, resourceCount: 0, highlightCount: 0 });
    assert.deepEqual(restored, exportPayload);
  } finally {
    server.close();
    await once(server, 'close');
  }
});
