import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestionBankApiError, createQuestionBankService, type QuestionBankDatabase, type QuestionBankSqlConnection } from './question-bank-service.js';

class FakeQuestionBankDatabase implements QuestionBankDatabase, QuestionBankSqlConnection {
  readonly statements: string[] = [];
  banks = [{ id: 'bank-1', subject_id: 'subject-1', kind: 'chapter', name: '章节题', sort_order: 0 }];
  chapters = [{ id: 'chapter-1', question_bank_id: 'bank-1', title: '第一章', sort_order: 0 }];
  questions: Array<{ id: string; question_bank_id: string; question_chapter_id: string | null; deleted_at: null }> = [];
  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.statements.push(`${sql} ${JSON.stringify(values)}`);
    if (sql.includes('FROM subjects AS s INNER JOIN courses')) return [[{ subject_id: 'subject-1', course_id: 'course-1', subject_name: '科目一', subject_sort_order: 0, subject_is_system: 0, material_count: 0, course_id_value: 'course-1', course_name: '课程一', course_sort_order: 0, course_is_system: 0, subject_count: 1 }], []];
    if (sql.includes('FROM question_banks AS b')) return [this.banks.map((bank) => ({ bank_id: bank.id, subject_id: bank.subject_id, kind: bank.kind, bank_name: bank.name, bank_sort_order: bank.sort_order, question_count: 0, chapter_count: this.chapters.filter((chapter) => chapter.question_bank_id === bank.id).length })), []];
    if (sql.includes('FROM question_chapters AS ch')) return [this.chapters.map((chapter) => ({ chapter_id: chapter.id, question_bank_id: chapter.question_bank_id, chapter_title: chapter.title, chapter_sort_order: chapter.sort_order, chapter_question_count: 0 })), []];
    if (sql.includes('SELECT id, subject_id, kind, name, sort_order FROM question_banks')) return [this.banks.filter((bank) => bank.id === values[0]), []];
    if (sql.includes('SELECT id, question_bank_id, title, sort_order FROM question_chapters')) return [this.chapters.filter((chapter) => chapter.id === values[0]), []];
    if (sql.includes('SELECT id FROM question_banks WHERE')) return [[], []];
    if (sql.includes('SELECT id FROM question_chapters WHERE')) return [[], []];
    if (sql.includes('SELECT id FROM questions WHERE question_chapter_id')) return [[], []];
    if (sql.includes('SELECT id FROM questions WHERE question_bank_id')) return [[], []];
    if (sql.includes('SELECT id FROM question_banks WHERE subject_id')) return [[], []];
    if (sql.includes('SELECT COALESCE(MAX(sort_order)') && sql.includes('question_banks')) return [[{ next_order: this.banks.length }], []];
    if (sql.includes('SELECT COALESCE(MAX(sort_order)') && sql.includes('question_chapters')) return [[{ next_order: this.chapters.length }], []];
    if (sql.includes('SELECT id FROM question_banks WHERE subject_id = ? AND kind')) return [[], []];
    return [[], []];
  }
  async getConnection() { return this; }
  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

test('题库目录按三类返回并包含章节计数', async () => {
  const service = createQuestionBankService({ database: new FakeQuestionBankDatabase() });
  const result = await service.getDirectory('subject-1');
  assert.equal(result.subject.name, '科目一');
  assert.equal(result.banks.chapter[0]?.chapters[0]?.title, '第一章');
  assert.deepEqual(result.banks.official, []);
});

test('新建题库和章节使用事务并拒绝非章节题库章节', async () => {
  const database = new FakeQuestionBankDatabase();
  const service = createQuestionBankService({ database });
  await service.createBank({ subjectId: 'subject-1', kind: 'official', name: '2026 真题' });
  assert.ok(database.statements.some((statement) => statement.includes('INSERT INTO question_banks')));
  await assert.rejects(() => service.createChapter({ questionBankId: 'bank-2', title: '无效章节' }), (error: unknown) => error instanceof QuestionBankApiError && error.statusCode === 404);
});

test('含题目的章节不能删除', async () => {
  const database = new FakeQuestionBankDatabase();
  database.questions.push({ id: 'q-1', question_bank_id: 'bank-1', question_chapter_id: 'chapter-1', deleted_at: null });
  const original = database.execute.bind(database);
  database.execute = async (sql, values = []) => sql.includes('SELECT id FROM questions WHERE question_chapter_id') ? [[{ id: 'q-1' }], []] : original(sql, values);
  const service = createQuestionBankService({ database });
  await assert.rejects(() => service.deleteChapter('chapter-1'), (error: unknown) => error instanceof QuestionBankApiError && error.statusCode === 409);
});
