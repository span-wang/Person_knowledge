import assert from 'node:assert/strict';
import test from 'node:test';
import { QuestionApiError, createQuestionService, type QuestionDatabase } from './question-service.js';

const noDatabase: QuestionDatabase = {
  async execute() { throw new Error('验证失败前不应访问数据库。'); },
  async getConnection() { throw new Error('验证失败前不应开启事务。'); },
};

const paragraph = (value: string) => [{ type: 'paragraph' as const, children: [{ type: 'text' as const, value }] }];

function baseQuestion() {
  return {
    questionBankId: 'bank-1',
    questionChapterId: 'chapter-1',
    stem: paragraph('题干'),
    type: 'single' as const,
    options: [{ key: 'A', content: paragraph('甲') }, { key: 'B', content: paragraph('乙') }],
    answer: ['A'],
    analysis: null,
    knowledgePoints: [],
  };
}

class FakeQuestionReviewNoteDatabase implements QuestionDatabase {
  note: { question_id: string; note_text: string; ink_json: string; updated_at: string } | null = null;

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    if (lower.startsWith('select id, question_bank_id, question_chapter_id, sort_order from questions')) {
      return [[{ id: String(values[0]), question_bank_id: 'bank-1', question_chapter_id: 'chapter-1', sort_order: 0 }], []];
    }
    if (lower.startsWith('select question_id, note_text, ink_json, updated_at')) return [this.note ? [this.note] : [], []];
    if (lower.startsWith('insert into question_review_notes')) {
      this.note = { question_id: String(values[0]), note_text: String(values[1]), ink_json: String(values[2]), updated_at: '2026-08-20T00:00:00.000Z' };
      return [[], []];
    }
    if (lower.startsWith('delete from question_review_notes')) {
      this.note = null;
      return [[], []];
    }
    throw new Error(`未处理 SQL: ${normalized}`);
  }

  async getConnection() {
    return {
      execute: (sql: string, values?: readonly unknown[]) => this.execute(sql, values),
      beginTransaction: async () => undefined,
      commit: async () => undefined,
      rollback: async () => undefined,
      release: () => undefined,
    };
  }
}

test('题目保存拒绝跳号选项和不匹配答案', async () => {
  const service = createQuestionService({ database: noDatabase });
  await assert.rejects(
    () => service.create({ ...baseQuestion(), options: [{ key: 'A', content: paragraph('甲') }, { key: 'C', content: paragraph('丙') }] }),
    (error: unknown) => error instanceof QuestionApiError && error.statusCode === 400 && error.message.includes('连续'),
  );
  await assert.rejects(
    () => service.create({ ...baseQuestion(), answer: ['C'] }),
    (error: unknown) => error instanceof QuestionApiError && error.statusCode === 400 && error.message.includes('答案'),
  );
});

test('判断题保存拒绝自定义选项', async () => {
  const service = createQuestionService({ database: noDatabase });
  await assert.rejects(
    () => service.create({ ...baseQuestion(), type: 'true_false', options: [{ key: 'A', content: paragraph('是') }, { key: 'B', content: paragraph('否') }], answer: ['A'] }),
    (error: unknown) => error instanceof QuestionApiError && error.statusCode === 400 && error.message.includes('判断题'),
  );
});

test('应用内保存允许超过 255 个字符的题干', async () => {
  const service = createQuestionService({ database: noDatabase });
  await assert.rejects(
    () => service.create({ ...baseQuestion(), stem: paragraph('题'.repeat(256)) }),
    /验证失败前不应开启事务/,
  );
});

test('题目备注支持文字与手写笔迹的合并更新', async () => {
  const database = new FakeQuestionReviewNoteDatabase();
  const service = createQuestionService({ database });
  const saved = await service.setReviewNote('question-1', { noteText: '  易错点  ', strokes: [{ points: [{ x: 1.4, y: 2.6 }] }] });
  assert.equal(saved?.noteText, '易错点');
  assert.deepEqual(saved?.strokes, [{ points: [{ x: 1, y: 3 }] }]);
  const textOnly = await service.setReviewNote('question-1', { noteText: '更新文字' });
  assert.equal(textOnly?.noteText, '更新文字');
  assert.deepEqual(textOnly?.strokes, [{ points: [{ x: 1, y: 3 }] }]);
  assert.deepEqual(await service.getReviewNote('question-1'), textOnly);
  assert.equal(await service.setReviewNote('question-1', { noteText: '', strokes: [] }), null);
});
