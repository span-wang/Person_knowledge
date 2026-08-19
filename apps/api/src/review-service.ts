import type { Pool } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import katex from 'katex';
import {
  type ReviewCardResponse,
  type ReviewCardSummary,
  type ReviewCardContentUpdateRequest,
  type ReviewCardContentUpdateResponse,
  type ReviewCardNavigationItem,
  type ReviewCardNavigation,
  type ReviewContentNode,
  type ReviewAiExplanation,
  type ReviewEditLockResponse,
  type ReviewDashboardResponse,
  type ReviewFilters,
  type ReviewFormulaHighlightAnchor,
  type ReviewHighlight,
  type ReviewHighlightAnchor,
  type ReviewHighlightCreateRequest,
  type ReviewHighlightKind,
  type ReviewHighlightResponse,
  type ReviewMasteryStatus,
  type ReviewMaterialSummary,
  type ReviewRecordSummary,
  type ReviewCardsResponse,
  type ReviewStartScope,
  type ReviewTextHighlightAnchor,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';
import type { ContentNode } from './ingestion.js';

const legacyLastCardSettingKey = 'review.lastCardId';
const lastCardsSettingKey = 'review.lastCards';
const editLockLeaseMs = 90_000;

export interface ReviewEditLockCredentials {
  deviceId: string;
  lockToken: string;
}

export interface ReviewSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface ReviewSqlConnection extends ReviewSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface ReviewDatabase extends ReviewSqlExecutor {
  getConnection(): Promise<ReviewSqlConnection>;
}

export interface ReviewServiceOptions {
  database: ReviewSqlExecutor;
}

export class ReviewApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ReviewApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(isRecord);
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableDateValue(value: unknown): string | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return textValue(value);
}

function requiredLockValue(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 255) {
    throw new ReviewApiError(400, `${label}无效。`);
  }
  return normalized;
}

function contentNodes(value: unknown): ContentNode[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isRecord) as ContentNode[];
}

const reviewNodeTypes = new Set([
  'root',
  'paragraph',
  'heading',
  'text',
  'emphasis',
  'strong',
  'delete',
  'inlineCode',
  'code',
  'blockquote',
  'list',
  'listItem',
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

function safeContentUrl(value: string): string | null {
  const normalized = value.trim();
  if (!normalized || normalized.startsWith('//')) {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(normalized) && !/^(?:https?:|mailto:)/i.test(normalized)) {
    return null;
  }
  return normalized;
}

function reviewContentNode(node: ContentNode): ReviewContentNode | null {
  if (!reviewNodeTypes.has(node.type)) {
    return null;
  }
  const safe: ReviewContentNode = { type: node.type };
  if (typeof node.value === 'string') {
    safe.value = node.value;
  }
  if (typeof node.url === 'string') {
    const url = safeContentUrl(node.url);
    if (url) {
      safe.url = url;
    }
  }
  if (typeof node.resourceId === 'string') {
    safe.resourceId = node.resourceId;
  }
  if (typeof node.resourcePath === 'string') {
    safe.resourcePath = node.resourcePath;
  }
  if (typeof node.title === 'string' || node.title === null) {
    safe.title = node.title;
  }
  if (typeof node.alt === 'string' || node.alt === null) {
    safe.alt = node.alt;
  }
  if (typeof node.lang === 'string' || node.lang === null) {
    safe.lang = node.lang;
  }
  if (typeof node.meta === 'string' || node.meta === null) {
    safe.meta = node.meta;
  }
  if (typeof node.depth === 'number' && Number.isInteger(node.depth)) {
    safe.depth = Math.min(6, Math.max(1, node.depth));
  }
  if (typeof node.ordered === 'boolean') {
    safe.ordered = node.ordered;
  }
  if (typeof node.start === 'number' && Number.isInteger(node.start)) {
    safe.start = node.start;
  }
  if (typeof node.checked === 'boolean' || node.checked === null) {
    safe.checked = node.checked;
  }
  if (typeof node.display === 'boolean') {
    safe.display = node.display;
  }
  if (Array.isArray(node.align)) {
    safe.align = node.align.map((value) =>
      value === 'left' || value === 'center' || value === 'right' ? value : null,
    );
  }
  if (typeof node.header === 'boolean') {
    safe.header = node.header;
  }
  if (typeof node.rowSpan === 'number' && Number.isInteger(node.rowSpan) && node.rowSpan > 0 && node.rowSpan <= 100) {
    safe.rowSpan = node.rowSpan;
  }
  if (typeof node.colSpan === 'number' && Number.isInteger(node.colSpan) && node.colSpan > 0 && node.colSpan <= 100) {
    safe.colSpan = node.colSpan;
  }
  if (Array.isArray(node.children)) {
    safe.children = node.children
      .map((child) => reviewContentNode(child))
      .filter((child): child is ReviewContentNode => child !== null);
  }
  return safe;
}

function reviewContent(value: unknown): ReviewContentNode[] {
  return contentNodes(value)
    .map((node) => reviewContentNode(node))
    .filter((node): node is ReviewContentNode => node !== null);
}

const maxEditableContentNodes = 500;
const maxEditableTextLength = 20_000;
const inlineContentTypes = new Set(['text', 'emphasis', 'strong', 'delete', 'inlineCode', 'inlineMath', 'link', 'break']);
const blockContentTypes = new Set(['paragraph', 'heading', 'code', 'blockquote', 'list', 'thematicBreak', 'image', 'math', 'table']);
const editableNodeTypes = new Set([...inlineContentTypes, ...blockContentTypes, 'listItem', 'tableRow', 'tableCell']);
const valueContentTypes = new Set(['text', 'inlineCode', 'code', 'math', 'inlineMath']);
const nestedContentTypes = new Set(['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'blockquote', 'list', 'listItem', 'table', 'tableRow', 'tableCell']);

function requiredEditorString(value: unknown, label: string, maxLength: number) {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ReviewApiError(400, `${label}格式无效。`);
  }
  return value;
}

function optionalEditorString(value: unknown, label: string, maxLength: number): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ReviewApiError(400, `${label}格式无效。`);
  }
  return value;
}

function allowsChild(parentType: string, childType: string) {
  if (['paragraph', 'heading', 'emphasis', 'strong', 'delete', 'link', 'tableCell'].includes(parentType)) {
    return inlineContentTypes.has(childType);
  }
  if (parentType === 'blockquote' || parentType === 'listItem') {
    return blockContentTypes.has(childType) || childType === 'list';
  }
  if (parentType === 'list') {
    return childType === 'listItem';
  }
  if (parentType === 'table') {
    return childType === 'tableRow';
  }
  if (parentType === 'tableRow') {
    return childType === 'tableCell';
  }
  return false;
}

function normalizedEditableNode(
  value: unknown,
  parentType: string | null,
  state: { count: number; depth: number },
): ReviewContentNode {
  if (!isRecord(value) || typeof value.type !== 'string' || !editableNodeTypes.has(value.type)) {
    throw new ReviewApiError(400, '正文结构无效。');
  }
  if (parentType && !allowsChild(parentType, value.type)) {
    throw new ReviewApiError(400, '正文层级无效。');
  }
  state.count += 1;
  state.depth += 1;
  if (state.count > maxEditableContentNodes || state.depth > 12) {
    throw new ReviewApiError(400, '正文内容过长或层级过深。');
  }
  const node: ReviewContentNode = { type: value.type };
  try {
    if (valueContentTypes.has(value.type)) {
      node.value = requiredEditorString(value.value, '正文内容', maxEditableTextLength);
      if (value.type === 'math' || value.type === 'inlineMath') {
        try {
          katex.renderToString(node.value, { displayMode: value.type === 'math', throwOnError: true });
        } catch {
          throw new ReviewApiError(400, '公式格式无效。');
        }
      }
    }
    if (value.type === 'image') {
      const resourceId = requiredEditorString(value.resourceId, '图片资源', 36).trim();
      if (!resourceId) {
        throw new ReviewApiError(400, '图片资源无效。');
      }
      node.resourceId = resourceId;
      const alt = optionalEditorString(value.alt, '图片说明', 255);
      const title = optionalEditorString(value.title, '图片标题', 255);
      if (alt !== undefined) {
        node.alt = alt;
      }
      if (title !== undefined) {
        node.title = title;
      }
    }
    if (value.type === 'link') {
      const url = optionalEditorString(value.url, '链接', 2048);
      if (url) {
        const safeUrl = safeContentUrl(url);
        if (!safeUrl) {
          throw new ReviewApiError(400, '链接地址无效。');
        }
        node.url = safeUrl;
      }
      const title = optionalEditorString(value.title, '链接标题', 255);
      if (title !== undefined) {
        node.title = title;
      }
    }
    if (value.type === 'heading') {
      if (!Number.isInteger(value.depth) || typeof value.depth !== 'number' || value.depth < 1 || value.depth > 6) {
        throw new ReviewApiError(400, '标题级别无效。');
      }
      node.depth = value.depth;
    }
    if (value.type === 'list') {
      if (typeof value.ordered === 'boolean') {
        node.ordered = value.ordered;
      }
      if (value.start !== undefined) {
        if (!Number.isInteger(value.start) || typeof value.start !== 'number' || value.start < 1) {
          throw new ReviewApiError(400, '列表起始值无效。');
        }
        node.start = value.start;
      }
    }
    if (value.type === 'listItem' && (typeof value.checked === 'boolean' || value.checked === null)) {
      node.checked = value.checked;
    }
    if (value.type === 'code') {
      const lang = optionalEditorString(value.lang, '代码语言', 64);
      const meta = optionalEditorString(value.meta, '代码信息', 255);
      if (lang !== undefined) {
        node.lang = lang;
      }
      if (meta !== undefined) {
        node.meta = meta;
      }
    }
    if (value.type === 'tableCell' && value.align !== undefined) {
      if (!Array.isArray(value.align) || value.align.some((item) => item !== 'left' && item !== 'center' && item !== 'right' && item !== null)) {
        throw new ReviewApiError(400, '表格对齐方式无效。');
      }
      node.align = value.align;
    }
    if (value.type === 'tableCell') {
      for (const [key, label] of [['rowSpan', '表格行跨度'], ['colSpan', '表格列跨度']] as const) {
        if (value[key] !== undefined) {
          if (!Number.isInteger(value[key]) || typeof value[key] !== 'number' || value[key] < 1 || value[key] > 100) {
            throw new ReviewApiError(400, `${label}无效。`);
          }
          node[key] = value[key];
        }
      }
    }
    if (value.type === 'tableRow' && typeof value.header === 'boolean') {
      node.header = value.header;
    }
    if (nestedContentTypes.has(value.type)) {
      if (!Array.isArray(value.children)) {
        throw new ReviewApiError(400, '正文子节点无效。');
      }
      node.children = value.children.map((child) => normalizedEditableNode(child, String(value.type), state));
    } else if (value.children !== undefined) {
      throw new ReviewApiError(400, '正文节点属性无效。');
    }
    return node;
  } finally {
    state.depth -= 1;
  }
}

function normalizedEditableContent(value: unknown): ReviewContentNode[] {
  if (!Array.isArray(value)) {
    throw new ReviewApiError(400, '正文内容无效。');
  }
  const state = { count: 0, depth: 0 };
  const content = value.map((node) => {
    const normalized = normalizedEditableNode(node, null, state);
    if (!blockContentTypes.has(normalized.type)) {
      throw new ReviewApiError(400, '正文顶层节点无效。');
    }
    return normalized;
  });
  validateEditableTables(content);
  return content;
}

function validateEditableTables(nodes: ReviewContentNode[]) {
  for (const node of nodes) {
    if (node.type === 'table') {
      const rows = node.children ?? [];
      if (rows.length === 0) {
        throw new ReviewApiError(400, '表格至少需要一行。');
      }
      const grid: boolean[][] = Array.from({ length: rows.length }, () => []);
      let columnCount = 0;
      rows.forEach((row, rowIndex) => {
        let columnIndex = 0;
        for (const cell of row.children ?? []) {
          while (grid[rowIndex]?.[columnIndex]) {
            columnIndex += 1;
          }
          const rowSpan = cell.rowSpan ?? 1;
          const colSpan = cell.colSpan ?? 1;
          if (rowIndex + rowSpan > rows.length) {
            throw new ReviewApiError(400, '表格行跨度超出范围。');
          }
          for (let coveredRow = rowIndex; coveredRow < rowIndex + rowSpan; coveredRow += 1) {
            for (let coveredColumn = columnIndex; coveredColumn < columnIndex + colSpan; coveredColumn += 1) {
              if (grid[coveredRow]?.[coveredColumn]) {
                throw new ReviewApiError(400, '表格单元格跨度重叠。');
              }
              grid[coveredRow]![coveredColumn] = true;
            }
          }
          columnIndex += colSpan;
          columnCount = Math.max(columnCount, columnIndex);
        }
      });
      if (columnCount === 0 || grid.some((row) => row.length !== columnCount || row.some((occupied) => !occupied))) {
        throw new ReviewApiError(400, '表格行列不完整。');
      }
    }
    if (node.children) {
      validateEditableTables(node.children);
    }
  }
}

function contentImageResourceIds(nodes: ReviewContentNode[]): string[] {
  const resourceIds = new Set<string>();
  const visit = (items: ReviewContentNode[]) => {
    for (const node of items) {
      if (node.type === 'image' && node.resourceId) {
        resourceIds.add(node.resourceId);
      }
      if (node.children) {
        visit(node.children);
      }
    }
  };
  visit(nodes);
  return [...resourceIds];
}

function parsedNodePath(nodePath: string): number[] | null {
  if (!/^\d+(?:\.\d+)*$/.test(nodePath)) {
    return null;
  }
  const parts = nodePath.split('.').map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function contentNodeAtPath(nodes: ReviewContentNode[], nodePath: string): ReviewContentNode | null {
  const parts = parsedNodePath(nodePath);
  if (!parts) {
    return null;
  }
  let currentNodes = nodes;
  let current: ReviewContentNode | undefined;
  for (const index of parts) {
    current = currentNodes[index];
    if (!current) {
      return null;
    }
    currentNodes = current.children ?? [];
  }
  return current ?? null;
}

function normalizedHighlightAnchor(
  kind: ReviewHighlightKind,
  value: unknown,
): ReviewHighlightAnchor | null {
  if (!isRecord(value) || typeof value.nodePath !== 'string' || !parsedNodePath(value.nodePath)) {
    return null;
  }
  if (kind === 'formula') {
    return { nodePath: value.nodePath } satisfies ReviewFormulaHighlightAnchor;
  }
  if (
    !Number.isInteger(value.start)
    || !Number.isInteger(value.end)
    || typeof value.start !== 'number'
    || typeof value.end !== 'number'
  ) {
    return null;
  }
  return {
    nodePath: value.nodePath,
    start: value.start,
    end: value.end,
  } satisfies ReviewTextHighlightAnchor;
}

function highlightFromRow(row: Record<string, unknown>): ReviewHighlight | null {
  const kind = row.kind;
  if (kind !== 'text' && kind !== 'formula' || typeof row.id !== 'string') {
    return null;
  }
  let anchor = row.anchor_json;
  if (typeof anchor === 'string') {
    try {
      anchor = JSON.parse(anchor);
    } catch {
      return null;
    }
  }
  const normalizedAnchor = normalizedHighlightAnchor(kind, anchor);
  return normalizedAnchor ? { id: row.id, kind, anchor: normalizedAnchor } : null;
}

function sameHighlightAnchor(left: ReviewHighlightAnchor, right: ReviewHighlightAnchor): boolean {
  if (left.nodePath !== right.nodePath) {
    return false;
  }
  if (!('start' in left) || !('start' in right)) {
    return !('start' in left) && !('start' in right);
  }
  return left.start === right.start && left.end === right.end;
}

function highlightSurvivesContentUpdate(
  highlight: ReviewHighlight,
  previousContent: ReviewContentNode[],
  nextContent: ReviewContentNode[],
) {
  const previousNode = contentNodeAtPath(previousContent, highlight.anchor.nodePath);
  const nextNode = contentNodeAtPath(nextContent, highlight.anchor.nodePath);
  if (!previousNode || !nextNode || previousNode.type !== nextNode.type) {
    return false;
  }
  if (highlight.kind === 'formula') {
    return (nextNode.type === 'math' || nextNode.type === 'inlineMath')
      && previousNode.value === nextNode.value;
  }
  return nextNode.type === 'text'
    && 'start' in highlight.anchor
    && previousNode.value === nextNode.value
    && highlight.anchor.start >= 0
    && highlight.anchor.start < highlight.anchor.end
    && highlight.anchor.end <= (nextNode.value ?? '').length;
}

function nodeText(node: ContentNode): string {
  if (node.type === 'image') {
    return node.alt ? `[图片：${node.alt}]` : '[图片]';
  }
  if (node.type === 'math' || node.type === 'inlineMath') {
    return '[公式]';
  }
  if (node.type === 'break') {
    return '\n';
  }
  if (node.type === 'tableRow') {
    return (node.children ?? []).map((child) => nodeText(child)).join(' | ');
  }
  if (node.type === 'table') {
    return (node.children ?? []).map((child) => nodeText(child)).join('\n');
  }
  if (node.children?.length) {
    return node.children.map((child) => nodeText(child)).join('');
  }
  return typeof node.value === 'string' ? node.value : '';
}

function contentToPlainText(content: ContentNode[]): string {
  return content
    .map((node) => nodeText(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();
}

function aiExplanationFromRow(row: Record<string, unknown>): ReviewAiExplanation | null {
  if (!row.ai_generated_at) {
    return null;
  }
  let parsed: unknown = row.ai_content_json;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (!isRecord(parsed) || typeof parsed.text !== 'string' || !parsed.text.trim()) {
    return null;
  }
  return {
    provider: textValue(row.ai_provider),
    model: textValue(row.ai_model),
    promptText: textValue(row.ai_prompt_text),
    content: parsed.text,
    generatedAt: nullableDateValue(row.ai_generated_at) ?? new Date(0).toISOString(),
  };
}

function cardFromRow(row: Record<string, unknown> | undefined): ReviewCardSummary | null {
  if (!row || typeof row.card_id !== 'string') {
    return null;
  }
  const masteryStatus = reviewStatuses.includes(row.mastery_status as ReviewMasteryStatus)
    ? row.mastery_status as ReviewMasteryStatus
    : 'unassessed';
  const review: ReviewRecordSummary = {
    firstViewedAt: nullableDateValue(row.first_viewed_at),
    lastViewedAt: nullableDateValue(row.last_viewed_at),
    statusChangedAt: nullableDateValue(row.status_changed_at),
    viewCount: numberValue(row.view_count),
  };
  return {
    id: row.card_id,
    title: textValue(row.card_title),
    materialId: textValue(row.material_id),
    materialName: textValue(row.material_name),
    chapterTitle: textValue(row.chapter_title),
    sectionTitle: textValue(row.section_title),
    bodyText: contentToPlainText(contentNodes(row.content_json)),
    content: reviewContent(row.content_json),
    masteryStatus,
    aiExplanation: aiExplanationFromRow(row),
    review,
  };
}

const reviewStatuses: ReviewMasteryStatus[] = ['unassessed', 'mastered', 'familiar', 'effort'];

function normalizedFilters(filters: ReviewFilters = {}): Required<Pick<ReviewFilters, 'statuses'>> & Omit<ReviewFilters, 'statuses'> {
  const statuses = filters.statuses ?? [];
  if (statuses.some((status) => !reviewStatuses.includes(status))) {
    throw new ReviewApiError(400, '掌握状态筛选无效。');
  }
  return {
    materialId: filters.materialId?.trim() || undefined,
    statuses: [...new Set(statuses)],
  };
}

function filterSql(filters: ReviewFilters): { clause: string; values: unknown[] } {
  const normalized = normalizedFilters(filters);
  const conditions = [activeCardWhere];
  const values: unknown[] = [];
  if (normalized.materialId) {
    conditions.push('m.id = ?');
    values.push(normalized.materialId);
  }
  if (normalized.statuses.length > 0) {
    conditions.push(`c.mastery_status IN (${normalized.statuses.map(() => '?').join(', ')})`);
    values.push(...normalized.statuses);
  }
  return { clause: conditions.join(' AND '), values };
}

const cardSelect = `
  SELECT
    c.id AS card_id,
    c.title AS card_title,
    m.id AS material_id,
    c.content_json,
    c.mastery_status,
    rr.first_viewed_at,
    rr.last_viewed_at,
    rr.status_changed_at,
    rr.view_count,
    m.name AS material_name,
    ch.title AS chapter_title,
    s.title AS section_title,
    ae.provider AS ai_provider,
    ae.model AS ai_model,
    ae.prompt_text AS ai_prompt_text,
    ae.content_json AS ai_content_json,
    ae.generated_at AS ai_generated_at
  FROM cards AS c
  INNER JOIN sections AS s ON s.id = c.section_id
  INNER JOIN chapters AS ch ON ch.id = s.chapter_id
  INNER JOIN materials AS m ON m.id = ch.material_id
  LEFT JOIN review_records AS rr ON rr.card_id = c.id
  LEFT JOIN ai_explanations AS ae ON ae.card_id = c.id
`;

const navigationCardSelect = `
  SELECT c.id AS card_id, m.id AS material_id
  FROM cards AS c
  INNER JOIN sections AS s ON s.id = c.section_id
  INNER JOIN chapters AS ch ON ch.id = s.chapter_id
  INNER JOIN materials AS m ON m.id = ch.material_id
`;

const cardOrderBy = 'm.created_at DESC, m.id, ch.sort_order, ch.id, s.sort_order, s.id, c.sort_order, c.id';

const activeCardWhere = `
  c.deleted_at IS NULL
  AND s.deleted_at IS NULL
  AND ch.deleted_at IS NULL
  AND m.deleted_at IS NULL
`;

export interface ReviewService {
  dashboard(): Promise<ReviewDashboardResponse>;
  start(scope: ReviewStartScope, materialId?: string): Promise<ReviewCardResponse>;
  getFirstCard(filters?: ReviewFilters): Promise<ReviewCardResponse>;
  getCard(cardId: string, filters?: ReviewFilters): Promise<ReviewCardResponse>;
  listCards(filters?: ReviewFilters, currentCardId?: string): Promise<ReviewCardsResponse>;
  updateStatus(cardId: string, status: ReviewMasteryStatus, filters?: ReviewFilters): Promise<ReviewCardResponse>;
  updateContent(cardId: string, request: ReviewCardContentUpdateRequest, lock?: ReviewEditLockCredentials): Promise<ReviewCardContentUpdateResponse>;
  acquireEditLock(cardId: string, deviceId: string): Promise<ReviewEditLockResponse>;
  renewEditLock(cardId: string, lock: ReviewEditLockCredentials): Promise<ReviewEditLockResponse>;
  releaseEditLock(cardId: string, lock: ReviewEditLockCredentials): Promise<void>;
  createHighlight(cardId: string, request: ReviewHighlightCreateRequest): Promise<ReviewHighlightResponse>;
  deleteHighlight(cardId: string, highlightId: string): Promise<void>;
}

export class ReviewServiceImpl implements ReviewService {
  constructor(private readonly options: ReviewServiceOptions) {}

  async dashboard(): Promise<ReviewDashboardResponse> {
    await this.migrateLegacyLastCard();
    const [countRows] = await this.options.database.execute(
      `
        SELECT
          COUNT(DISTINCT m.id) AS material_count,
          COUNT(c.id) AS card_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'unassessed' THEN 1 ELSE 0 END), 0) AS unassessed_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'effort' THEN 1 ELSE 0 END), 0) AS effort_count
        FROM materials AS m
        LEFT JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
        LEFT JOIN sections AS s ON s.chapter_id = ch.id AND s.deleted_at IS NULL
        LEFT JOIN cards AS c ON c.section_id = s.id AND c.deleted_at IS NULL
        WHERE m.deleted_at IS NULL
      `,
    );
    const counts = rowsFrom(countRows)[0] ?? {};

    const [materialRows] = await this.options.database.execute(
      `
        SELECT
          m.id AS material_id,
          m.name AS material_name,
          COUNT(c.id) AS card_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'mastered' THEN 1 ELSE 0 END), 0) AS mastered_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'familiar' THEN 1 ELSE 0 END), 0) AS familiar_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'unassessed' THEN 1 ELSE 0 END), 0) AS unassessed_count,
          COALESCE(SUM(CASE WHEN c.mastery_status = 'effort' THEN 1 ELSE 0 END), 0) AS effort_count
        FROM materials AS m
        INNER JOIN chapters AS ch ON ch.material_id = m.id AND ch.deleted_at IS NULL
        INNER JOIN sections AS s ON s.chapter_id = ch.id AND s.deleted_at IS NULL
        INNER JOIN cards AS c ON c.section_id = s.id AND c.deleted_at IS NULL
        WHERE m.deleted_at IS NULL
        GROUP BY m.id, m.name
        ORDER BY m.created_at DESC, m.id
      `,
    );
    const materials = this.materialSummaries(rowsFrom(materialRows));

    const [lastCardRows] = await this.options.database.execute(
      `${cardSelect}
        INNER JOIN app_settings AS setting
          ON setting.setting_key = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(setting.setting_value, CONCAT('$."', m.id, '"'))) = c.id
        WHERE ${activeCardWhere}
      `,
      [lastCardsSettingKey],
    );
    const continueCards = new Map(
      rowsFrom(lastCardRows)
        .map((row) => cardFromRow(row))
        .filter((card): card is ReviewCardSummary => card !== null)
        .map((card) => [card.materialId, card]),
    );

    return {
      counts: {
        materialCount: numberValue(counts.material_count),
        cardCount: numberValue(counts.card_count),
        unassessedCount: numberValue(counts.unassessed_count),
        effortCount: numberValue(counts.effort_count),
      },
      materials: materials.map((material) => ({ ...material, continueCard: continueCards.get(material.id) ?? null })),
    };
  }

  async start(scope: ReviewStartScope, materialId?: string): Promise<ReviewCardResponse> {
    if (!['all', 'unassessed', 'effort'].includes(scope)) {
      throw new ReviewApiError(400, '复习入口无效。');
    }
    await this.migrateLegacyLastCard();
    const filters: ReviewFilters = {
      materialId: materialId?.trim() || undefined,
      statuses: scope === 'all' ? undefined : [scope],
    };
    const resumedCardId = scope === 'all' && filters.materialId
      ? await this.findLastCardIdForMaterial(filters.materialId)
      : null;
    const cardReference = await this.findFirstCardReference(filters, resumedCardId);
    if (!cardReference) {
      throw new ReviewApiError(404, '没有可复习的闪卡。');
    }
    await this.saveLastCard(cardReference);
    await this.recordView(cardReference.id);
    return this.cardResponse(cardReference.id, filters);
  }

  async getFirstCard(filters: ReviewFilters = {}): Promise<ReviewCardResponse> {
    const cardReference = await this.findFirstCardReference(filters);
    if (!cardReference) {
      throw new ReviewApiError(404, '没有符合条件的闪卡。');
    }
    await this.saveLastCard(cardReference);
    await this.recordView(cardReference.id);
    return this.cardResponse(cardReference.id, filters);
  }

  async getCard(cardId: string, filters: ReviewFilters = {}): Promise<ReviewCardResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    const cardReference = await this.findCardReference(normalizedId);
    if (!cardReference) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    await this.saveLastCard(cardReference);
    await this.recordView(cardReference.id);
    return this.cardResponse(cardReference.id, filters);
  }

  async updateStatus(cardId: string, status: ReviewMasteryStatus, filters: ReviewFilters = {}): Promise<ReviewCardResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    if (!reviewStatuses.includes(status)) {
      throw new ReviewApiError(400, '掌握状态无效。');
    }
    const existing = await this.findCardReference(normalizedId);
    if (!existing) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    const transactionalDatabase = this.options.database as Partial<ReviewDatabase>;
    if (typeof transactionalDatabase.getConnection !== 'function') {
      throw new Error('复习数据库不支持事务。');
    }

    const connection = await transactionalDatabase.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      const [cardRows] = await connection.execute(
      `${navigationCardSelect.replace('SELECT c.id AS card_id, m.id AS material_id', 'SELECT c.id AS card_id, c.mastery_status')}
         WHERE c.id = ? AND ${activeCardWhere}
         LIMIT 1 FOR UPDATE`,
        [normalizedId],
      );
      const current = cardFromRow(rowsFrom(cardRows)[0]);
      if (!current) {
        throw new ReviewApiError(404, '闪卡不存在或已删除。');
      }
      if (current.masteryStatus !== status) {
        await connection.execute(
          `UPDATE cards AS c
           INNER JOIN sections AS s ON s.id = c.section_id
           INNER JOIN chapters AS ch ON ch.id = s.chapter_id
           INNER JOIN materials AS m ON m.id = ch.material_id
           SET c.mastery_status = ?, c.updated_at = CURRENT_TIMESTAMP(3)
           WHERE c.id = ? AND ${activeCardWhere}`,
          [status, normalizedId],
        );
        await connection.execute(
          `INSERT INTO review_records (card_id, status_changed_at)
           VALUES (?, CURRENT_TIMESTAMP(3))
           ON DUPLICATE KEY UPDATE status_changed_at = CURRENT_TIMESTAMP(3)`,
          [normalizedId],
        );
        await connection.execute(
          `INSERT INTO review_status_history (id, card_id, from_status, to_status, source)
           VALUES (?, ?, ?, ?, 'review')`,
          [randomUUID(), normalizedId, current.masteryStatus, status],
        );
      }
      await connection.commit();
      committed = true;
    } catch (error) {
      if (!committed) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
    return this.cardResponse(normalizedId, filters);
  }

  async acquireEditLock(cardId: string, deviceId: string): Promise<ReviewEditLockResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    const normalizedDeviceId = requiredLockValue(deviceId, '设备标识');
    const transactionalDatabase = this.options.database as Partial<ReviewDatabase>;
    if (typeof transactionalDatabase.getConnection !== 'function') {
      throw new Error('复习数据库不支持事务。');
    }

    const connection = await transactionalDatabase.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      const [cardRows] = await connection.execute(
        `${cardSelect}
         WHERE c.id = ? AND ${activeCardWhere}
         LIMIT 1 FOR UPDATE`,
        [normalizedId],
      );
      if (!cardFromRow(rowsFrom(cardRows)[0])) {
        throw new ReviewApiError(404, '闪卡不存在或已删除。');
      }
      await connection.execute(
        'DELETE FROM sync_locks WHERE card_id = ? AND expires_at <= CURRENT_TIMESTAMP(3)',
        [normalizedId],
      );
      const [lockRows] = await connection.execute(
        'SELECT lock_token, device_id FROM sync_locks WHERE card_id = ? FOR UPDATE',
        [normalizedId],
      );
      const current = rowsFrom(lockRows)[0];
      const currentDeviceId = current ? textValue(current.device_id) : '';
      if (current && currentDeviceId !== normalizedDeviceId) {
        throw new ReviewApiError(409, '该闪卡正在由其他设备编辑。');
      }

      const lockToken = current ? textValue(current.lock_token) : randomUUID();
      const expiresAt = new Date(Date.now() + editLockLeaseMs);
      if (current) {
        await connection.execute(
          'UPDATE sync_locks SET expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND) WHERE card_id = ? AND lock_token = ? AND device_id = ?',
          [normalizedId, lockToken, normalizedDeviceId],
        );
      } else {
        await connection.execute(
          'INSERT INTO sync_locks (card_id, lock_token, device_id, expires_at) VALUES (?, ?, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND))',
          [normalizedId, lockToken, normalizedDeviceId],
        );
      }
      await connection.commit();
      committed = true;
      return { lock: { lockToken, expiresAt: expiresAt.toISOString() } };
    } catch (error) {
      if (!committed) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async renewEditLock(cardId: string, lock: ReviewEditLockCredentials): Promise<ReviewEditLockResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    const normalizedDeviceId = requiredLockValue(lock?.deviceId ?? '', '设备标识');
    const normalizedToken = requiredLockValue(lock?.lockToken ?? '', '编辑锁令牌');
    const transactionalDatabase = this.options.database as Partial<ReviewDatabase>;
    if (typeof transactionalDatabase.getConnection !== 'function') {
      throw new Error('复习数据库不支持事务。');
    }

    const connection = await transactionalDatabase.getConnection();
    let committed = false;
    try {
      await connection.beginTransaction();
      await connection.execute(
        'DELETE FROM sync_locks WHERE card_id = ? AND expires_at <= CURRENT_TIMESTAMP(3)',
        [normalizedId],
      );
      const [lockRows] = await connection.execute(
        'SELECT lock_token, device_id FROM sync_locks WHERE card_id = ? FOR UPDATE',
        [normalizedId],
      );
      const current = rowsFrom(lockRows)[0];
      if (!current || textValue(current.device_id) !== normalizedDeviceId || textValue(current.lock_token) !== normalizedToken) {
        throw new ReviewApiError(409, '编辑锁已失效，请重新进入编辑。');
      }
      const expiresAt = new Date(Date.now() + editLockLeaseMs);
      await connection.execute(
        'UPDATE sync_locks SET expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND) WHERE card_id = ? AND lock_token = ? AND device_id = ?',
        [normalizedId, normalizedToken, normalizedDeviceId],
      );
      await connection.commit();
      committed = true;
      return { lock: { lockToken: normalizedToken, expiresAt: expiresAt.toISOString() } };
    } catch (error) {
      if (!committed) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }
  }

  async releaseEditLock(cardId: string, lock: ReviewEditLockCredentials): Promise<void> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    const normalizedDeviceId = requiredLockValue(lock?.deviceId ?? '', '设备标识');
    const normalizedToken = requiredLockValue(lock?.lockToken ?? '', '编辑锁令牌');
    await this.options.database.execute(
      'DELETE FROM sync_locks WHERE card_id = ? AND lock_token = ? AND device_id = ?',
      [normalizedId, normalizedToken, normalizedDeviceId],
    );
  }

  async updateContent(
    cardId: string,
    request: ReviewCardContentUpdateRequest,
    lock?: ReviewEditLockCredentials,
  ): Promise<ReviewCardContentUpdateResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId || !isRecord(request)) {
      throw new ReviewApiError(400, '闪卡内容无效。');
    }
    const title = requiredEditorString(request.title, '闪卡标题', 255).trim();
    if (!title) {
      throw new ReviewApiError(400, '闪卡标题不能为空。');
    }
    const content = normalizedEditableContent(request.content);
    const transactionalDatabase = this.options.database as Partial<ReviewDatabase>;
    if (typeof transactionalDatabase.getConnection !== 'function') {
      throw new Error('复习数据库不支持事务。');
    }

    const connection = await transactionalDatabase.getConnection();
    let committed = false;
    let invalidatedHighlightCount = 0;
    try {
      await connection.beginTransaction();
      const [cardRows] = await connection.execute(
        `${cardSelect}
         WHERE c.id = ? AND ${activeCardWhere}
         LIMIT 1 FOR UPDATE`,
        [normalizedId],
      );
      const existingCard = cardFromRow(rowsFrom(cardRows)[0]);
      if (!existingCard) {
        throw new ReviewApiError(404, '闪卡不存在或已删除。');
      }
      const normalizedDeviceId = requiredLockValue(lock?.deviceId ?? '', '设备标识');
      const normalizedToken = requiredLockValue(lock?.lockToken ?? '', '编辑锁令牌');
      await connection.execute(
        'DELETE FROM sync_locks WHERE card_id = ? AND expires_at <= CURRENT_TIMESTAMP(3)',
        [normalizedId],
      );
      const [lockRows] = await connection.execute(
        'SELECT lock_token, device_id FROM sync_locks WHERE card_id = ? FOR UPDATE',
        [normalizedId],
      );
      const currentLock = rowsFrom(lockRows)[0];
      if (!currentLock || textValue(currentLock.device_id) !== normalizedDeviceId || textValue(currentLock.lock_token) !== normalizedToken) {
        throw new ReviewApiError(409, '编辑锁已失效，请重新进入编辑。');
      }
      await connection.execute(
        'UPDATE sync_locks SET expires_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 90 SECOND) WHERE card_id = ? AND lock_token = ? AND device_id = ?',
        [normalizedId, normalizedToken, normalizedDeviceId],
      );
      await this.verifyContentResources(connection, content);
      const [highlightRows] = await connection.execute(
        'SELECT id, kind, anchor_json FROM highlights WHERE card_id = ? FOR UPDATE',
        [normalizedId],
      );
      const invalidatedHighlightIds = rowsFrom(highlightRows).flatMap((row) => {
        const id = typeof row.id === 'string' ? row.id : null;
        const highlight = highlightFromRow(row);
        return id && (!highlight || !highlightSurvivesContentUpdate(highlight, existingCard.content ?? [], content))
          ? [id]
          : [];
      });

      await connection.execute(
        `UPDATE cards AS c
         INNER JOIN sections AS s ON s.id = c.section_id
         INNER JOIN chapters AS ch ON ch.id = s.chapter_id
         INNER JOIN materials AS m ON m.id = ch.material_id
         SET c.title = ?, c.content_json = ?, c.updated_at = CURRENT_TIMESTAMP(3)
         WHERE c.id = ? AND ${activeCardWhere}`,
        [title, JSON.stringify(content), normalizedId],
      );
      for (const highlightId of invalidatedHighlightIds) {
        await connection.execute('DELETE FROM highlights WHERE id = ? AND card_id = ?', [highlightId, normalizedId]);
      }
      invalidatedHighlightCount = invalidatedHighlightIds.length;
      await connection.commit();
      committed = true;
    } catch (error) {
      if (!committed) {
        await connection.rollback().catch(() => undefined);
      }
      throw error;
    } finally {
      connection.release();
    }

    const card = await this.findCard(normalizedId);
    if (!card) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    return { card, invalidatedHighlightCount };
  }

  async createHighlight(
    cardId: string,
    request: ReviewHighlightCreateRequest,
  ): Promise<ReviewHighlightResponse> {
    const normalizedId = cardId.trim();
    if (!normalizedId) {
      throw new ReviewApiError(400, '闪卡 ID 无效。');
    }
    if (!request || (request.kind !== 'text' && request.kind !== 'formula')) {
      throw new ReviewApiError(400, '高亮类型无效。');
    }
    const card = await this.findCard(normalizedId);
    if (!card) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    const anchor = normalizedHighlightAnchor(request.kind, request.anchor);
    const content = card.content ?? [];
    const node = anchor ? contentNodeAtPath(content, anchor.nodePath) : null;
    if (!anchor || !node) {
      throw new ReviewApiError(400, '高亮位置无效。');
    }
    if (request.kind === 'formula') {
      if (node.type !== 'math' && node.type !== 'inlineMath') {
        throw new ReviewApiError(400, '公式高亮必须指向公式节点。');
      }
    } else {
      if (node.type !== 'text' || !('start' in anchor) || anchor.start < 0 || anchor.end > (node.value ?? '').length || anchor.start >= anchor.end) {
        throw new ReviewApiError(400, '文本高亮范围无效。');
      }
    }
    const existing = card.highlights?.find((item) => item.kind === request.kind && sameHighlightAnchor(item.anchor, anchor));
    if (existing) {
      return { highlight: existing };
    }
    const highlight: ReviewHighlight = {
      id: randomUUID(),
      kind: request.kind,
      anchor,
    };
    await this.options.database.execute(
      `INSERT INTO highlights (id, card_id, kind, anchor_json)
       VALUES (?, ?, ?, ?)`,
      [highlight.id, normalizedId, highlight.kind, JSON.stringify(highlight.anchor)],
    );
    return { highlight };
  }

  async deleteHighlight(cardId: string, highlightId: string): Promise<void> {
    const normalizedCardId = cardId.trim();
    const normalizedHighlightId = highlightId.trim();
    if (!normalizedCardId || !normalizedHighlightId) {
      throw new ReviewApiError(400, '高亮 ID 无效。');
    }
    const card = await this.findCard(normalizedCardId);
    if (!card) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    if (!card.highlights?.some((item) => item.id === normalizedHighlightId)) {
      throw new ReviewApiError(404, '高亮不存在。');
    }
    await this.options.database.execute(
      'DELETE FROM highlights WHERE id = ? AND card_id = ?',
      [normalizedHighlightId, normalizedCardId],
    );
  }

  async listCards(filters: ReviewFilters = {}, currentCardId?: string): Promise<ReviewCardsResponse> {
    const { clause, values } = filterSql(filters);
    const [rows] = await this.options.database.execute(
      `${navigationCardSelect}
        WHERE ${clause}
        ORDER BY m.created_at DESC, m.id, ch.sort_order, ch.id, s.sort_order, s.id, c.sort_order, c.id
      `,
      values,
    );
    const cards = rowsFrom(rows)
      .flatMap((row): ReviewCardNavigationItem[] => typeof row.card_id === 'string' ? [{ id: row.card_id }] : []);
    const currentIndex = currentCardId ? cards.findIndex((card) => card.id === currentCardId) : cards.length > 0 ? 0 : -1;
    return { cards, currentIndex };
  }

  private async cardResponse(cardId: string, filters: ReviewFilters): Promise<ReviewCardResponse> {
    const [card, navigation] = await Promise.all([
      this.findCard(cardId),
      this.findNavigation(cardId, filters),
    ]);
    if (!card) {
      throw new ReviewApiError(404, '闪卡不存在或已删除。');
    }
    return {
      card,
      navigation: navigation ?? {
        previousCardId: null,
        nextCardId: null,
        currentIndex: -1,
        total: 0,
      },
    };
  }

  private async migrateLegacyLastCard() {
    await this.options.database.execute(
      `
        INSERT INTO app_settings (setting_key, setting_value)
        SELECT ?, JSON_OBJECT(m.id, JSON_UNQUOTE(JSON_EXTRACT(legacy.setting_value, '$.cardId')))
        FROM app_settings AS legacy
        INNER JOIN cards AS c ON JSON_UNQUOTE(JSON_EXTRACT(legacy.setting_value, '$.cardId')) = c.id
        INNER JOIN sections AS s ON s.id = c.section_id
        INNER JOIN chapters AS ch ON ch.id = s.chapter_id
        INNER JOIN materials AS m ON m.id = ch.material_id
        WHERE legacy.setting_key = ? AND ${activeCardWhere}
        ON DUPLICATE KEY UPDATE setting_value = JSON_MERGE_PATCH(VALUES(setting_value), app_settings.setting_value)
      `,
      [lastCardsSettingKey, legacyLastCardSettingKey],
    );
    await this.options.database.execute('DELETE FROM app_settings WHERE setting_key = ?', [legacyLastCardSettingKey]);
  }

  private async saveLastCard(card: Pick<ReviewCardSummary, 'id' | 'materialId'>) {
    await this.options.database.execute(
      `
        INSERT INTO app_settings (setting_key, setting_value)
        VALUES (?, JSON_OBJECT(?, ?))
        ON DUPLICATE KEY UPDATE setting_value = JSON_SET(setting_value, CONCAT('$."', ?, '"'), ?)
      `,
      [lastCardsSettingKey, card.materialId, card.id, card.materialId, card.id],
    );
  }

  private async findLastCardIdForMaterial(materialId: string): Promise<string | null> {
    const [rows] = await this.options.database.execute(
      `${navigationCardSelect}
        INNER JOIN app_settings AS setting
          ON setting.setting_key = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(setting.setting_value, CONCAT('$."', m.id, '"'))) = c.id
        WHERE m.id = ? AND ${activeCardWhere}
        LIMIT 1
      `,
      [lastCardsSettingKey, materialId],
    );
    const cardId = rowsFrom(rows)[0]?.card_id;
    return typeof cardId === 'string' ? cardId : null;
  }

  private async recordView(cardId: string) {
    await this.options.database.execute(
      `INSERT INTO review_records (card_id, first_viewed_at, last_viewed_at, view_count)
       VALUES (?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 1)
       ON DUPLICATE KEY UPDATE
         first_viewed_at = COALESCE(first_viewed_at, CURRENT_TIMESTAMP(3)),
         last_viewed_at = CURRENT_TIMESTAMP(3),
         view_count = view_count + 1`,
      [cardId],
    );
  }

  private async findCard(cardId: string): Promise<ReviewCardSummary | null> {
    const [rows] = await this.options.database.execute(
      `${cardSelect}
        WHERE c.id = ? AND ${activeCardWhere}
        LIMIT 1
      `,
      [cardId],
    );
    const card = cardFromRow(rowsFrom(rows)[0]);
    if (!card) {
      return null;
    }
    return {
      ...card,
      highlights: await this.findHighlights(card.id, card.content ?? []),
    };
  }

  private async findCardReference(cardId: string): Promise<Pick<ReviewCardSummary, 'id' | 'materialId'> | null> {
    const [rows] = await this.options.database.execute(
      `${navigationCardSelect}
        WHERE c.id = ? AND ${activeCardWhere}
        LIMIT 1
      `,
      [cardId],
    );
    const row = rowsFrom(rows)[0];
    if (typeof row?.card_id !== 'string' || typeof row.material_id !== 'string') {
      return null;
    }
    return { id: row.card_id, materialId: row.material_id };
  }

  private async findFirstCardReference(
    filters: ReviewFilters,
    preferredCardId?: string | null,
  ): Promise<Pick<ReviewCardSummary, 'id' | 'materialId'> | null> {
    const { clause, values } = filterSql(filters);
    const [rows] = await this.options.database.execute(
      `${navigationCardSelect}
        WHERE ${clause}
        ORDER BY ${preferredCardId ? 'c.id = ? DESC, ' : ''}${cardOrderBy}
        LIMIT 1
      `,
      preferredCardId ? [...values, preferredCardId] : values,
    );
    const row = rowsFrom(rows)[0];
    if (typeof row?.card_id !== 'string' || typeof row.material_id !== 'string') {
      return null;
    }
    return { id: row.card_id, materialId: row.material_id };
  }

  private async findNavigation(cardId: string, filters: ReviewFilters): Promise<ReviewCardNavigation | null> {
    const { clause, values } = filterSql(filters);
    const [rows] = await this.options.database.execute(
      `WITH ordered_cards AS (
        SELECT
          c.id AS card_id,
          LAG(c.id) OVER (ORDER BY ${cardOrderBy}) AS previous_card_id,
          LEAD(c.id) OVER (ORDER BY ${cardOrderBy}) AS next_card_id,
          ROW_NUMBER() OVER (ORDER BY ${cardOrderBy}) - 1 AS current_index,
          COUNT(*) OVER () AS total
        FROM cards AS c
        INNER JOIN sections AS s ON s.id = c.section_id
        INNER JOIN chapters AS ch ON ch.id = s.chapter_id
        INNER JOIN materials AS m ON m.id = ch.material_id
        WHERE ${clause}
      )
      SELECT card_id, previous_card_id, next_card_id, current_index, total
      FROM ordered_cards
      WHERE card_id = ?`,
      [...values, cardId],
    );
    const row = rowsFrom(rows)[0];
    if (!row || typeof row.card_id !== 'string') {
      return null;
    }
    return {
      previousCardId: typeof row.previous_card_id === 'string' ? row.previous_card_id : null,
      nextCardId: typeof row.next_card_id === 'string' ? row.next_card_id : null,
      currentIndex: numberValue(row.current_index),
      total: numberValue(row.total),
    };
  }

  private async verifyContentResources(executor: ReviewSqlExecutor, content: ReviewContentNode[]) {
    const resourceIds = contentImageResourceIds(content);
    if (resourceIds.length === 0) {
      return;
    }
    const [rows] = await executor.execute(
      `SELECT id FROM resources WHERE id IN (${resourceIds.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
      resourceIds,
    );
    const available = new Set(rowsFrom(rows).map((row) => textValue(row.id)).filter(Boolean));
    if (resourceIds.some((resourceId) => !available.has(resourceId))) {
      throw new ReviewApiError(400, '图片资源不可用。');
    }
  }

  private async findHighlights(cardId: string, content: ReviewContentNode[]): Promise<ReviewHighlight[]> {
    const [rows] = await this.options.database.execute(
      `SELECT id, kind, anchor_json
       FROM highlights
       WHERE card_id = ?
       ORDER BY created_at, id`,
      [cardId],
    );
    return rowsFrom(rows)
      .map((row) => highlightFromRow(row))
      .filter((highlight): highlight is ReviewHighlight => highlight !== null)
      .filter((highlight) => {
        const node = contentNodeAtPath(content, highlight.anchor.nodePath);
        if (!node) {
          return false;
        }
        if (highlight.kind === 'formula') {
          return node.type === 'math' || node.type === 'inlineMath';
        }
        return node.type === 'text'
          && 'start' in highlight.anchor
          && highlight.anchor.start >= 0
          && highlight.anchor.start < highlight.anchor.end
          && highlight.anchor.end <= (node.value ?? '').length;
      });
  }

  private materialSummaries(rows: Array<Record<string, unknown>>): ReviewMaterialSummary[] {
    return rows.flatMap((row) => {
      const id = textValue(row.material_id);
      return id ? [{
        id,
        name: textValue(row.material_name),
        cardCount: numberValue(row.card_count),
        masteredCount: numberValue(row.mastered_count),
        familiarCount: numberValue(row.familiar_count),
        unassessedCount: numberValue(row.unassessed_count),
        effortCount: numberValue(row.effort_count),
        continueCard: null,
      }] : [];
    });
  }
}

export function createReviewDatabase(pool: Pool): ReviewDatabase {
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

export function createReviewService(
  options: Partial<ReviewServiceOptions> = {},
): ReviewService {
  return new ReviewServiceImpl({
    database: options.database ?? createReviewDatabase(createDatabasePool()),
  });
}
