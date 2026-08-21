import assert from 'node:assert/strict';
import test from 'node:test';
import { CardReviewNoteApiError, createCardReviewNoteService, type CardReviewNoteSqlExecutor } from './card-review-note-service.js';

class FakeCardReviewNoteDatabase implements CardReviewNoteSqlExecutor {
  note: { card_id: string; note_text: string; ink_json: string; updated_at: string } | null = null;
  writes: string[] = [];

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    if (lower.startsWith('select id from cards')) return [[{ id: String(values[0]) }], []];
    if (lower.startsWith('select card_id, note_text')) return [this.note ? [this.note] : [], []];
    if (lower.startsWith('delete from card_review_notes')) {
      this.writes.push(normalized);
      this.note = null;
      return [[], []];
    }
    if (lower.startsWith('insert into card_review_notes')) {
      this.writes.push(normalized);
      this.note = { card_id: String(values[0]), note_text: String(values[1]), ink_json: String(values[2]), updated_at: '2026-08-20T00:00:00.000Z' };
      return [[], []];
    }
    throw new Error(`未处理 SQL: ${normalized}`);
  }
}

test('闪卡备注支持文字和归一化手写笔迹，并可清除', async () => {
  const database = new FakeCardReviewNoteDatabase();
  const service = createCardReviewNoteService({ database });
  const saved = await service.set('card-1', { noteText: '  重点  ', strokes: [{ points: [{ x: 12.7, y: 34.2 }, { x: 20, y: 40 }] }] });
  assert.deepEqual(saved?.strokes, [{ points: [{ x: 13, y: 34 }, { x: 20, y: 40 }] }]);
  assert.equal(saved?.noteText, '重点');
  assert.deepEqual(await service.get('card-1'), saved);
  assert.equal(await service.set('card-1', { noteText: '', strokes: [] }), null);
  assert.ok(database.writes.some((sql) => sql.startsWith('DELETE FROM card_review_notes')));
});

test('闪卡备注拒绝越界坐标且不写入', async () => {
  const database = new FakeCardReviewNoteDatabase();
  const service = createCardReviewNoteService({ database });
  await assert.rejects(
    () => service.set('card-1', { noteText: '', strokes: [{ points: [{ x: 1001, y: 0 }] }] }),
    (error: unknown) => error instanceof CardReviewNoteApiError && error.statusCode === 400,
  );
  assert.equal(database.writes.length, 0);
});
