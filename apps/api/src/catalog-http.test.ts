import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import {
  catalogCoursesPath,
  catalogMaterialsPath,
  catalogSubjectsPath,
  type CatalogCoursesResponse,
  type CatalogMaterialResponse,
} from '@knowledge-flashcards/shared';
import { createApp } from './app.js';
import { CatalogApiError, type CatalogService } from './catalog-service.js';

async function withServer<T>(run: (baseUrl: string) => Promise<T>, catalogService: CatalogService) {
  const server = createServer(createApp(new Date('2026-08-11T00:00:00.000Z'), { catalogService }));
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

function serviceFixture(onCreateSubject?: (courseId: string, name: string) => void): CatalogService {
  const courses: CatalogCoursesResponse = {
    courses: [{ id: 'course-1', name: '课程一', sortOrder: 0, isSystem: false, subjectCount: 1 }],
  };
  const materialResponse: CatalogMaterialResponse = {
    material: {
      id: 'material-1', courseId: 'course-1', subjectId: 'subject-1', name: '资料一', cardCount: 0, cover: null,
      chapters: [],
      masteryDistribution: { mastered: 0, familiar: 0, effort: 0, unassessed: 0 },
      statusTrend: [],
    },
  };
  return {
    listCourses: async () => courses,
    listCourseSubjects: async () => ({ course: courses.courses[0]!, subjects: [] }),
    getSubject: async (subjectId) => {
      if (subjectId === 'missing') throw new CatalogApiError(404, '科目不存在或已删除。');
      return { course: courses.courses[0]!, subject: { id: subjectId, courseId: 'course-1', name: '科目一', sortOrder: 0, isSystem: false, materialCount: 0 }, materials: [] };
    },
    getMaterial: async (materialId) => {
      if (materialId === 'missing') throw new CatalogApiError(404, '资料不存在或已删除。');
      return { material: { ...materialResponse.material, id: materialId } };
    },
    renameMaterial: async (materialId, request) => ({ material: { ...materialResponse.material, id: materialId, name: request.name } }),
    replaceMaterialCover: async () => ({
      id: 'cover-1',
      original: { id: 'original-1', mimeType: 'image/png', width: 800, height: 600, sha256: 'a'.repeat(64) },
      thumbnail: { id: 'thumbnail-1', mimeType: 'image/webp', width: 512, height: 384, sha256: 'b'.repeat(64) },
    }),
    removeMaterialCover: async () => undefined,
    createCourse: async () => courses,
    renameCourse: async () => courses,
    reorderCourse: async () => courses,
    removeCourse: async () => courses,
    createSubject: async (request) => {
      onCreateSubject?.(request.courseId, request.name);
      return courses;
    },
    renameSubject: async () => courses,
    moveSubject: async () => courses,
    reorderSubject: async () => courses,
    removeSubject: async () => courses,
  };
}

test('目录 API 返回课程并将科目写入请求交给服务', async () => {
  const creates: Array<{ courseId: string; name: string }> = [];
  await withServer(async (baseUrl) => {
    const courses = await fetch(`${baseUrl}${catalogCoursesPath}`);
    assert.equal(courses.status, 200);
    assert.equal((await courses.json() as CatalogCoursesResponse).courses[0]?.name, '课程一');

    const material = await fetch(`${baseUrl}${catalogMaterialsPath}/material-1`);
    assert.equal(material.status, 200);
    assert.equal((await material.json() as CatalogMaterialResponse).material.statusTrend.length, 0);

    const created = await fetch(`${baseUrl}${catalogSubjectsPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ courseId: 'course-1', name: '新增科目' }),
    });
    assert.equal(created.status, 201);
  }, serviceFixture((courseId, name) => creates.push({ courseId, name })));

  assert.deepEqual(creates, [{ courseId: 'course-1', name: '新增科目' }]);
});

test('目录 API 传递可识别的服务错误', async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}${catalogSubjectsPath}/missing`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: '科目不存在或已删除。' });

    const missingMaterial = await fetch(`${baseUrl}${catalogMaterialsPath}/missing`);
    assert.equal(missingMaterial.status, 404);
    assert.deepEqual(await missingMaterial.json(), { error: '资料不存在或已删除。' });
  }, serviceFixture());
});

test('资料目录 API 支持改名、封面上传和移除', async () => {
  await withServer(async (baseUrl) => {
    const renamed = await fetch(`${baseUrl}${catalogMaterialsPath}/material-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '改名资料' }),
    });
    assert.equal(renamed.status, 200);
    assert.equal((await renamed.json() as CatalogMaterialResponse).material.name, '改名资料');

    const uploaded = await fetch(`${baseUrl}${catalogMaterialsPath}/material-1/cover`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    });
    assert.equal(uploaded.status, 201);
    assert.equal((await uploaded.json() as { cover: { thumbnail: { mimeType: string } } }).cover.thumbnail.mimeType, 'image/webp');

    const removed = await fetch(`${baseUrl}${catalogMaterialsPath}/material-1/cover`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
  }, serviceFixture());
});
