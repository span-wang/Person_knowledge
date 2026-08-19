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
