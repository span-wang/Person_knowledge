import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import type { Pool } from 'mysql2/promise';
import { learningInsightsPath, type LearningInsightsResponse } from '@knowledge-flashcards/shared';
import { createApp } from '../src/app.js';
import { createDatabasePool } from '../src/database.js';
import { createLearningInsightsService } from '../src/learning-insights-service.js';

test('PH7-03 周期洞察通过真实 MySQL 与 HTTP 验收', { timeout: 60_000 }, async () => {
  const pool = createDatabasePool();
  const ids = {
    course: randomUUID(), subject: randomUUID(), material: randomUUID(), chapter: randomUUID(), section: randomUUID(), card: randomUUID(), deletedCard: randomUUID(), bank: randomUUID(), deletedBank: randomUUID(), question: randomUUID(), deletedQuestion: randomUUID(), completedSession: randomUUID(), completedSessionTwo: randomUUID(), completedSessionThree: randomUUID(), inProgressSession: randomUUID(),
  };
  let server: Server | null = null;
  try {
    const now = new Date('2026-08-20T02:00:00.000Z');
    const body = JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: '题干' }] }]);
    const options = JSON.stringify([{ key: 'A', content: [] }, { key: 'B', content: [] }]);
    await pool.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, 990001)', [ids.course, 'PH7-03 课程']);
    await pool.execute('INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, 0)', [ids.subject, ids.course, 'PH7-03 科目']);
    await pool.execute('INSERT INTO materials (id, subject_id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?, ?)', [ids.material, ids.subject, 'PH7-03 资料', `ph7-03-${ids.material}.md`, ids.material.replaceAll('-', '')]);
    await pool.execute('INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, 0)', [ids.chapter, ids.material, '第一章']);
    await pool.execute('INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, 0)', [ids.section, ids.chapter, '第一节']);
    await pool.execute('INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, 0), (?, ?, ?, ?, 1)', [ids.card, ids.section, '有效闪卡', body, ids.deletedCard, ids.section, '已删除闪卡', body]);
    await pool.execute('INSERT INTO review_records (card_id, first_viewed_at, last_viewed_at, view_count) VALUES (?, ?, ?, 2), (?, ?, ?, 5)', [ids.card, '2026-08-14 16:30:00.000', '2026-08-14 16:30:00.000', ids.deletedCard, '2026-08-19 16:30:00.000', '2026-08-19 16:30:00.000']);
    await pool.execute('INSERT INTO review_status_history (id, card_id, from_status, to_status, changed_at, source) VALUES (?, ?, NULL, \'unassessed\', ?, \'review\'), (?, ?, \'unassessed\', \'mastered\', ?, \'review\')', [randomUUID(), ids.card, '2026-08-19 16:30:00.000', randomUUID(), ids.card, '2026-08-20 00:30:00.000']);
    await pool.execute('UPDATE cards SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [ids.deletedCard]);
    await pool.execute('INSERT INTO question_banks (id, subject_id, kind, name, sort_order) VALUES (?, ?, \'official\', ?, 0), (?, ?, \'mock\', ?, 1)', [ids.bank, ids.subject, '有效题库', ids.deletedBank, ids.subject, '已删除题库']);
    await pool.execute('INSERT INTO questions (id, question_bank_id, stem_json, question_type, options_json, answer_json, knowledge_points_json, sort_order) VALUES (?, ?, ?, \'single\', ?, ?, ?, 0), (?, ?, ?, \'single\', ?, ?, ?, 1)', [ids.question, ids.bank, body, options, JSON.stringify(['A']), JSON.stringify(['函数']), ids.deletedQuestion, ids.deletedBank, body, options, JSON.stringify(['A']), JSON.stringify(['函数'])]);
    await pool.execute('UPDATE question_banks SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [ids.deletedBank]);
    await pool.execute('UPDATE questions SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [ids.deletedQuestion]);
    await pool.execute('INSERT INTO practice_sessions (id, question_bank_id, mode, source, scope_json, status, completed_at) VALUES (?, ?, \'test\', \'full\', \'{}\', \'completed\', ?), (?, ?, \'test\', \'full\', \'{}\', \'completed\', ?), (?, ?, \'test\', \'full\', \'{}\', \'completed\', ?), (?, ?, \'test\', \'full\', \'{}\', \'in_progress\', NULL)', [ids.completedSession, ids.bank, '2026-08-19 16:00:00.000', ids.completedSessionTwo, ids.bank, '2026-08-19 17:00:00.000', ids.completedSessionThree, ids.bank, '2026-08-19 17:30:00.000', ids.inProgressSession, ids.bank]);
    const snapshot = JSON.stringify({ questionId: ids.question, questionVersion: 1 });
    await pool.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result, answered_at) VALUES (?, ?, ?, 1, 0, ?, ?, \'correct\', ?), (?, ?, ?, 1, 0, ?, ?, \'incorrect\', ?), (?, ?, ?, 1, 0, ?, ?, \'incorrect\', ?), (?, ?, ?, 1, 0, ?, ?, \'incorrect\', ?)', [randomUUID(), ids.completedSession, ids.question, snapshot, JSON.stringify(['A']), '2026-08-19 16:30:00.000', randomUUID(), ids.completedSessionTwo, ids.question, snapshot, JSON.stringify(['B']), '2026-08-19 17:30:00.000', randomUUID(), ids.completedSessionThree, ids.question, snapshot, JSON.stringify(['B']), '2026-08-19 17:40:00.000', randomUUID(), ids.inProgressSession, ids.question, snapshot, JSON.stringify(['B']), '2026-08-19 18:30:00.000']);
    const app = createApp(new Date(), { learningInsightsService: createLearningInsightsService({ database: pool, now }) });
    server = createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await fetch(`${baseUrl}${learningInsightsPath}?periodDays=7&courseId=${ids.course}&subjectId=${ids.subject}`);
    assert.equal(result.status, 200);
    const response = await result.json() as LearningInsightsResponse;
    assert.equal(response.flashcards.reviewedCount, 1);
    assert.equal(response.masteryChanges.total, 2);
    assert.equal(response.practice.answeredCount, 3);
    assert.equal(response.practice.correctCount, 1);
    assert.deepEqual(response.weakKnowledgePoints, [{ knowledgePoint: '函数', answeredCount: 3, incorrectCount: 2, accuracy: 33 }]);
  } finally {
    if (server) { server.close(); await once(server, 'close'); }
    await pool.execute('DELETE a FROM practice_attempts a INNER JOIN practice_sessions s ON s.id = a.practice_session_id WHERE s.question_bank_id IN (?, ?)', [ids.bank, ids.deletedBank]);
    await pool.execute('DELETE FROM practice_sessions WHERE question_bank_id IN (?, ?)', [ids.bank, ids.deletedBank]);
    await pool.execute('DELETE FROM review_status_history WHERE card_id IN (?, ?)', [ids.card, ids.deletedCard]);
    await pool.execute('DELETE FROM review_records WHERE card_id IN (?, ?)', [ids.card, ids.deletedCard]);
    await pool.execute('DELETE FROM questions WHERE id IN (?, ?)', [ids.question, ids.deletedQuestion]);
    await pool.execute('DELETE FROM question_banks WHERE id IN (?, ?)', [ids.bank, ids.deletedBank]);
    await pool.execute('DELETE FROM cards WHERE id IN (?, ?)', [ids.card, ids.deletedCard]);
    await pool.execute('DELETE FROM sections WHERE id = ?', [ids.section]);
    await pool.execute('DELETE FROM chapters WHERE id = ?', [ids.chapter]);
    await pool.execute('DELETE FROM materials WHERE id = ?', [ids.material]);
    await pool.execute('DELETE FROM subjects WHERE id = ?', [ids.subject]);
    await pool.execute('DELETE FROM courses WHERE id = ?', [ids.course]);
    await pool.end();
  }
});
