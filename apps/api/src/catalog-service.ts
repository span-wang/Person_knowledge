import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'mysql2/promise';
import sharp from 'sharp';
import {
  type CatalogCourse,
  type CatalogCoursesResponse,
  type CatalogCourseSubjectsResponse,
  type CatalogCreateCourseRequest,
  type CatalogCreateSubjectRequest,
  type CatalogMaterialCard,
  type CatalogMaterialDetail,
  type CatalogMaterialCover,
  type CatalogMaterialResponse,
  type CatalogMasteryDistribution,
  type CatalogReorderRequest,
  type CatalogResource,
  type CatalogSortDirection,
  type CatalogSubject,
  type CatalogSubjectResponse,
  type CatalogUpdateCourseRequest,
  type CatalogUpdateMaterialRequest,
  type CatalogUpdateSubjectRequest,
  type CatalogMoveSubjectRequest,
  type CatalogStatusTrendPoint,
  type HierarchyChapter,
  type HierarchySection,
  type ReviewMasteryStatus,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createDatabasePool } from './database.js';

export interface CatalogSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface CatalogSqlConnection extends CatalogSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface CatalogDatabase extends CatalogSqlExecutor {
  getConnection(): Promise<CatalogSqlConnection>;
}

export interface CatalogServiceOptions {
  database: CatalogDatabase;
  now: () => Date;
  resourcesDirectory: string;
}

export class CatalogApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'CatalogApiError';
  }
}

export interface CatalogService {
  listCourses(): Promise<CatalogCoursesResponse>;
  listCourseSubjects(courseId: string): Promise<CatalogCourseSubjectsResponse>;
  getSubject(subjectId: string): Promise<CatalogSubjectResponse>;
  getMaterial(materialId: string): Promise<CatalogMaterialResponse>;
  renameMaterial(materialId: string, request: CatalogUpdateMaterialRequest): Promise<CatalogMaterialResponse>;
  replaceMaterialCover(materialId: string, source: Buffer, declaredMimeType: string | undefined): Promise<CatalogMaterialCover>;
  removeMaterialCover(materialId: string): Promise<void>;
  createCourse(request: CatalogCreateCourseRequest): Promise<CatalogCoursesResponse>;
  renameCourse(courseId: string, request: CatalogUpdateCourseRequest): Promise<CatalogCoursesResponse>;
  reorderCourse(courseId: string, request: CatalogReorderRequest): Promise<CatalogCoursesResponse>;
  removeCourse(courseId: string): Promise<CatalogCoursesResponse>;
  createSubject(request: CatalogCreateSubjectRequest): Promise<CatalogCoursesResponse>;
  renameSubject(subjectId: string, request: CatalogUpdateSubjectRequest): Promise<CatalogCoursesResponse>;
  moveSubject(subjectId: string, request: CatalogMoveSubjectRequest): Promise<CatalogCoursesResponse>;
  reorderSubject(subjectId: string, request: CatalogReorderRequest): Promise<CatalogCoursesResponse>;
  removeSubject(subjectId: string): Promise<CatalogCoursesResponse>;
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
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function requiredId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) {
    throw new CatalogApiError(400, `${label}无效。`);
  }
  return value.trim();
}

function requiredName(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new CatalogApiError(400, `${label}无效。`);
  }
  const name = value.trim();
  if (!name || name.length > 255) {
    throw new CatalogApiError(400, `${label}不能为空且不能超过 255 个字符。`);
  }
  return name;
}

function readDirection(value: unknown): CatalogSortDirection {
  if (value !== 'up' && value !== 'down') {
    throw new CatalogApiError(400, '排序方向无效。');
  }
  return value;
}

function courseFromRow(row: Record<string, unknown>): CatalogCourse {
  return {
    id: textValue(row.id),
    name: textValue(row.name),
    sortOrder: numberValue(row.sort_order),
    isSystem: booleanValue(row.is_system),
    subjectCount: numberValue(row.subject_count),
  };
}

function subjectFromRow(row: Record<string, unknown>): CatalogSubject {
  return {
    id: textValue(row.id),
    courseId: textValue(row.course_id),
    name: textValue(row.name),
    sortOrder: numberValue(row.sort_order),
    isSystem: booleanValue(row.is_system),
    materialCount: numberValue(row.material_count),
  };
}

const supportedCoverMimeTypes = new Set<CatalogResource['mimeType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);
const maxCoverBytes = 5 * 1024 * 1024;

type CoverFileType = {
  mimeType: CatalogResource['mimeType'];
  extension: string;
};

type StoredCoverResource = CatalogResource & {
  relativePath: string;
};

type PreviousCover = {
  id: string;
  resources: StoredCoverResource[];
};

function detectedCoverFileType(source: Buffer): CoverFileType | null {
  if (source.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', extension: 'png' };
  }
  if (source.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    return { mimeType: 'image/jpeg', extension: 'jpg' };
  }
  if (source.subarray(0, 6).equals(Buffer.from('GIF87a')) || source.subarray(0, 6).equals(Buffer.from('GIF89a'))) {
    return { mimeType: 'image/gif', extension: 'gif' };
  }
  if (source.subarray(0, 4).equals(Buffer.from('RIFF')) && source.subarray(8, 12).equals(Buffer.from('WEBP'))) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }
  return null;
}

function isPathInside(parent: string, target: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function resourcePath(resourcesDirectory: string, relativePath: string): string {
  const absolutePath = path.resolve(resourcesDirectory, relativePath);
  if (!isPathInside(resourcesDirectory, absolutePath)) {
    throw new CatalogApiError(400, '封面保存路径无效。');
  }
  return absolutePath;
}

async function prepareCover(source: Buffer, declaredMimeType: string | undefined) {
  if (!Buffer.isBuffer(source) || source.length === 0 || source.length > maxCoverBytes) {
    throw new CatalogApiError(400, '封面需为 5MB 以内的有效图片。');
  }
  const detected = detectedCoverFileType(source);
  const declared = declaredMimeType?.split(';', 1)[0]?.trim().toLowerCase();
  if (!detected || (declared && declared !== detected.mimeType)) {
    throw new CatalogApiError(400, '封面仅支持 PNG、JPEG、GIF 或 WebP。');
  }
  try {
    const image = sharp(source, { animated: false, failOn: 'error' });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) {
      throw new Error('missing dimensions');
    }
    const thumbnail = await image
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    if (!thumbnail.info.width || !thumbnail.info.height) {
      throw new Error('missing thumbnail dimensions');
    }
    return {
      detected,
      original: {
        width: metadata.width,
        height: metadata.height,
        sha256: createHash('sha256').update(source).digest('hex'),
      },
      thumbnail: {
        content: thumbnail.data,
        width: thumbnail.info.width,
        height: thumbnail.info.height,
        sha256: createHash('sha256').update(thumbnail.data).digest('hex'),
      },
    };
  } catch (error) {
    if (error instanceof CatalogApiError) {
      throw error;
    }
    throw new CatalogApiError(400, '封面图片无法解析。');
  }
}

function coverResourceFromRow(row: Record<string, unknown>, prefix: 'original' | 'thumbnail'): CatalogResource | null {
  const id = row[`${prefix}_resource_id`];
  const mimeType = row[`${prefix}_mime_type`];
  if (typeof id !== 'string' || typeof mimeType !== 'string' || !supportedCoverMimeTypes.has(mimeType as CatalogResource['mimeType'])) {
    return null;
  }
  return {
    id,
    mimeType: mimeType as CatalogResource['mimeType'],
    width: row[`${prefix}_width`] === null || row[`${prefix}_width`] === undefined ? null : numberValue(row[`${prefix}_width`]),
    height: row[`${prefix}_height`] === null || row[`${prefix}_height`] === undefined ? null : numberValue(row[`${prefix}_height`]),
    sha256: textValue(row[`${prefix}_sha256`]),
  };
}

function coverFromRow(row: Record<string, unknown>): CatalogMaterialCover | null {
  const id = row.cover_id;
  const original = coverResourceFromRow(row, 'original');
  const thumbnail = coverResourceFromRow(row, 'thumbnail');
  return typeof id === 'string' && original && thumbnail ? { id, original, thumbnail } : null;
}

const catalogStatuses: ReviewMasteryStatus[] = ['mastered', 'familiar', 'effort', 'unassessed'];
const shanghaiTimeZone = 'Asia/Shanghai';
const dayMilliseconds = 24 * 60 * 60 * 1000;
const shanghaiDayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: shanghaiTimeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function catalogStatus(value: unknown): ReviewMasteryStatus {
  return catalogStatuses.includes(value as ReviewMasteryStatus) ? value as ReviewMasteryStatus : 'unassessed';
}

function emptyMasteryDistribution(): CatalogMasteryDistribution {
  return { mastered: 0, familiar: 0, effort: 0, unassessed: 0 };
}

function masteryDistributionFromStatuses(statuses: Iterable<ReviewMasteryStatus>): CatalogMasteryDistribution {
  const distribution = emptyMasteryDistribution();
  for (const status of statuses) {
    distribution[status] += 1;
  }
  return distribution;
}

function shanghaiDayKey(value: Date): string {
  const parts = shanghaiDayFormatter.formatToParts(value);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`;
}

function recentShanghaiDays(now: Date): string[] {
  const [year, month, day] = shanghaiDayKey(now).split('-').map(Number);
  const lastDay = Date.UTC(year!, month! - 1, day!);
  return Array.from({ length: 30 }, (_, index) => new Date(lastDay - (29 - index) * dayMilliseconds).toISOString().slice(0, 10));
}

function timestampValue(value: unknown): number | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const timestamp = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function endOfShanghaiDayTimestamp(day: string): number {
  return Date.parse(`${day}T00:00:00.000+08:00`) + dayMilliseconds;
}

function materialCardFromRow(row: Record<string, unknown>, courseId: string, subjectId: string): CatalogMaterialCard {
  return {
    id: textValue(row.material_id),
    courseId,
    subjectId,
    name: textValue(row.material_name),
    cardCount: numberValue(row.card_count),
    cover: coverFromRow(row),
  };
}

function chaptersFromRows(rows: Array<Record<string, unknown>>): HierarchyChapter[] {
  const chapters: HierarchyChapter[] = [];
  const chapterById = new Map<string, HierarchyChapter>();
  const sectionById = new Map<string, HierarchySection>();
  for (const row of rows) {
    const chapterId = textValue(row.chapter_id);
    if (!chapterId) continue;
    let chapter = chapterById.get(chapterId);
    if (!chapter) {
      chapter = { id: chapterId, title: textValue(row.chapter_title), sortOrder: numberValue(row.chapter_sort_order), sections: [] };
      chapterById.set(chapterId, chapter);
      chapters.push(chapter);
    }
    const sectionId = textValue(row.section_id);
    if (!sectionId) continue;
    let section = sectionById.get(sectionId);
    if (!section) {
      section = { id: sectionId, title: textValue(row.section_title), sortOrder: numberValue(row.section_sort_order), cards: [] };
      sectionById.set(sectionId, section);
      chapter.sections.push(section);
    }
    const cardId = textValue(row.card_id);
    if (cardId) {
      section.cards.push({ id: cardId, title: textValue(row.card_title), sortOrder: numberValue(row.card_sort_order) });
    }
  }
  return chapters;
}

function statusTrendFromRows(cardRows: Array<Record<string, unknown>>, historyRows: Array<Record<string, unknown>>, now: Date): CatalogStatusTrendPoint[] {
  const statuses = new Map(cardRows.map((row) => [textValue(row.card_id), 'unassessed' as ReviewMasteryStatus]));
  const events = historyRows
    .map((row) => ({ cardId: textValue(row.card_id), status: catalogStatus(row.to_status), changedAt: timestampValue(row.changed_at) }))
    .filter((event): event is { cardId: string; status: ReviewMasteryStatus; changedAt: number } => event.cardId.length > 0 && event.changedAt !== null);
  let eventIndex = 0;
  return recentShanghaiDays(now).map((date) => {
    const dayEnd = endOfShanghaiDayTimestamp(date);
    while (eventIndex < events.length && events[eventIndex]!.changedAt < dayEnd) {
      const event = events[eventIndex]!;
      if (statuses.has(event.cardId)) {
        statuses.set(event.cardId, event.status);
      }
      eventIndex += 1;
    }
    return { date, ...masteryDistributionFromStatuses(statuses.values()) };
  });
}

async function listCoursesFrom(database: CatalogSqlExecutor): Promise<CatalogCoursesResponse> {
  const [rows] = await database.execute(`
    SELECT c.id, c.name, c.sort_order, c.is_system, COUNT(s.id) AS subject_count
    FROM courses AS c
    LEFT JOIN subjects AS s ON s.course_id = c.id AND s.deleted_at IS NULL
    WHERE c.deleted_at IS NULL
    GROUP BY c.id, c.name, c.sort_order, c.is_system, c.created_at
    ORDER BY c.sort_order, c.created_at, c.id
  `);
  return { courses: rowsFrom(rows).map(courseFromRow) };
}

async function activeCourse(database: CatalogSqlExecutor, courseId: string): Promise<CatalogCourse> {
  const id = requiredId(courseId, '课程标识');
  const courses = await listCoursesFrom(database);
  const course = courses.courses.find((item) => item.id === id);
  if (!course) {
    throw new CatalogApiError(404, '课程不存在或已删除。');
  }
  return course;
}

async function listSubjectsFrom(database: CatalogSqlExecutor, courseId: string): Promise<CatalogSubject[]> {
  const [rows] = await database.execute(`
    SELECT s.id, s.course_id, s.name, s.sort_order, s.is_system, COUNT(m.id) AS material_count
    FROM subjects AS s
    LEFT JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
    WHERE s.course_id = ? AND s.deleted_at IS NULL
    GROUP BY s.id, s.course_id, s.name, s.sort_order, s.is_system, s.created_at
    ORDER BY s.sort_order, s.created_at, s.id
  `, [courseId]);
  return rowsFrom(rows).map(subjectFromRow);
}

async function activeSubject(database: CatalogSqlExecutor, subjectId: string): Promise<CatalogSubject> {
  const id = requiredId(subjectId, '科目标识');
  const [rows] = await database.execute(`
    SELECT s.id, s.course_id, s.name, s.sort_order, s.is_system, COUNT(m.id) AS material_count
    FROM subjects AS s
    LEFT JOIN materials AS m ON m.subject_id = s.id AND m.deleted_at IS NULL
    WHERE s.id = ? AND s.deleted_at IS NULL
    GROUP BY s.id, s.course_id, s.name, s.sort_order, s.is_system
    LIMIT 1
  `, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) {
    throw new CatalogApiError(404, '科目不存在或已删除。');
  }
  return subjectFromRow(row);
}

async function listMaterialsFrom(database: CatalogSqlExecutor, subject: CatalogSubject, course: CatalogCourse): Promise<CatalogMaterialCard[]> {
  const [rows] = await database.execute(`
    SELECT
      m.id AS material_id,
      m.name AS material_name,
      COUNT(c.id) AS card_count,
      mc.id AS cover_id,
      original_resource.id AS original_resource_id,
      original_resource.mime_type AS original_mime_type,
      original_resource.width AS original_width,
      original_resource.height AS original_height,
      original_resource.sha256 AS original_sha256,
      thumbnail_resource.id AS thumbnail_resource_id,
      thumbnail_resource.mime_type AS thumbnail_mime_type,
      thumbnail_resource.width AS thumbnail_width,
      thumbnail_resource.height AS thumbnail_height,
      thumbnail_resource.sha256 AS thumbnail_sha256
    FROM materials AS m
    LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
    LEFT JOIN sections AS sec ON sec.chapter_id = ch.id AND sec.deleted_at IS NULL
    LEFT JOIN cards AS c ON c.section_id = sec.id AND c.deleted_at IS NULL
    LEFT JOIN material_covers AS mc ON mc.material_id = m.id
    LEFT JOIN resources AS original_resource ON original_resource.id = mc.original_resource_id AND original_resource.deleted_at IS NULL
    LEFT JOIN resources AS thumbnail_resource ON thumbnail_resource.id = mc.thumbnail_resource_id AND thumbnail_resource.deleted_at IS NULL
    WHERE m.subject_id = ? AND m.deleted_at IS NULL
    GROUP BY
      m.id, m.name, m.imported_at, m.created_at,
      mc.id,
      original_resource.id, original_resource.mime_type, original_resource.width, original_resource.height, original_resource.sha256,
      thumbnail_resource.id, thumbnail_resource.mime_type, thumbnail_resource.width, thumbnail_resource.height, thumbnail_resource.sha256
    ORDER BY m.imported_at, m.created_at, m.id
  `, [subject.id]);
  return rowsFrom(rows).map((row) => materialCardFromRow(row, course.id, subject.id));
}

async function activeMaterial(database: CatalogSqlExecutor, materialId: string): Promise<CatalogMaterialCard> {
  const id = requiredId(materialId, '资料标识');
  const [rows] = await database.execute(`
    SELECT
      m.id AS material_id,
      m.name AS material_name,
      s.id AS subject_id,
      s.course_id,
      COUNT(card.id) AS card_count,
      mc.id AS cover_id,
      original_resource.id AS original_resource_id,
      original_resource.mime_type AS original_mime_type,
      original_resource.width AS original_width,
      original_resource.height AS original_height,
      original_resource.sha256 AS original_sha256,
      thumbnail_resource.id AS thumbnail_resource_id,
      thumbnail_resource.mime_type AS thumbnail_mime_type,
      thumbnail_resource.width AS thumbnail_width,
      thumbnail_resource.height AS thumbnail_height,
      thumbnail_resource.sha256 AS thumbnail_sha256
    FROM materials AS m
    INNER JOIN subjects AS s ON s.id = m.subject_id AND s.deleted_at IS NULL
    INNER JOIN courses AS course ON course.id = s.course_id AND course.deleted_at IS NULL
    LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
    LEFT JOIN sections AS sec ON sec.chapter_id = ch.id AND sec.deleted_at IS NULL
    LEFT JOIN cards AS card ON card.section_id = sec.id AND card.deleted_at IS NULL
    LEFT JOIN material_covers AS mc ON mc.material_id = m.id
    LEFT JOIN resources AS original_resource ON original_resource.id = mc.original_resource_id AND original_resource.deleted_at IS NULL
    LEFT JOIN resources AS thumbnail_resource ON thumbnail_resource.id = mc.thumbnail_resource_id AND thumbnail_resource.deleted_at IS NULL
    WHERE m.id = ? AND m.deleted_at IS NULL
    GROUP BY
      m.id, m.name, s.id, s.course_id, m.imported_at, m.created_at,
      mc.id,
      original_resource.id, original_resource.mime_type, original_resource.width, original_resource.height, original_resource.sha256,
      thumbnail_resource.id, thumbnail_resource.mime_type, thumbnail_resource.width, thumbnail_resource.height, thumbnail_resource.sha256
    LIMIT 1
  `, [id]);
  const row = rowsFrom(rows)[0];
  if (!row) {
    throw new CatalogApiError(404, '资料不存在或已删除。');
  }
  return materialCardFromRow(row, textValue(row.course_id), textValue(row.subject_id));
}

async function activeMaterialForUpdate(database: CatalogSqlConnection, materialId: string): Promise<string> {
  const id = requiredId(materialId, '资料标识');
  const [rows] = await database.execute(
    'SELECT id FROM materials WHERE id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
    [id],
  );
  if (!rowsFrom(rows)[0]) {
    throw new CatalogApiError(404, '资料不存在或已删除。');
  }
  return id;
}

function previousCoverFromRows(rows: Array<Record<string, unknown>>): PreviousCover | null {
  const row = rows[0];
  if (!row || typeof row.cover_id !== 'string') {
    return null;
  }
  const resources: StoredCoverResource[] = [];
  for (const prefix of ['original', 'thumbnail'] as const) {
    const id = row[`${prefix}_resource_id`];
    const mimeType = row[`${prefix}_mime_type`];
    const relativePath = row[`${prefix}_relative_path`];
    if (typeof id === 'string' && typeof mimeType === 'string' && typeof relativePath === 'string' && supportedCoverMimeTypes.has(mimeType as CatalogResource['mimeType'])) {
      resources.push({
        id,
        mimeType: mimeType as CatalogResource['mimeType'],
        relativePath,
        width: row[`${prefix}_width`] === null || row[`${prefix}_width`] === undefined ? null : numberValue(row[`${prefix}_width`]),
        height: row[`${prefix}_height`] === null || row[`${prefix}_height`] === undefined ? null : numberValue(row[`${prefix}_height`]),
        sha256: textValue(row[`${prefix}_sha256`]),
      });
    }
  }
  return { id: row.cover_id, resources };
}

async function previousCoverForUpdate(database: CatalogSqlConnection, materialId: string): Promise<PreviousCover | null> {
  const [rows] = await database.execute(`
    SELECT
      mc.id AS cover_id,
      original_resource.id AS original_resource_id,
      original_resource.relative_path AS original_relative_path,
      original_resource.mime_type AS original_mime_type,
      original_resource.width AS original_width,
      original_resource.height AS original_height,
      original_resource.sha256 AS original_sha256,
      thumbnail_resource.id AS thumbnail_resource_id,
      thumbnail_resource.relative_path AS thumbnail_relative_path,
      thumbnail_resource.mime_type AS thumbnail_mime_type,
      thumbnail_resource.width AS thumbnail_width,
      thumbnail_resource.height AS thumbnail_height,
      thumbnail_resource.sha256 AS thumbnail_sha256
    FROM material_covers AS mc
    INNER JOIN resources AS original_resource ON original_resource.id = mc.original_resource_id
    INNER JOIN resources AS thumbnail_resource ON thumbnail_resource.id = mc.thumbnail_resource_id
    WHERE mc.material_id = ?
    LIMIT 1
    FOR UPDATE
  `, [materialId]);
  return previousCoverFromRows(rowsFrom(rows));
}

async function removeResourceFiles(resourcesDirectory: string, resources: readonly StoredCoverResource[]) {
  await Promise.all(resources.map(async (resource) => {
    const absolutePath = resourcePath(resourcesDirectory, resource.relativePath);
    await fs.rm(absolutePath, { force: true }).catch(() => undefined);
  }));
}

async function materialChaptersFrom(database: CatalogSqlExecutor, materialId: string): Promise<HierarchyChapter[]> {
  const [rows] = await database.execute(`
    SELECT
      ch.id AS chapter_id, ch.title AS chapter_title, ch.sort_order AS chapter_sort_order,
      sec.id AS section_id, sec.title AS section_title, sec.sort_order AS section_sort_order,
      card.id AS card_id, card.title AS card_title, card.sort_order AS card_sort_order
    FROM chapters AS ch
    LEFT JOIN sections AS sec ON sec.chapter_id = ch.id AND sec.deleted_at IS NULL
    LEFT JOIN cards AS card ON card.section_id = sec.id AND card.deleted_at IS NULL
    WHERE ch.material_id = ? AND ch.deleted_at IS NULL
    ORDER BY ch.sort_order, ch.created_at, ch.id, sec.sort_order, sec.created_at, sec.id, card.sort_order, card.created_at, card.id
  `, [materialId]);
  return chaptersFromRows(rowsFrom(rows));
}

async function materialCardStatusesFrom(database: CatalogSqlExecutor, materialId: string): Promise<Array<Record<string, unknown>>> {
  const [rows] = await database.execute(`
    SELECT card.id AS card_id, card.mastery_status
    FROM cards AS card
    INNER JOIN sections AS sec ON sec.id = card.section_id AND sec.deleted_at IS NULL
    INNER JOIN chapters AS ch ON ch.id = sec.chapter_id AND ch.deleted_at IS NULL
    WHERE ch.material_id = ? AND card.deleted_at IS NULL
    ORDER BY card.id
  `, [materialId]);
  return rowsFrom(rows);
}

async function materialStatusHistoryFrom(database: CatalogSqlExecutor, materialId: string): Promise<Array<Record<string, unknown>>> {
  // 保留 DATETIME 墙上时间，避免 mysql2 按 UTC 包装后把上海当天事件推到次日。
  const [rows] = await database.execute(`
    SELECT
      history.card_id,
      history.to_status,
      DATE_FORMAT(history.changed_at, '%Y-%m-%d %H:%i:%s.%f') AS changed_at,
      history.id
    FROM review_status_history AS history
    INNER JOIN cards AS card ON card.id = history.card_id AND card.deleted_at IS NULL
    INNER JOIN sections AS sec ON sec.id = card.section_id AND sec.deleted_at IS NULL
    INNER JOIN chapters AS ch ON ch.id = sec.chapter_id AND ch.deleted_at IS NULL
    WHERE ch.material_id = ?
    ORDER BY history.changed_at, history.id
  `, [materialId]);
  return rowsFrom(rows);
}

async function transaction<T>(database: CatalogDatabase, run: (connection: CatalogSqlConnection) => Promise<T>): Promise<T> {
  const connection = await database.getConnection();
  try {
    await connection.beginTransaction();
    const result = await run(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

async function nextCourseOrder(database: CatalogSqlExecutor): Promise<number> {
  const [rows] = await database.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM courses WHERE deleted_at IS NULL');
  return numberValue(rowsFrom(rows)[0]?.next_order);
}

async function nextSubjectOrder(database: CatalogSqlExecutor, courseId: string): Promise<number> {
  const [rows] = await database.execute(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM subjects WHERE course_id = ? AND deleted_at IS NULL',
    [courseId],
  );
  return numberValue(rowsFrom(rows)[0]?.next_order);
}

async function normalizeCourseOrder(database: CatalogSqlExecutor) {
  const [rows] = await database.execute('SELECT id FROM courses WHERE deleted_at IS NULL ORDER BY sort_order, created_at, id');
  for (const [sortOrder, row] of rowsFrom(rows).entries()) {
    await database.execute('UPDATE courses SET sort_order = ? WHERE id = ?', [sortOrder, textValue(row.id)]);
  }
}

async function normalizeSubjectOrder(database: CatalogSqlExecutor, courseId: string) {
  const [rows] = await database.execute(
    'SELECT id FROM subjects WHERE course_id = ? AND deleted_at IS NULL ORDER BY sort_order, created_at, id',
    [courseId],
  );
  for (const [sortOrder, row] of rowsFrom(rows).entries()) {
    await database.execute('UPDATE subjects SET sort_order = ? WHERE id = ?', [sortOrder, textValue(row.id)]);
  }
}

async function reorderCourse(database: CatalogSqlConnection, courseId: string, direction: CatalogSortDirection) {
  const current = await activeCourse(database, courseId);
  const courses = (await listCoursesFrom(database)).courses;
  const index = courses.findIndex((course) => course.id === current.id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= courses.length) {
    return;
  }
  const target = courses[targetIndex];
  if (!target) {
    return;
  }
  await database.execute('UPDATE courses SET sort_order = ? WHERE id = ?', [target.sortOrder, current.id]);
  await database.execute('UPDATE courses SET sort_order = ? WHERE id = ?', [current.sortOrder, target.id]);
  await normalizeCourseOrder(database);
}

async function reorderSubject(database: CatalogSqlConnection, subjectId: string, direction: CatalogSortDirection) {
  const current = await activeSubject(database, subjectId);
  const subjects = await listSubjectsFrom(database, current.courseId);
  const index = subjects.findIndex((subject) => subject.id === current.id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= subjects.length) {
    return;
  }
  const target = subjects[targetIndex];
  if (!target) {
    return;
  }
  await database.execute('UPDATE subjects SET sort_order = ? WHERE id = ?', [target.sortOrder, current.id]);
  await database.execute('UPDATE subjects SET sort_order = ? WHERE id = ?', [current.sortOrder, target.id]);
  await normalizeSubjectOrder(database, current.courseId);
}

export function createCatalogDatabase(pool: Pool): CatalogDatabase {
  return {
    execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        execute: (sql, values) => connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
}

export function createCatalogService(options: Partial<CatalogServiceOptions> = {}): CatalogService {
  const database = options.database ?? createCatalogDatabase(createDatabasePool());
  const now = options.now ?? (() => new Date());
  const resourcesDirectory = options.resourcesDirectory ?? config.storage.resources;
  return {
    listCourses: () => listCoursesFrom(database),

    async listCourseSubjects(courseId) {
      const course = await activeCourse(database, courseId);
      return { course, subjects: await listSubjectsFrom(database, course.id) };
    },

    async getSubject(subjectId) {
      const subject = await activeSubject(database, subjectId);
      const course = await activeCourse(database, subject.courseId);
      return { course, subject, materials: await listMaterialsFrom(database, subject, course) };
    },

    async getMaterial(materialId) {
      const material = await activeMaterial(database, materialId);
      const [chapters, cardRows, historyRows] = await Promise.all([
        materialChaptersFrom(database, material.id),
        materialCardStatusesFrom(database, material.id),
        materialStatusHistoryFrom(database, material.id),
      ]);
      const detail: CatalogMaterialDetail = {
        ...material,
        chapters,
        masteryDistribution: masteryDistributionFromStatuses(cardRows.map((row) => catalogStatus(row.mastery_status))),
        statusTrend: statusTrendFromRows(cardRows, historyRows, now()),
      };
      return { material: detail };
    },

    async renameMaterial(materialId, request) {
      const id = requiredId(materialId, '资料标识');
      const name = requiredName(request.name, '资料名称');
      await transaction(database, async (connection) => {
        await activeMaterialForUpdate(connection, id);
        await connection.execute('UPDATE materials SET name = ? WHERE id = ? AND deleted_at IS NULL', [name, id]);
      });
      const material = await activeMaterial(database, id);
      const [chapters, cardRows, historyRows] = await Promise.all([
        materialChaptersFrom(database, material.id),
        materialCardStatusesFrom(database, material.id),
        materialStatusHistoryFrom(database, material.id),
      ]);
      return {
        material: {
          ...material,
          chapters,
          masteryDistribution: masteryDistributionFromStatuses(cardRows.map((row) => catalogStatus(row.mastery_status))),
          statusTrend: statusTrendFromRows(cardRows, historyRows, now()),
        },
      };
    },

    async replaceMaterialCover(materialId, source, declaredMimeType) {
      const id = requiredId(materialId, '资料标识');
      const prepared = await prepareCover(source, declaredMimeType);
      const coverId = randomUUID();
      const originalId = randomUUID();
      const thumbnailId = randomUUID();
      const originalRelativePath = `covers/${originalId}.${prepared.detected.extension}`;
      const thumbnailRelativePath = `covers/${thumbnailId}.webp`;
      const originalPath = resourcePath(resourcesDirectory, originalRelativePath);
      const thumbnailPath = resourcePath(resourcesDirectory, thumbnailRelativePath);
      const original: StoredCoverResource = {
        id: originalId,
        mimeType: prepared.detected.mimeType,
        relativePath: originalRelativePath,
        width: prepared.original.width,
        height: prepared.original.height,
        sha256: prepared.original.sha256,
      };
      const thumbnail: StoredCoverResource = {
        id: thumbnailId,
        mimeType: 'image/webp',
        relativePath: thumbnailRelativePath,
        width: prepared.thumbnail.width,
        height: prepared.thumbnail.height,
        sha256: prepared.thumbnail.sha256,
      };
      const newResources = [original, thumbnail];

      await fs.mkdir(path.dirname(originalPath), { recursive: true });
      try {
        await fs.writeFile(originalPath, source, { flag: 'wx' });
        await fs.writeFile(thumbnailPath, prepared.thumbnail.content, { flag: 'wx' });
        const previous = await transaction(database, async (connection) => {
          await activeMaterialForUpdate(connection, id);
          const current = await previousCoverForUpdate(connection, id);
          await connection.execute(
            'INSERT INTO resources (id, relative_path, mime_type, width, height, sha256) VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)',
            [
              original.id, original.relativePath, original.mimeType, original.width, original.height, original.sha256,
              thumbnail.id, thumbnail.relativePath, thumbnail.mimeType, thumbnail.width, thumbnail.height, thumbnail.sha256,
            ],
          );
          if (current) {
            await connection.execute(
              'UPDATE material_covers SET id = ?, original_resource_id = ?, thumbnail_resource_id = ? WHERE material_id = ?',
              [coverId, original.id, thumbnail.id, id],
            );
            if (current.resources.length > 0) {
              await connection.execute(
                `DELETE FROM resources WHERE id IN (${current.resources.map(() => '?').join(', ')})`,
                current.resources.map((resource) => resource.id),
              );
            }
          } else {
            await connection.execute(
              'INSERT INTO material_covers (id, material_id, original_resource_id, thumbnail_resource_id) VALUES (?, ?, ?, ?)',
              [coverId, id, original.id, thumbnail.id],
            );
          }
          return current;
        });
        await removeResourceFiles(resourcesDirectory, previous?.resources ?? []);
        return { id: coverId, original, thumbnail };
      } catch (error) {
        await removeResourceFiles(resourcesDirectory, newResources);
        throw error;
      }
    },

    async removeMaterialCover(materialId) {
      const id = requiredId(materialId, '资料标识');
      const previous = await transaction(database, async (connection) => {
        await activeMaterialForUpdate(connection, id);
        const current = await previousCoverForUpdate(connection, id);
        if (!current) {
          return null;
        }
        await connection.execute('DELETE FROM material_covers WHERE material_id = ?', [id]);
        if (current.resources.length > 0) {
          await connection.execute(
            `DELETE FROM resources WHERE id IN (${current.resources.map(() => '?').join(', ')})`,
            current.resources.map((resource) => resource.id),
          );
        }
        return current;
      });
      if (previous) {
        await removeResourceFiles(resourcesDirectory, previous.resources);
      }
    },

    async createCourse(request) {
      const name = requiredName(request.name, '课程名称');
      return transaction(database, async (connection) => {
        await connection.execute('INSERT INTO courses (id, name, sort_order) VALUES (?, ?, ?)', [randomUUID(), name, await nextCourseOrder(connection)]);
        return listCoursesFrom(connection);
      });
    },

    async renameCourse(courseId, request) {
      const id = requiredId(courseId, '课程标识');
      const name = requiredName(request.name, '课程名称');
      return transaction(database, async (connection) => {
        await activeCourse(connection, id);
        await connection.execute('UPDATE courses SET name = ? WHERE id = ? AND deleted_at IS NULL', [name, id]);
        return listCoursesFrom(connection);
      });
    },

    async reorderCourse(courseId, request) {
      const id = requiredId(courseId, '课程标识');
      const direction = readDirection(request.direction);
      return transaction(database, async (connection) => {
        await reorderCourse(connection, id, direction);
        return listCoursesFrom(connection);
      });
    },

    async removeCourse(courseId) {
      const id = requiredId(courseId, '课程标识');
      return transaction(database, async (connection) => {
        const course = await activeCourse(connection, id);
        if (course.isSystem) {
          throw new CatalogApiError(400, '待整理课程不可删除。');
        }
        const [subjects] = await connection.execute(
          'SELECT id FROM subjects WHERE course_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
          [id],
        );
        if (rowsFrom(subjects).length > 0) {
          throw new CatalogApiError(409, '课程仍包含科目，不能删除。');
        }
        await connection.execute('UPDATE courses SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]);
        await normalizeCourseOrder(connection);
        return listCoursesFrom(connection);
      });
    },

    async createSubject(request) {
      const courseId = requiredId(request.courseId, '课程标识');
      const name = requiredName(request.name, '科目名称');
      return transaction(database, async (connection) => {
        await activeCourse(connection, courseId);
        await connection.execute(
          'INSERT INTO subjects (id, course_id, name, sort_order) VALUES (?, ?, ?, ?)',
          [randomUUID(), courseId, name, await nextSubjectOrder(connection, courseId)],
        );
        return listCoursesFrom(connection);
      });
    },

    async renameSubject(subjectId, request) {
      const id = requiredId(subjectId, '科目标识');
      const name = requiredName(request.name, '科目名称');
      return transaction(database, async (connection) => {
        await activeSubject(connection, id);
        await connection.execute('UPDATE subjects SET name = ? WHERE id = ? AND deleted_at IS NULL', [name, id]);
        return listCoursesFrom(connection);
      });
    },

    async moveSubject(subjectId, request) {
      const id = requiredId(subjectId, '科目标识');
      const courseId = requiredId(request.courseId, '课程标识');
      return transaction(database, async (connection) => {
        const subject = await activeSubject(connection, id);
        await activeCourse(connection, courseId);
        if (subject.courseId !== courseId) {
          await connection.execute(
            'UPDATE subjects SET course_id = ?, sort_order = ? WHERE id = ? AND deleted_at IS NULL',
            [courseId, await nextSubjectOrder(connection, courseId), id],
          );
          await normalizeSubjectOrder(connection, subject.courseId);
          await normalizeSubjectOrder(connection, courseId);
        }
        return listCoursesFrom(connection);
      });
    },

    async reorderSubject(subjectId, request) {
      const id = requiredId(subjectId, '科目标识');
      const direction = readDirection(request.direction);
      return transaction(database, async (connection) => {
        await reorderSubject(connection, id, direction);
        return listCoursesFrom(connection);
      });
    },

    async removeSubject(subjectId) {
      const id = requiredId(subjectId, '科目标识');
      return transaction(database, async (connection) => {
        const subject = await activeSubject(connection, id);
        if (subject.isSystem) {
          throw new CatalogApiError(400, '待整理科目不可删除。');
        }
        const [materials] = await connection.execute(
          'SELECT id FROM materials WHERE subject_id = ? AND deleted_at IS NULL LIMIT 1 FOR UPDATE',
          [id],
        );
        if (rowsFrom(materials).length > 0) {
          throw new CatalogApiError(409, '科目仍包含资料，不能删除。');
        }
        await connection.execute('UPDATE subjects SET deleted_at = CURRENT_TIMESTAMP(3) WHERE id = ?', [id]);
        await normalizeSubjectOrder(connection, subject.courseId);
        return listCoursesFrom(connection);
      });
    },
  };
}
