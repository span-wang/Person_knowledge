import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  reviewWorkspacePath,
  type ReviewWorkspaceResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import type { ReviewWorkspaceService } from './review-workspace-service.js';

async function withServer<T>(run: (baseUrl: string) => Promise<T>, reviewWorkspaceService: ReviewWorkspaceService) {
  const server = createServer(createApp(new Date('2026-08-19T00:00:00.000Z'), { reviewWorkspaceService }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

function fixture(): { service: ReviewWorkspaceService; updates: unknown[] } {
  const updates: unknown[] = [];
  const response: ReviewWorkspaceResponse = {
    context: { courseId: 'course-1', subjectId: null, mode: 'flashcards', expandedMaterialId: null },
    courses: [{ id: 'course-1', name: '课程一', isSystem: false, subjectCount: 1, materialCount: 1, flashcardCount: 2, questionBankCount: 1, questionCount: 3, hasContinue: false }],
    currentCourse: { id: 'course-1', name: '课程一', isSystem: false, subjectCount: 1, materialCount: 1, flashcardCount: 2, questionBankCount: 1, questionCount: 3, hasContinue: false },
    subjects: [{ id: 'subject-1', courseId: 'course-1', name: '科目一', isSystem: false, materialCount: 1, flashcardCount: 2, questionBankCount: 1, questionCount: 3 }],
    flashcards: { materialCount: 1, cardCount: 2, unassessedCount: 2, effortCount: 0, materials: [{ id: 'material-1', subjectId: 'subject-1', name: '资料一', cardCount: 2, masteredCount: 0, familiarCount: 0, effortCount: 0, unassessedCount: 2, lastCardId: null, lastCardTitle: null, lastViewedAt: null, cover: null }] },
    questions: { questionBankCount: 1, questionCount: 3, inProgressCount: 0, aggregateWrongCount: 0, banks: [{ id: 'bank-1', subjectId: 'subject-1', kind: 'chapter', name: '章节题', questionCount: 3, chapterCount: 1, inProgressCount: 0, latestSessionId: null, latestSessionMode: null, latestSessionUpdatedAt: null }] },
    continue: null,
  };
  return {
    updates,
    service: {
      getWorkspace: async () => response,
      updateContext: async (request) => { updates.push(request); return { ...response, context: request }; },
    },
  };
}

test('课程复习工作台 API 返回聚合摘要并持久化上下文更新', async () => {
  const { service, updates } = fixture();
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${reviewWorkspacePath}?subjectId=all`);
    assert.equal(response.status, 200);
    const body = await response.json() as ReviewWorkspaceResponse;
    assert.equal(body.currentCourse.name, '课程一');
    assert.equal(body.flashcards.materials[0]?.name, '资料一');
    assert.equal('content' in (body.flashcards.materials[0] ?? {}), false);

    const updated = await fetch(`${baseUrl}${reviewWorkspacePath}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: 'course-1', subjectId: 'subject-1', mode: 'questions', expandedMaterialId: 'material-1' }),
    });
    assert.equal(updated.status, 200);
    assert.equal((await updated.json() as ReviewWorkspaceResponse).context.mode, 'questions');
  }, service);
  assert.deepEqual(updates, [{ courseId: 'course-1', subjectId: 'subject-1', mode: 'questions', expandedMaterialId: 'material-1' }]);
});
