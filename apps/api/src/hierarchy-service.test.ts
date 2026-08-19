import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HierarchyApiError,
  createHierarchyService,
  type HierarchyDatabase,
  type HierarchySqlConnection,
} from './hierarchy-service.js';

class FakeHierarchyDatabase implements HierarchyDatabase, HierarchySqlConnection {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    this.statements.push({ sql, values });
    if (sql.includes('FROM materials AS m')) {
      return [[
        {
          material_id: 'material-1', material_name: '资料一',
          chapter_id: 'chapter-1', chapter_title: '第一章', chapter_sort_order: 0,
          section_id: 'section-1', section_title: '第一节', section_sort_order: 0,
          card_id: 'card-1', card_title: '闪卡一', card_sort_order: 0,
        },
        {
          material_id: 'material-1', material_name: '资料一',
          chapter_id: 'chapter-1', chapter_title: '第一章', chapter_sort_order: 0,
          section_id: 'section-1', section_title: '第一节', section_sort_order: 0,
          card_id: 'card-2', card_title: '闪卡二', card_sort_order: 1,
        },
      ], []];
    }
    if (sql.includes('SELECT id FROM materials')) {
      return [[{ id: 'material-1' }], []];
    }
    if (sql.includes('SELECT id FROM chapters') && sql.includes('LIMIT 1')) {
      return [[{ id: 'chapter-1' }], []];
    }
    if (sql.includes('SELECT COALESCE(MAX(sort_order)')) {
      return [[{ next_order: 2 }], []];
    }
    if (sql.includes('material_id AS parent_id') && sql.includes('FROM chapters WHERE id = ?')) {
      return [[{ id: 'chapter-1', title: '第一章', parent_id: 'material-1', sort_order: 0 }], []];
    }
    if (sql.includes('SELECT id, title, chapter_id AS parent_id')) {
      return [[{ id: 'section-1', title: '第一节', parent_id: 'chapter-1', sort_order: 0 }], []];
    }
    if (sql.includes('FROM cards AS c INNER JOIN sections AS s')) {
      return [[{ id: 'card-1', title: '闪卡一', parent_id: 'section-1', sort_order: 0 }], []];
    }
    return [[], []];
  }

  async getConnection(): Promise<HierarchySqlConnection> {
    return this;
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

test('资料树按资料、章、节和闪卡的顺序返回', async () => {
  const service = createHierarchyService({ database: new FakeHierarchyDatabase() });

  const hierarchy = await service.list();

  assert.deepEqual(hierarchy.materials, [{
    id: 'material-1',
    name: '资料一',
    chapters: [{
      id: 'chapter-1',
      title: '第一章',
      sortOrder: 0,
      sections: [{
        id: 'section-1',
        title: '第一节',
        sortOrder: 0,
        cards: [
          { id: 'card-1', title: '闪卡一', sortOrder: 0 },
          { id: 'card-2', title: '闪卡二', sortOrder: 1 },
        ],
      }],
    }],
  }]);
});

test('新增章节使用父资料的末尾排序位置', async () => {
  const database = new FakeHierarchyDatabase();
  const service = createHierarchyService({ database });

  await service.create({ entityType: 'chapter', parentId: 'material-1', title: '新增章节' });

  const insert = database.statements.find((statement) => statement.sql.includes('INSERT INTO chapters'));
  assert.ok(insert);
  assert.deepEqual(insert.values.slice(1), ['material-1', '新增章节', 2]);
});

test('删除章节会级联标记下级内容并逐项写入回收站', async () => {
  const database = new FakeHierarchyDatabase();
  const service = createHierarchyService({ database });

  await service.softDelete('chapter', 'chapter-1');

  const trashWrites = database.statements.filter((statement) => statement.sql.includes('INSERT INTO trash_items'));
  assert.equal(trashWrites.length, 3);
  assert.deepEqual(trashWrites.map((statement) => statement.values[1]), ['chapter', 'section', 'card']);
  assert.ok(database.statements.some((statement) => statement.sql.includes('UPDATE chapters SET deleted_at')));
  assert.ok(database.statements.some((statement) => statement.sql.includes('UPDATE sections SET deleted_at')));
  assert.ok(database.statements.some((statement) => statement.sql.includes('UPDATE cards SET deleted_at')));
});

test('空标题在写入前被拒绝', async () => {
  const service = createHierarchyService({ database: new FakeHierarchyDatabase() });

  await assert.rejects(
    service.create({ entityType: 'section', parentId: 'chapter-1', title: '  ' }),
    (error: unknown) => error instanceof HierarchyApiError && error.statusCode === 400,
  );
});
