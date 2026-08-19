import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReviewDatabase, ReviewSqlConnection, ReviewSqlExecutor } from './review-service.js';
import { ReviewApiError, ReviewServiceImpl } from './review-service.js';

class FakeReviewDatabase implements ReviewSqlExecutor {
  readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];

  async execute(sql: string, values: readonly unknown[] = []) {
    this.statements.push({ sql, values });
    if (sql.includes('COUNT(DISTINCT m.id)')) {
      return [[{
        material_count: '1',
        card_count: '3',
        unassessed_count: '1',
        effort_count: '1',
      }], []];
    }
    if (sql.includes('GROUP BY m.id, m.name')) {
      return [[
        {
          material_id: 'material-1',
          material_name: '资料一',
          card_count: '3',
          mastered_count: '0',
          familiar_count: '1',
          unassessed_count: '1',
          effort_count: '1',
        },
      ], []];
    }
    if (sql.includes('app_settings AS setting')) {
      return [[{
        card_id: 'card-2',
        card_title: '最近闪卡',
        material_id: 'material-1',
        material_name: '资料一',
        chapter_title: '第二章',
        section_title: '第二节',
        content_json: JSON.stringify([{ type: 'paragraph', children: [{ type: 'text', value: '最近正文' }] }]),
      }], []];
    }
    if (sql.includes('ORDER BY m.created_at DESC')) {
      return [[{
        card_id: 'card-1',
        card_title: '首张闪卡',
        material_id: 'material-1',
        material_name: '资料一',
        chapter_title: '第一章',
        section_title: '第一节',
        content_json: [{ type: 'paragraph', children: [{ type: 'text', value: '首张正文' }] }],
      }], []];
    }
    if (sql.includes('WHERE c.id = ?')) {
      const cardId = String(values[0]);
      return [[{
        card_id: cardId,
        card_title: cardId === 'card-1' ? '首张闪卡' : '最近闪卡',
        material_id: 'material-1',
        material_name: '资料一',
        chapter_title: cardId === 'card-1' ? '第一章' : '第二章',
        section_title: cardId === 'card-1' ? '第一节' : '第二节',
        content_json: [{ type: 'paragraph', children: [{ type: 'text', value: cardId === 'card-1' ? '首张正文' : '最近正文' }] }],
      }], []];
    }
    return [[], []];
  }
}

test('复习面板返回数量、资料进度和每份资料的上次闪卡', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  const dashboard = await service.dashboard();

  assert.deepEqual(dashboard.counts, {
    materialCount: 1,
    cardCount: 3,
    unassessedCount: 1,
    effortCount: 1,
  });
  assert.equal(dashboard.materials[0]?.id, 'material-1');
  assert.equal(dashboard.materials[0]?.cardCount, 3);
  assert.equal(dashboard.materials[0]?.masteredCount, 0);
  assert.equal(dashboard.materials[0]?.familiarCount, 1);
  assert.equal(dashboard.materials[0]?.unassessedCount, 1);
  assert.equal(dashboard.materials[0]?.effortCount, 1);
  assert.equal(dashboard.materials[0]?.continueCard?.id, 'card-2');
  assert.equal(dashboard.materials[0]?.continueCard?.bodyText, '最近正文');
});

test('复习入口返回首张闪卡并按资料保存最后位置', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  const result = await service.start('effort', 'material-1');

  assert.equal(result.card.id, 'card-1');
  assert.equal(result.card.bodyText, '首张正文');
  const save = database.statements.find((statement) => statement.sql.includes('JSON_SET(setting_value'));
  assert.deepEqual(save?.values, ['review.lastCards', 'material-1', 'card-1', 'material-1', 'card-1']);
});

test('资料和掌握状态筛选返回稳定结果集和当前卡片位置', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  const result = await service.listCards({
    materialId: 'material-1',
    statuses: ['mastered', 'effort'],
  }, 'card-1');

  assert.equal(result.currentIndex, 0);
  assert.equal(result.cards[0]?.id, 'card-1');
  const query = database.statements.find((statement) => statement.sql.includes('c.mastery_status IN'));
  assert.match(query?.sql ?? '', /c\.mastery_status IN \(\?, \?\)/);
  assert.doesNotMatch(query?.sql ?? '', /content_json|ai_explanations|review_records/);
  assert.deepEqual(query?.values, ['material-1', 'mastered', 'effort']);
});

test('无效掌握状态会被拒绝', async () => {
  const service = new ReviewServiceImpl({ database: new FakeReviewDatabase() });

  await assert.rejects(
    service.listCards({ statuses: ['invalid' as 'mastered'] }),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 400,
  );
});

test('复习闪卡只返回允许的富内容节点和安全链接', async () => {
  const database = new FakeReviewDatabase();
  database.execute = async (sql, values = []) => {
    database.statements.push({ sql, values });
    if (sql.includes('WITH ordered_cards')) {
      return [[{
        card_id: 'card-1',
        previous_card_id: null,
        next_card_id: null,
        current_index: 0,
        total: 1,
      }], []];
    }
    if (sql.includes('WHERE c.id = ?')) {
      return [[{
        card_id: 'card-1',
        material_id: 'material-1',
        card_title: '富内容闪卡',
        material_name: '资料一',
        chapter_title: '第一章',
        section_title: '第一节',
        content_json: [
          { type: 'paragraph', children: [{ type: 'text', value: '安全正文' }] },
          { type: 'html', value: '<script>alert(1)</script>' },
          { type: 'link', url: 'javascript:alert(1)', children: [{ type: 'text', value: '危险链接' }] },
          { type: 'math', value: 'E = mc^2', display: true },
          { type: 'image', resourceId: 'resource-1', resourcePath: 'material-1/images/example.png', alt: '示例图' },
        ],
      }], []];
    }
    return [[], []];
  };
  const service = new ReviewServiceImpl({ database });

  const result = await service.getCard('card-1');

  assert.deepEqual(result.card.content?.map((node) => node.type), ['paragraph', 'link', 'math', 'image']);
  assert.equal(result.card.content?.[1]?.url, undefined);
  assert.equal(result.card.content?.[3]?.resourceId, 'resource-1');
});

test('不存在的闪卡返回可识别错误', async () => {
  const database = new FakeReviewDatabase();
  database.execute = async (sql, values = []) => {
    database.statements.push({ sql, values });
    return [[], []];
  };
  const service = new ReviewServiceImpl({ database });

  await assert.rejects(
    service.getCard('missing-card'),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 404,
  );
});

test('打开闪卡会记录首次查看、最近查看和查看次数', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  await service.getCard('card-2');

  const recordView = database.statements.find((statement) =>
    statement.sql.includes('INSERT INTO review_records (card_id, first_viewed_at, last_viewed_at, view_count)'),
  );
  assert.deepEqual(recordView?.values, ['card-2']);
  assert.match(recordView?.sql ?? '', /view_count = view_count \+ 1/);
});

test('打开闪卡不会为响应重复查询同一张卡', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  await service.getCard('card-2');

  assert.equal(
    database.statements.filter((statement) => statement.sql.includes('c.content_json') && statement.sql.includes('WHERE c.id = ?')).length,
    1,
  );
});

test('更新掌握状态会保存状态历史并返回新状态', async () => {
  class StatusReviewDatabase implements ReviewDatabase, ReviewSqlConnection {
    readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    masteryStatus = 'unassessed';

    async getConnection() {
      return this;
    }

    async beginTransaction() {}
    async commit() {}
    async rollback() {}
    release() {}

    async execute(sql: string, values: readonly unknown[] = []) {
      this.statements.push({ sql, values });
      if (sql.includes('WITH ordered_cards')) {
        return [[{
          card_id: 'card-1',
          previous_card_id: null,
          next_card_id: null,
          current_index: 0,
          total: 1,
        }], []];
      }
      if (sql.includes('UPDATE cards AS c')) {
        this.masteryStatus = String(values[0]);
        return [[], []];
      }
      if (sql.includes('WHERE c.id = ?')) {
        return [[{
          card_id: 'card-1',
          material_id: 'material-1',
          card_title: '状态闪卡',
          material_name: '资料一',
          chapter_title: '第一章',
          section_title: '第一节',
          mastery_status: this.masteryStatus,
          content_json: [],
        }], []];
      }
      return [[], []];
    }
  }

  const database = new StatusReviewDatabase();
  const service = new ReviewServiceImpl({ database });
  const result = await service.updateStatus('card-1', 'mastered');

  assert.equal(result.card.masteryStatus, 'mastered');
  const update = database.statements.find((statement) => statement.sql.includes('UPDATE cards AS c'));
  const statusRecord = database.statements.find((statement) =>
    statement.sql.includes('INSERT INTO review_records (card_id, status_changed_at)'),
  );
  const history = database.statements.find((statement) =>
    statement.sql.includes('INSERT INTO review_status_history'),
  );
  assert.deepEqual(update?.values, ['mastered', 'card-1']);
  assert.deepEqual(statusRecord?.values, ['card-1']);
  assert.deepEqual(history?.values.slice(1), ['card-1', 'unassessed', 'mastered']);

  await service.updateStatus('card-1', 'mastered');
  assert.equal(database.statements.filter((statement) => statement.sql.includes('INSERT INTO review_status_history')).length, 1);
});

test('更新状态会拒绝不存在闪卡和非法状态', async () => {
  const database = new FakeReviewDatabase();
  database.execute = async (sql, values = []) => {
    database.statements.push({ sql, values });
    return [[], []];
  };
  const service = new ReviewServiceImpl({ database });

  await assert.rejects(
    service.updateStatus('missing-card', 'mastered'),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 404,
  );
  await assert.rejects(
    service.updateStatus('card-1', 'invalid' as 'mastered'),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 400,
  );
});

test('高亮只保存有效的文本或公式锚点，重复锚点不会重复写入', async () => {
  class HighlightReviewDatabase extends FakeReviewDatabase {
    readonly highlights: Array<{ id: string; kind: string; anchor_json: string }> = [];

    override async execute(sql: string, values: readonly unknown[] = []) {
      this.statements.push({ sql, values });
      if (sql.includes('WITH ordered_cards')) {
        return [[{
          card_id: 'card-1',
          previous_card_id: null,
          next_card_id: null,
          current_index: 0,
          total: 1,
        }], []];
      }
      if (sql.includes('DELETE FROM highlights')) {
        const index = this.highlights.findIndex((highlight) => highlight.id === values[0]);
        if (index >= 0) {
          this.highlights.splice(index, 1);
        }
        return [[], []];
      }
      if (sql.includes('INSERT INTO highlights')) {
        this.highlights.push({
          id: String(values[0]),
          kind: String(values[2]),
          anchor_json: String(values[3]),
        });
        return [[], []];
      }
      if (sql.includes('FROM highlights')) {
        return [this.highlights, []];
      }
      if (sql.includes('WHERE c.id = ?')) {
        return [[{
          card_id: 'card-1',
          material_id: 'material-1',
          card_title: '高亮闪卡',
          material_name: '资料一',
          chapter_title: '第一章',
          section_title: '第一节',
          content_json: [
            { type: 'paragraph', children: [{ type: 'text', value: '示例文字' }] },
            { type: 'math', value: 'E = mc^2', display: true },
          ],
        }], []];
      }
      return super.execute(sql, values);
    }
  }

  const database = new HighlightReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  const text = await service.createHighlight('card-1', {
    kind: 'text',
    anchor: { nodePath: '0.0', start: 1, end: 3 },
  });
  const duplicate = await service.createHighlight('card-1', {
    kind: 'text',
    anchor: { nodePath: '0.0', start: 1, end: 3 },
  });
  const formula = await service.createHighlight('card-1', {
    kind: 'formula',
    anchor: { nodePath: '1' },
  });

  assert.equal(text.highlight.kind, 'text');
  assert.equal(duplicate.highlight.id, text.highlight.id);
  assert.equal(formula.highlight.kind, 'formula');
  assert.equal(database.statements.filter((statement) => statement.sql.includes('INSERT INTO highlights')).length, 2);

  await service.deleteHighlight('card-1', text.highlight.id);
  assert.equal(database.highlights.length, 1);
  database.highlights.push({
    id: 'stale-highlight',
    kind: 'text',
    anchor_json: JSON.stringify({ nodePath: '9.9', start: 0, end: 2 }),
  });
  const currentCard = await service.getCard('card-1');
  assert.deepEqual(currentCard.card.highlights?.map((highlight) => highlight.id), [formula.highlight.id]);
  await assert.rejects(
    service.createHighlight('card-1', {
      kind: 'text',
      anchor: { nodePath: '0.0', start: 4, end: 4 },
    }),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 400,
  );
  await assert.rejects(
    service.createHighlight('card-1', {
      kind: 'formula',
      anchor: { nodePath: '0.0' },
    }),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 400,
  );
});

test('可视化编辑会保留未改变节点的高亮并删除可能漂移的高亮', async () => {
  class ContentReviewDatabase implements ReviewDatabase, ReviewSqlConnection {
    readonly statements: Array<{ sql: string; values: readonly unknown[] }> = [];
    title = '编辑前标题';
    content = [
      { type: 'paragraph', children: [{ type: 'text', value: '保持不变' }] },
      { type: 'paragraph', children: [{ type: 'text', value: '需要修改' }] },
      { type: 'math', value: 'x + 1' },
      { type: 'table', children: [
        { type: 'tableRow', children: [
          { type: 'tableCell', children: [{ type: 'text', value: '左' }] },
          { type: 'tableCell', children: [{ type: 'text', value: '右' }] },
        ] },
      ] },
    ];
    highlights = [
      { id: 'keep', kind: 'text', anchor_json: JSON.stringify({ nodePath: '0.0', start: 0, end: 2 }) },
      { id: 'remove-text', kind: 'text', anchor_json: JSON.stringify({ nodePath: '1.0', start: 0, end: 2 }) },
      { id: 'remove-formula', kind: 'formula', anchor_json: JSON.stringify({ nodePath: '2' }) },
      { id: 'remove-corrupt', kind: 'text', anchor_json: 'not-json' },
    ];
    lock = { lock_token: 'lock-1', device_id: 'device-1' };

    async getConnection() {
      return this;
    }

    async beginTransaction() {}
    async commit() {}
    async rollback() {}
    release() {}

    async execute(sql: string, values: readonly unknown[] = []) {
      this.statements.push({ sql, values });
      if (sql.includes('FROM sync_locks')) {
        return [[this.lock], []] as [unknown, unknown];
      }
      if (sql.includes('DELETE FROM sync_locks') || sql.includes('UPDATE sync_locks')) {
        return [[], []] as [unknown, unknown];
      }
      if (sql.includes('DELETE FROM highlights')) {
        this.highlights = this.highlights.filter((highlight) => highlight.id !== values[0]);
        return [[], []] as [unknown, unknown];
      }
      if (sql.includes('FROM highlights')) {
        return [this.highlights, []] as [unknown, unknown];
      }
      if (sql.includes('UPDATE cards AS c')) {
        this.title = String(values[0]);
        this.content = JSON.parse(String(values[1])) as typeof this.content;
        return [[], []] as [unknown, unknown];
      }
      if (sql.includes('WHERE c.id = ?')) {
        return [[{
          card_id: 'card-1',
          card_title: this.title,
          material_name: '资料一',
          chapter_title: '第一章',
          section_title: '第一节',
          content_json: this.content,
        }], []] as [unknown, unknown];
      }
      return [[], []] as [unknown, unknown];
    }
  }

  const database = new ContentReviewDatabase();
  const service = new ReviewServiceImpl({ database });
  const result = await service.updateContent('card-1', {
    title: '编辑后标题',
    content: [
      { type: 'paragraph', children: [{ type: 'text', value: '保持不变' }] },
      { type: 'paragraph', children: [{ type: 'text', value: '已经修改' }] },
      { type: 'math', value: 'y + 1' },
      { type: 'table', children: [
        { type: 'tableRow', children: [
          { type: 'tableCell', colSpan: 2, children: [{ type: 'text', value: '合并后' }] },
        ] },
      ] },
    ],
  }, { deviceId: 'device-1', lockToken: 'lock-1' });

  assert.equal(result.card.title, '编辑后标题');
  assert.equal(result.invalidatedHighlightCount, 3);
  assert.deepEqual(result.card.highlights?.map((highlight) => highlight.id), ['keep']);
  assert.deepEqual(database.highlights.map((highlight) => highlight.id), ['keep']);
  const savedTable = database.content.find((node) => node.type === 'table');
  assert.equal(savedTable?.children?.[0]?.children?.[0]?.colSpan, 2);
  assert.ok(database.statements.some((statement) => statement.sql.includes('FOR UPDATE')));
  assert.ok(database.statements.some((statement) => statement.sql.includes('FROM sync_locks')));
});

test('可视化编辑拒绝无效的合并单元格跨度', async () => {
  const database = new FakeReviewDatabase();
  const service = new ReviewServiceImpl({ database });

  await assert.rejects(
    service.updateContent('card-1', {
      title: '测试闪卡',
      content: [{ type: 'table', children: [{ type: 'tableRow', children: [{
        type: 'tableCell',
        colSpan: 0,
        children: [{ type: 'text', value: '' }],
      }] }] }],
    }, { deviceId: 'device-1', lockToken: 'lock-1' }),
    (error: unknown) => error instanceof ReviewApiError && error.statusCode === 400 && error.message === '表格列跨度无效。',
  );
});
