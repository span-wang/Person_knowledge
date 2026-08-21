import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { wrongAnswerReviewPath, type PracticeSessionResponse, type WrongAnswerFilterResponse } from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createPracticeDatabase, createPracticeService } from '../src/practice-service.js';
import { createWrongAnswerService } from '../src/wrong-answer-service.js';

test('PH7-02 错题备注、最近错误筛选和复练通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const ids = { course: randomUUID(), subject: randomUUID(), bank: randomUUID(), first: randomUUID(), second: randomUUID(), oldSession: randomUUID(), newSession: randomUUID() };
  let server: Server | null = null;
  try {
    const content = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: '题干' }] }]);
    const options = JSON.stringify([{ key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '甲' }] }] }, { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '乙' }] }] }]);
    await pool.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, 990000)', [ids.course, 'PH7-02 课程']);
    await pool.execute('INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, 0)', [ids.subject, ids.course, 'PH7-02 科目']);
    await pool.execute('INSERT INTO question_banks (id, subject_id, kind, name, sort_order) VALUES (?, ?, \'official\', ?, 0)', [ids.bank, ids.subject, 'PH7-02 题库']);
    await pool.execute('INSERT INTO questions (id, question_bank_id, stem_json, question_type, options_json, answer_json, knowledge_points_json, sort_order) VALUES (?, ?, ?, \'single\', ?, ?, ?, 0), (?, ?, ?, \'single\', ?, ?, ?, 1)', [ids.first, ids.bank, content, options, JSON.stringify(['A']), JSON.stringify(['函数']), ids.second, ids.bank, content, options, JSON.stringify(['A']), JSON.stringify(['极限'])]);
    const snapshot = JSON.stringify({ questionId: ids.first, questionVersion: 1, questionChapterId: null, stem: JSON.parse(content), type: 'single', options: JSON.parse(options), answer: ['A'], analysis: null, isFavorite: false });
    const snapshotSecond = snapshot.replace(ids.first, ids.second);
    await pool.execute('INSERT INTO practice_sessions (id, question_bank_id, subject_id, mode, source, scope_json, status, completed_at) VALUES (?, ?, NULL, \'test\', \'full\', \'{}\', \'completed\', CURRENT_TIMESTAMP(3)), (?, ?, NULL, \'test\', \'full\', \'{}\', \'completed\', CURRENT_TIMESTAMP(3))', [ids.oldSession, ids.bank, ids.newSession, ids.bank]);
    await pool.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result, answered_at) VALUES (?, ?, ?, 1, 0, ?, ?, \'incorrect\', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 2 DAY)), (?, ?, ?, 1, 0, ?, ?, \'correct\', DATE_SUB(CURRENT_TIMESTAMP(3), INTERVAL 1 DAY)), (?, ?, ?, 1, 1, ?, ?, \'incorrect\', CURRENT_TIMESTAMP(3))', [randomUUID(), ids.oldSession, ids.first, snapshot, JSON.stringify(['B']), randomUUID(), ids.newSession, ids.first, snapshot, JSON.stringify(['A']), randomUUID(), ids.newSession, ids.second, snapshotSecond, JSON.stringify(['B'])]);
    await pool.execute('INSERT INTO question_review_notes (question_id, note_text) VALUES (?, ?)', [ids.second, '先检查定义']);

    const app = createApp(new Date(), { wrongAnswerService: createWrongAnswerService({ database: pool }), practiceService: createPracticeService({ database: createPracticeDatabase(pool) }) });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const listed = await fetch(`${baseUrl}${wrongAnswerReviewPath}?subjectId=${ids.subject}`);
    assert.equal(listed.status, 200);
    const body = await listed.json() as WrongAnswerFilterResponse;
    assert.deepEqual(body.items.map((item) => item.question.id), [ids.second]);
    assert.equal(body.items[0]?.note?.noteText, '先检查定义');
    const started = await fetch(`${baseUrl}${wrongAnswerReviewPath}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId: ids.subject, mode: 'cram', since: new Date(Date.now() - 86_400_000).toISOString() }) });
    assert.equal(started.status, 201);
    const startedBody = await started.json() as PracticeSessionResponse;
    assert.deepEqual(startedBody.questions.map((question) => question.id), [ids.second]);
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    await pool.execute('DELETE n FROM question_review_notes n INNER JOIN questions q ON q.id = n.question_id WHERE q.question_bank_id = ?', [ids.bank]);
    await pool.execute('DELETE a FROM practice_attempts a INNER JOIN practice_sessions s ON s.id = a.practice_session_id WHERE s.question_bank_id = ? OR s.subject_id = ?', [ids.bank, ids.subject]);
    await pool.execute('DELETE FROM practice_sessions WHERE question_bank_id = ? OR subject_id = ?', [ids.bank, ids.subject]);
    await pool.execute('DELETE FROM questions WHERE question_bank_id = ?', [ids.bank]);
    await pool.execute('DELETE FROM question_banks WHERE id = ?', [ids.bank]);
    await pool.execute('DELETE FROM subjects WHERE id = ?', [ids.subject]);
    await pool.execute('DELETE FROM courses WHERE id = ?', [ids.course]);
    await pool.end();
  }
});
