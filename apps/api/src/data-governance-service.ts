import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { toMarkdown, type Handle } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import type { Pool } from 'mysql2/promise';
import {
  type DataExportAiExplanation,
  type DataExportQuestionAiExplanation,
  type DataExportQuestion,
  type DataExportQuestionBank,
  type DataExportQuestionChapter,
  type DataExportPracticeSession,
  type DataExportPracticeAttempt,
  type DataExportCard,
  type DataExportChapter,
  type DataExportCourse,
  type DataExportHighlight,
  type DataExportMaterialCover,
  type DataExportMaterial,
  type DataExportResource,
  type DataExportReviewRecord,
  type DataExportReviewStatusHistory,
  type DataExportSection,
  type DataExportSubject,
  type DataExportTrashItem,
  type DataExportTrashEntityType,
  type DataBackupFileManifest,
  type DataBackupResponse,
  type DataBackupsResponse,
  type DataBackupSummary,
  type DataPermanentDeleteResponse,
  type DataJsonExport,
  type DataJsonExportV2,
  type QuestionBankKind,
  type QuestionType,
  type PracticeMode,
  type PracticeSource,
  type PracticeSessionStatus,
  type PracticeAttemptResult,
  type DataRestoreResponse,
  type HierarchyEntityType,
  type ReviewContentNode,
  type ReviewHighlightAnchor,
  type ReviewMasteryStatus,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';
import { config } from './config.js';

export interface DataGovernanceSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface DataGovernanceSqlConnection extends DataGovernanceSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface DataGovernanceDatabase extends DataGovernanceSqlExecutor {
  getConnection(): Promise<DataGovernanceSqlConnection>;
}

export interface DataGovernanceServiceOptions {
  database: DataGovernanceDatabase;
  resourcesDirectory?: string;
  backupsDirectory?: string;
}

export interface MarkdownExport {
  fileName: string;
  content: string;
}

export interface DataGovernanceService {
  exportMarkdown(materialId: string): Promise<MarkdownExport>;
  exportJson(): Promise<DataJsonExport>;
  restoreJson(value: unknown): Promise<DataRestoreResponse>;
  listBackups(): Promise<DataBackupsResponse>;
  createBackup(): Promise<DataBackupResponse>;
  ensureDailyBackup(): Promise<DataBackupResponse | null>;
  restoreBackup(backupId: string): Promise<DataRestoreResponse>;
  permanentlyDeleteTrashItem(trashItemId: string): Promise<DataPermanentDeleteResponse>;
}

export class DataGovernanceApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'DataGovernanceApiError';
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
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function dateValue(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const text = textValue(value);
  const timestamp = Date.parse(text);
  return Number.isNaN(timestamp) ? new Date(0).toISOString() : new Date(timestamp).toISOString();
}

function nullableDateValue(value: unknown): string | null {
  return value === null || value === undefined ? null : dateValue(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isPathInside(parent: string, target: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeRelativePath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.includes('\\')) {
    throw new DataGovernanceApiError(400, '恢复文件包含无效资源路径。');
  }
  const normalized = path.posix.normalize(value.trim());
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/') || normalized.includes('/../')) {
    throw new DataGovernanceApiError(400, '恢复文件包含不安全资源路径。');
  }
  return normalized;
}

function assertNoSecretKeys(value: unknown, location = '导出文件'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${location}[${index}]`));
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/(?:api[_-]?key|password|ciphertext|credential|tunnel|secret)/i.test(key)) {
      throw new DataGovernanceApiError(400, `${location}包含不允许恢复的敏感字段。`);
    }
    assertNoSecretKeys(child, `${location}.${key}`);
  }
}

const reviewContentTypes = new Set([
  'paragraph',
  'text',
  'strong',
  'emphasis',
  'delete',
  'inlineCode',
  'blockquote',
  'list',
  'listItem',
  'code',
  'heading',
  'break',
  'thematicBreak',
  'link',
  'image',
  'math',
  'inlineMath',
  'table',
  'tableRow',
  'tableCell',
]);

const reviewContentKeys = new Set([
  'type',
  'value',
  'url',
  'resourceId',
  'resourcePath',
  'title',
  'alt',
  'lang',
  'meta',
  'depth',
  'ordered',
  'start',
  'checked',
  'display',
  'align',
  'rowSpan',
  'colSpan',
  'children',
]);

function safeContentUrl(value: string): string {
  const normalized = value.trim();
  if (normalized.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(?:https?:|mailto:)/i.test(normalized)) {
    throw new DataGovernanceApiError(400, '恢复文件包含不安全链接。');
  }
  return normalized;
}

function normalizeContentNode(value: unknown): ReviewContentNode {
  if (!isRecord(value) || typeof value.type !== 'string' || !reviewContentTypes.has(value.type)) {
    throw new DataGovernanceApiError(400, '恢复文件包含不支持的正文节点。');
  }
  const node: Record<string, unknown> = { type: value.type };
  for (const [key, child] of Object.entries(value)) {
    if (!reviewContentKeys.has(key) || key === 'type' || child === undefined) {
      continue;
    }
    if (key === 'children') {
      if (!Array.isArray(child)) {
        throw new DataGovernanceApiError(400, '恢复文件的正文节点子项无效。');
      }
      node.children = child.map(normalizeContentNode);
    } else if (key === 'url') {
      if (typeof child !== 'string') {
        throw new DataGovernanceApiError(400, '恢复文件的链接无效。');
      }
      node.url = safeContentUrl(child);
    } else if (key === 'align') {
      if (!Array.isArray(child)) {
        throw new DataGovernanceApiError(400, '恢复文件的表格对齐方式无效。');
      }
      node.align = child.map((item) => item === 'left' || item === 'center' || item === 'right' ? item : null);
    } else if (key === 'rowSpan' || key === 'colSpan') {
      if (typeof child !== 'number' || !Number.isInteger(child) || child < 1 || child > 100) {
        throw new DataGovernanceApiError(400, '恢复文件的表格跨度无效。');
      }
      node[key] = child;
    } else if (typeof child === 'string' || typeof child === 'boolean' || typeof child === 'number' || child === null) {
      node[key] = child;
    } else {
      throw new DataGovernanceApiError(400, '恢复文件的正文节点属性无效。');
    }
  }
  return node as unknown as ReviewContentNode;
}

function normalizeContent(value: unknown): ReviewContentNode[] {
  if (!Array.isArray(value)) {
    throw new DataGovernanceApiError(400, '恢复文件的卡片正文无效。');
  }
  return value.map(normalizeContentNode);
}

function normalizeText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return value;
}

function normalizeId(value: unknown, label: string): string {
  return normalizeText(value, label, 128).trim();
}

function normalizeDate(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) {
    return null;
  }
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return new Date(Date.parse(value)).toISOString();
}

function mysqlDateTime(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new DataGovernanceApiError(400, '恢复文件包含无效时间。');
  }
  return date.toISOString().slice(0, -1).replace('T', ' ');
}

function normalizeSha256(value: unknown, label: string): string {
  const normalized = normalizeText(value, label, 64).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return normalized;
}

function normalizeSortOrder(value: unknown, label: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 2_147_483_647) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return normalized;
}

function normalizeMasteryStatus(value: unknown, label: string): ReviewMasteryStatus {
  if (value === 'unassessed' || value === 'mastered' || value === 'familiar' || value === 'effort') {
    return value;
  }
  throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
}

const defaultCourseId = '00000000-0000-4000-8000-000000000001';
const defaultSubjectId = '00000000-0000-4000-8000-000000000002';

function legacyCatalog(exportedAt: string): { courses: DataExportCourse[]; subjects: DataExportSubject[] } {
  return {
    courses: [{ id: defaultCourseId, name: '待整理', sortOrder: 0, isSystem: true, deletedAt: null, createdAt: exportedAt, updatedAt: exportedAt }],
    subjects: [{ id: defaultSubjectId, courseId: defaultCourseId, name: '待整理', sortOrder: 0, isSystem: true, deletedAt: null, createdAt: exportedAt, updatedAt: exportedAt }],
  };
}

function duplicateIds(rows: Array<{ id: string }>, label: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new DataGovernanceApiError(400, `恢复文件的${label}存在重复标识。`);
    }
    seen.add(row.id);
  }
}

function normalizeAnchor(value: unknown): ReviewHighlightAnchor {
  if (!isRecord(value) || typeof value.nodePath !== 'string' || !value.nodePath.trim()) {
    throw new DataGovernanceApiError(400, '恢复文件的高亮定位无效。');
  }
  if ('start' in value || 'end' in value) {
    if (!Number.isInteger(value.start) || !Number.isInteger(value.end) || (value.start as number) < 0 || (value.end as number) <= (value.start as number)) {
      throw new DataGovernanceApiError(400, '恢复文件的文字高亮范围无效。');
    }
    return { nodePath: value.nodePath, start: value.start as number, end: value.end as number };
  }
  return { nodePath: value.nodePath };
}

function normalizeQuestionType(value: unknown): QuestionType {
  if (value === 'single' || value === 'multiple' || value === 'true_false') return value;
  throw new DataGovernanceApiError(400, '恢复文件的题型无效。');
}

function normalizeQuestionBankKind(value: unknown): QuestionBankKind {
  if (value === 'chapter' || value === 'official' || value === 'mock') return value;
  throw new DataGovernanceApiError(400, '恢复文件的题库类型无效。');
}

function normalizePracticeMode(value: unknown): PracticeMode {
  if (value === 'cram' || value === 'test') return value;
  throw new DataGovernanceApiError(400, '恢复文件的刷题模式无效。');
}

function normalizePracticeSource(value: unknown): PracticeSource {
  if (value === 'full' || value === 'current_wrong' || value === 'aggregate_wrong') return value;
  throw new DataGovernanceApiError(400, '恢复文件的刷题来源无效。');
}

function normalizePracticeSessionStatus(value: unknown): PracticeSessionStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'abandoned') return value;
  throw new DataGovernanceApiError(400, '恢复文件的刷题会话状态无效。');
}

function normalizePracticeAttemptResult(value: unknown): PracticeAttemptResult {
  if (value === 'unanswered' || value === 'correct' || value === 'incorrect') return value;
  throw new DataGovernanceApiError(400, '恢复文件的作答结果无效。');
}

function normalizeStringArray(value: unknown, label: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return value.map((item) => normalizeText(item, label, 255).trim()).filter(Boolean);
}

function normalizePromptText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length > 20_000) {
    throw new DataGovernanceApiError(400, `恢复文件的${label}无效。`);
  }
  return value;
}

function normalizeQuestionOptions(value: unknown): DataExportQuestion['options'] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) {
    throw new DataGovernanceApiError(400, '恢复文件的题目选项数量无效。');
  }
  return value.map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复文件的题目选项无效。');
    const key = normalizeText(item.key, '题目选项字母', 1).trim().toUpperCase();
    if (!/^[A-F]$/.test(key)) throw new DataGovernanceApiError(400, '恢复文件的题目选项字母无效。');
    return { key, content: normalizeContent(item.content) };
  });
}

function normalizeQuestionAnswer(value: unknown): string[] {
  const values = typeof value === 'string' ? [value] : value;
  return normalizeStringArray(values, '题目答案', 6).map((item) => item.toUpperCase());
}

interface NormalizedDataExport {
  payload: DataJsonExportV2;
  sourceVersion: 1 | 2;
}

function normalizeExport(value: unknown): NormalizedDataExport {
  if (!isRecord(value) || value.format !== 'knowledge-flashcards-json' || (value.version !== 1 && value.version !== 2)) {
    throw new DataGovernanceApiError(400, '恢复文件版本不受支持。');
  }
  const sourceVersion = value.version;
  assertNoSecretKeys(value);
  const exportedAt = normalizeDate(value.exportedAt, '导出时间')!;
  const array = (key: string): unknown[] => {
    if (!Array.isArray(value[key])) {
      throw new DataGovernanceApiError(400, `恢复文件缺少${key}。`);
    }
    return value[key] as unknown[];
  };
  const optionalArray = (key: string): unknown[] | null => {
    if (value[key] === undefined) {
      return null;
    }
    if (!Array.isArray(value[key])) {
      throw new DataGovernanceApiError(400, `恢复文件的${key}无效。`);
    }
    return value[key] as unknown[];
  };
  const courseEntries = optionalArray('courses');
  const subjectEntries = optionalArray('subjects');
  if ((courseEntries === null) !== (subjectEntries === null)) {
    throw new DataGovernanceApiError(400, '恢复文件的课程和科目目录必须同时提供。');
  }
  const materials: DataExportMaterial[] = array('materials').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复资料记录无效。');
    return {
      id: normalizeId(item.id, '资料标识'),
      name: normalizeText(item.name, '资料名称', 255),
      sourceFilename: normalizeText(item.sourceFilename, '源文件名', 255),
      sourceSha256: normalizeSha256(item.sourceSha256, '源文件哈希'),
      importedAt: normalizeDate(item.importedAt, '导入时间')!,
      deletedAt: normalizeDate(item.deletedAt, '资料删除时间', true),
      createdAt: normalizeDate(item.createdAt, '资料创建时间')!,
      updatedAt: normalizeDate(item.updatedAt, '资料更新时间')!,
      ...(item.subjectId === undefined ? {} : { subjectId: normalizeId(item.subjectId, '资料科目标识') }),
    };
  });
  const chapters: DataExportChapter[] = array('chapters').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复章节记录无效。');
    return {
      id: normalizeId(item.id, '章节标识'), materialId: normalizeId(item.materialId, '章节资料标识'),
      title: normalizeText(item.title, '章节标题', 255), sortOrder: numberValue(item.sortOrder),
      deletedAt: normalizeDate(item.deletedAt, '章节删除时间', true), createdAt: normalizeDate(item.createdAt, '章节创建时间')!, updatedAt: normalizeDate(item.updatedAt, '章节更新时间')!,
    };
  });
  const sections: DataExportSection[] = array('sections').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复小节记录无效。');
    return {
      id: normalizeId(item.id, '小节标识'), chapterId: normalizeId(item.chapterId, '小节章节标识'),
      title: normalizeText(item.title, '小节标题', 255), sortOrder: numberValue(item.sortOrder),
      deletedAt: normalizeDate(item.deletedAt, '小节删除时间', true), createdAt: normalizeDate(item.createdAt, '小节创建时间')!, updatedAt: normalizeDate(item.updatedAt, '小节更新时间')!,
    };
  });
  const cards: DataExportCard[] = array('cards').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复闪卡记录无效。');
    return {
      id: normalizeId(item.id, '闪卡标识'), sectionId: normalizeId(item.sectionId, '闪卡小节标识'),
      title: normalizeText(item.title, '闪卡标题', 255), content: normalizeContent(item.content), masteryStatus: normalizeMasteryStatus(item.masteryStatus, '闪卡掌握状态'),
      sortOrder: numberValue(item.sortOrder), deletedAt: normalizeDate(item.deletedAt, '闪卡删除时间', true),
      createdAt: normalizeDate(item.createdAt, '闪卡创建时间')!, updatedAt: normalizeDate(item.updatedAt, '闪卡更新时间')!,
    };
  });
  const resources: DataExportResource[] = array('resources').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复资源记录无效。');
    const encoded = item.contentBase64;
    if (encoded !== null && typeof encoded !== 'string') throw new DataGovernanceApiError(400, '恢复资源内容无效。');
    if (typeof encoded === 'string' && (encoded.length > 8 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))) {
      throw new DataGovernanceApiError(400, '恢复资源内容过大或格式无效。');
    }
    return {
      id: normalizeId(item.id, '资源标识'), relativePath: safeRelativePath(item.relativePath), mimeType: normalizeText(item.mimeType, '资源类型', 100),
      width: item.width === null ? null : numberValue(item.width), height: item.height === null ? null : numberValue(item.height),
      sha256: normalizeSha256(item.sha256, '资源哈希'), createdAt: normalizeDate(item.createdAt, '资源创建时间')!,
      deletedAt: normalizeDate(item.deletedAt, '资源删除时间', true), contentBase64: encoded,
    };
  });
  if (resources.reduce((total, item) => total + (item.contentBase64?.length ?? 0), 0) > 32 * 1024 * 1024) {
    throw new DataGovernanceApiError(400, '恢复资源总量不能超过 32MB。');
  }
  const highlights: DataExportHighlight[] = array('highlights').map((item) => {
    if (!isRecord(item) || (item.kind !== 'text' && item.kind !== 'formula')) throw new DataGovernanceApiError(400, '恢复高亮记录无效。');
    return { id: normalizeId(item.id, '高亮标识'), cardId: normalizeId(item.cardId, '高亮闪卡标识'), kind: item.kind, anchor: normalizeAnchor(item.anchor), createdAt: normalizeDate(item.createdAt, '高亮创建时间')!, updatedAt: normalizeDate(item.updatedAt, '高亮更新时间')! };
  });
  const reviewRecords: DataExportReviewRecord[] = array('reviewRecords').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复复习记录无效。');
    return { cardId: normalizeId(item.cardId, '复习记录闪卡标识'), firstViewedAt: normalizeDate(item.firstViewedAt, '首次查看时间', true), lastViewedAt: normalizeDate(item.lastViewedAt, '最近查看时间', true), statusChangedAt: normalizeDate(item.statusChangedAt, '状态变更时间', true), viewCount: Math.max(0, Math.floor(numberValue(item.viewCount))) };
  });
  const aiExplanations: DataExportAiExplanation[] = array('aiExplanations').map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复 AI 讲解记录无效。');
    return { cardId: normalizeId(item.cardId, '讲解闪卡标识'), provider: normalizeText(item.provider, '讲解 Provider', 100), model: normalizeText(item.model, '讲解模型', 255), promptText: normalizeText(item.promptText, '讲解提示词', 20000), content: normalizeText(item.content, '讲解内容', 1_000_000), generatedAt: normalizeDate(item.generatedAt, '讲解生成时间')! };
  });
  const trashItems: DataExportTrashItem[] = array('trashItems').map((item) => {
    if (!isRecord(item) || !['material', 'chapter', 'section', 'card', 'question_bank', 'question_chapter', 'question'].includes(String(item.entityType))) throw new DataGovernanceApiError(400, '恢复回收站记录无效。');
    if (!isRecord(item.payload)) throw new DataGovernanceApiError(400, '恢复回收站载荷无效。');
    return { id: normalizeId(item.id, '回收站标识'), entityType: item.entityType as DataExportTrashEntityType, entityId: normalizeId(item.entityId, '回收站对象标识'), payload: item.payload, deletedAt: normalizeDate(item.deletedAt, '删除时间')!, expiresAt: normalizeDate(item.expiresAt, '过期时间', true), restoredAt: normalizeDate(item.restoredAt, '恢复时间', true) };
  });
  const appSettings: DataJsonExport['appSettings'] = array('appSettings').map((item) => {
    if (!isRecord(item) || !isRecord(item.settingValue)) throw new DataGovernanceApiError(400, '恢复应用设置无效。');
    if (item.settingKey === 'review.lastCardId') {
      return { settingKey: 'review.lastCardId', settingValue: { cardId: normalizeId(item.settingValue.cardId, '最近闪卡标识') } };
    }
    if (item.settingKey === 'review.lastCards') {
      if (!isRecord(item.settingValue.cardIdsByMaterial)) throw new DataGovernanceApiError(400, '恢复资料进度无效。');
      const cardIdsByMaterial = Object.fromEntries(Object.entries(item.settingValue.cardIdsByMaterial).map(([materialId, cardId]) => [
        normalizeId(materialId, '资料进度资料标识'),
        normalizeId(cardId, '资料进度闪卡标识'),
      ]));
      return { settingKey: 'review.lastCards', settingValue: { cardIdsByMaterial } };
    }
    throw new DataGovernanceApiError(400, '恢复应用设置无效。');
  });
  const catalog = courseEntries === null ? legacyCatalog(exportedAt) : {
    courses: courseEntries.map((item): DataExportCourse => {
      if (!isRecord(item) || typeof item.isSystem !== 'boolean') throw new DataGovernanceApiError(400, '恢复课程记录无效。');
      return {
        id: normalizeId(item.id, '课程标识'), name: normalizeText(item.name, '课程名称', 255), sortOrder: normalizeSortOrder(item.sortOrder, '课程排序'), isSystem: item.isSystem,
        deletedAt: normalizeDate(item.deletedAt, '课程删除时间', true), createdAt: normalizeDate(item.createdAt, '课程创建时间')!, updatedAt: normalizeDate(item.updatedAt, '课程更新时间')!,
      };
    }),
    subjects: subjectEntries!.map((item): DataExportSubject => {
      if (!isRecord(item) || typeof item.isSystem !== 'boolean') throw new DataGovernanceApiError(400, '恢复科目记录无效。');
      return {
        id: normalizeId(item.id, '科目标识'), courseId: normalizeId(item.courseId, '科目课程标识'), name: normalizeText(item.name, '科目名称', 255), sortOrder: normalizeSortOrder(item.sortOrder, '科目排序'), isSystem: item.isSystem,
        deletedAt: normalizeDate(item.deletedAt, '科目删除时间', true), createdAt: normalizeDate(item.createdAt, '科目创建时间')!, updatedAt: normalizeDate(item.updatedAt, '科目更新时间')!,
      };
    }),
  };
  const materialCovers: DataExportMaterialCover[] = (optionalArray('materialCovers') ?? []).map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复资料封面记录无效。');
    return {
      id: normalizeId(item.id, '封面标识'), materialId: normalizeId(item.materialId, '封面资料标识'), originalResourceId: normalizeId(item.originalResourceId, '封面原图资源标识'), thumbnailResourceId: normalizeId(item.thumbnailResourceId, '封面缩略图资源标识'),
      createdAt: normalizeDate(item.createdAt, '封面创建时间')!, updatedAt: normalizeDate(item.updatedAt, '封面更新时间')!,
    };
  });
  const reviewStatusHistory: DataExportReviewStatusHistory[] = (optionalArray('reviewStatusHistory') ?? []).map((item) => {
    if (!isRecord(item) || !['import', 'review', 'migration', 'restore'].includes(String(item.source))) {
      throw new DataGovernanceApiError(400, '恢复掌握状态历史记录无效。');
    }
    return {
      id: normalizeId(item.id, '状态历史标识'), cardId: normalizeId(item.cardId, '状态历史闪卡标识'),
      fromStatus: item.fromStatus === null ? null : normalizeMasteryStatus(item.fromStatus, '状态历史原状态'),
      toStatus: normalizeMasteryStatus(item.toStatus, '状态历史目标状态'), changedAt: normalizeDate(item.changedAt, '状态历史变更时间')!,
      source: item.source as DataExportReviewStatusHistory['source'],
    };
  });
  if (courseEntries !== null && materials.some((item) => !item.subjectId)) {
    throw new DataGovernanceApiError(400, '恢复文件的资料缺少科目归属。');
  }
  const normalizedMaterials = materials.map((item) => ({ ...item, subjectId: item.subjectId ?? defaultSubjectId }));

  duplicateIds(catalog.courses, '课程'); duplicateIds(catalog.subjects, '科目'); duplicateIds(normalizedMaterials, '资料'); duplicateIds(chapters, '章节'); duplicateIds(sections, '小节'); duplicateIds(cards, '闪卡'); duplicateIds(resources, '资源'); duplicateIds(highlights, '高亮'); duplicateIds(trashItems, '回收站'); duplicateIds(materialCovers, '资料封面'); duplicateIds(reviewStatusHistory, '掌握状态历史');
  const courseIds = new Set(catalog.courses.map((item) => item.id));
  const subjectIds = new Set(catalog.subjects.map((item) => item.id));
  const materialIds = new Set(normalizedMaterials.map((item) => item.id));
  const chapterIds = new Set(chapters.map((item) => item.id));
  const sectionIds = new Set(sections.map((item) => item.id));
  const cardIds = new Set(cards.map((item) => item.id));
  const resourceIds = new Set(resources.map((item) => item.id));
  if (!courseIds.has(defaultCourseId) || !subjectIds.has(defaultSubjectId) || !catalog.courses.some((item) => item.id === defaultCourseId && item.isSystem) || !catalog.subjects.some((item) => item.id === defaultSubjectId && item.courseId === defaultCourseId && item.isSystem)) {
    throw new DataGovernanceApiError(400, '恢复文件缺少系统默认课程或科目。');
  }
  if (catalog.subjects.some((item) => !courseIds.has(item.courseId)) || normalizedMaterials.some((item) => !subjectIds.has(item.subjectId)) || chapters.some((item) => !materialIds.has(item.materialId)) || sections.some((item) => !chapterIds.has(item.chapterId)) || cards.some((item) => !sectionIds.has(item.sectionId))) {
    throw new DataGovernanceApiError(400, '恢复文件的层级关系无效。');
  }
  const coverMaterialIds = new Set<string>();
  const coverResourceIds = new Set<string>();
  for (const item of materialCovers) {
    if (!materialIds.has(item.materialId) || !resourceIds.has(item.originalResourceId) || !resourceIds.has(item.thumbnailResourceId) || coverMaterialIds.has(item.materialId) || coverResourceIds.has(item.originalResourceId) || coverResourceIds.has(item.thumbnailResourceId)) {
      throw new DataGovernanceApiError(400, '恢复文件的资料封面关联无效。');
    }
    coverMaterialIds.add(item.materialId);
    coverResourceIds.add(item.originalResourceId);
    coverResourceIds.add(item.thumbnailResourceId);
  }
  if (highlights.some((item) => !cardIds.has(item.cardId)) || reviewRecords.some((item) => !cardIds.has(item.cardId)) || aiExplanations.some((item) => !cardIds.has(item.cardId)) || reviewStatusHistory.some((item) => !cardIds.has(item.cardId)) || trashItems.some((item) => !new Set([...materialIds, ...chapterIds, ...sectionIds, ...cardIds, ...questionBankIds, ...questionChapterIds, ...questionIds]).has(item.entityId))) {
    throw new DataGovernanceApiError(400, '恢复文件引用了不存在的对象。');
  }
  const referencedResources = new Set<string>();
  const walk = (nodes: ReviewContentNode[]) => nodes.forEach((node) => { if (node.resourceId) referencedResources.add(node.resourceId); if (node.children) walk(node.children); });
  cards.forEach((card) => walk(card.content));
  materialCovers.forEach((cover) => { referencedResources.add(cover.originalResourceId); referencedResources.add(cover.thumbnailResourceId); });
  if ([...referencedResources].some((id) => !resourceIds.has(id))) {
    throw new DataGovernanceApiError(400, '恢复文件引用了不存在的图片资源。');
  }
  if (new Set(appSettings.map((item) => item.settingKey)).size !== appSettings.length) {
    throw new DataGovernanceApiError(400, '恢复应用设置重复。');
  }
  const materialIdByChapterId = new Map(chapters.map((item) => [item.id, item.materialId]));
  const materialIdBySectionId = new Map(sections.map((item) => [item.id, materialIdByChapterId.get(item.chapterId)]));
  const materialIdByCardId = new Map(cards.map((item) => [item.id, materialIdBySectionId.get(item.sectionId)]));
  const invalidLastCard = appSettings.some((item) => item.settingKey === 'review.lastCardId'
    ? !cardIds.has(item.settingValue.cardId)
    : Object.entries(item.settingValue.cardIdsByMaterial).some(([materialId, cardId]) => !materialIds.has(materialId) || materialIdByCardId.get(cardId) !== materialId));
  if (invalidLastCard) {
    throw new DataGovernanceApiError(400, '恢复文件的最近闪卡不存在。');
  }
  const questionBanks: DataExportQuestionBank[] = (optionalArray('questionBanks') ?? []).map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复题库记录无效。');
    return { id: normalizeId(item.id, '题库标识'), subjectId: normalizeId(item.subjectId, '题库科目标识'), kind: normalizeQuestionBankKind(item.kind), name: normalizeText(item.name, '题库名称', 255), sortOrder: normalizeSortOrder(item.sortOrder, '题库排序'), deletedAt: normalizeDate(item.deletedAt, '题库删除时间', true), createdAt: normalizeDate(item.createdAt, '题库创建时间')!, updatedAt: normalizeDate(item.updatedAt, '题库更新时间')! };
  });
  const questionChapters: DataExportQuestionChapter[] = (optionalArray('questionChapters') ?? []).map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复题库章节记录无效。');
    return { id: normalizeId(item.id, '题库章节标识'), questionBankId: normalizeId(item.questionBankId, '题库章节题库标识'), title: normalizeText(item.title, '题库章节标题', 255), sortOrder: normalizeSortOrder(item.sortOrder, '题库章节排序'), deletedAt: normalizeDate(item.deletedAt, '题库章节删除时间', true), createdAt: normalizeDate(item.createdAt, '题库章节创建时间')!, updatedAt: normalizeDate(item.updatedAt, '题库章节更新时间')! };
  });
  const questions: DataExportQuestion[] = (optionalArray('questions') ?? []).map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复题目记录无效。');
    const type = normalizeQuestionType(item.type);
    const answer = normalizeQuestionAnswer(item.answer);
    const options = normalizeQuestionOptions(item.options);
    const keys = options.map((option) => option.key);
    if (keys.some((key, index) => key !== String.fromCharCode(65 + index)) || new Set(keys).size !== keys.length || answer.some((key) => !keys.includes(key))) {
      throw new DataGovernanceApiError(400, '恢复文件的题目选项或答案不连续。');
    }
    if (type === 'multiple' ? answer.length < 2 : answer.length !== 1) throw new DataGovernanceApiError(400, '恢复文件的题目答案数量与题型不匹配。');
    if (type === 'true_false' && (keys.length !== 2 || options[0]?.content?.[0]?.value !== '对' || options[1]?.content?.[0]?.value !== '错' || !['A', 'B'].includes(answer[0]!))) throw new DataGovernanceApiError(400, '恢复文件的判断题格式无效。');
    return { id: normalizeId(item.id, '题目标识'), questionBankId: normalizeId(item.questionBankId, '题目题库标识'), questionChapterId: item.questionChapterId === null ? null : normalizeId(item.questionChapterId, '题目章节标识'), stem: normalizeContent(item.stem), type, options, answer, analysis: item.analysis === null ? null : normalizeContent(item.analysis), knowledgePoints: normalizeStringArray(item.knowledgePoints ?? [], '题目知识点'), version: normalizeSortOrder(item.version, '题目版本') || 1, sortOrder: normalizeSortOrder(item.sortOrder, '题目排序'), deletedAt: normalizeDate(item.deletedAt, '题目删除时间', true), createdAt: normalizeDate(item.createdAt, '题目创建时间')!, updatedAt: normalizeDate(item.updatedAt, '题目更新时间')! };
  });
  const questionAiExplanations: DataExportQuestionAiExplanation[] = (optionalArray('questionAiExplanations') ?? []).map((item) => {
    if (!isRecord(item)) throw new DataGovernanceApiError(400, '恢复题目 AI 讲解记录无效。');
    return { id: normalizeId(item.id, '题目讲解标识'), questionId: normalizeId(item.questionId, '题目讲解题目标识'), questionVersion: normalizeSortOrder(item.questionVersion, '题目讲解版本'), provider: normalizeText(item.provider, '题目讲解 Provider', 100), model: normalizeText(item.model, '题目讲解模型', 255), promptText: normalizePromptText(item.promptText, '题目讲解提示词'), content: normalizeText(item.content, '题目讲解内容', 1_000_000), generatedAt: normalizeDate(item.generatedAt, '题目讲解生成时间')! };
  });
  const practiceSessions: DataExportPracticeSession[] = (optionalArray('practiceSessions') ?? []).map((item) => {
    if (!isRecord(item) || !isRecord(item.scope)) throw new DataGovernanceApiError(400, '恢复刷题会话记录无效。');
    return { id: normalizeId(item.id, '刷题会话标识'), questionBankId: normalizeId(item.questionBankId, '刷题会话题库标识'), questionChapterId: item.questionChapterId === null ? null : normalizeId(item.questionChapterId, '刷题会话章节标识'), mode: normalizePracticeMode(item.mode), source: normalizePracticeSource(item.source), scope: item.scope, status: normalizePracticeSessionStatus(item.status), startedAt: normalizeDate(item.startedAt, '刷题会话开始时间')!, completedAt: normalizeDate(item.completedAt, '刷题会话完成时间', true), createdAt: normalizeDate(item.createdAt, '刷题会话创建时间')!, updatedAt: normalizeDate(item.updatedAt, '刷题会话更新时间')! };
  });
  const practiceAttempts: DataExportPracticeAttempt[] = (optionalArray('practiceAttempts') ?? []).map((item) => {
    if (!isRecord(item) || !isRecord(item.snapshot)) throw new DataGovernanceApiError(400, '恢复作答快照记录无效。');
    const answer = item.answer === null ? null : normalizeQuestionAnswer(item.answer);
    return { id: normalizeId(item.id, '作答记录标识'), practiceSessionId: normalizeId(item.practiceSessionId, '作答会话标识'), questionId: normalizeId(item.questionId, '作答题目标识'), questionVersion: normalizeSortOrder(item.questionVersion, '作答题目版本'), sortOrder: normalizeSortOrder(item.sortOrder, '作答排序'), snapshot: item.snapshot, answer, result: normalizePracticeAttemptResult(item.result), answeredAt: normalizeDate(item.answeredAt, '作答时间', true), createdAt: normalizeDate(item.createdAt, '作答创建时间')!, updatedAt: normalizeDate(item.updatedAt, '作答更新时间')! };
  });
  duplicateIds(questionBanks, '题库'); duplicateIds(questionChapters, '题库章节'); duplicateIds(questions, '题目'); duplicateIds(questionAiExplanations, '题目讲解'); duplicateIds(practiceSessions, '刷题会话'); duplicateIds(practiceAttempts, '作答记录');
  const questionBankIds = new Set(questionBanks.map((item) => item.id));
  const questionChapterIds = new Set(questionChapters.map((item) => item.id));
  const questionIds = new Set(questions.map((item) => item.id));
  const sessionIds = new Set(practiceSessions.map((item) => item.id));
  const questionBankById = new Map(questionBanks.map((item) => [item.id, item]));
  const questionChapterById = new Map(questionChapters.map((item) => [item.id, item]));
  if (questionBanks.some((item) => !subjectIds.has(item.subjectId)) || questionChapters.some((item) => !questionBankIds.has(item.questionBankId) || questionBankById.get(item.questionBankId)?.kind !== 'chapter') || questions.some((item) => {
    const bank = questionBankById.get(item.questionBankId);
    const chapter = item.questionChapterId === null ? null : questionChapterById.get(item.questionChapterId);
    return !bank || (bank.kind === 'chapter' ? !chapter || chapter.questionBankId !== bank.id : chapter !== null);
  }) || questionAiExplanations.some((item) => !questionIds.has(item.questionId)) || practiceSessions.some((item) => {
    const bank = questionBankById.get(item.questionBankId);
    const chapter = item.questionChapterId === null ? null : questionChapterById.get(item.questionChapterId);
    return !bank || (bank.kind === 'chapter' ? !chapter || chapter.questionBankId !== bank.id : chapter !== null);
  }) || practiceAttempts.some((item) => !sessionIds.has(item.practiceSessionId) || !questionIds.has(item.questionId))) {
    throw new DataGovernanceApiError(400, '恢复文件的题库层级关系无效。');
  }
  return {
    sourceVersion,
    payload: { format: 'knowledge-flashcards-json', version: 2, exportedAt, materials: normalizedMaterials, chapters, sections, cards, resources, highlights, reviewRecords, aiExplanations, trashItems, appSettings, courses: catalog.courses, subjects: catalog.subjects, materialCovers, reviewStatusHistory, questionBanks, questionChapters, questions, questionAiExplanations, practiceSessions, practiceAttempts },
  };
}

function contentForMarkdown(nodes: ReviewContentNode[]): Record<string, unknown>[] {
  return nodes.map((node) => {
    const copy: Record<string, unknown> = { ...node };
    delete copy.resourceId;
    if (node.type === 'image' && node.resourcePath) {
      copy.url = node.url || node.resourcePath;
    }
    if (node.children) {
      copy.children = contentForMarkdown(node.children);
    }
    return copy;
  });
}

const markdownHandlers: Partial<Record<string, Handle>> = {
  inlineMath: (node) => `$${String(node.value ?? '').replaceAll('$', '\\$')}$`,
  math: (node) => `$$\n${String(node.value ?? '')}\n$$`,
};

function markdownForCard(content: ReviewContentNode[]): string {
  return toMarkdown({ type: 'root', children: contentForMarkdown(content) } as never, {
    extensions: [gfmToMarkdown()],
    handlers: markdownHandlers as never,
  }).trim();
}

function cardContent(row: Record<string, unknown>): ReviewContentNode[] {
  const parsed = parseJson(row.content_json);
  return Array.isArray(parsed) ? parsed as ReviewContentNode[] : [];
}

function rowToMaterial(row: Record<string, unknown>): DataExportMaterial {
  const subjectId = textValue(row.subject_id);
  return {
    id: textValue(row.id), name: textValue(row.name), sourceFilename: textValue(row.source_filename), sourceSha256: textValue(row.source_sha256), importedAt: dateValue(row.imported_at), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at),
    ...(subjectId ? { subjectId } : {}),
  };
}

async function readResourceContent(resourcesDirectory: string, relativePath: string, sha256: string): Promise<string | null> {
  const absolutePath = path.resolve(resourcesDirectory, relativePath);
  if (!isPathInside(resourcesDirectory, absolutePath)) return null;
  try {
    const source = await fs.readFile(absolutePath);
    if (createHash('sha256').update(source).digest('hex') !== sha256) return null;
    return source.toString('base64');
  } catch {
    return null;
  }
}

const backupRetentionCount = 7;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function backupManifest(value: unknown): DataBackupFileManifest[] {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isRecord).flatMap((item) => {
    if (typeof item.path !== 'string' || !Number.isFinite(Number(item.byteLength)) || typeof item.sha256 !== 'string') {
      return [];
    }
    return [{ path: item.path, byteLength: Math.max(0, Math.floor(Number(item.byteLength))), sha256: item.sha256 }];
  });
}

function rowToBackup(row: Record<string, unknown>): DataBackupSummary {
  return {
    id: textValue(row.id),
    startedAt: dateValue(row.started_at),
    finishedAt: nullableDateValue(row.finished_at),
    status: textValue(row.status) as DataBackupSummary['status'],
    fileManifest: backupManifest(row.file_manifest),
    errorMessage: row.error_message === null || row.error_message === undefined ? null : textValue(row.error_message),
  };
}

function resourceIdsFromContent(nodes: unknown, result = new Set<string>()): Set<string> {
  if (!Array.isArray(nodes)) {
    return result;
  }
  for (const node of nodes) {
    if (!isRecord(node)) {
      continue;
    }
    if (typeof node.resourceId === 'string' && node.resourceId) {
      result.add(node.resourceId);
    }
    resourceIdsFromContent(node.children, result);
  }
  return result;
}

function sqlIn(values: string[]): string {
  return values.map(() => '?').join(', ');
}

type PermanentEntityIds = {
  material: string[];
  chapter: string[];
  section: string[];
  card: string[];
};

async function collectPermanentEntityIds(
  connection: DataGovernanceSqlExecutor,
  entityType: HierarchyEntityType,
  entityId: string,
): Promise<PermanentEntityIds> {
  const result: PermanentEntityIds = { material: [], chapter: [], section: [], card: [] };
  if (entityType === 'material') {
    result.material = [entityId];
    const [chapters] = await connection.execute('SELECT id FROM chapters WHERE material_id = ?', [entityId]);
    result.chapter = rowsFrom(chapters).map((row) => textValue(row.id));
    if (result.chapter.length > 0) {
      const [sections] = await connection.execute(`SELECT id FROM sections WHERE chapter_id IN (${sqlIn(result.chapter)})`, result.chapter);
      result.section = rowsFrom(sections).map((row) => textValue(row.id));
    }
    if (result.section.length > 0) {
      const [cards] = await connection.execute(`SELECT id FROM cards WHERE section_id IN (${sqlIn(result.section)})`, result.section);
      result.card = rowsFrom(cards).map((row) => textValue(row.id));
    }
    return result;
  }

  if (entityType === 'chapter') {
    result.chapter = [entityId];
    const [sections] = await connection.execute('SELECT id FROM sections WHERE chapter_id = ?', [entityId]);
    result.section = rowsFrom(sections).map((row) => textValue(row.id));
    if (result.section.length > 0) {
      const [cards] = await connection.execute(`SELECT id FROM cards WHERE section_id IN (${sqlIn(result.section)})`, result.section);
      result.card = rowsFrom(cards).map((row) => textValue(row.id));
    }
    return result;
  }

  if (entityType === 'section') {
    result.section = [entityId];
    const [cards] = await connection.execute('SELECT id FROM cards WHERE section_id = ?', [entityId]);
    result.card = rowsFrom(cards).map((row) => textValue(row.id));
    return result;
  }

  result.card = [entityId];
  return result;
}

export class DataGovernanceServiceImpl implements DataGovernanceService {
  private readonly resourcesDirectory: string;
  private readonly backupsDirectory: string;

  constructor(
    private readonly database: DataGovernanceDatabase,
    resourcesDirectory = config.storage.resources,
    backupsDirectory = config.storage.backups,
  ) {
    this.resourcesDirectory = resourcesDirectory;
    this.backupsDirectory = path.resolve(backupsDirectory);
  }

  async exportMarkdown(materialId: string): Promise<MarkdownExport> {
    const id = normalizeId(materialId, '资料标识');
    const [rows] = await this.database.execute(
      `SELECT m.id AS material_id, m.name AS material_name, ch.title AS chapter_title, ch.sort_order AS chapter_sort_order,
              s.title AS section_title, s.sort_order AS section_sort_order, c.title AS card_title, c.sort_order AS card_sort_order,
              c.content_json
       FROM materials AS m
       INNER JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
       INNER JOIN sections AS s ON s.chapter_id = ch.id AND s.deleted_at IS NULL
       INNER JOIN cards AS c ON c.section_id = s.id AND c.deleted_at IS NULL
       WHERE m.id = ? AND m.deleted_at IS NULL
       ORDER BY ch.sort_order, s.sort_order, c.sort_order, c.id`,
      [id],
    );
    const sourceRows = rowsFrom(rows);
    if (sourceRows.length === 0) {
      throw new DataGovernanceApiError(404, '资料不存在或已删除。');
    }
    const materialName = textValue(sourceRows[0]?.material_name) || '资料';
    const blocks = [`# ${materialName}`];
    let lastChapter = '';
    let lastSection = '';
    for (const row of sourceRows) {
      const chapter = textValue(row.chapter_title);
      const section = textValue(row.section_title);
      if (chapter !== lastChapter) {
        blocks.push(`## ${chapter}`);
        lastChapter = chapter;
        lastSection = '';
      }
      if (section !== lastSection) {
        blocks.push(`### ${section}`);
        lastSection = section;
      }
      blocks.push(`#### ${textValue(row.card_title)}\n\n${markdownForCard(cardContent(row))}`.trim());
    }
    const safeName = materialName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || '资料';
    return { fileName: `${safeName}.md`, content: `${blocks.join('\n\n')}\n` };
  }

  async exportJson(): Promise<DataJsonExportV2> {
    const [courseRows, subjectRows, materialRows, chapterRows, sectionRows, cardRows, resourceRows, highlightRows, reviewRows, explanationRows, trashRows, settingRows, materialCoverRows, statusHistoryRows, questionBankRows, questionChapterRows, questionRows, questionAiExplanationRows, practiceSessionRows, practiceAttemptRows] = await Promise.all([
      this.database.execute('SELECT id, name, sort_order, is_system, deleted_at, created_at, updated_at FROM courses ORDER BY sort_order, created_at, id'),
      this.database.execute('SELECT id, course_id, name, sort_order, is_system, deleted_at, created_at, updated_at FROM subjects ORDER BY course_id, sort_order, created_at, id'),
      this.database.execute('SELECT id, subject_id, name, source_filename, source_sha256, imported_at, deleted_at, created_at, updated_at FROM materials ORDER BY created_at, id'),
      this.database.execute('SELECT id, material_id, title, sort_order, deleted_at, created_at, updated_at FROM chapters ORDER BY material_id, sort_order, id'),
      this.database.execute('SELECT id, chapter_id, title, sort_order, deleted_at, created_at, updated_at FROM sections ORDER BY chapter_id, sort_order, id'),
      this.database.execute('SELECT id, section_id, title, content_json, mastery_status, sort_order, deleted_at, created_at, updated_at FROM cards ORDER BY section_id, sort_order, id'),
      this.database.execute('SELECT id, relative_path, mime_type, width, height, sha256, created_at, deleted_at FROM resources ORDER BY id'),
      this.database.execute('SELECT id, card_id, kind, anchor_json, created_at, updated_at FROM highlights ORDER BY card_id, created_at, id'),
      this.database.execute('SELECT card_id, first_viewed_at, last_viewed_at, status_changed_at, view_count FROM review_records ORDER BY card_id'),
      this.database.execute('SELECT card_id, provider, model, prompt_text, content_json, generated_at FROM ai_explanations ORDER BY card_id'),
      this.database.execute('SELECT id, entity_type, entity_id, payload_json, deleted_at, expires_at, restored_at FROM trash_items ORDER BY deleted_at, id'),
      this.database.execute("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')"),
      this.database.execute('SELECT id, material_id, original_resource_id, thumbnail_resource_id, created_at, updated_at FROM material_covers ORDER BY material_id'),
      this.database.execute('SELECT id, card_id, from_status, to_status, changed_at, source FROM review_status_history ORDER BY card_id, changed_at, id'),
      this.database.execute('SELECT id, subject_id, kind, name, sort_order, deleted_at, created_at, updated_at FROM question_banks ORDER BY subject_id, kind, sort_order, id'),
      this.database.execute('SELECT id, question_bank_id, title, sort_order, deleted_at, created_at, updated_at FROM question_chapters ORDER BY question_bank_id, sort_order, id'),
      this.database.execute('SELECT id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order, deleted_at, created_at, updated_at FROM questions ORDER BY question_bank_id, sort_order, id'),
      this.database.execute('SELECT id, question_id, question_version, provider, model, prompt_text, content_json, generated_at FROM question_ai_explanations ORDER BY question_id, generated_at, id'),
      this.database.execute('SELECT id, question_bank_id, question_chapter_id, mode, source, scope_json, status, started_at, completed_at, created_at, updated_at FROM practice_sessions ORDER BY started_at, id'),
      this.database.execute('SELECT id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result, answered_at, created_at, updated_at FROM practice_attempts ORDER BY practice_session_id, sort_order, id'),
    ]);
    const resources: DataExportResource[] = await Promise.all(rowsFrom(resourceRows[0]).map(async (row) => ({
      id: textValue(row.id), relativePath: textValue(row.relative_path), mimeType: textValue(row.mime_type), width: row.width === null ? null : numberValue(row.width), height: row.height === null ? null : numberValue(row.height), sha256: textValue(row.sha256), createdAt: dateValue(row.created_at), deletedAt: nullableDateValue(row.deleted_at), contentBase64: await readResourceContent(this.resourcesDirectory, textValue(row.relative_path), textValue(row.sha256)),
    })));
    const aiExplanations: DataExportAiExplanation[] = rowsFrom(explanationRows[0]).map((row) => {
      const content = parseJson(row.content_json);
      return { cardId: textValue(row.card_id), provider: textValue(row.provider), model: textValue(row.model), promptText: textValue(row.prompt_text), content: isRecord(content) ? textValue(content.text) : '', generatedAt: dateValue(row.generated_at) };
    });
    return {
      format: 'knowledge-flashcards-json', version: 2, exportedAt: new Date().toISOString(),
      materials: rowsFrom(materialRows[0]).map(rowToMaterial),
      courses: rowsFrom(courseRows[0]).map((row) => ({ id: textValue(row.id), name: textValue(row.name), sortOrder: numberValue(row.sort_order), isSystem: Boolean(row.is_system), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      subjects: rowsFrom(subjectRows[0]).map((row) => ({ id: textValue(row.id), courseId: textValue(row.course_id), name: textValue(row.name), sortOrder: numberValue(row.sort_order), isSystem: Boolean(row.is_system), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      chapters: rowsFrom(chapterRows[0]).map((row) => ({ id: textValue(row.id), materialId: textValue(row.material_id), title: textValue(row.title), sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      sections: rowsFrom(sectionRows[0]).map((row) => ({ id: textValue(row.id), chapterId: textValue(row.chapter_id), title: textValue(row.title), sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      cards: rowsFrom(cardRows[0]).map((row) => ({ id: textValue(row.id), sectionId: textValue(row.section_id), title: textValue(row.title), content: cardContent(row), masteryStatus: textValue(row.mastery_status) as ReviewMasteryStatus, sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      resources,
      highlights: rowsFrom(highlightRows[0]).map((row) => ({ id: textValue(row.id), cardId: textValue(row.card_id), kind: textValue(row.kind) as 'text' | 'formula', anchor: parseJson(row.anchor_json) as ReviewHighlightAnchor, createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      reviewRecords: rowsFrom(reviewRows[0]).map((row) => ({ cardId: textValue(row.card_id), firstViewedAt: nullableDateValue(row.first_viewed_at), lastViewedAt: nullableDateValue(row.last_viewed_at), statusChangedAt: nullableDateValue(row.status_changed_at), viewCount: numberValue(row.view_count) })),
      aiExplanations,
      trashItems: rowsFrom(trashRows[0]).map((row) => ({ id: textValue(row.id), entityType: textValue(row.entity_type) as DataExportTrashEntityType, entityId: textValue(row.entity_id), payload: (parseJson(row.payload_json) as Record<string, unknown>) ?? {}, deletedAt: dateValue(row.deleted_at), expiresAt: nullableDateValue(row.expires_at), restoredAt: nullableDateValue(row.restored_at) })),
      appSettings: rowsFrom(settingRows[0]).flatMap((row): DataJsonExport['appSettings'] => {
        const value = parseJson(row.setting_value);
        if (row.setting_key === 'review.lastCardId' && isRecord(value) && typeof value.cardId === 'string') {
          return [{ settingKey: 'review.lastCardId' as const, settingValue: { cardId: value.cardId } }];
        }
        if (row.setting_key === 'review.lastCards' && isRecord(value)) {
          const cardIdsByMaterial = Object.fromEntries(Object.entries(value).filter(([, cardId]) => typeof cardId === 'string')) as Record<string, string>;
          return [{ settingKey: 'review.lastCards' as const, settingValue: { cardIdsByMaterial } }];
        }
        return [];
      }),
      materialCovers: rowsFrom(materialCoverRows[0]).map((row) => ({ id: textValue(row.id), materialId: textValue(row.material_id), originalResourceId: textValue(row.original_resource_id), thumbnailResourceId: textValue(row.thumbnail_resource_id), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      reviewStatusHistory: rowsFrom(statusHistoryRows[0]).map((row) => ({ id: textValue(row.id), cardId: textValue(row.card_id), fromStatus: row.from_status === null ? null : textValue(row.from_status) as ReviewMasteryStatus, toStatus: textValue(row.to_status) as ReviewMasteryStatus, changedAt: dateValue(row.changed_at), source: textValue(row.source) as DataExportReviewStatusHistory['source'] })),
      questionBanks: rowsFrom(questionBankRows[0]).map((row) => ({ id: textValue(row.id), subjectId: textValue(row.subject_id), kind: textValue(row.kind) as QuestionBankKind, name: textValue(row.name), sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      questionChapters: rowsFrom(questionChapterRows[0]).map((row) => ({ id: textValue(row.id), questionBankId: textValue(row.question_bank_id), title: textValue(row.title), sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      questions: rowsFrom(questionRows[0]).map((row) => ({ id: textValue(row.id), questionBankId: textValue(row.question_bank_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), stem: normalizeContent(parseJson(row.stem_json)), type: textValue(row.question_type) as QuestionType, options: normalizeQuestionOptions(parseJson(row.options_json)), answer: normalizeQuestionAnswer(parseJson(row.answer_json)), analysis: row.analysis_json === null ? null : normalizeContent(parseJson(row.analysis_json)), knowledgePoints: normalizeStringArray(parseJson(row.knowledge_points_json), '题目知识点'), version: numberValue(row.version), sortOrder: numberValue(row.sort_order), deletedAt: nullableDateValue(row.deleted_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      questionAiExplanations: rowsFrom(questionAiExplanationRows[0]).map((row) => { const content = parseJson(row.content_json); return { id: textValue(row.id), questionId: textValue(row.question_id), questionVersion: numberValue(row.question_version), provider: textValue(row.provider), model: textValue(row.model), promptText: textValue(row.prompt_text), content: isRecord(content) ? textValue(content.text) : '', generatedAt: dateValue(row.generated_at) }; }),
      practiceSessions: rowsFrom(practiceSessionRows[0]).map((row) => ({ id: textValue(row.id), questionBankId: textValue(row.question_bank_id), questionChapterId: row.question_chapter_id === null ? null : textValue(row.question_chapter_id), mode: textValue(row.mode) as PracticeMode, source: textValue(row.source) as PracticeSource, scope: (parseJson(row.scope_json) as Record<string, unknown>) ?? {}, status: textValue(row.status) as PracticeSessionStatus, startedAt: dateValue(row.started_at), completedAt: nullableDateValue(row.completed_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
      practiceAttempts: rowsFrom(practiceAttemptRows[0]).map((row) => ({ id: textValue(row.id), practiceSessionId: textValue(row.practice_session_id), questionId: textValue(row.question_id), questionVersion: numberValue(row.question_version), sortOrder: numberValue(row.sort_order), snapshot: (parseJson(row.snapshot_json) as Record<string, unknown>) ?? {}, answer: row.answer_json === null ? null : normalizeQuestionAnswer(parseJson(row.answer_json)), result: textValue(row.result) as PracticeAttemptResult, answeredAt: nullableDateValue(row.answered_at), createdAt: dateValue(row.created_at), updatedAt: dateValue(row.updated_at) })),
    };
  }

  async listBackups(): Promise<DataBackupsResponse> {
    const [rows] = await this.database.execute(
      'SELECT id, started_at, finished_at, file_manifest, status, error_message FROM backup_records ORDER BY started_at DESC, id DESC',
    );
    return { backups: rowsFrom(rows).map(rowToBackup) };
  }

  async createBackup(): Promise<DataBackupResponse> {
    const id = randomUUID();
    const startedAt = new Date();
    const directory = path.join(this.backupsDirectory, id);
    const fileManifest: DataBackupFileManifest[] = [];
    await fs.mkdir(directory, { recursive: true });

    try {
      await this.database.execute(
        'INSERT INTO backup_records (id, started_at, directory, file_manifest, status) VALUES (?, ?, ?, ?, ?)',
        [id, startedAt, directory, JSON.stringify(fileManifest), 'running'],
      );
      const payload = await this.exportJson();
      const dataContent = JSON.stringify(payload, null, 2);
      const dataPath = path.join(directory, 'data.json');
      await fs.writeFile(dataPath, dataContent, 'utf8');
      fileManifest.push({
        path: 'data.json',
        byteLength: Buffer.byteLength(dataContent),
        sha256: createHash('sha256').update(dataContent).digest('hex'),
      });

      for (const resource of payload.resources) {
        if (resource.contentBase64 === null) {
          if (resource.deletedAt === null) {
            throw new Error(`资源 ${resource.relativePath} 不存在，无法完成备份。`);
          }
          continue;
        }
        const relativePath = safeRelativePath(resource.relativePath);
        const source = Buffer.from(resource.contentBase64, 'base64');
        const target = path.resolve(directory, 'resources', relativePath);
        if (!isPathInside(path.join(directory, 'resources'), target)) {
          throw new Error(`资源 ${relativePath} 超出备份目录。`);
        }
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, source);
        fileManifest.push({
          path: path.posix.join('resources', relativePath),
          byteLength: source.length,
          sha256: createHash('sha256').update(source).digest('hex'),
        });
      }

      await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 2, files: fileManifest }, null, 2), 'utf8');
      const finishedAt = new Date();
      await this.database.execute(
        'UPDATE backup_records SET finished_at = ?, file_manifest = ?, status = ?, error_message = NULL WHERE id = ?',
        [finishedAt, JSON.stringify(fileManifest), 'succeeded', id],
      );
      await this.pruneBackups();
      return { backup: { id, startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), status: 'succeeded', fileManifest, errorMessage: null } };
    } catch (error) {
      const message = errorText(error).slice(0, 2000);
      await this.database.execute(
        'UPDATE backup_records SET finished_at = ?, status = ?, error_message = ? WHERE id = ?',
        [new Date(), 'failed', message, id],
      ).catch(() => undefined);
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw new DataGovernanceApiError(500, '备份失败，请检查数据和备份目录。');
    }
  }

  async ensureDailyBackup(): Promise<DataBackupResponse | null> {
    const [rows] = await this.database.execute(
      "SELECT id FROM backup_records WHERE status = 'succeeded' AND started_at >= UTC_DATE() LIMIT 1",
    );
    if (rowsFrom(rows).length > 0) {
      return null;
    }
    return this.createBackup();
  }

  async restoreBackup(backupId: string): Promise<DataRestoreResponse> {
    const id = normalizeId(backupId, '备份标识');
    const [rows] = await this.database.execute(
      "SELECT directory, status FROM backup_records WHERE id = ? LIMIT 1",
      [id],
    );
    const row = rowsFrom(rows)[0];
    if (!row || textValue(row.status) !== 'succeeded') {
      throw new DataGovernanceApiError(404, '备份不存在或不可恢复。');
    }
    const directory = path.resolve(textValue(row.directory));
    if (!isPathInside(this.backupsDirectory, directory)) {
      throw new DataGovernanceApiError(400, '备份目录无效。');
    }
    try {
      const payload = JSON.parse(await fs.readFile(path.join(directory, 'data.json'), 'utf8'));
      return this.restoreJson(payload);
    } catch (error) {
      if (error instanceof DataGovernanceApiError) {
        throw error;
      }
      throw new DataGovernanceApiError(400, '备份文件损坏或不可读取。');
    }
  }

  async restoreJson(value: unknown): Promise<DataRestoreResponse> {
    const { payload, sourceVersion } = normalizeExport(value);
    await this.createBackup();
    const preparedResources = payload.resources.map((resource) => {
      if (resource.contentBase64 === null) {
        return { resource, source: null as Buffer | null };
      }
      const source = Buffer.from(resource.contentBase64, 'base64');
      if (createHash('sha256').update(source).digest('hex') !== resource.sha256) {
        throw new DataGovernanceApiError(400, '恢复文件的资源校验失败。');
      }
      return { resource, source };
    });
    const [oldResourceRows] = await this.database.execute('SELECT relative_path FROM resources');
    const oldPaths = rowsFrom(oldResourceRows).map((row) => textValue(row.relative_path)).filter(Boolean);
    const connection = await this.database.getConnection();
    try {
      await connection.beginTransaction();
      for (const table of ['practice_attempts', 'practice_sessions', 'question_ai_explanations', 'questions', 'question_chapters', 'question_banks', 'sync_locks', 'ai_explanations', 'highlights', 'review_status_history', 'review_records', 'cards', 'sections', 'chapters', 'material_covers', 'materials', 'resources', 'trash_items', 'subjects', 'courses'] as const) {
        await connection.execute(`DELETE FROM ${table}`);
      }
      await connection.execute("DELETE FROM app_settings WHERE setting_key IN ('review.lastCardId', 'review.lastCards')");
      for (const item of payload.courses ?? []) await connection.execute('INSERT INTO courses (id, name, sort_order, is_system, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.name, item.sortOrder, item.isSystem, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.subjects ?? []) await connection.execute('INSERT INTO subjects (id, course_id, name, sort_order, is_system, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.courseId, item.name, item.sortOrder, item.isSystem, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.materials) await connection.execute('INSERT INTO materials (id, subject_id, name, source_filename, source_sha256, imported_at, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.subjectId, item.name, item.sourceFilename, item.sourceSha256, mysqlDateTime(item.importedAt), mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.chapters) await connection.execute('INSERT INTO chapters (id, material_id, title, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.materialId, item.title, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.sections) await connection.execute('INSERT INTO sections (id, chapter_id, title, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.chapterId, item.title, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.resources) await connection.execute('INSERT INTO resources (id, relative_path, mime_type, width, height, sha256, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.relativePath, item.mimeType, item.width, item.height, item.sha256, mysqlDateTime(item.createdAt), mysqlDateTime(item.deletedAt)]);
      for (const item of payload.cards) await connection.execute('INSERT INTO cards (id, section_id, title, content_json, mastery_status, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.sectionId, item.title, JSON.stringify(item.content), item.masteryStatus, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.materialCovers ?? []) await connection.execute('INSERT INTO material_covers (id, material_id, original_resource_id, thumbnail_resource_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [item.id, item.materialId, item.originalResourceId, item.thumbnailResourceId, mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.highlights) await connection.execute('INSERT INTO highlights (id, card_id, kind, anchor_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [item.id, item.cardId, item.kind, JSON.stringify(item.anchor), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.reviewRecords) await connection.execute('INSERT INTO review_records (card_id, first_viewed_at, last_viewed_at, status_changed_at, view_count) VALUES (?, ?, ?, ?, ?)', [item.cardId, mysqlDateTime(item.firstViewedAt), mysqlDateTime(item.lastViewedAt), mysqlDateTime(item.statusChangedAt), item.viewCount]);
      for (const item of payload.reviewStatusHistory ?? []) await connection.execute('INSERT INTO review_status_history (id, card_id, from_status, to_status, changed_at, source) VALUES (?, ?, ?, ?, ?, ?)', [item.id, item.cardId, item.fromStatus, item.toStatus, mysqlDateTime(item.changedAt), item.source]);
      for (const item of payload.aiExplanations) await connection.execute('INSERT INTO ai_explanations (card_id, provider_profile_id, provider, model, prompt_text, content_json, generated_at) VALUES (?, NULL, ?, ?, ?, ?, ?)', [item.cardId, item.provider, item.model, item.promptText, JSON.stringify({ text: item.content }), mysqlDateTime(item.generatedAt)]);
      for (const item of payload.questionBanks) await connection.execute('INSERT INTO question_banks (id, subject_id, kind, name, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.subjectId, item.kind, item.name, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.questionChapters) await connection.execute('INSERT INTO question_chapters (id, question_bank_id, title, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.questionBankId, item.title, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.questions) await connection.execute('INSERT INTO questions (id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order, deleted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.questionBankId, item.questionChapterId, JSON.stringify(item.stem), item.type, JSON.stringify(item.options), JSON.stringify(item.answer), item.analysis === null ? null : JSON.stringify(item.analysis), JSON.stringify(item.knowledgePoints), item.version, item.sortOrder, mysqlDateTime(item.deletedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.questionAiExplanations) await connection.execute('INSERT INTO question_ai_explanations (id, question_id, question_version, provider_profile_id, provider, model, prompt_text, content_json, generated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)', [item.id, item.questionId, item.questionVersion, item.provider, item.model, item.promptText, JSON.stringify({ text: item.content }), mysqlDateTime(item.generatedAt)]);
      for (const item of payload.practiceSessions) await connection.execute('INSERT INTO practice_sessions (id, question_bank_id, question_chapter_id, mode, source, scope_json, status, started_at, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.questionBankId, item.questionChapterId, item.mode, item.source, JSON.stringify(item.scope), item.status, mysqlDateTime(item.startedAt), mysqlDateTime(item.completedAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.practiceAttempts) await connection.execute('INSERT INTO practice_attempts (id, practice_session_id, question_id, question_version, sort_order, snapshot_json, answer_json, result, answered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [item.id, item.practiceSessionId, item.questionId, item.questionVersion, item.sortOrder, JSON.stringify(item.snapshot), item.answer === null ? null : JSON.stringify(item.answer), item.result, mysqlDateTime(item.answeredAt), mysqlDateTime(item.createdAt), mysqlDateTime(item.updatedAt)]);
      for (const item of payload.trashItems) await connection.execute('INSERT INTO trash_items (id, entity_type, entity_id, payload_json, deleted_at, expires_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [item.id, item.entityType, item.entityId, JSON.stringify(item.payload), mysqlDateTime(item.deletedAt), mysqlDateTime(item.expiresAt), mysqlDateTime(item.restoredAt)]);
      for (const item of payload.appSettings) await connection.execute('INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)', [item.settingKey, JSON.stringify(item.settingValue)]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const restoredPaths = new Set(payload.resources.map((item) => item.relativePath));
    for (const relativePath of oldPaths) {
      if (!restoredPaths.has(relativePath)) {
        await fs.rm(path.resolve(this.resourcesDirectory, relativePath), { force: true }).catch(() => undefined);
      }
    }
    for (const { resource, source } of preparedResources) {
      const target = path.resolve(this.resourcesDirectory, resource.relativePath);
      if (!isPathInside(this.resourcesDirectory, target)) {
        throw new DataGovernanceApiError(400, '恢复文件包含不安全资源路径。');
      }
      if (source === null) {
        await fs.rm(target, { force: true });
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
    }
    const restored = {
      materialCount: payload.materials.length, chapterCount: payload.chapters.length, sectionCount: payload.sections.length, cardCount: payload.cards.length, resourceCount: payload.resources.length, highlightCount: payload.highlights.length,
      courseCount: payload.courses?.length ?? 0, subjectCount: payload.subjects?.length ?? 0, materialCoverCount: payload.materialCovers?.length ?? 0, reviewStatusHistoryCount: payload.reviewStatusHistory?.length ?? 0,
    };
    return sourceVersion === 2
      ? { ...restored, questionBankCount: payload.questionBanks.length, questionChapterCount: payload.questionChapters.length, questionCount: payload.questions.length, questionAiExplanationCount: payload.questionAiExplanations.length, practiceSessionCount: payload.practiceSessions.length, practiceAttemptCount: payload.practiceAttempts.length }
      : restored;
  }

  private async pruneBackups() {
    const [rows] = await this.database.execute(
      "SELECT id, directory FROM backup_records WHERE status = 'succeeded' ORDER BY finished_at DESC, id DESC",
    );
    const staleRows = rowsFrom(rows).slice(backupRetentionCount);
    for (const row of staleRows) {
      const id = textValue(row.id);
      const directory = path.resolve(textValue(row.directory));
      if (!isPathInside(this.backupsDirectory, directory) || directory === this.backupsDirectory) {
        continue;
      }
      await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
      await this.database.execute('DELETE FROM backup_records WHERE id = ?', [id]);
    }
  }

  async permanentlyDeleteTrashItem(trashItemId: string): Promise<DataPermanentDeleteResponse> {
    const id = normalizeId(trashItemId, '回收站标识');
    const [trashRows] = await this.database.execute(
      'SELECT entity_type, entity_id FROM trash_items WHERE id = ? AND restored_at IS NULL LIMIT 1',
      [id],
    );
    const trashRow = rowsFrom(trashRows)[0];
    if (!trashRow) {
      throw new DataGovernanceApiError(404, '回收站项目不存在或已恢复。');
    }
    const entityType = textValue(trashRow.entity_type) as HierarchyEntityType;
    const entityId = textValue(trashRow.entity_id);
    const connection = await this.database.getConnection();
    let deletedResources: Array<{ id: string; path: string }> = [];
    let deletedEntityCount = 0;
    try {
      await connection.beginTransaction();
      const entities = await collectPermanentEntityIds(connection, entityType, entityId);
      const allEntityIds = [...entities.material, ...entities.chapter, ...entities.section, ...entities.card];
      if (allEntityIds.length === 0) {
        throw new DataGovernanceApiError(404, '回收站项目对应的内容不存在。');
      }
      const cardRows = entities.card.length > 0
        ? (await connection.execute(`SELECT id, content_json FROM cards WHERE id IN (${sqlIn(entities.card)})`, entities.card))[0]
        : [];
      const resourceIds = new Set<string>();
      for (const row of rowsFrom(cardRows)) {
        resourceIdsFromContent(parseJson(row.content_json), resourceIds);
      }
      if (entities.material.length > 0) {
        const [coverRows] = await connection.execute(
          `SELECT original_resource_id, thumbnail_resource_id FROM material_covers WHERE material_id IN (${sqlIn(entities.material)})`,
          entities.material,
        );
        for (const row of rowsFrom(coverRows)) {
          for (const key of ['original_resource_id', 'thumbnail_resource_id']) {
            const resourceId = textValue(row[key]);
            if (resourceId) resourceIds.add(resourceId);
          }
        }
      }
      const candidateResourceIds = [...resourceIds];
      if (candidateResourceIds.length > 0) {
        const [resourceRows] = await connection.execute(
          `SELECT id, relative_path FROM resources WHERE id IN (${sqlIn(candidateResourceIds)})`,
          candidateResourceIds,
        );
        deletedResources = rowsFrom(resourceRows)
          .map((row) => ({ id: textValue(row.id), path: textValue(row.relative_path) }))
          .filter((resource) => resource.id && resource.path);
      }

      if (entities.card.length > 0) {
        const values = entities.card;
        for (const table of ['sync_locks', 'ai_explanations', 'highlights', 'review_records', 'review_status_history'] as const) {
          await connection.execute(`DELETE FROM ${table} WHERE card_id IN (${sqlIn(values)})`, values);
        }
        await connection.execute(`DELETE FROM cards WHERE id IN (${sqlIn(values)})`, values);
      }
      if (entities.section.length > 0) {
        await connection.execute(`DELETE FROM sections WHERE id IN (${sqlIn(entities.section)})`, entities.section);
      }
      if (entities.chapter.length > 0) {
        await connection.execute(`DELETE FROM chapters WHERE id IN (${sqlIn(entities.chapter)})`, entities.chapter);
      }
      if (entities.material.length > 0) {
        await connection.execute(`DELETE FROM material_covers WHERE material_id IN (${sqlIn(entities.material)})`, entities.material);
        await connection.execute(`DELETE FROM materials WHERE id IN (${sqlIn(entities.material)})`, entities.material);
      }
      for (const [type, ids] of Object.entries(entities) as Array<[HierarchyEntityType, string[]]>) {
        if (ids.length > 0) {
          await connection.execute(`DELETE FROM trash_items WHERE entity_type = ? AND entity_id IN (${sqlIn(ids)})`, [type, ...ids]);
        }
      }

      const remainingResourceIds = new Set<string>();
      const [remainingCardRows] = await connection.execute('SELECT content_json FROM cards');
      for (const row of rowsFrom(remainingCardRows)) {
        resourceIdsFromContent(parseJson(row.content_json), remainingResourceIds);
      }
      const removableResourceIds = candidateResourceIds.filter((resourceId) => !remainingResourceIds.has(resourceId));
      if (removableResourceIds.length > 0) {
        await connection.execute(`DELETE FROM resources WHERE id IN (${sqlIn(removableResourceIds)})`, removableResourceIds);
      }
      await connection.commit();
      deletedEntityCount = allEntityIds.length;
      deletedResources = deletedResources.filter((resource) => !remainingResourceIds.has(resource.id));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    for (const resource of deletedResources) {
      const target = path.resolve(this.resourcesDirectory, resource.path);
      if (isPathInside(this.resourcesDirectory, target)) {
        await fs.rm(target, { force: true }).catch(() => undefined);
      }
    }
    return { deletedEntityCount, deletedResourceCount: deletedResources.length };
  }
}

export function createDataGovernanceDatabase(pool: Pool): DataGovernanceDatabase {
  return {
    execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
    async getConnection() {
      const connection = await pool.getConnection();
      return {
        execute: (sql: string, values?: readonly unknown[]) => connection.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
        beginTransaction: () => connection.beginTransaction(),
        commit: () => connection.commit(),
        rollback: () => connection.rollback(),
        release: () => connection.release(),
      };
    },
  };
}

export function createDataGovernanceService(options: Partial<DataGovernanceServiceOptions> = {}): DataGovernanceService {
  const pool = options.database ? null : createDatabasePool();
  return new DataGovernanceServiceImpl(
    options.database ?? createDataGovernanceDatabase(pool!),
    options.resourcesDirectory ?? config.storage.resources,
    options.backupsDirectory ?? config.storage.backups,
  );
}

export function startBackupScheduler(service: DataGovernanceService) {
  void service.ensureDailyBackup().catch((error) => console.error('每日备份失败。', error));
  const timer = setInterval(() => {
    void service.ensureDailyBackup().catch((error) => console.error('每日备份失败。', error));
  }, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
