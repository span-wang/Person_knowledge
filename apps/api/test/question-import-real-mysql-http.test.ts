import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import {
  questionImportApplyPath,
  questionImportPreviewPath,
  type QuestionImportAppliedResponse,
  type QuestionImportPreviewResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createQuestionImportDatabase, createQuestionImportService } from '../src/question-import-service.js';

function jsonValue(value: unknown) {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function startServer(pool: Pool) {
  const server = createServer(createApp(new Date(), {
    questionImportService: createQuestionImportService({ database: createQuestionImportDatabase(pool) }),
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function stopServer(server: Server) {
  server.close();
  await once(server, 'close');
}

test('PH6-03 题库 JSON 导入通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const runId = randomUUID();
  const courseId = randomUUID();
  const subjectId = randomUUID();
  const bankName = `PH6-03 导入题库 ${runId}`;
  let server: Server | null = null;
  let bankId: string | null = null;
  try {
    await pool.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, 900000)', [courseId, `PH6-03 课程 ${runId}`]);
    await pool.execute('INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, 0)', [subjectId, courseId, `PH6-03 科目 ${runId}`]);
    const started = await startServer(pool);
    server = started.server;
    const source = Buffer.from(JSON.stringify({
      format: 'knowledge-flashcards-question-bank',
      version: 1,
      title: bankName,
      chapters: [{
        title: '第一章',
        questions: [
          { stem: '单选题', type: 'single', options: { A: '正确', B: '错误' }, answer: 'A', analysis: '单选解析', knowledgePoints: ['基础'] },
          { stem: '多选题', type: 'multiple', options: { A: '一', B: '二', C: '三' }, answer: ['a', 'c'], knowledgePoints: [] },
          { stem: '判断题', type: 'true_false', options: { A: '对', B: '错' }, answer: 'B' },
        ],
      }],
    }));
    const previewResponse = await fetch(`${started.baseUrl}${questionImportPreviewPath}?courseId=${courseId}&subjectId=${subjectId}&kind=chapter`, {
      method: 'POST',
      headers: { 'x-import-file-name': encodeURIComponent(`ph6-03-${runId}.json`), 'content-type': 'application/json' },
      body: source,
    });
    assert.equal(previewResponse.status, 200);
    const preview = await previewResponse.json() as QuestionImportPreviewResponse;
    assert.equal(preview.valid, true);
    assert.equal(preview.document?.chapters[0]?.questions.length, 3);
    assert.deepEqual(preview.document?.chapters[0]?.questions[1]?.answer, ['A', 'C']);
    assert.ok(preview.previewId);

    const applyResponse = await fetch(`${started.baseUrl}${questionImportApplyPath}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ previewId: preview.previewId }),
    });
    assert.equal(applyResponse.status, 200);
    const applied = await applyResponse.json() as QuestionImportAppliedResponse;
    bankId = applied.questionBankId;
    assert.equal(applied.questionChapterCount, 1);
    assert.equal(applied.questionCount, 3);

    const [banks] = await pool.execute<RowDataPacket[]>('SELECT subject_id, kind, name FROM question_banks WHERE id = ?', [bankId]);
    assert.deepEqual(banks.map((row) => [row.subject_id, row.kind, row.name]), [[subjectId, 'chapter', bankName]]);
    const [chapters] = await pool.execute<RowDataPacket[]>('SELECT title FROM question_chapters WHERE question_bank_id = ?', [bankId]);
    assert.deepEqual(chapters.map((row) => row.title), ['第一章']);
    const [questions] = await pool.execute<RowDataPacket[]>('SELECT question_type, options_json, answer_json, analysis_json, knowledge_points_json FROM questions WHERE question_bank_id = ? ORDER BY sort_order', [bankId]);
    assert.deepEqual(questions.map((row) => row.question_type), ['single', 'multiple', 'true_false']);
    assert.deepEqual(jsonValue(questions[1]?.answer_json), ['A', 'C']);
    assert.equal((jsonValue(questions[0]?.analysis_json) as Array<{ children: Array<{ value: string }> }>)[0]?.children[0]?.value, '单选解析');
    assert.deepEqual(jsonValue(questions[0]?.knowledge_points_json), ['基础']);
  } finally {
    if (server) await stopServer(server);
    if (bankId) {
      await pool.execute('DELETE FROM questions WHERE question_bank_id = ?', [bankId]);
      await pool.execute('DELETE FROM question_chapters WHERE question_bank_id = ?', [bankId]);
      await pool.execute('DELETE FROM question_banks WHERE id = ?', [bankId]);
    }
    await pool.execute('DELETE FROM subjects WHERE id = ?', [subjectId]);
    await pool.execute('DELETE FROM courses WHERE id = ?', [courseId]);
    await pool.end();
  }
});
