import assert from 'node:assert/strict';
import test from 'node:test';
import { createReviewWorkspaceService, type ReviewWorkspaceSqlExecutor } from './review-workspace-service.js';

class FakeWorkspaceDatabase implements ReviewWorkspaceSqlExecutor {
  readonly writes: string[] = [];
  constructor(private readonly includeFavorite = false) {}

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    if (lower.startsWith('select setting_value from app_settings')) {
      return [[{ setting_value: JSON.stringify({ courseId: 'course-1', cardIdsByMaterial: { 'material-1': 'card-1' } }) }], []];
    }
    if (lower.startsWith('insert into app_settings')) {
      this.writes.push(String(values[1] ?? ''));
      return [[], []];
    }
    if (lower.includes('select id, name, is_system from courses')) {
      return [[{ id: 'course-1', name: '课程一', is_system: 0 }], []];
    }
    if (lower.includes('select c.id, c.name, c.is_system')) {
      return [[{ id: 'course-1', name: '课程一', is_system: 0, subject_count: 1, material_count: 1 }], []];
    }
    if (lower.includes('select distinct s.course_id')) {
      return [[{ course_id: 'course-1' }], []];
    }
    if (lower.includes('select s.course_id, count(c.id) as flashcard_count')) {
      return [[{ course_id: 'course-1', flashcard_count: 2 }], []];
    }
    if (lower.includes('select s.course_id, count(distinct b.id)')) {
      return [[{ course_id: 'course-1', question_bank_count: 1, question_count: 3 }], []];
    }
    if (lower.includes('select s.course_id, count(*) as in_progress_count')) {
      return [[], []];
    }
    if (lower.startsWith('select id, course_id, name, is_system from subjects')) {
      return [[{ id: 'subject-1', course_id: 'course-1', name: '科目一', is_system: 0 }], []];
    }
    if (lower.includes('select s.id, s.course_id, s.name')) {
      return [[{ id: 'subject-1', course_id: 'course-1', name: '科目一', is_system: 0, material_count: 1, flashcard_count: 2, question_bank_count: 1, question_count: 3 }], []];
    }
    if (lower.startsWith('select m.id as material_id')) {
      return [[{ material_id: 'material-1', subject_id: 'subject-1', material_name: '资料一', card_count: 2, mastered_count: 0, familiar_count: 0, effort_count: 0, unassessed_count: 2, last_card_id: 'card-1', last_card_title: '卡片一', last_viewed_at: '2026-08-19T01:00:00.000Z' }], []];
    }
    if (lower.includes('from material_covers')) return [[], []];
    if (lower.startsWith('select b.id as bank_id')) {
      return [[{ bank_id: 'bank-1', subject_id: 'subject-1', kind: 'chapter', name: '章节题', question_count: 3, chapter_count: 1 }], []];
    }
    if (lower.startsWith('select b.subject_id')) return [this.includeFavorite ? [{ subject_id: 'subject-1', favorite_count: 1, in_progress_count: 1, latest_session_id: 'favorite-session-1', latest_session_mode: 'cram', latest_session_updated_at: '2026-08-20T01:00:00.000Z' }] : [], []];
    if (lower.startsWith('select ch.id as chapter_id')) {
      return [[{ chapter_id: 'chapter-1', question_bank_id: 'bank-1', title: '第一章', question_count: 3 }], []];
    }
    if (lower.startsWith('select ps.id as session_id')) return [lower.includes("coalesce(b.name, '收藏题')") && this.includeFavorite ? [{ session_id: 'favorite-session-1', mode: 'cram', source: 'favorite', updated_at: '2026-08-20T01:00:00.000Z', bank_id: null, bank_name: '收藏题', subject_id: 'subject-1' }] : [], []];
    if (lower.includes('select count(distinct q.id) as wrong_count')) return [[{ wrong_count: 0 }], []];
    if (lower.startsWith('select m.id as material_id, m.subject_id, m.name as material_name, c.id as card_id')) {
      return [[{ material_id: 'material-1', subject_id: 'subject-1', material_name: '资料一', card_id: 'card-1', card_title: '卡片一', last_viewed_at: '2026-08-19T01:00:00.000Z' }], []];
    }
    if (lower.includes('from cards as c') && lower.includes('where c.id in')) return [[{ course_id: 'course-1' }], []];
    throw new Error(`未覆盖的 SQL: ${normalized}`);
  }
}

test('课程工作台真实 SQL 聚合包含闪卡续读并返回轻量摘要', async () => {
  const database = new FakeWorkspaceDatabase();
  const service = createReviewWorkspaceService({ database });
  const response = await service.getWorkspace({ courseId: 'course-1' });

  assert.equal(response.context.courseId, 'course-1');
  assert.equal(response.currentCourse.name, '课程一');
  assert.equal(response.currentCourse.hasContinue, true);
  assert.equal(response.flashcards.materials[0]?.lastCardTitle, '卡片一');
  assert.equal(response.continue?.kind, 'flashcard');
  assert.equal(response.questions.banks[0]?.questionCount, 3);
  assert.deepEqual(response.questions.banks[0]?.chapters, [{ id: 'chapter-1', title: '第一章', questionCount: 3 }]);
  assert.equal('content' in (response.flashcards.materials[0] ?? {}), false);
  assert.ok(database.writes.length >= 1);
});

test('课程工作台汇总收藏题会话并允许作为最近学习继续', async () => {
  const service = createReviewWorkspaceService({ database: new FakeWorkspaceDatabase(true) });
  const response = await service.getWorkspace({ courseId: 'course-1', subjectId: 'subject-1' });

  assert.deepEqual(response.questions.favorites, [{ subjectId: 'subject-1', questionCount: 1, inProgressCount: 1, latestSessionId: 'favorite-session-1', latestSessionMode: 'cram', latestSessionUpdatedAt: '2026-08-20T01:00:00.000Z' }]);
  assert.equal(response.questions.inProgressCount, 1);
  assert.deepEqual(response.continue, { kind: 'practice', courseId: 'course-1', subjectId: 'subject-1', questionBankId: null, questionBankName: '收藏题', sessionId: 'favorite-session-1', mode: 'cram', source: 'favorite', updatedAt: '2026-08-20T01:00:00.000Z' });
});
