import assert from 'node:assert/strict';
import test from 'node:test';
import { createPracticeStatisticsService, type PracticeStatisticsDatabase } from './practice-statistics-service.js';

const paragraph = (value: string) => [{ type: 'paragraph', children: [{ type: 'text', value }] }];
const snapshot = (chapterId: string, type: 'single' | 'multiple') => JSON.stringify({ questionChapterId: chapterId, type, stem: paragraph('题干'), options: [], answer: ['A'], analysis: null });

const database: PracticeStatisticsDatabase = {
  async execute(sql: string) {
    const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalized.startsWith('select id, subject_id') && normalized.includes('from question_banks')) {
      return [[{ id: 'bank-1', subject_id: 'subject-1', kind: 'chapter', name: '题库', sort_order: 0, question_count: 3, chapter_count: 2 }], []];
    }
    if (normalized.startsWith('select q.id, q.question_chapter_id')) {
      return [[
        { id: 'question-1', question_chapter_id: 'chapter-1', question_type: 'single', chapter_title: '第一章' },
        { id: 'question-2', question_chapter_id: 'chapter-1', question_type: 'multiple', chapter_title: '第一章' },
        { id: 'question-3', question_chapter_id: 'chapter-2', question_type: 'single', chapter_title: '第二章' },
      ], []];
    }
    if (normalized.startsWith('select a.question_id, a.result')) {
      return [[
        { question_id: 'question-1', result: 'correct', answer_json: JSON.stringify(['A']), snapshot_json: snapshot('chapter-1', 'single'), mode: 'test', completed_at: '2026-08-19T00:00:01.000Z' },
        { question_id: 'question-2', result: 'incorrect', answer_json: JSON.stringify(['A']), snapshot_json: snapshot('chapter-1', 'multiple'), mode: 'test', completed_at: '2026-08-19T00:00:01.000Z' },
        { question_id: 'question-1', result: 'incorrect', answer_json: JSON.stringify(['B']), snapshot_json: snapshot('chapter-1', 'single'), mode: 'cram', completed_at: '2026-08-19T00:00:02.000Z' },
        { question_id: 'question-3', result: 'correct', answer_json: JSON.stringify(['A']), snapshot_json: snapshot('chapter-2', 'single'), mode: 'cram', completed_at: '2026-08-19T00:00:02.000Z' },
        { question_id: 'deleted-question', result: 'incorrect', answer_json: JSON.stringify(['A']), snapshot_json: snapshot('chapter-1', 'single'), mode: 'test', completed_at: '2026-08-19T00:00:03.000Z' },
      ], []];
    }
    throw new Error(`未处理 SQL: ${sql}`);
  },
};

test('题库统计按最近完成结果汇总章节、题型和模式', async () => {
  const result = await createPracticeStatisticsService({ database }).get('bank-1');
  assert.deepEqual(result.overall, { key: 'overall', label: '总览', questionCount: 3, answeredCount: 3, unansweredCount: 0, correctCount: 1, incorrectCount: 2, accuracy: 33.3, latestCompletedAt: '2026-08-19T00:00:02.000Z' });
  assert.equal(result.aggregateWrongCount, 2);
  assert.deepEqual(result.chapters.map((line) => [line.label, line.correctCount, line.incorrectCount]), [['第一章', 0, 2], ['第二章', 1, 0]]);
  assert.deepEqual(result.types.map((line) => [line.type, line.correctCount, line.incorrectCount]), [['single', 1, 1], ['multiple', 0, 1]]);
  assert.deepEqual(result.modes.map((line) => [line.mode, line.answeredCount, line.correctCount, line.incorrectCount, line.unansweredCount]), [['cram', 2, 1, 1, 1], ['test', 2, 1, 1, 1]]);
});
