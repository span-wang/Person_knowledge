import type {
  GlobalSearchContentType,
  GlobalSearchFilters,
  GlobalSearchResponse,
  GlobalSearchResult,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

const resultLimitPerType = 20;
const maxQueryLength = 120;
const searchTypes = new Set<GlobalSearchContentType>(['material', 'card', 'question']);

export interface GlobalSearchSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface GlobalSearchService {
  search(filters: GlobalSearchFilters): Promise<GlobalSearchResponse>;
}

export class GlobalSearchApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'GlobalSearchApiError';
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

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function nodeText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (value.type === 'image') return typeof value.alt === 'string' ? value.alt : '';
  if (value.type === 'math' || value.type === 'inlineMath') return typeof value.value === 'string' ? value.value : '';
  if (value.type === 'break') return ' ';
  if (Array.isArray(value.children)) return value.children.map(nodeText).join(value.type === 'tableRow' ? ' ' : '');
  return typeof value.value === 'string' ? value.value : '';
}

function contentText(value: unknown): string {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return '';
  return parsed.map(nodeText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function normalizedId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new GlobalSearchApiError(400, `${label}无效。`);
  }
  return value.trim();
}

function normalizedFilters(filters: GlobalSearchFilters) {
  if (!isRecord(filters)) throw new GlobalSearchApiError(400, '检索条件无效。');
  if (typeof filters.query !== 'string') throw new GlobalSearchApiError(400, '检索词无效。');
  const query = filters.query.trim().replace(/\s+/g, ' ');
  if (Array.from(query).length < 2 || query.length > maxQueryLength) {
    throw new GlobalSearchApiError(400, `检索词需要 2 到 ${maxQueryLength} 个字符。`);
  }
  const terms = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (!terms.length) throw new GlobalSearchApiError(400, '检索词无效。');
  const types = filters.types === undefined ? [...searchTypes] : filters.types;
  if (!Array.isArray(types) || types.length === 0 || types.some((type) => !searchTypes.has(type))) {
    throw new GlobalSearchApiError(400, '内容类型无效。');
  }
  return {
    query,
    matchQuery: terms.map((term) => `+${term}*`).join(' '),
    courseId: normalizedId(filters.courseId, '课程标识'),
    subjectId: normalizedId(filters.subjectId, '科目标识'),
    types: [...new Set(types)],
  };
}

function searchConstraints(courseId: string | undefined, subjectId: string | undefined) {
  const clauses: string[] = [];
  const values: unknown[] = [];
  if (courseId) {
    clauses.push('co.id = ?');
    values.push(courseId);
  }
  if (subjectId) {
    clauses.push('su.id = ?');
    values.push(subjectId);
  }
  return { clause: clauses.length ? ` AND ${clauses.join(' AND ')}` : '', values };
}

function snippet(value: string, query: string): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const index = text.toLocaleLowerCase('zh-CN').indexOf(query.toLocaleLowerCase('zh-CN'));
  const start = index > 44 ? index - 44 : 0;
  const end = Math.min(text.length, start + 160);
  return `${start > 0 ? '...' : ''}${text.slice(start, end)}${end < text.length ? '...' : ''}`;
}

function materialResult(row: Record<string, unknown>): GlobalSearchResult {
  const cardCount = numberValue(row.card_count);
  return {
    type: 'material', id: textValue(row.material_id), title: textValue(row.material_name),
    summary: cardCount > 0 ? `${cardCount} 张闪卡` : '资料',
    course: { id: textValue(row.course_id), name: textValue(row.course_name) },
    subject: { id: textValue(row.subject_id), name: textValue(row.subject_name) },
    materialId: textValue(row.material_id), cardId: null, questionBankId: null, questionId: null,
  };
}

function cardResult(row: Record<string, unknown>, query: string): GlobalSearchResult {
  const body = contentText(row.content_json);
  return {
    type: 'card', id: textValue(row.card_id), title: textValue(row.card_title),
    summary: snippet(body, query),
    course: { id: textValue(row.course_id), name: textValue(row.course_name) },
    subject: { id: textValue(row.subject_id), name: textValue(row.subject_name) },
    materialId: textValue(row.material_id), cardId: textValue(row.card_id), questionBankId: null, questionId: null,
  };
}

function questionResult(row: Record<string, unknown>, query: string): GlobalSearchResult {
  const stem = contentText(row.stem_json);
  return {
    type: 'question', id: textValue(row.question_id), title: snippet(stem, query) || '题目',
    summary: [textValue(row.question_bank_name), textValue(row.question_chapter_title)].filter(Boolean).join(' · '),
    course: { id: textValue(row.course_id), name: textValue(row.course_name) },
    subject: { id: textValue(row.subject_id), name: textValue(row.subject_name) },
    materialId: null, cardId: null, questionBankId: textValue(row.question_bank_id), questionId: textValue(row.question_id),
  };
}

export class GlobalSearchServiceImpl implements GlobalSearchService {
  constructor(private readonly database: GlobalSearchSqlExecutor) {}

  async search(filters: GlobalSearchFilters): Promise<GlobalSearchResponse> {
    const normalized = normalizedFilters(filters);
    const constraints = searchConstraints(normalized.courseId, normalized.subjectId);
    const materialPromise = normalized.types.includes('material') ? this.database.execute(`
      SELECT m.id AS material_id, m.name AS material_name, co.id AS course_id, co.name AS course_name,
        su.id AS subject_id, su.name AS subject_name, COUNT(c.id) AS card_count,
        MATCH(m.name) AGAINST (? IN BOOLEAN MODE) AS score
      FROM materials AS m
      INNER JOIN subjects AS su ON su.id = m.subject_id AND su.deleted_at IS NULL
      INNER JOIN courses AS co ON co.id = su.course_id AND co.deleted_at IS NULL
      LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
      LEFT JOIN sections AS se ON se.chapter_id = ch.id AND se.deleted_at IS NULL
      LEFT JOIN cards AS c ON c.section_id = se.id AND c.deleted_at IS NULL
      WHERE m.deleted_at IS NULL${constraints.clause} AND MATCH(m.name) AGAINST (? IN BOOLEAN MODE)
      GROUP BY m.id, m.name, m.imported_at, co.id, co.name, su.id, su.name
      ORDER BY score DESC, m.imported_at DESC, m.id
      LIMIT ${resultLimitPerType}
    `, [normalized.matchQuery, ...constraints.values, normalized.matchQuery]) : Promise.resolve([[], []] as [unknown, unknown]);
    const cardPromise = normalized.types.includes('card') ? this.database.execute(`
      SELECT c.id AS card_id, c.title AS card_title, c.content_json, m.id AS material_id,
        co.id AS course_id, co.name AS course_name, su.id AS subject_id, su.name AS subject_name,
        MATCH(c.title, c.search_text) AGAINST (? IN BOOLEAN MODE) AS score
      FROM cards AS c
      INNER JOIN sections AS se ON se.id = c.section_id AND se.deleted_at IS NULL
      INNER JOIN chapters AS ch ON ch.id = se.chapter_id AND ch.deleted_at IS NULL
      INNER JOIN materials AS m ON m.id = ch.material_id AND m.deleted_at IS NULL
      INNER JOIN subjects AS su ON su.id = m.subject_id AND su.deleted_at IS NULL
      INNER JOIN courses AS co ON co.id = su.course_id AND co.deleted_at IS NULL
      WHERE c.deleted_at IS NULL${constraints.clause} AND MATCH(c.title, c.search_text) AGAINST (? IN BOOLEAN MODE)
      ORDER BY score DESC, m.imported_at DESC, ch.sort_order, se.sort_order, c.sort_order, c.id
      LIMIT ${resultLimitPerType}
    `, [normalized.matchQuery, ...constraints.values, normalized.matchQuery]) : Promise.resolve([[], []] as [unknown, unknown]);
    const questionPromise = normalized.types.includes('question') ? this.database.execute(`
      SELECT q.id AS question_id, q.stem_json, qb.id AS question_bank_id, qb.name AS question_bank_name,
        qc.title AS question_chapter_title, co.id AS course_id, co.name AS course_name,
        su.id AS subject_id, su.name AS subject_name,
        MATCH(q.stem_search_text) AGAINST (? IN BOOLEAN MODE) AS score
      FROM questions AS q
      INNER JOIN question_banks AS qb ON qb.id = q.question_bank_id AND qb.deleted_at IS NULL
      LEFT JOIN question_chapters AS qc ON qc.id = q.question_chapter_id AND qc.deleted_at IS NULL
      INNER JOIN subjects AS su ON su.id = qb.subject_id AND su.deleted_at IS NULL
      INNER JOIN courses AS co ON co.id = su.course_id AND co.deleted_at IS NULL
      WHERE q.deleted_at IS NULL${constraints.clause} AND MATCH(q.stem_search_text) AGAINST (? IN BOOLEAN MODE)
      ORDER BY score DESC, qb.sort_order, qc.sort_order, q.sort_order, q.id
      LIMIT ${resultLimitPerType}
    `, [normalized.matchQuery, ...constraints.values, normalized.matchQuery]) : Promise.resolve([[], []] as [unknown, unknown]);

    const [materialRows, cardRows, questionRows] = await Promise.all([materialPromise, cardPromise, questionPromise]);
    const results = [
      ...rowsFrom(materialRows[0]).map(materialResult),
      ...rowsFrom(cardRows[0]).map((row) => cardResult(row, normalized.query)),
      ...rowsFrom(questionRows[0]).map((row) => questionResult(row, normalized.query)),
    ];
    return { query: normalized.query, resultLimitPerType, results };
  }
}

export function createGlobalSearchService(options: { database?: GlobalSearchSqlExecutor } = {}): GlobalSearchService {
  if (options.database) {
    return new GlobalSearchServiceImpl(options.database);
  }
  const pool = createDatabasePool();
  const database: GlobalSearchSqlExecutor = {
    execute: (sql: string, values?: readonly unknown[]) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
  };
  return new GlobalSearchServiceImpl(database);
}
