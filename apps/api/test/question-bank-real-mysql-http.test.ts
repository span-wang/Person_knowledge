import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import {
  questionBanksPath,
  questionChaptersPath,
  type QuestionBankDirectoryResponse,
  type QuestionBankTrashResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createQuestionBankDatabase, createQuestionBankService } from '../src/question-bank-service.js';

async function startServer(pool: Pool) {
  const server = createServer(createApp(new Date(), { questionBankService: createQuestionBankService({ database: createQuestionBankDatabase(pool) }) }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function requestJson<T>(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  return { response, body: await response.json() as T };
}

test('PH6-04 题库目录通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const runId = randomUUID();
  const courseId = randomUUID();
  const subjectId = randomUUID();
  let server: Server | null = null;
  const bankIds: string[] = [];
  const chapterIds: string[] = [];
  try {
    await pool.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, 990000)', [courseId, `PH6-04 课程 ${runId}`]);
    await pool.execute('INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, 0)', [subjectId, courseId, `PH6-04 科目 ${runId}`]);
    const started = await startServer(pool); server = started.server;

    const first = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionBanksPath}/subject/${subjectId}`);
    assert.equal(first.response.status, 200);
    assert.deepEqual(first.body.banks.chapter, []);

    const createOne = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionBanksPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId, kind: 'chapter', name: '章节题一' }) });
    assert.equal(createOne.response.status, 201);
    const bankOne = createOne.body.banks.chapter[0]!; bankIds.push(bankOne.id);
    const createTwo = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionBanksPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId, kind: 'chapter', name: '章节题二' }) });
    const bankTwo = createTwo.body.banks.chapter.find((bank) => bank.id !== bankOne.id)!; bankIds.push(bankTwo.id);

    const chapterCreated = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionChaptersPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId: bankOne.id, title: '第一章' }) });
    assert.equal(chapterCreated.response.status, 201);
    const chapterId = chapterCreated.body.banks.chapter.find((bank) => bank.id === bankOne.id)?.chapters[0]?.id;
    assert.ok(chapterId); chapterIds.push(chapterId);

    const moved = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionChaptersPath}/${chapterId}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId: bankTwo.id }) });
    assert.equal(moved.response.status, 200);
    assert.equal(moved.body.banks.chapter.find((bank) => bank.id === bankTwo.id)?.chapters[0]?.id, chapterId);

    const deleted = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionBanksPath}/${bankTwo.id}`, { method: 'DELETE' });
    assert.equal(deleted.response.status, 200);
    const trash = await requestJson<QuestionBankTrashResponse>(`${started.baseUrl}${questionBanksPath}/subject/${subjectId}/trash`);
    assert.equal(trash.response.status, 200);
    assert.equal(trash.body.items.some((item) => item.entityType === 'question_bank' && item.entityId === bankTwo.id), true);

    const restored = await requestJson<QuestionBankDirectoryResponse>(`${started.baseUrl}${questionBanksPath}/${bankTwo.id}/restore`, { method: 'POST' });
    assert.equal(restored.response.status, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.banks.chapter.some((bank) => bank.id === bankTwo.id), true);
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    await pool.execute(`DELETE FROM trash_items WHERE entity_id IN (${[...bankIds, ...chapterIds].map(() => '?').join(', ') || "''"})`, [...bankIds, ...chapterIds]);
    if (bankIds.length) {
      await pool.execute(`DELETE FROM questions WHERE question_bank_id IN (${bankIds.map(() => '?').join(', ')})`, bankIds);
      await pool.execute(`DELETE FROM question_chapters WHERE question_bank_id IN (${bankIds.map(() => '?').join(', ')})`, bankIds);
      await pool.execute(`DELETE FROM question_banks WHERE id IN (${bankIds.map(() => '?').join(', ')})`, bankIds);
    }
    await pool.execute('DELETE FROM subjects WHERE id = ?', [subjectId]);
    await pool.execute('DELETE FROM courses WHERE id = ?', [courseId]);
    await pool.end();
  }
});
