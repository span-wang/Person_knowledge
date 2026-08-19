import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  type HierarchyChapter,
  type HierarchyCreateRequest,
  type HierarchyEntityType,
  type HierarchyMaterial,
  type HierarchyMoveRequest,
  type HierarchyReorderRequest,
  type HierarchyResponse,
  type HierarchySection,
  type HierarchySortDirection,
  type HierarchyTrashItem,
  type HierarchyTrashResponse,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';

export interface HierarchySqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface HierarchySqlConnection extends HierarchySqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface HierarchyDatabase extends HierarchySqlExecutor {
  getConnection(): Promise<HierarchySqlConnection>;
}

export interface HierarchyServiceOptions {
  database: HierarchyDatabase;
}

export class HierarchyApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'HierarchyApiError';
  }
}

export interface HierarchyService {
  list(): Promise<HierarchyResponse>;
  listTrash(): Promise<HierarchyTrashResponse>;
  create(request: HierarchyCreateRequest): Promise<HierarchyResponse>;
  rename(entityType: HierarchyEntityType, entityId: string, title: string): Promise<HierarchyResponse>;
  move(entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, request: HierarchyMoveRequest): Promise<HierarchyResponse>;
  reorder(entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, request: HierarchyReorderRequest): Promise<HierarchyResponse>;
  softDelete(entityType: HierarchyEntityType, entityId: string): Promise<HierarchyResponse>;
}

type ChildEntityType = Exclude<HierarchyEntityType, 'material'>;

const childTable = {
  chapter: { table: 'chapters', title: 'title', parent: 'material_id' },
  section: { table: 'sections', title: 'title', parent: 'chapter_id' },
  card: { table: 'cards', title: 'title', parent: 'section_id' },
} as const;

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
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return textValue(value);
}

function nullableDateValue(value: unknown): string | null {
  return value === null || value === undefined ? null : dateValue(value);
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) {
    throw new HierarchyApiError(400, `${label}无效。`);
  }
  return value.trim();
}

function requiredTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new HierarchyApiError(400, '标题无效。');
  }
  const title = value.trim();
  if (!title || title.length > 255) {
    throw new HierarchyApiError(400, '标题不能为空且不能超过 255 个字符。');
  }
  return title;
}

function readEntityType(value: unknown): ChildEntityType {
  if (value !== 'chapter' && value !== 'section' && value !== 'card') {
    throw new HierarchyApiError(400, '只支持章、节和闪卡。');
  }
  return value;
}

function readDirection(value: unknown): HierarchySortDirection {
  if (value !== 'up' && value !== 'down') {
    throw new HierarchyApiError(400, '排序方向无效。');
  }
  return value;
}

function entityName(entityType: HierarchyEntityType): string {
  return entityType === 'material' ? '资料' : entityType === 'chapter' ? '章' : entityType === 'section' ? '节' : '闪卡';
}

function entityRows(value: unknown, entityType: HierarchyEntityType) {
  return rowsFrom(value).map((row) => ({
    id: textValue(row.id),
    title: textValue(row.title ?? row.name),
    parentId: row.parent_id === null || row.parent_id === undefined ? null : textValue(row.parent_id),
    sortOrder: numberValue(row.sort_order),
  })).map((row) => ({ ...row, entityType }));
}

function buildHierarchy(rows: Array<Record<string, unknown>>): HierarchyResponse {
  const materials = new Map<string, HierarchyMaterial>();
  const chapters = new Map<string, HierarchyChapter>();
  const sections = new Map<string, HierarchySection>();

  for (const row of rows) {
    const materialId = textValue(row.material_id);
    let material = materials.get(materialId);
    if (!material) {
      material = { id: materialId, name: textValue(row.material_name), chapters: [] };
      materials.set(materialId, material);
    }

    const chapterId = textValue(row.chapter_id);
    if (chapterId) {
      let chapter = chapters.get(chapterId);
      if (!chapter) {
        chapter = { id: chapterId, title: textValue(row.chapter_title), sortOrder: numberValue(row.chapter_sort_order), sections: [] };
        chapters.set(chapterId, chapter);
        material.chapters.push(chapter);
      }

      const sectionId = textValue(row.section_id);
      if (sectionId) {
        let section = sections.get(sectionId);
        if (!section) {
          section = { id: sectionId, title: textValue(row.section_title), sortOrder: numberValue(row.section_sort_order), cards: [] };
          sections.set(sectionId, section);
          chapter.sections.push(section);
        }
        const cardId = textValue(row.card_id);
        if (cardId) {
          section.cards.push({
            id: cardId,
            title: textValue(row.card_title),
            sortOrder: numberValue(row.card_sort_order),
          });
        }
      }
    }
  }

  return { materials: [...materials.values()] };
}

const hierarchySelect = `
  SELECT
    m.id AS material_id, m.name AS material_name,
    ch.id AS chapter_id, ch.title AS chapter_title, ch.sort_order AS chapter_sort_order,
    s.id AS section_id, s.title AS section_title, s.sort_order AS section_sort_order,
    c.id AS card_id, c.title AS card_title, c.sort_order AS card_sort_order
  FROM materials AS m
  LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
  LEFT JOIN sections AS s ON s.chapter_id = ch.id AND s.deleted_at IS NULL
  LEFT JOIN cards AS c ON c.section_id = s.id AND c.deleted_at IS NULL
  WHERE m.deleted_at IS NULL
  ORDER BY m.created_at, ch.sort_order, s.sort_order, c.sort_order
`;

async function listFrom(database: HierarchySqlExecutor): Promise<HierarchyResponse> {
  const [rows] = await database.execute(hierarchySelect);
  return buildHierarchy(rowsFrom(rows));
}

async function ensureActiveParent(connection: HierarchySqlExecutor, entityType: ChildEntityType, parentId: string) {
  const parent = entityType === 'chapter' ? 'material' : entityType === 'section' ? 'chapter' : 'section';
  const table = parent === 'material' ? 'materials' : parent === 'chapter' ? 'chapters' : 'sections';
  const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [parentId]);
  if (rowsFrom(rows).length === 0) {
    throw new HierarchyApiError(404, `${entityName(parent)}不存在或已删除。`);
  }
}

async function ensureActiveEntity(connection: HierarchySqlExecutor, entityType: HierarchyEntityType, entityId: string) {
  const table = entityType === 'material' ? 'materials' : childTable[entityType].table;
  const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NULL LIMIT 1`, [entityId]);
  if (rowsFrom(rows).length === 0) {
    throw new HierarchyApiError(404, `${entityName(entityType)}不存在或已删除。`);
  }
}

async function nextSortOrder(connection: HierarchySqlExecutor, entityType: ChildEntityType, parentId: string): Promise<number> {
  const config = childTable[entityType];
  const [rows] = await connection.execute(
    `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM ${config.table} WHERE ${config.parent} = ? AND deleted_at IS NULL`,
    [parentId],
  );
  return numberValue(rowsFrom(rows)[0]?.next_order);
}

async function normalizeSiblingOrder(connection: HierarchySqlExecutor, entityType: ChildEntityType, parentId: string) {
  const config = childTable[entityType];
  const [rows] = await connection.execute(
    `SELECT id FROM ${config.table} WHERE ${config.parent} = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id`,
    [parentId],
  );
  for (const [sortOrder, row] of rowsFrom(rows).entries()) {
    await connection.execute(`UPDATE ${config.table} SET sort_order = ? WHERE id = ?`, [sortOrder, textValue(row.id)]);
  }
}

async function transaction<T>(database: HierarchyDatabase, run: (connection: HierarchySqlConnection) => Promise<T>): Promise<T> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function moveEntity(
  connection: HierarchySqlConnection,
  entityType: ChildEntityType,
  entityId: string,
  parentId: string,
) {
  const config = childTable[entityType];
  const [rows] = await connection.execute(
    `SELECT ${config.parent} AS parent_id FROM ${config.table} WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
    [entityId],
  );
  const current = rowsFrom(rows)[0];
  if (!current) {
    throw new HierarchyApiError(404, `${entityName(entityType)}不存在或已删除。`);
  }
  await ensureActiveParent(connection, entityType, parentId);
  const previousParentId = textValue(current.parent_id);
  if (previousParentId === parentId) {
    return;
  }
  await connection.execute(
    `UPDATE ${config.table} SET ${config.parent} = ?, sort_order = ? WHERE id = ?`,
    [parentId, await nextSortOrder(connection, entityType, parentId), entityId],
  );
  await normalizeSiblingOrder(connection, entityType, previousParentId);
  await normalizeSiblingOrder(connection, entityType, parentId);
}

async function reorderEntity(
  connection: HierarchySqlConnection,
  entityType: ChildEntityType,
  entityId: string,
  direction: HierarchySortDirection,
) {
  const config = childTable[entityType];
  const [rows] = await connection.execute(
    `SELECT id, ${config.parent} AS parent_id, sort_order FROM ${config.table} WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
    [entityId],
  );
  const current = rowsFrom(rows)[0];
  if (!current) {
    throw new HierarchyApiError(404, `${entityName(entityType)}不存在或已删除。`);
  }
  const parentId = textValue(current.parent_id);
  const [siblings] = await connection.execute(
    `SELECT id, sort_order FROM ${config.table} WHERE ${config.parent} = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id FOR UPDATE`,
    [parentId],
  );
  const ordered = rowsFrom(siblings);
  const index = ordered.findIndex((row) => textValue(row.id) === entityId);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) {
    return;
  }
  const target = ordered[targetIndex];
  if (!target) {
    return;
  }
  await connection.execute(`UPDATE ${config.table} SET sort_order = ? WHERE id = ?`, [numberValue(target.sort_order), entityId]);
  await connection.execute(`UPDATE ${config.table} SET sort_order = ? WHERE id = ?`, [numberValue(current.sort_order), textValue(target.id)]);
  await normalizeSiblingOrder(connection, entityType, parentId);
}

async function collectDeletedEntities(connection: HierarchySqlExecutor, entityType: HierarchyEntityType, entityId: string) {
  const result: Array<{ entityType: HierarchyEntityType; id: string; title: string; parentId: string | null; sortOrder: number }> = [];
  if (entityType === 'material') {
    const [materials] = await connection.execute('SELECT id, name AS title, NULL AS parent_id, 0 AS sort_order FROM materials WHERE id = ? AND deleted_at IS NULL', [entityId]);
    result.push(...entityRows(materials, entityType));
    const [chapters] = await connection.execute('SELECT id, title, material_id AS parent_id, sort_order FROM chapters WHERE material_id = ? AND deleted_at IS NULL', [entityId]);
    result.push(...entityRows(chapters, 'chapter'));
    const [sections] = await connection.execute('SELECT s.id, s.title, s.chapter_id AS parent_id, s.sort_order FROM sections AS s INNER JOIN chapters AS ch ON ch.id = s.chapter_id WHERE ch.material_id = ? AND s.deleted_at IS NULL', [entityId]);
    result.push(...entityRows(sections, 'section'));
    const [cards] = await connection.execute('SELECT c.id, c.title, c.section_id AS parent_id, c.sort_order FROM cards AS c INNER JOIN sections AS s ON s.id = c.section_id INNER JOIN chapters AS ch ON ch.id = s.chapter_id WHERE ch.material_id = ? AND c.deleted_at IS NULL', [entityId]);
    result.push(...entityRows(cards, 'card'));
    return result;
  }

  const config = childTable[entityType];
  const [entityRowsResult] = await connection.execute(
    `SELECT id, ${config.title} AS title, ${config.parent} AS parent_id, sort_order FROM ${config.table} WHERE id = ? AND deleted_at IS NULL`,
    [entityId],
  );
  result.push(...entityRows(entityRowsResult, entityType));
  if (entityType === 'chapter') {
    const [sections] = await connection.execute('SELECT id, title, chapter_id AS parent_id, sort_order FROM sections WHERE chapter_id = ? AND deleted_at IS NULL', [entityId]);
    result.push(...entityRows(sections, 'section'));
    const [cards] = await connection.execute('SELECT c.id, c.title, c.section_id AS parent_id, c.sort_order FROM cards AS c INNER JOIN sections AS s ON s.id = c.section_id WHERE s.chapter_id = ? AND c.deleted_at IS NULL', [entityId]);
    result.push(...entityRows(cards, 'card'));
  } else if (entityType === 'section') {
    const [cards] = await connection.execute('SELECT id, title, section_id AS parent_id, sort_order FROM cards WHERE section_id = ? AND deleted_at IS NULL', [entityId]);
    result.push(...entityRows(cards, 'card'));
  }
  return result;
}

async function markDeleted(connection: HierarchySqlConnection, entities: Array<{ entityType: HierarchyEntityType; id: string; title: string; parentId: string | null; sortOrder: number }>) {
  for (const entity of entities) {
    await connection.execute(
      'INSERT INTO trash_items (id, entity_type, entity_id, payload_json) VALUES (?, ?, ?, ?)',
      [randomUUID(), entity.entityType, entity.id, JSON.stringify({ title: entity.title, parentId: entity.parentId, sortOrder: entity.sortOrder })],
    );
  }
  for (const entityType of ['card', 'section', 'chapter', 'material'] as const) {
    const ids = entities.filter((entity) => entity.entityType === entityType).map((entity) => entity.id);
    if (ids.length === 0) {
      continue;
    }
    const table = entityType === 'material' ? 'materials' : childTable[entityType].table;
    const placeholders = ids.map(() => '?').join(', ');
    await connection.execute(`UPDATE ${table} SET deleted_at = COALESCE(deleted_at, CURRENT_TIMESTAMP(3)) WHERE id IN (${placeholders})`, ids);
  }
}

export function createHierarchyDatabase(pool: Pool): HierarchyDatabase {
  return {
    execute: (sql: string, values?: readonly unknown[]) =>
      pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        execute: (sql: string, values?: readonly unknown[]) =>
          connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
}

export function createHierarchyService(options: Partial<HierarchyServiceOptions> = {}): HierarchyService {
  const database = options.database ?? createHierarchyDatabase(createDatabasePool());
  return {
    list: () => listFrom(database),

    async listTrash() {
      const [rows] = await database.execute(
        'SELECT id, entity_type, entity_id, payload_json, deleted_at, expires_at FROM trash_items WHERE restored_at IS NULL ORDER BY deleted_at DESC, id DESC',
      );
      const items: HierarchyTrashItem[] = rowsFrom(rows).map((row) => {
        let payload: Record<string, unknown> = {};
        try {
          const parsed = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json;
          if (isRecord(parsed)) {
            payload = parsed;
          }
        } catch {
          // 损坏的回收站载荷仍显示实体类型和 ID，避免阻断回收站读取。
        }
        return {
          id: textValue(row.id),
          entityType: textValue(row.entity_type) as HierarchyEntityType,
          entityId: textValue(row.entity_id),
          title: textValue(payload.title) || '未命名内容',
          deletedAt: dateValue(row.deleted_at),
          expiresAt: nullableDateValue(row.expires_at),
        };
      });
      return { items };
    },

    async create(request) {
      const entityType = readEntityType(request.entityType);
      const parentId = requiredId(request.parentId, '父级');
      const title = requiredTitle(request.title);
      return transaction(database, async (connection) => {
        await ensureActiveParent(connection, entityType, parentId);
        const id = randomUUID();
        const config = childTable[entityType];
        const sortOrder = await nextSortOrder(connection, entityType, parentId);
        const values = entityType === 'card'
          ? [id, parentId, title, JSON.stringify([]), sortOrder]
          : [id, parentId, title, sortOrder];
        const columns = entityType === 'card'
          ? '(id, section_id, title, content_json, sort_order)'
          : entityType === 'section'
            ? '(id, chapter_id, title, sort_order)'
            : '(id, material_id, title, sort_order)';
        await connection.execute(`INSERT INTO ${config.table} ${columns} VALUES (${values.map(() => '?').join(', ')})`, values);
        return listFrom(connection);
      });
    },

    async rename(entityType, entityId, title) {
      const normalizedType = entityType === 'material' || entityType === 'chapter' || entityType === 'section' || entityType === 'card'
        ? entityType
        : (() => { throw new HierarchyApiError(400, '层级类型无效。'); })();
      const id = requiredId(entityId, '对象');
      const normalizedTitle = requiredTitle(title);
      return transaction(database, async (connection) => {
        await ensureActiveEntity(connection, normalizedType, id);
        const table = normalizedType === 'material' ? 'materials' : childTable[normalizedType].table;
        const column = normalizedType === 'material' ? 'name' : 'title';
        await connection.execute(`UPDATE ${table} SET ${column} = ? WHERE id = ? AND deleted_at IS NULL`, [normalizedTitle, id]);
        return listFrom(connection);
      });
    },

    async move(entityType, entityId, request) {
      const normalizedType = readEntityType(entityType);
      const id = requiredId(entityId, '对象');
      const parentId = requiredId(request.parentId, '父级');
      return transaction(database, async (connection) => {
        await moveEntity(connection, normalizedType, id, parentId);
        return listFrom(connection);
      });
    },

    async reorder(entityType, entityId, request) {
      const normalizedType = readEntityType(entityType);
      const id = requiredId(entityId, '对象');
      const direction = readDirection(request.direction);
      return transaction(database, async (connection) => {
        await reorderEntity(connection, normalizedType, id, direction);
        return listFrom(connection);
      });
    },

    async softDelete(entityType, entityId) {
      const normalizedType = entityType === 'material' || entityType === 'chapter' || entityType === 'section' || entityType === 'card'
        ? entityType
        : (() => { throw new HierarchyApiError(400, '层级类型无效。'); })();
      const id = requiredId(entityId, '对象');
      return transaction(database, async (connection) => {
        await ensureActiveEntity(connection, normalizedType, id);
        const entities = await collectDeletedEntities(connection, normalizedType, id);
        await markDeleted(connection, entities);
        if (normalizedType !== 'material') {
          const root = entities.find((entity) => entity.entityType === normalizedType && entity.id === id);
          if (root?.parentId) {
            await normalizeSiblingOrder(connection, normalizedType, root.parentId);
          }
        }
        return listFrom(connection);
      });
    },
  };
}
