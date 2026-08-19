import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Pool } from 'mysql2/promise';
import type {
  ImportApplyRequest,
  ImportApplyResponse,
  ImportAiCorrectionRequest,
  ImportDuplicateMaterial,
  ImportIssueResponse,
  ImportPreviewDocument,
  ImportPreviewResponse,
  ImportResourcePreview,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createDatabasePool } from './database.js';
import { decryptAiProviderApiKey, type AiProviderApiError } from './ai-provider-service.js';
import {
  parseImportPackage,
  parseContentMarkdown,
  type ContentNode,
  type ImportIssue,
  type ImportPackageResult,
  type ImportResource,
  type ParsedMaterial,
  resolveImportedHighlights,
} from './ingestion.js';

export { createImportTemplate } from './ingestion.js';

const previewTtlMs = 30 * 60 * 1000;
const previewMaxEntries = 20;
const maxCorrectionTextLength = 1_000_000;
const maxAiCorrectionInputLength = 500_000;
const maxAiCorrectionOutputLength = 2_000_000;
const aiCorrectionRequestTimeoutMs = 30_000;
const aiRepairableIssueCodes = new Set(['unsafe_html', 'invalid_formula', 'invalid_table']);

export interface ImportSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface ImportDatabaseConnection extends ImportSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface ImportDatabase extends ImportSqlExecutor {
  getConnection(): Promise<ImportDatabaseConnection>;
}

export interface StoredImportPreview {
  id: string;
  createdAt: number;
  revision: number;
  sourceFileName: string;
  sourceSha256: string;
  packageResult: ImportPackageResult;
  duplicateMaterial: ImportDuplicateMaterial | null;
}

export interface ImportPreviewStore {
  create(preview: Omit<StoredImportPreview, 'id' | 'createdAt' | 'revision'>): StoredImportPreview;
  get(id: string): StoredImportPreview | null;
  delete(id: string): void;
}

export class InMemoryImportPreviewStore implements ImportPreviewStore {
  private readonly previews = new Map<string, StoredImportPreview>();

  constructor(
    private readonly ttl = previewTtlMs,
    private readonly maxEntries = previewMaxEntries,
  ) {}

  create(preview: Omit<StoredImportPreview, 'id' | 'createdAt' | 'revision'>) {
    this.removeExpired();
    while (this.previews.size >= this.maxEntries) {
      const oldestId = this.previews.keys().next().value;
      if (typeof oldestId !== 'string') {
        break;
      }
      this.previews.delete(oldestId);
    }

    const stored: StoredImportPreview = {
      ...preview,
      id: randomUUID(),
      createdAt: Date.now(),
      revision: 0,
    };
    this.previews.set(stored.id, stored);
    return stored;
  }

  get(id: string) {
    this.removeExpired();
    const preview = this.previews.get(id);
    if (!preview) {
      return null;
    }
    return preview;
  }

  delete(id: string) {
    this.previews.delete(id);
  }

  private removeExpired() {
    const cutoff = Date.now() - this.ttl;
    for (const [id, preview] of this.previews) {
      if (preview.createdAt < cutoff) {
        this.previews.delete(id);
      }
    }
  }
}

export class ImportApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ImportApiError';
  }
}

interface ManagedResource {
  id: string;
  sourcePath: string;
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  sha256: string;
}

interface PreparedResources {
  directory: string | null;
  items: ManagedResource[];
}

interface CorrectedCard {
  title: string;
  bodyText: string;
}

interface CorrectedSection {
  title: string;
  cards: CorrectedCard[];
}

interface CorrectedChapter {
  title: string;
  sections: CorrectedSection[];
}

interface CorrectedDocument {
  title: string;
  chapters: CorrectedChapter[];
}

export interface ImportServiceOptions {
  database: ImportDatabase;
  resourcesDirectory: string;
  previewStore?: ImportPreviewStore;
  encryptionSecret?: string;
  fetchImplementation?: typeof fetch;
  aiCorrectionRequestTimeoutMs?: number;
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

function formatDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

function duplicateFromRow(row: Record<string, unknown> | undefined): ImportDuplicateMaterial | null {
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') {
    return null;
  }
  return {
    id: row.id,
    name: row.name,
    importedAt: formatDate(row.imported_at),
  };
}

async function findDuplicate(
  executor: ImportSqlExecutor,
  sourceSha256: string,
  forUpdate = false,
): Promise<ImportDuplicateMaterial | null> {
  const lockClause = forUpdate ? ' FOR UPDATE' : '';
  const [rows] = await executor.execute(
    `SELECT id, name, imported_at FROM materials WHERE source_sha256 = ? AND deleted_at IS NULL LIMIT 1${lockClause}`,
    [sourceSha256],
  );
  return duplicateFromRow(rowsFrom(rows)[0]);
}

function sha256(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function normalizeUploadFileName(fileName: string): string {
  const normalized = fileName.trim().replaceAll('\\', '/');
  const baseName = path.posix.basename(normalized);
  if (!baseName || baseName === '.' || baseName === '..' || baseName.includes('\0')) {
    throw new ImportApiError(400, '上传文件名无效。');
  }
  return baseName;
}

function mimeTypeFor(fileName: string): string {
  const extension = path.posix.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.gif': 'image/gif',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
  };
  return mimeTypes[extension] ?? 'application/octet-stream';
}

function toIssueResponse(importIssue: ImportIssue): ImportIssueResponse {
  return {
    code: importIssue.code,
    message: importIssue.message,
    suggestion: importIssue.suggestion,
    location: importIssue.location,
    context: importIssue.context,
  };
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

export function contentToPlainText(content: ContentNode[]): string {
  return content
    .map((node) => nodeText(node))
    .filter((value) => value.length > 0)
    .join('\n\n')
    .trim();
}

function previewDocument(document: ParsedMaterial): ImportPreviewDocument {
  return {
    title: document.title,
    location: document.location,
    chapters: document.chapters.map((chapter) => ({
      title: chapter.title,
      location: chapter.location,
      sections: chapter.sections.map((section) => ({
        title: section.title,
        location: section.location,
        cards: section.cards.map((card) => ({
          title: card.title,
          location: card.location,
          bodyText: contentToPlainText(card.content),
        })),
      })),
    })),
  };
}

function resourcePreviews(resources: ImportResource[]): ImportResourcePreview[] {
  return resources.map((resource) => ({
    relativePath: resource.relativePath,
    byteLength: resource.content.byteLength,
    mimeType: mimeTypeFor(resource.relativePath),
  }));
}

function canAiCorrect(packageResult: ImportPackageResult) {
  return packageResult.document !== null
    && !packageResult.issues.some((item) => item.code === 'json_read_error' || item.code === 'json_schema_error')
    && packageResult.issues.some((item) => cardIndexForIssue(packageResult, item) !== null);
}

function previewResponse(
  stored: StoredImportPreview | null,
  sourceFileName: string,
  sourceSha256: string,
  packageResult: ImportPackageResult,
  duplicateMaterial: ImportDuplicateMaterial | null,
): ImportPreviewResponse {
  const valid = packageResult.valid && packageResult.document !== null;
  return {
    previewId: stored?.id ?? null,
    revision: stored?.revision ?? 0,
    sourceFileName,
    sourceType: packageResult.sourceType,
    markdownFileName: packageResult.markdownFileName,
    sourceSha256,
    valid,
    duplicate: duplicateMaterial !== null,
    duplicateMaterial,
    document: packageResult.document ? previewDocument(packageResult.document) : null,
    resources: resourcePreviews(packageResult.resources),
    issues: packageResult.issues.map(toIssueResponse),
    aiCorrectionAvailable: !valid && canAiCorrect(packageResult),
  };
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function responseContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) {
    return '';
  }
  const message = payload.choices[0].message;
  if (!isRecord(message)) {
    return '';
  }
  return typeof message.content === 'string' ? message.content.trim() : '';
}

function stripAiCorrectionCodeFence(content: string): string {
  const fenced = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/i.exec(content.trim());
  return (fenced?.[1] ?? content).trim();
}

function readAiCorrectedBody(content: string, targetIndex: number): string {
  const normalized = stripAiCorrectionCodeFence(content);
  if (!normalized || normalized.length > maxAiCorrectionOutputLength) {
    throw new ImportApiError(502, 'AI 返回内容无效。');
  }
  if (!normalized.startsWith('{')) {
    return normalized;
  }
  try {
    const value = JSON.parse(normalized);
    if (isRecord(value) && (typeof value.body === 'string' || Array.isArray(value.cards))) {
      return legacyAiCorrectedBody(value, targetIndex);
    }
    return normalized;
  } catch (error) {
    return normalized;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return null;
  }
}

function markdownInline(nodes: ContentNode[] | undefined): string {
  return (nodes ?? []).map((node) => {
    const value = typeof node.value === 'string' ? node.value : '';
    switch (node.type) {
      case 'text': return value;
      case 'emphasis': return `*${markdownInline(node.children)}*`;
      case 'strong': return `**${markdownInline(node.children)}**`;
      case 'delete': return `~~${markdownInline(node.children)}~~`;
      case 'inlineCode': return `\`${value}\``;
      case 'inlineMath': return `$${value}$`;
      case 'link': return `[${markdownInline(node.children)}](${node.url ?? ''})`;
      case 'break': return '  \n';
      default: return markdownInline(node.children) || value;
    }
  }).join('');
}

function markdownBody(content: ContentNode[]): string {
  return content.map((node) => {
    const children = node.children ?? [];
    switch (node.type) {
      case 'html': return node.value ?? '';
      case 'paragraph': return markdownInline(children);
      case 'heading': return `${'#'.repeat(Number(node.depth) || 1)} ${markdownInline(children)}`;
      case 'math': return `$$\n${node.value ?? ''}\n$$`;
      case 'code': return `\`\`\`${node.lang ?? ''}\n${node.value ?? ''}\n\`\`\``;
      case 'blockquote': return markdownBody(children).split('\n').map((line) => `> ${line}`).join('\n');
      case 'list': return children.map((item, index) => `${node.ordered ? `${(Number(node.start) || 1) + index}.` : '-'} ${markdownInline(item.children)}`).join('\n');
      case 'table': return children.map((row) => `| ${row.children?.map((cell) => markdownInline(cell.children)).join(' | ') ?? ''} |`).join('\n');
      case 'thematicBreak': return '---';
      case 'image': return `![${node.alt ?? ''}](${node.url ?? ''})`;
      default: return markdownInline(children) || node.value || '';
    }
  }).filter(Boolean).join('\n\n');
}

function cardsFrom(document: ParsedMaterial) {
  return document.chapters.flatMap((chapter, chapterIndex) => chapter.sections.flatMap((section, sectionIndex) =>
    section.cards.map((card, cardIndex) => ({ card, chapterIndex, sectionIndex, cardIndex })),
  ));
}

function legacyAiCorrectedBody(value: unknown, targetIndex: number): string {
  if (isRecord(value) && Array.isArray(value.cards) && value.cards.length === 1) {
    value = value.cards[0];
  }
  if (
    !isRecord(value)
    || !Number.isInteger(value.index)
    || value.index !== targetIndex
    || typeof value.body !== 'string'
    || value.body.length > maxAiCorrectionOutputLength
  ) {
    throw new ImportApiError(502, 'AI 返回内容无效。');
  }
  return value.body;
}

function cardIndexForIssue(packageResult: ImportPackageResult, issue: ImportIssue): number | null {
  const document = packageResult.document;
  if (!document || !aiRepairableIssueCodes.has(issue.code)) {
    return null;
  }
  const matches = cardsFrom(document).flatMap(({ card, chapterIndex, sectionIndex }, index) => {
    const chapter = document.chapters[chapterIndex]!;
    const section = chapter.sections[sectionIndex]!;
    const context = [document.title, chapter.title, section.title, card.title];
    return issue.context.length === context.length && issue.context.every((value, contextIndex) => value === context[contextIndex])
      ? [index]
      : [];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function issueIdentity(issue: ImportIssue) {
  return JSON.stringify([issue.code, issue.location.fileName, issue.location.line, issue.location.column, issue.context]);
}

function issueMatchesContext(issue: ImportIssue, context: string[]) {
  return issue.context.length === context.length
    && issue.context.every((value, index) => value === context[index]);
}

function cardContext(packageResult: ImportPackageResult, cardIndex: number): string[] | null {
  const document = packageResult.document;
  const card = document ? cardsFrom(document)[cardIndex] : undefined;
  if (!document || !card) {
    return null;
  }
  return [
    document.title,
    document.chapters[card.chapterIndex]!.title,
    document.chapters[card.chapterIndex]!.sections[card.sectionIndex]!.title,
    card.card.title,
  ];
}

function issueCountForCard(packageResult: ImportPackageResult, cardIndex: number) {
  const context = cardContext(packageResult, cardIndex);
  return context ? packageResult.issues.filter((issue) => issueMatchesContext(issue, context)).length : 0;
}

function issueCodeCountForCard(packageResult: ImportPackageResult, cardIndex: number, code: ImportIssue['code']) {
  const context = cardContext(packageResult, cardIndex);
  return context
    ? packageResult.issues.filter((item) => item.code === code && issueMatchesContext(item, context)).length
    : 0;
}

function updateCorrectedDocument(packageResult: ImportPackageResult, bodies: Map<number, string>): ImportPackageResult {
  const document = packageResult.document;
  if (!document) {
    throw new ImportApiError(400, '导入预览已失效，请重新选择文件。');
  }
  const correctedContexts = [...bodies.keys()]
    .map((index) => cardContext(packageResult, index))
    .filter((context): context is string[] => context !== null);
  const issues: ImportIssue[] = packageResult.issues.filter((issue) =>
    !correctedContexts.some((context) => issueMatchesContext(issue, context)),
  );
  let bodyIndex = 0;
  const correctedDocument: ParsedMaterial = {
    ...document,
    chapters: document.chapters.map((chapter) => ({
      ...chapter,
      sections: chapter.sections.map((section) => ({
        ...section,
        cards: section.cards.map((card) => {
          const index = bodyIndex++;
          const body = bodies.get(index);
          if (body === undefined) {
            return card;
          }
          const parsed = parseContentMarkdown(
            body,
            { fileName: packageResult.markdownFileName ?? packageResult.sourceFileName, resourcePaths: packageResult.resources.map((resource) => resource.relativePath) },
            [document.title, chapter.title, section.title, card.title],
            card.location.line - 1,
          );
          issues.push(...parsed.issues);
          return { ...card, content: parsed.content, aiFormatCorrected: true };
        }),
      })),
    })),
  };
  return {
    ...packageResult,
    document: correctedDocument,
    imageReferences: packageResult.imageReferences,
    issues,
    valid: issues.length === 0,
  };
}

function addStandaloneMarkdownIssues(result: ImportPackageResult) {
  if (result.sourceType !== 'markdown') {
    return;
  }
  for (const image of result.imageReferences) {
    if (!image.resourcePath) {
      continue;
    }
    result.issues.push({
      code: 'missing_image',
      message: `单个 Markdown 文件缺少图片资源“${image.resourcePath}”。`,
      suggestion: '将 Markdown 和图片一起放入 ZIP 后重试。',
      location: image.location,
      context: [],
    });
  }
  if (result.issues.length > 0) {
    result.valid = false;
  }
}

function isPathInside(parent: string, candidate: string): boolean {
  const normalizedParent = path.resolve(parent) + path.sep;
  return path.resolve(candidate).startsWith(normalizedParent);
}

function managedResourcePath(resourcesDirectory: string, materialId: string, relativePath: string) {
  const normalized = path.posix.normalize(relativePath.replaceAll('\\', '/'));
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    relativePath.includes('\\')
  ) {
    throw new Error(`资源路径不安全：${relativePath}`);
  }
  const materialDirectory = path.resolve(resourcesDirectory, materialId);
  const absolutePath = path.resolve(materialDirectory, ...normalized.split('/'));
  if (!isPathInside(resourcesDirectory, absolutePath) || !isPathInside(materialDirectory, absolutePath)) {
    throw new Error(`资源路径不安全：${relativePath}`);
  }
  return { normalized, materialDirectory, absolutePath };
}

async function prepareResources(
  resourcesDirectory: string,
  materialId: string,
  resources: ImportResource[],
): Promise<PreparedResources> {
  if (resources.length === 0) {
    return { directory: null, items: [] };
  }

  const items: ManagedResource[] = [];
  let materialDirectory: string | null = null;
  try {
    for (const resource of resources) {
      const target = managedResourcePath(resourcesDirectory, materialId, resource.relativePath);
      materialDirectory = target.materialDirectory;
      await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
      await fs.writeFile(target.absolutePath, resource.content, { flag: 'wx' });
      items.push({
        id: randomUUID(),
        sourcePath: resource.relativePath,
        relativePath: `${materialId}/${target.normalized}`,
        absolutePath: target.absolutePath,
        mimeType: mimeTypeFor(resource.relativePath),
        sha256: sha256(resource.content),
      });
    }
    return { directory: materialDirectory, items };
  } catch (error) {
    if (materialDirectory) {
      await fs.rm(materialDirectory, { recursive: true, force: true });
    }
    throw error;
  }
}

function rewriteContent(content: ContentNode[], resources: Map<string, ManagedResource>): ContentNode[] {
  return content.map((node) => {
    const rewritten: ContentNode = { ...node };
    if (node.children) {
      rewritten.children = rewriteContent(node.children, resources);
    }
    if (node.type === 'image' && typeof node.resourcePath === 'string') {
      const resource = resources.get(node.resourcePath);
      if (resource) {
        rewritten.resourcePath = resource.relativePath;
        rewritten.resourceId = resource.id;
      }
    }
    return rewritten;
  });
}

function plainTextContent(bodyText: string): ContentNode[] {
  return [
    {
      type: 'paragraph',
      children: bodyText ? [{ type: 'text', value: bodyText }] : [],
    },
  ];
}

function readObject(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ImportApiError(400, `${label}格式无效。`);
  }
  return value;
}

function readArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ImportApiError(400, `${label}格式无效。`);
  }
  return value;
}

function readTitle(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ImportApiError(400, `${label}格式无效。`);
  }
  const title = value.trim();
  if (!title || title.length > 255) {
    throw new ImportApiError(400, `${label}不能为空且不能超过 255 个字符。`);
  }
  return title;
}

function readBodyText(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new ImportApiError(400, `${label}格式无效。`);
  }
  if (value.length > maxCorrectionTextLength) {
    throw new ImportApiError(400, `${label}不能超过 ${maxCorrectionTextLength} 个字符。`);
  }
  return value;
}

function readCatalogId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    throw new ImportApiError(400, `请选择${label}。`);
  }
  return value.trim();
}

async function verifyImportDestination(
  connection: ImportDatabaseConnection,
  courseId: string,
  subjectId: string,
) {
  const [rows] = await connection.execute(
    `SELECT subject.id
     FROM subjects AS subject
     INNER JOIN courses AS course ON course.id = subject.course_id AND course.deleted_at IS NULL
     WHERE subject.id = ? AND subject.course_id = ? AND subject.deleted_at IS NULL
     LIMIT 1
     FOR UPDATE`,
    [subjectId, courseId],
  );
  if (rowsFrom(rows).length === 0) {
    throw new ImportApiError(400, '所选科目不属于所选课程，请重新选择。');
  }
}

function normalizeCorrection(input: unknown, original: ParsedMaterial): CorrectedDocument {
  const document = readObject(input, '资料修正内容');
  const chapters = readArray(document.chapters, '资料章节');
  if (chapters.length !== original.chapters.length) {
    throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
  }

  return {
    title: readTitle(document.title, '资料标题'),
    chapters: chapters.map((chapterValue, chapterIndex) => {
      const originalChapter = original.chapters[chapterIndex];
      if (!originalChapter) {
        throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
      }
      const chapter = readObject(chapterValue, `第 ${chapterIndex + 1} 章`);
      const sections = readArray(chapter.sections, `第 ${chapterIndex + 1} 章的节`);
      if (sections.length !== originalChapter.sections.length) {
        throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
      }
      return {
        title: readTitle(chapter.title, `第 ${chapterIndex + 1} 章标题`),
        sections: sections.map((sectionValue, sectionIndex) => {
          const originalSection = originalChapter.sections[sectionIndex];
          if (!originalSection) {
            throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
          }
          const section = readObject(sectionValue, `第 ${chapterIndex + 1} 章第 ${sectionIndex + 1} 节`);
          const cards = readArray(section.cards, `第 ${chapterIndex + 1} 章第 ${sectionIndex + 1} 节的闪卡`);
          if (cards.length !== originalSection.cards.length) {
            throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
          }
          return {
            title: readTitle(section.title, `第 ${chapterIndex + 1} 章第 ${sectionIndex + 1} 节标题`),
            cards: cards.map((cardValue, cardIndex) => {
              const card = readObject(
                cardValue,
                `第 ${chapterIndex + 1} 章第 ${sectionIndex + 1} 节第 ${cardIndex + 1} 张闪卡`,
              );
              return {
                title: readTitle(card.title, '闪卡标题'),
                bodyText: readBodyText(card.bodyText, '闪卡正文'),
              };
            }),
          };
        }),
      };
    }),
  };
}

async function insertImport(
  connection: ImportDatabaseConnection,
  preview: StoredImportPreview,
  corrected: CorrectedDocument,
  preparedResources: ManagedResource[],
  materialId: string,
  subjectId: string,
) {
  const resourceMap = new Map(preparedResources.map((resource) => [resource.sourcePath, resource]));
  await connection.execute(
    'INSERT INTO materials (id, subject_id, name, source_filename, source_sha256) VALUES (?, ?, ?, ?, ?)',
    [materialId, subjectId, corrected.title, preview.sourceFileName, preview.sourceSha256],
  );

  for (const resource of preparedResources) {
    await connection.execute(
      'INSERT INTO resources (id, relative_path, mime_type, sha256) VALUES (?, ?, ?, ?)',
      [resource.id, resource.relativePath, resource.mimeType, resource.sha256],
    );
  }

  let chapterCount = 0;
  let sectionCount = 0;
  let cardCount = 0;
  for (const [chapterIndex, chapter] of corrected.chapters.entries()) {
    const originalChapter = preview.packageResult.document?.chapters[chapterIndex];
    if (!originalChapter) {
      throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
    }
    const chapterId = randomUUID();
    chapterCount += 1;
    await connection.execute(
      'INSERT INTO chapters (id, material_id, title, sort_order) VALUES (?, ?, ?, ?)',
      [chapterId, materialId, chapter.title, chapterIndex],
    );

    for (const [sectionIndex, section] of chapter.sections.entries()) {
      const originalSection = originalChapter.sections[sectionIndex];
      if (!originalSection) {
        throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
      }
      const sectionId = randomUUID();
      sectionCount += 1;
      await connection.execute(
        'INSERT INTO sections (id, chapter_id, title, sort_order) VALUES (?, ?, ?, ?)',
        [sectionId, chapterId, section.title, sectionIndex],
      );

      for (const [cardIndex, card] of section.cards.entries()) {
        const originalCard = originalSection.cards[cardIndex];
        if (!originalCard) {
          throw new ImportApiError(400, '预览层级已变化，请重新选择文件。');
        }
        const bodyUnchanged = contentToPlainText(originalCard.content) === card.bodyText;
        const sourceContent = bodyUnchanged
          ? originalCard.content
          : plainTextContent(card.bodyText);
        const content = rewriteContent(sourceContent, resourceMap);
        const highlights = originalCard.aiFormatCorrected
          ? originalCard.highlights
          : resolveImportedHighlights(content, originalCard.highlights, bodyUnchanged);
        if (!highlights) {
          throw new ImportApiError(400, `闪卡“${card.title}”的高亮无法匹配修正后的正文，请重新选择文件。`);
        }
        const cardId = randomUUID();
        cardCount += 1;
        await connection.execute(
          'INSERT INTO cards (id, section_id, title, content_json, sort_order) VALUES (?, ?, ?, ?, ?)',
          [cardId, sectionId, card.title, JSON.stringify(content), cardIndex],
        );
        for (const highlight of highlights) {
          await connection.execute(
            'INSERT INTO highlights (id, card_id, kind, anchor_json) VALUES (?, ?, ?, ?)',
            [randomUUID(), cardId, highlight.kind, JSON.stringify(highlight.anchor)],
          );
        }
      }
    }
  }

  return { materialId, chapterCount, sectionCount, cardCount };
}

export class ImportService {
  private readonly previewStore: ImportPreviewStore;
  private readonly fetchImplementation: typeof fetch;
  private readonly aiCorrectionTimeoutMs: number;

  constructor(private readonly options: ImportServiceOptions) {
    this.previewStore = options.previewStore ?? new InMemoryImportPreviewStore();
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.aiCorrectionTimeoutMs = options.aiCorrectionRequestTimeoutMs ?? aiCorrectionRequestTimeoutMs;
  }

  async preview(sourceFileName: string, source: Buffer): Promise<ImportPreviewResponse> {
    const safeFileName = normalizeUploadFileName(sourceFileName);
    const sourceSha256 = sha256(source);
    const packageResult = await parseImportPackage(safeFileName, source);
    addStandaloneMarkdownIssues(packageResult);
    const duplicateMaterial = await findDuplicate(this.options.database, sourceSha256);
    const valid = packageResult.valid && packageResult.document !== null;
    const stored = (valid || canAiCorrect(packageResult))
      ? this.previewStore.create({
          sourceFileName: safeFileName,
          sourceSha256,
          packageResult,
          duplicateMaterial,
        })
      : null;

    return previewResponse(stored, safeFileName, sourceSha256, packageResult, duplicateMaterial);
  }

  async correctFormat(input: ImportAiCorrectionRequest): Promise<ImportPreviewResponse> {
    if (!isRecord(input) || typeof input.previewId !== 'string' || !input.previewId || !Number.isInteger(input.issueIndex)) {
      throw new ImportApiError(400, '导入预览已失效，请重新选择文件。');
    }
    const preview = this.previewStore.get(input.previewId);
    if (!preview || !canAiCorrect(preview.packageResult) || !preview.packageResult.document) {
      throw new ImportApiError(400, '当前问题不支持 AI 格式修正。');
    }

    const document = preview.packageResult.document;
    const issue = preview.packageResult.issues[input.issueIndex];
    if (!issue) {
      throw new ImportApiError(400, '当前问题不支持 AI 格式修正。');
    }
    const targetIndex = cardIndexForIssue(preview.packageResult, issue);
    if (targetIndex === null) {
      throw new ImportApiError(400, '当前问题不支持 AI 格式修正。');
    }
    const issueId = issueIdentity(issue);
    const cards = cardsFrom(document);
    const targetCard = cards[targetIndex];
    if (!targetCard) {
      throw new ImportApiError(400, '当前问题不支持 AI 格式修正。');
    }
    const requestCard = { index: targetIndex, title: targetCard.card.title, body: markdownBody(targetCard.card.content) };
    const inputLength = requestCard.body.length;
    if (inputLength > maxAiCorrectionInputLength) {
      throw new ImportApiError(400, '需要修正的正文过长，请手动处理格式。');
    }

    const [providerRows] = await this.options.database.execute(
      `
        SELECT id, provider, base_url, model, api_key_ciphertext
        FROM ai_provider_profiles
        WHERE is_active = TRUE
        ORDER BY updated_at DESC, id
        LIMIT 1
      `,
    );
    const provider = rowsFrom(providerRows)[0];
    if (!provider) {
      throw new ImportApiError(503, '尚未配置启用的 AI Provider。');
    }
    if (!provider.api_key_ciphertext) {
      throw new ImportApiError(503, '当前 AI Provider 尚未配置 API Key。');
    }

    let apiKey: string;
    try {
      apiKey = decryptAiProviderApiKey(provider.api_key_ciphertext as Buffer, this.options.encryptionSecret ?? config.ai.providerKeyEncryptionSecret);
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) {
        throw new ImportApiError((error as AiProviderApiError).statusCode, error.message);
      }
      throw new ImportApiError(503, 'AI 密钥解密失败。');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.aiCorrectionTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(endpointFor(textValue(provider.base_url)), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: textValue(provider.model),
          messages: [
            {
              role: 'system',
              content: '你是 Markdown 格式修正器。只能修正输入正文中的 Markdown、GFM 表格、HTML 转 Markdown 或 LaTeX 格式错误。严禁润色、改写、增删、翻译、解释或重排正文内容；标题、正文措辞和可供既有高亮定位的文字及公式必须保持不变。直接返回修正后的完整 Markdown 正文，不要 JSON、代码围栏、标题或解释。',
            },
            {
              role: 'user',
              content: requestCard.body,
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch {
      throw new ImportApiError(502, 'AI 格式修正请求失败。');
    } finally {
      clearTimeout(timer);
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw new ImportApiError(502, 'AI Provider 返回错误。');
    }
    const content = responseContent(payload);
    if (!content) {
      throw new ImportApiError(502, 'AI 返回内容无效。');
    }
    let correctedBodies: Map<number, string>;
    try {
      correctedBodies = new Map([[targetIndex, readAiCorrectedBody(content, targetIndex)]]);
    } catch (error) {
      if (error instanceof ImportApiError) {
        throw error;
      }
      throw new ImportApiError(502, 'AI 返回内容无效。');
    }

    const currentIssueIndex = preview.packageResult.issues.findIndex((item) => issueIdentity(item) === issueId);
    if (currentIssueIndex === -1) {
      return previewResponse(preview, preview.sourceFileName, preview.sourceSha256, preview.packageResult, preview.duplicateMaterial);
    }
    const currentTargetCard = cardsFrom(preview.packageResult.document)[targetIndex];
    if (!currentTargetCard || markdownBody(currentTargetCard.card.content) !== requestCard.body) {
      throw new ImportApiError(409, '该闪卡正文已被另一条格式修正更新，请重新处理当前问题。');
    }
    const issueCountBefore = issueCountForCard(preview.packageResult, targetIndex);
    const issueCodeCountBefore = issueCodeCountForCard(preview.packageResult, targetIndex, issue.code);
    const correctedPackage = updateCorrectedDocument(preview.packageResult, correctedBodies);
    if (
      !correctedPackage.document
      || issueCountForCard(correctedPackage, targetIndex) >= issueCountBefore
      || issueCodeCountForCard(correctedPackage, targetIndex, issue.code) >= issueCodeCountBefore
    ) {
      throw new ImportApiError(400, 'AI 未能完成格式修正，请手动处理。');
    }
    preview.packageResult = correctedPackage;
    preview.revision += 1;
    return previewResponse(preview, preview.sourceFileName, preview.sourceSha256, correctedPackage, preview.duplicateMaterial);
  }

  async apply(input: ImportApplyRequest): Promise<ImportApplyResponse> {
    if (!isRecord(input) || typeof input.previewId !== 'string' || !input.previewId) {
      throw new ImportApiError(400, '导入预览已失效，请重新选择文件。');
    }
    const preview = this.previewStore.get(input.previewId);
    if (!preview || !preview.packageResult.document || !preview.packageResult.valid) {
      throw new ImportApiError(404, '导入预览已失效，请重新选择文件。');
    }
    const corrected = normalizeCorrection(input.document, preview.packageResult.document);
    const courseId = readCatalogId(input.courseId, '课程');
    const subjectId = readCatalogId(input.subjectId, '科目');
    const skipDuplicate = input.skipDuplicate !== false;
    let connection: ImportDatabaseConnection | null = null;
    let prepared: PreparedResources | null = null;
    let committed = false;

    try {
      connection = await this.options.database.getConnection();
      await connection.beginTransaction();
      await verifyImportDestination(connection, courseId, subjectId);
      const duplicateMaterial = await findDuplicate(connection, preview.sourceSha256, true);
      if (duplicateMaterial) {
        if (!skipDuplicate) {
          throw new ImportApiError(409, `资料“${duplicateMaterial.name}”已经导入过。`);
        }
        await connection.commit();
        committed = true;
        this.previewStore.delete(preview.id);
        return { status: 'skipped', reason: 'duplicate', material: duplicateMaterial };
      }

      const materialId = randomUUID();
      prepared = await prepareResources(this.options.resourcesDirectory, materialId, preview.packageResult.resources);
      const result = await insertImport(connection, preview, corrected, prepared.items, materialId, subjectId);
      if (result.materialId !== materialId) {
        throw new Error('资料 ID 生成不一致。');
      }
      await connection.commit();
      committed = true;
      this.previewStore.delete(preview.id);
      return {
        status: 'applied',
        materialId: result.materialId,
        materialName: corrected.title,
        chapterCount: result.chapterCount,
        sectionCount: result.sectionCount,
        cardCount: result.cardCount,
        resourceCount: prepared.items.length,
      };
    } catch (error) {
      if (connection && !committed) {
        await connection.rollback().catch(() => undefined);
      }
      if (prepared?.directory && !committed) {
        await fs.rm(prepared.directory, { recursive: true, force: true }).catch(() => undefined);
      }
      if (error instanceof ImportApiError) {
        throw error;
      }
      throw new ImportApiError(500, '资料应用失败，请检查数据库和资源目录后重试。');
    } finally {
      connection?.release();
    }
  }

  cancel(previewId: string) {
    this.previewStore.delete(previewId);
  }
}

export function createImportDatabase(pool: Pool): ImportDatabase {
  const execute = (sql: string, values?: readonly unknown[]) =>
    pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>;
  return {
    execute,
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

export function createImportService(
  options: Partial<ImportServiceOptions> = {},
): ImportService {
  const database = options.database ?? createImportDatabase(createDatabasePool());
  return new ImportService({
    database,
    resourcesDirectory: options.resourcesDirectory ?? config.storage.resources,
    previewStore: options.previewStore,
    encryptionSecret: options.encryptionSecret,
    fetchImplementation: options.fetchImplementation,
    aiCorrectionRequestTimeoutMs: options.aiCorrectionRequestTimeoutMs,
  });
}
