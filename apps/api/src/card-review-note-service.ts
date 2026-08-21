import type {
  CardReviewNote,
  CardReviewNoteUpdateRequest,
  HandwrittenPoint,
  HandwrittenStroke,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface CardReviewNoteSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface CardReviewNoteService {
  get(cardId: string): Promise<CardReviewNote | null>;
  set(cardId: string, request: CardReviewNoteUpdateRequest): Promise<CardReviewNote | null>;
}

export class CardReviewNoteApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'CardReviewNoteApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function dateValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : textValue(value);
}

function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new CardReviewNoteApiError(400, '闪卡标识无效。');
  }
  return value.trim();
}

export function normalizeHandwrittenStrokes(value: unknown, error: (message: string) => Error): HandwrittenStroke[] {
  if (!Array.isArray(value) || value.length > 200) {
    throw error('手写笔画数量无效。');
  }
  let pointCount = 0;
  const strokes = value.map((stroke) => {
    if (!isRecord(stroke) || !Array.isArray(stroke.points) || stroke.points.length === 0 || stroke.points.length > 1_000) {
      throw error('手写笔画无效。');
    }
    pointCount += stroke.points.length;
    if (pointCount > 10_000) {
      throw error('手写点数过多。');
    }
    return {
      points: stroke.points.map((point): HandwrittenPoint => {
        if (!isRecord(point) || typeof point.x !== 'number' || typeof point.y !== 'number' || !Number.isFinite(point.x) || !Number.isFinite(point.y) || point.x < 0 || point.x > 1_000 || point.y < 0 || point.y > 1_000) {
          throw error('手写坐标无效。');
        }
        return { x: Math.round(point.x), y: Math.round(point.y) };
      }),
    };
  });
  if (JSON.stringify(strokes).length > 256_000) {
    throw error('手写备注过大。');
  }
  return strokes;
}

function noteFromRow(row: Record<string, unknown>): CardReviewNote {
  let parsed: unknown = [];
  if (row.ink_json !== null && row.ink_json !== undefined) {
    if (typeof row.ink_json === 'string') {
      try {
        parsed = JSON.parse(row.ink_json) as unknown;
      } catch {
        throw new CardReviewNoteApiError(409, '已保存的闪卡手写备注已损坏。');
      }
    } else {
      parsed = row.ink_json;
    }
  }
  const strokes = normalizeHandwrittenStrokes(parsed, (message) => new CardReviewNoteApiError(409, `已保存的${message}`));
  return { cardId: textValue(row.card_id), noteText: textValue(row.note_text), strokes, updatedAt: dateValue(row.updated_at) };
}

async function activeCard(database: CardReviewNoteSqlExecutor, cardId: string) {
  const id = requiredId(cardId);
  const [rows] = await database.execute('SELECT id FROM cards WHERE id = ? AND deleted_at IS NULL LIMIT 1', [id]);
  if (!rowsFrom(rows).length) {
    throw new CardReviewNoteApiError(404, '闪卡不存在。');
  }
  return id;
}

export function createCardReviewNoteService(options: { database?: CardReviewNoteSqlExecutor } = {}): CardReviewNoteService {
  const database: CardReviewNoteSqlExecutor = options.database ?? createDatabasePool() as unknown as CardReviewNoteSqlExecutor;
  return {
    async get(cardId) {
      const id = await activeCard(database, cardId);
      const [rows] = await database.execute('SELECT card_id, note_text, ink_json, updated_at FROM card_review_notes WHERE card_id = ? LIMIT 1', [id]);
      const row = rowsFrom(rows)[0];
      return row ? noteFromRow(row) : null;
    },
    async set(cardId, request) {
      const id = await activeCard(database, cardId);
      if (!request || typeof request.noteText !== 'string' || request.noteText.length > 2_000) {
        throw new CardReviewNoteApiError(400, '文字备注不能超过 2000 个字符。');
      }
      const noteText = request.noteText.trim();
      const strokes = normalizeHandwrittenStrokes(request.strokes, (message) => new CardReviewNoteApiError(400, message));
      if (!noteText && strokes.length === 0) {
        await database.execute('DELETE FROM card_review_notes WHERE card_id = ?', [id]);
        return null;
      }
      await database.execute('INSERT INTO card_review_notes (card_id, note_text, ink_json) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE note_text = VALUES(note_text), ink_json = VALUES(ink_json), updated_at = CURRENT_TIMESTAMP(3)', [id, noteText, JSON.stringify(strokes)]);
      return this.get(id);
    },
  };
}
