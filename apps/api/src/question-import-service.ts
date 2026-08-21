import { createHash, randomUUID } from 'node:crypto';
import XlsxPopulate from 'xlsx-populate';
import type {
  QuestionBankKind,
  QuestionImportAppliedResponse,
  QuestionImportApplyRequest,
  QuestionImportDuplicateQuestionBank,
  QuestionImportIssueResponse,
  QuestionImportPreviewChapter,
  QuestionImportPreviewDocument,
  QuestionImportPreviewQuestion,
  QuestionImportPreviewResponse,
  QuestionImportSourceLocation,
  QuestionImportTemplateFormat,
  QuestionType,
  ReviewContentNode,
} from '@knowledge-flashcards/shared';
import { createDatabasePool } from './database.js';
import { parseContentMarkdown, type ContentNode, type ImportIssue } from './ingestion.js';

const previewTtlMs = 30 * 60 * 1000;
const previewMaxEntries = 20;
const maxTextLength = 1_000_000;
const questionKinds = new Set<QuestionBankKind>(['chapter', 'official', 'mock']);
const questionTypes = new Set<QuestionType>(['single', 'multiple', 'true_false']);
const optionKeys = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export interface QuestionImportSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface QuestionImportDatabaseConnection extends QuestionImportSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface QuestionImportDatabase extends QuestionImportSqlExecutor {
  getConnection(): Promise<QuestionImportDatabaseConnection>;
}

export interface QuestionImportTemplate {
  fileName: string;
  contentType: string;
  content: Buffer | string;
}

interface ParsedQuestion {
  stemText: string;
  stem: ContentNode[];
  type: QuestionType;
  options: Array<{ key: string; text: string; content: ContentNode[] }>;
  answer: string[];
  analysisText: string | null;
  analysis: ContentNode[] | null;
  knowledgePoints: string[];
  location: QuestionImportSourceLocation;
  chapterTitle: string | null;
  chapterIndex: number | null;
}

interface ParsedChapter {
  title: string;
  location: QuestionImportSourceLocation;
  questions: ParsedQuestion[];
}

interface ParsedQuestionBank {
  title: string;
  kind: QuestionBankKind;
  chapters: ParsedChapter[];
  questions: ParsedQuestion[];
  issues: ImportIssue[];
  valid: boolean;
}

interface StoredQuestionImportPreview {
  id: string;
  createdAt: number;
  courseId: string;
  subjectId: string;
  kind: QuestionBankKind;
  sourceFileName: string;
  sourceSha256: string;
  parsed: ParsedQuestionBank;
  duplicateQuestionBank: QuestionImportDuplicateQuestionBank | null;
}

export interface QuestionImportPreviewStore {
  create(preview: Omit<StoredQuestionImportPreview, 'id' | 'createdAt'>): StoredQuestionImportPreview;
  get(id: string): StoredQuestionImportPreview | null;
  delete(id: string): void;
}

export class InMemoryQuestionImportPreviewStore implements QuestionImportPreviewStore {
  private readonly previews = new Map<string, StoredQuestionImportPreview>();

  constructor(
    private readonly ttl = previewTtlMs,
    private readonly maxEntries = previewMaxEntries,
  ) {}

  create(preview: Omit<StoredQuestionImportPreview, 'id' | 'createdAt'>) {
    this.removeExpired();
    while (this.previews.size >= this.maxEntries) {
      const oldestId = this.previews.keys().next().value;
      if (typeof oldestId !== 'string') break;
      this.previews.delete(oldestId);
    }
    const stored = { ...preview, id: randomUUID(), createdAt: Date.now() };
    this.previews.set(stored.id, stored);
    return stored;
  }

  get(id: string) {
    this.removeExpired();
    return this.previews.get(id) ?? null;
  }

  delete(id: string) {
    this.previews.delete(id);
  }

  private removeExpired() {
    const cutoff = Date.now() - this.ttl;
    for (const [id, preview] of this.previews) {
      if (preview.createdAt < cutoff) this.previews.delete(id);
    }
  }
}

export class QuestionImportApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'QuestionImportApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowsFrom(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function sha256(source: Buffer): string {
  return createHash('sha256').update(source).digest('hex');
}

function normalizeUploadFileName(fileName: string): string {
  const normalized = fileName.trim().replaceAll('\\', '/');
  const baseName = normalized.split('/').at(-1) ?? '';
  if (!baseName || baseName === '.' || baseName === '..' || baseName.includes('\0')) {
    throw new QuestionImportApiError(400, '上传文件名无效。');
  }
  return baseName;
}

function location(fileName: string, line: number, column = 1): QuestionImportSourceLocation {
  return { fileName, line: Math.max(1, line), column: Math.max(1, column) };
}

function issue(
  code: string,
  message: string,
  suggestion: string,
  fileName: string,
  line: number,
  context: string[],
  column = 1,
): ImportIssue {
  return { code: code as ImportIssue['code'], message, suggestion, location: location(fileName, line, column), context };
}

function issueResponse(value: ImportIssue): QuestionImportIssueResponse {
  return { code: value.code, message: value.message, suggestion: value.suggestion, location: value.location, context: value.context };
}

function schemaIssue(
  sourceType: 'json' | 'excel',
  message: string,
  suggestion: string,
  fileName: string,
  line: number,
  context: string[],
  column = 1,
): ImportIssue {
  return issue(`${sourceType}_schema_error`, message, suggestion, fileName, line, context, column);
}

function requiredText(
  value: unknown,
  label: string,
  sourceType: 'json' | 'excel',
  fileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
  maxLength = 255,
): string | null {
  if (typeof value === 'string' && value.trim()) {
    if (value.trim().length > maxLength) {
      issues.push(schemaIssue(sourceType, `${label}不能超过 ${maxLength} 个字符。`, '缩短文本后重新导入。', fileName, line, context));
      return null;
    }
    return value.trim();
  }
  issues.push(schemaIssue(sourceType, `${label}不能为空。`, '填写非空文本后重新导入。', fileName, line, context));
  return null;
}

function textField(
  value: unknown,
  label: string,
  sourceType: 'json' | 'excel',
  fileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') {
    issues.push(schemaIssue(sourceType, `${label}必须是文本。`, '填写文本或留空。', fileName, line, context));
    return null;
  }
  if (value.length > maxTextLength) {
    issues.push(schemaIssue(sourceType, `${label}不能超过 ${maxTextLength} 个字符。`, '缩短内容后重新导入。', fileName, line, context));
    return null;
  }
  return value.trim() || null;
}

function parseMarkdownField(
  value: string,
  label: string,
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): ContentNode[] {
  const parsed = parseContentMarkdown(value, { fileName: sourceFileName, resourcePaths: [] }, [...context, label], line - 1);
  issues.push(...parsed.issues);
  if (parsed.imageReferences.length > 0) {
    issues.push(schemaIssue('json', `${label}不支持导入图片。`, '删除图片后重新导入题库。', sourceFileName, line, [...context, label]));
  }
  return parsed.content;
}

function parseMarkdownFieldForExcel(
  value: string,
  label: string,
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): ContentNode[] {
  const parsed = parseContentMarkdown(value, { fileName: sourceFileName, resourcePaths: [] }, [...context, label], line - 1);
  issues.push(...parsed.issues);
  if (parsed.imageReferences.length > 0) {
    issues.push(schemaIssue('excel', `${label}不支持导入图片。`, '删除图片后重新导入题库。', sourceFileName, line, [...context, label]));
  }
  return parsed.content;
}

function normalizeType(value: unknown): QuestionType | null {
  return typeof value === 'string' && questionTypes.has(value as QuestionType) ? value as QuestionType : null;
}

function optionObject(
  value: unknown,
  sourceType: 'json' | 'excel',
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): Map<string, string> {
  const result = new Map<string, string>();
  if (!isRecord(value)) {
    issues.push(schemaIssue(sourceType, '选项必须是对象。', '使用 A、B、C 等连续字母作为选项键。', sourceFileName, line, [...context, '选项']));
    return result;
  }
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!(optionKeys as readonly string[]).includes(key)) {
      issues.push(schemaIssue(sourceType, `选项“${key}”无效。`, '选项只能使用 A 到 F，且必须从 A 连续填写。', sourceFileName, line, [...context, '选项', key]));
      continue;
    }
    const text = value[key];
    if (typeof text !== 'string' || !text.trim()) {
      issues.push(schemaIssue(sourceType, `选项${key}不能为空。`, '删除未使用的选项，或填写非空文本。', sourceFileName, line, [...context, '选项', key]));
      continue;
    }
    if (text.length > maxTextLength) {
      issues.push(schemaIssue(sourceType, `选项${key}过长。`, '缩短选项内容后重新导入。', sourceFileName, line, [...context, '选项', key]));
      continue;
    }
    result.set(key, text.trim());
  }
  const sortedKeys = [...result.keys()].sort();
  if (sortedKeys.length < 2 || sortedKeys.length > 6) {
    issues.push(schemaIssue(sourceType, '选项数量必须为 2 到 6 个。', '从 A 开始填写 2 到 6 个连续选项。', sourceFileName, line, [...context, '选项']));
  }
  sortedKeys.forEach((key, index) => {
    if (key !== optionKeys[index]) {
      issues.push(schemaIssue(sourceType, '选项必须从 A 开始连续填写，不能跳号或留空。', '例如填写 A、B、C，不要直接填写 A、C。', sourceFileName, line, [...context, '选项']));
    }
  });
  return result;
}

function excelOptionObject(
  values: string[],
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): Map<string, string> {
  const result = new Map<string, string>();
  let reachedEmpty = false;
  values.forEach((value, index) => {
    const key = optionKeys[index]!;
    if (!value) {
      reachedEmpty = true;
      return;
    }
    if (reachedEmpty) {
      issues.push(schemaIssue('excel', `选项${key}前存在空选项。`, '选项必须从 A 开始连续填写，不能留空后继续填写。', sourceFileName, line, [...context, `选项${key}`]));
      return;
    }
    result.set(key, value);
  });
  return optionObject(Object.fromEntries(result), 'excel', sourceFileName, line, context, issues);
}

function normalizeAnswer(
  value: unknown,
  type: QuestionType | null,
  options: Map<string, string>,
  sourceType: 'json' | 'excel',
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): string[] {
  if (!type) return [];
  let answer: string[] = [];
  if (sourceType === 'json') {
    if (type === 'multiple') {
      if (!Array.isArray(value)) {
        issues.push(schemaIssue(sourceType, '多选题答案必须是数组。', '例如填写 ["A", "C"]。', sourceFileName, line, [...context, '答案']));
        return [];
      }
      answer = value.map((item) => typeof item === 'string' ? item.trim().toUpperCase() : '');
    } else if (typeof value === 'string') {
      answer = [value.trim().toUpperCase()];
    } else {
      issues.push(schemaIssue(sourceType, '单选题和判断题答案必须是一个字母。', '例如填写 "A"。', sourceFileName, line, [...context, '答案']));
      return [];
    }
  } else if (typeof value === 'string') {
    const normalized = value.trim().toUpperCase();
    answer = normalized.split(/[\s,，、;；]+/).filter(Boolean);
    if (type !== 'multiple' && answer.length !== 1 && normalized.length === 1) answer = [normalized];
  } else {
    issues.push(schemaIssue(sourceType, '答案必须是文本。', '填写选项字母，例如 A 或 A,C。', sourceFileName, line, [...context, '答案']));
    return [];
  }
  if (answer.some((item) => !(optionKeys as readonly string[]).includes(item))) {
    issues.push(schemaIssue(sourceType, '答案只能使用 A 到 F 的选项字母。', '检查答案是否与实际选项一致。', sourceFileName, line, [...context, '答案']));
  }
  if (new Set(answer).size !== answer.length) {
    issues.push(schemaIssue(sourceType, '答案不能包含重复选项。', '每个正确选项只填写一次。', sourceFileName, line, [...context, '答案']));
  }
  if (answer.some((item) => !options.has(item))) {
    issues.push(schemaIssue(sourceType, '答案必须对应已填写的选项。', '删除不存在的答案字母，或补齐对应选项。', sourceFileName, line, [...context, '答案']));
  }
  if (type === 'multiple' && answer.length < 2) {
    issues.push(schemaIssue(sourceType, '多选题至少需要两个正确选项。', '填写两个或以上答案字母，例如 A,C。', sourceFileName, line, [...context, '答案']));
  }
  if ((type === 'single' || type === 'true_false') && answer.length !== 1) {
    issues.push(schemaIssue(sourceType, '单选题和判断题只能有一个正确选项。', '只填写一个答案字母。', sourceFileName, line, [...context, '答案']));
  }
  return answer;
}

function enforceTrueFalse(
  type: QuestionType | null,
  options: Map<string, string>,
  sourceType: 'json' | 'excel',
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
) {
  if (type !== 'true_false') return;
  if (options.size !== 2 || options.get('A') !== '对' || options.get('B') !== '错') {
    issues.push(schemaIssue(sourceType, '判断题选项必须固定为 A: 对、B: 错。', '不要修改判断题的两个选项文本。', sourceFileName, line, [...context, '选项']));
  }
}

function knowledgePoints(
  value: unknown,
  sourceType: 'json' | 'excel',
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): string[] {
  const values = sourceType === 'excel'
    ? (typeof value === 'string' ? value.split(',') : [])
    : (value === undefined ? [] : Array.isArray(value) ? value : null);
  if (values === null) {
    issues.push(schemaIssue(sourceType, '知识点必须是数组。', '填写字符串数组，或留空。', sourceFileName, line, [...context, '知识点']));
    return [];
  }
  const result: string[] = [];
  for (const item of values) {
    if (typeof item !== 'string' || !item.trim()) {
      issues.push(schemaIssue(sourceType, '知识点不能包含空值。', '删除空知识点，或使用非空文本。', sourceFileName, line, [...context, '知识点']));
      continue;
    }
    result.push(item.trim());
  }
  return result;
}

function questionFromFields(
  sourceType: 'json' | 'excel',
  sourceFileName: string,
  line: number,
  context: string[],
  fields: { stem: unknown; type: unknown; options: unknown; answer: unknown; analysis?: unknown; knowledgePoints?: unknown },
  issues: ImportIssue[],
  chapterTitle: string | null,
  chapterIndex: number | null,
): ParsedQuestion | null {
  const stemText = requiredText(fields.stem, '题干', sourceType, sourceFileName, line, [...context, '题干'], issues, maxTextLength) ?? '';
  const type = normalizeType(fields.type);
  if (!type) {
    issues.push(schemaIssue(sourceType, '题型无效。', '题型只能是 single、multiple 或 true_false。', sourceFileName, line, [...context, '题型']));
  }
  const options = sourceType === 'excel'
    ? excelOptionObject(Array.isArray(fields.options) ? fields.options as string[] : [], sourceFileName, line, context, issues)
    : optionObject(fields.options, sourceType, sourceFileName, line, context, issues);
  enforceTrueFalse(type, options, sourceType, sourceFileName, line, context, issues);
  const answer = normalizeAnswer(fields.answer, type, options, sourceType, sourceFileName, line, context, issues);
  const analysisText = textField(fields.analysis, '解析', sourceType, sourceFileName, line, [...context, '解析'], issues);
  const knowledge = knowledgePoints(fields.knowledgePoints, sourceType, sourceFileName, line, context, issues);
  const stem = stemText ? (sourceType === 'excel'
    ? parseMarkdownFieldForExcel(stemText, '题干', sourceFileName, line, context, issues)
    : parseMarkdownField(stemText, '题干', sourceFileName, line, context, issues)) : [];
  const parsedOptions = [...options.entries()].map(([key, text]) => ({
    key,
    text,
    content: sourceType === 'excel'
      ? parseMarkdownFieldForExcel(text, `选项${key}`, sourceFileName, line, context, issues)
      : parseMarkdownField(text, `选项${key}`, sourceFileName, line, context, issues),
  }));
  const analysis = analysisText
    ? (sourceType === 'excel'
      ? parseMarkdownFieldForExcel(analysisText, '解析', sourceFileName, line, context, issues)
      : parseMarkdownField(analysisText, '解析', sourceFileName, line, context, issues))
    : null;
  return {
    stemText,
    stem,
    type: type ?? 'single',
    options: parsedOptions,
    answer,
    analysisText,
    analysis,
    knowledgePoints: knowledge,
    location: location(sourceFileName, line),
    chapterTitle,
    chapterIndex,
  };
}

function parseJson(sourceFileName: string, source: Buffer, kind: QuestionBankKind): ParsedQuestionBank {
  const issues: ImportIssue[] = [];
  let payload: Record<string, unknown>;
  try {
    const value = JSON.parse(source.toString('utf8'));
    if (!isRecord(value)) throw new Error('根节点必须是对象。');
    payload = value;
  } catch (error) {
    issues.push(issue('json_read_error', `JSON 文件无法读取：${error instanceof Error ? error.message : '未知错误'}。`, '使用下载的 JSON 模板并确认文件未损坏。', sourceFileName, 1, []));
    return { title: '', kind, chapters: [], questions: [], issues, valid: false };
  }
  if (payload.format !== 'knowledge-flashcards-question-bank' || payload.version !== 1) {
    issues.push(schemaIssue('json', 'JSON 格式或版本不匹配。', '使用题库导入页下载的 JSON 模板。', sourceFileName, 1, []));
  }
  const title = requiredText(payload.title, '题库名称', 'json', sourceFileName, 1, [], issues) ?? '';
  const chapters: ParsedChapter[] = [];
  const questions: ParsedQuestion[] = [];
  if (kind === 'chapter') {
    if (!Array.isArray(payload.chapters)) {
      issues.push(schemaIssue('json', '章节题库必须填写 chapters 数组。', '章节题使用 chapters，每章包含 title 和 questions。', sourceFileName, 1, []));
    }
    if (payload.questions !== undefined) {
      issues.push(schemaIssue('json', '章节题库不能填写根级 questions。', '把题目放入对应章节的 questions 数组。', sourceFileName, 1, []));
    }
    for (const [chapterIndex, value] of (Array.isArray(payload.chapters) ? payload.chapters : []).entries()) {
      const line = chapterIndex + 2;
      if (!isRecord(value)) {
        issues.push(schemaIssue('json', `第 ${chapterIndex + 1} 章必须是对象。`, '每章填写 title 和 questions。', sourceFileName, line, [title, `第 ${chapterIndex + 1} 章`]));
        continue;
      }
      const chapterTitle = requiredText(value.title, `第 ${chapterIndex + 1} 章标题`, 'json', sourceFileName, line, [title], issues);
      const chapterQuestions: ParsedQuestion[] = [];
      if (!Array.isArray(value.questions)) {
        issues.push(schemaIssue('json', '章节 questions 必须是数组。', '在章节中填写至少一道题目。', sourceFileName, line, [title, chapterTitle ?? `第 ${chapterIndex + 1} 章`]));
      }
      for (const [questionIndex, questionValue] of (Array.isArray(value.questions) ? value.questions : []).entries()) {
        const questionLine = line + questionIndex + 1;
        const context = [title, chapterTitle ?? `第 ${chapterIndex + 1} 章`, `第 ${questionIndex + 1} 题`];
        if (!isRecord(questionValue)) {
          issues.push(schemaIssue('json', '题目必须是对象。', '填写题干、题型、选项和答案。', sourceFileName, questionLine, context));
          continue;
        }
        const parsed = questionFromFields('json', sourceFileName, questionLine, context, {
          stem: questionValue.stem,
          type: questionValue.type,
          options: questionValue.options,
          answer: questionValue.answer,
          analysis: questionValue.analysis,
          knowledgePoints: questionValue.knowledgePoints,
        }, issues, chapterTitle, chapterIndex);
        if (parsed) chapterQuestions.push(parsed);
      }
      if (chapterTitle) chapters.push({ title: chapterTitle, location: location(sourceFileName, line), questions: chapterQuestions });
    }
  } else {
    if (!Array.isArray(payload.questions)) {
      issues.push(schemaIssue('json', '真题或模拟题库必须填写根级 questions 数组。', '在根节点填写 questions，不要使用 chapters。', sourceFileName, 1, []));
    }
    if (payload.chapters !== undefined) {
      issues.push(schemaIssue('json', '真题和模拟题不能填写 chapters。', '真题和模拟题不区分章节，请使用根级 questions。', sourceFileName, 1, []));
    }
    for (const [questionIndex, questionValue] of (Array.isArray(payload.questions) ? payload.questions : []).entries()) {
      const line = questionIndex + 2;
      const context = [title, `第 ${questionIndex + 1} 题`];
      if (!isRecord(questionValue)) {
        issues.push(schemaIssue('json', '题目必须是对象。', '填写题干、题型、选项和答案。', sourceFileName, line, context));
        continue;
      }
      const parsed = questionFromFields('json', sourceFileName, line, context, {
        stem: questionValue.stem,
        type: questionValue.type,
        options: questionValue.options,
        answer: questionValue.answer,
        analysis: questionValue.analysis,
        knowledgePoints: questionValue.knowledgePoints,
      }, issues, null, null);
      if (parsed) questions.push(parsed);
    }
  }
  const count = chapters.reduce((sum, chapter) => sum + chapter.questions.length, 0) + questions.length;
  if (count === 0) issues.push(schemaIssue('json', '题库没有可导入的题目。', '至少填写一道完整题目。', sourceFileName, 1, [title]));
  return { title, kind, chapters, questions, issues, valid: issues.length === 0 && Boolean(title) && count > 0 };
}

function excelText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim();
}

async function parseExcel(sourceFileName: string, source: Buffer, kind: QuestionBankKind): Promise<ParsedQuestionBank> {
  const issues: ImportIssue[] = [];
  let workbook: Awaited<ReturnType<typeof XlsxPopulate.fromDataAsync>>;
  try {
    workbook = await XlsxPopulate.fromDataAsync(source);
  } catch (error) {
    issues.push(issue('excel_read_error', `Excel 文件无法读取：${error instanceof Error ? error.message : '未知错误'}。`, '使用下载的 Excel 模板并确认文件未损坏。', sourceFileName, 1, []));
    return { title: '', kind, chapters: [], questions: [], issues, valid: false };
  }
  const worksheet = workbook.sheet('题库');
  const headers = kind === 'chapter'
    ? ['题库', '章节', '题干', '题型', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '答案', '解析', '知识点']
    : ['题库', '题干', '题型', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '答案', '解析', '知识点'];
  if (!worksheet) {
    issues.push(issue('excel_schema_error', '找不到“题库”工作表。', '使用题库导入页下载的 Excel 模板，不要修改工作表名称。', sourceFileName, 1, []));
    return { title: '', kind, chapters: [], questions: [], issues, valid: false };
  }
  const used = worksheet.usedRange();
  const table = used ? used.value() : [];
  const headerRow = Array.isArray(table) && Array.isArray(table[0]) ? table[0] as unknown[] : [];
  if (headers.some((header, index) => excelText(headerRow[index]) !== header)) {
    issues.push(issue('excel_schema_error', 'Excel 列标题不匹配。', `首行必须依次为：${headers.join('、')}。`, sourceFileName, 1, []));
    return { title: '', kind, chapters: [], questions: [], issues, valid: false };
  }
  let title: string | null = null;
  const chapters: ParsedChapter[] = [];
  const chapterMap = new Map<string, ParsedChapter>();
  const questions: ParsedQuestion[] = [];
  const dataRows = Array.isArray(table) ? table.slice(1) : [];
  for (const [rowIndex, rawRow] of dataRows.entries()) {
    const rowNumber = rowIndex + 2;
    const row = Array.isArray(rawRow) ? rawRow : [];
    const values = headers.map((_, index) => excelText(row[index]));
    if (values.every((value) => !value)) continue;
    const rowTitle = requiredText(values[0], '题库名称', 'excel', sourceFileName, rowNumber, [], issues);
    if (rowTitle && title && rowTitle !== title) {
      issues.push(issue('excel_schema_error', '题库列必须保持一致。', `将本行题库名称修改为“${title}”，或拆分为单独文件。`, sourceFileName, rowNumber, [title, '题库']));
      continue;
    }
    title ??= rowTitle;
    const offset = kind === 'chapter' ? 1 : 0;
    const chapterTitle = kind === 'chapter' ? requiredText(values[1], '章节', 'excel', sourceFileName, rowNumber, [title ?? ''], issues) : null;
    const stemIndex = 1 + offset;
    const typeIndex = stemIndex + 1;
    const optionStart = typeIndex + 1;
    const context = [title ?? '', ...(chapterTitle ? [chapterTitle] : []), `第 ${rowIndex + 1} 题`].filter(Boolean);
    const parsed = questionFromFields('excel', sourceFileName, rowNumber, context, {
      stem: values[stemIndex],
      type: values[typeIndex],
      options: values.slice(optionStart, optionStart + 6),
      answer: values[optionStart + 6],
      analysis: values[optionStart + 7],
      knowledgePoints: values[optionStart + 8],
    }, issues, chapterTitle, kind === 'chapter' ? chapters.length : null);
    if (!parsed) continue;
    if (kind === 'chapter') {
      const key = chapterTitle!;
      let chapter = chapterMap.get(key);
      if (!chapter) {
        chapter = { title: key, location: location(sourceFileName, rowNumber), questions: [] };
        chapterMap.set(key, chapter);
        chapters.push(chapter);
      }
      parsed.chapterIndex = chapters.indexOf(chapter);
      chapter.questions.push(parsed);
    } else {
      questions.push(parsed);
    }
  }
  if (!title) issues.push(issue('excel_schema_error', 'Excel 没有可导入的题目行。', '从第 2 行开始填写至少一道题目。', sourceFileName, 2, []));
  const count = chapters.reduce((sum, chapter) => sum + chapter.questions.length, 0) + questions.length;
  if (count === 0 && title) issues.push(issue('excel_schema_error', '题库没有可导入的题目。', '至少填写一道完整题目。', sourceFileName, 2, [title]));
  return { title: title ?? '', kind, chapters, questions, issues, valid: issues.length === 0 && Boolean(title) && count > 0 };
}

function previewQuestion(question: ParsedQuestion): QuestionImportPreviewQuestion {
  return {
    stemText: question.stemText,
    type: question.type,
    options: question.options.map(({ key, text }) => ({ key, text })),
    answer: question.answer,
    analysisText: question.analysisText,
    knowledgePoints: question.knowledgePoints,
    location: question.location,
  };
}

function previewDocument(parsed: ParsedQuestionBank): QuestionImportPreviewDocument {
  return {
    title: parsed.title,
    kind: parsed.kind,
    chapters: parsed.chapters.map((chapter): QuestionImportPreviewChapter => ({
      title: chapter.title,
      location: chapter.location,
      questions: chapter.questions.map(previewQuestion),
    })),
    questions: parsed.questions.map(previewQuestion),
  };
}

function previewResponse(preview: StoredQuestionImportPreview | null, sourceFileName: string, sourceSha256Value: string, kind: QuestionBankKind, courseId: string, subjectId: string, parsed: ParsedQuestionBank, duplicate: QuestionImportDuplicateQuestionBank | null): QuestionImportPreviewResponse {
  return {
    previewId: preview?.id ?? null,
    sourceFileName,
    sourceType: sourceFileName.toLowerCase().endsWith('.json') ? 'json' : sourceFileName.toLowerCase().endsWith('.xlsx') ? 'excel' : null,
    sourceSha256: sourceSha256Value,
    courseId,
    subjectId,
    kind,
    valid: parsed.valid,
    duplicate: duplicate !== null,
    duplicateQuestionBank: duplicate,
    document: parsed.title ? previewDocument(parsed) : null,
    issues: parsed.issues.map(issueResponse),
  };
}

function duplicateFromRow(row: Record<string, unknown> | undefined): QuestionImportDuplicateQuestionBank | null {
  if (!row || typeof row.id !== 'string' || typeof row.name !== 'string') return null;
  return { id: row.id, name: row.name };
}

async function verifyDestination(database: QuestionImportSqlExecutor, courseId: string, subjectId: string, forUpdate = false) {
  const [rows] = await database.execute(
    `SELECT subject.id FROM subjects AS subject INNER JOIN courses AS course ON course.id = subject.course_id AND course.deleted_at IS NULL WHERE subject.id = ? AND subject.course_id = ? AND subject.deleted_at IS NULL LIMIT 1${forUpdate ? ' FOR UPDATE' : ''}`,
    [subjectId, courseId],
  );
  if (rowsFrom(rows).length === 0) throw new QuestionImportApiError(400, '所选科目不属于所选课程，请重新选择。');
}

async function findDuplicate(database: QuestionImportSqlExecutor, subjectId: string, kind: QuestionBankKind, name: string, forUpdate = false): Promise<QuestionImportDuplicateQuestionBank | null> {
  const [rows] = await database.execute(
    `SELECT id, name FROM question_banks WHERE subject_id = ? AND kind = ? AND name = ? AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
    [subjectId, kind, name],
  );
  return duplicateFromRow(rowsFrom(rows)[0]);
}

async function lockBanksAndNextOrder(connection: QuestionImportDatabaseConnection, subjectId: string, kind: QuestionBankKind) {
  await connection.execute('SELECT id FROM question_banks WHERE subject_id = ? AND kind = ? AND deleted_at IS NULL FOR UPDATE', [subjectId, kind]);
  const [rows] = await connection.execute('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM question_banks WHERE subject_id = ? AND kind = ? AND deleted_at IS NULL', [subjectId, kind]);
  return Number(rowsFrom(rows)[0]?.next_order ?? 0);
}

function contentForStorage(content: ContentNode[]): ReviewContentNode[] {
  return content.map(({ position: _position, ...node }) => ({
    ...node,
    children: node.children ? contentForStorage(node.children) : undefined,
  })) as ReviewContentNode[];
}

function allQuestions(parsed: ParsedQuestionBank): ParsedQuestion[] {
  return parsed.kind === 'chapter' ? parsed.chapters.flatMap((chapter) => chapter.questions) : parsed.questions;
}

export interface QuestionImportServiceOptions {
  database: QuestionImportDatabase;
  previewStore?: QuestionImportPreviewStore;
}

export class QuestionImportService {
  private readonly previewStore: QuestionImportPreviewStore;

  constructor(private readonly options: QuestionImportServiceOptions) {
    this.previewStore = options.previewStore ?? new InMemoryQuestionImportPreviewStore();
  }

  async preview(sourceFileName: string, source: Buffer, courseId: string, subjectId: string, kind: QuestionBankKind): Promise<QuestionImportPreviewResponse> {
    const safeFileName = normalizeUploadFileName(sourceFileName);
    if (!questionKinds.has(kind)) throw new QuestionImportApiError(400, '题库类型无效。');
    if (!courseId.trim() || !subjectId.trim()) throw new QuestionImportApiError(400, '请选择课程和科目。');
    await verifyDestination(this.options.database, courseId.trim(), subjectId.trim());
    const extension = safeFileName.toLowerCase().split('.').at(-1);
    const parsed = extension === 'json'
      ? parseJson(safeFileName, source, kind)
      : extension === 'xlsx'
      ? await parseExcel(safeFileName, source, kind)
      : { title: '', kind, chapters: [], questions: [], issues: [issue('invalid_extension', `不支持的文件类型“${extension ? `.${extension}` : '无扩展名'}”。`, '只选择 .json 或 .xlsx 文件。', safeFileName, 1, [])], valid: false };
    const sourceHash = sha256(source);
    const duplicate = parsed.title ? await findDuplicate(this.options.database, subjectId.trim(), kind, parsed.title) : null;
    const stored = parsed.valid ? this.previewStore.create({
      courseId: courseId.trim(), subjectId: subjectId.trim(), kind, sourceFileName: safeFileName, sourceSha256: sourceHash, parsed, duplicateQuestionBank: duplicate,
    }) : null;
    return previewResponse(stored, safeFileName, sourceHash, kind, courseId.trim(), subjectId.trim(), parsed, duplicate);
  }

  async apply(input: QuestionImportApplyRequest): Promise<QuestionImportAppliedResponse> {
    if (!isRecord(input) || typeof input.previewId !== 'string' || !input.previewId) throw new QuestionImportApiError(400, '导入预览已失效，请重新选择文件。');
    const preview = this.previewStore.get(input.previewId);
    if (!preview || !preview.parsed.valid) throw new QuestionImportApiError(404, '导入预览已失效，请重新选择文件。');
    let connection: QuestionImportDatabaseConnection | null = null;
    let committed = false;
    try {
      connection = await this.options.database.getConnection();
      await connection.beginTransaction();
      await verifyDestination(connection, preview.courseId, preview.subjectId, true);
      const sortOrder = await lockBanksAndNextOrder(connection, preview.subjectId, preview.kind);
      const duplicate = await findDuplicate(connection, preview.subjectId, preview.kind, preview.parsed.title);
      if (duplicate) throw new QuestionImportApiError(409, `题库“${duplicate.name}”已经存在。`);
      const questionBankId = randomUUID();
      await connection.execute('INSERT INTO question_banks (id, subject_id, kind, name, sort_order) VALUES (?, ?, ?, ?, ?)', [questionBankId, preview.subjectId, preview.kind, preview.parsed.title, sortOrder]);
      const chapterIds = new Map<number, string>();
      for (const [chapterIndex, chapter] of preview.parsed.chapters.entries()) {
        const chapterId = randomUUID();
        chapterIds.set(chapterIndex, chapterId);
        await connection.execute('INSERT INTO question_chapters (id, question_bank_id, title, sort_order) VALUES (?, ?, ?, ?)', [chapterId, questionBankId, chapter.title, chapterIndex]);
      }
      for (const [sort, question] of allQuestions(preview.parsed).entries()) {
        const chapterId = question.chapterIndex === null ? null : chapterIds.get(question.chapterIndex) ?? null;
        await connection.execute('INSERT INTO questions (id, question_bank_id, question_chapter_id, stem_json, question_type, options_json, answer_json, analysis_json, knowledge_points_json, version, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', [
          randomUUID(), questionBankId, chapterId, JSON.stringify(contentForStorage(question.stem)), question.type,
          JSON.stringify(question.options.map((option) => ({ key: option.key, content: contentForStorage(option.content) }))), JSON.stringify(question.answer), question.analysis ? JSON.stringify(contentForStorage(question.analysis)) : null, JSON.stringify(question.knowledgePoints), sort,
        ]);
      }
      await connection.commit();
      committed = true;
      this.previewStore.delete(preview.id);
      return { questionBankId, questionBankName: preview.parsed.title, kind: preview.kind, questionChapterCount: preview.parsed.chapters.length, questionCount: allQuestions(preview.parsed).length };
    } catch (error) {
      if (connection && !committed) await connection.rollback().catch(() => undefined);
      if (error instanceof QuestionImportApiError) throw error;
      throw new QuestionImportApiError(500, '题库应用失败，请检查数据库后重试。');
    } finally {
      connection?.release();
    }
  }

  cancel(previewId: string) {
    this.previewStore.delete(previewId);
  }
}

export function createQuestionImportDatabase(pool: ReturnType<typeof createDatabasePool>): QuestionImportDatabase {
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

export function createQuestionImportService(options: Partial<QuestionImportServiceOptions> = {}): QuestionImportService {
  return new QuestionImportService({ database: options.database ?? createQuestionImportDatabase(createDatabasePool()), previewStore: options.previewStore });
}

function templateQuestion(type: QuestionType, answer: string | string[], options: Record<string, string>) {
  return { stem: '在这里填写题干。', type, options, answer, analysis: '在这里填写解析（可留空）。', knowledgePoints: ['知识点一'] };
}

export async function createQuestionImportTemplate(kind: QuestionBankKind, format: QuestionImportTemplateFormat): Promise<QuestionImportTemplate> {
  if (!questionKinds.has(kind)) throw new QuestionImportApiError(404, '未找到题库模板。');
  if (format === 'json') {
    const payload = kind === 'chapter'
      ? { format: 'knowledge-flashcards-question-bank', version: 1, title: '示例章节题库', chapters: [{ title: '第一章', questions: [templateQuestion('single', 'A', { A: '选项 A', B: '选项 B' }), templateQuestion('multiple', ['A', 'C'], { A: '选项 A', B: '选项 B', C: '选项 C' }), templateQuestion('true_false', 'A', { A: '对', B: '错' })] }] }
      : { format: 'knowledge-flashcards-question-bank', version: 1, title: kind === 'official' ? '示例真题题库' : '示例模拟题库', questions: [templateQuestion('single', 'A', { A: '选项 A', B: '选项 B' }), templateQuestion('multiple', ['A', 'C'], { A: '选项 A', B: '选项 B', C: '选项 C' }), templateQuestion('true_false', 'A', { A: '对', B: '错' })] };
    return { fileName: `knowledge-question-bank-${kind}-template.json`, contentType: 'application/json; charset=utf-8', content: `${JSON.stringify(payload, null, 2)}\n` };
  }
  const workbook = await XlsxPopulate.fromBlankAsync();
  const worksheet = workbook.sheet(0);
  if (!worksheet) throw new Error('无法创建 Excel 模板。');
  worksheet.name('题库');
  const headers = kind === 'chapter'
    ? ['题库', '章节', '题干', '题型', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '答案', '解析', '知识点']
    : ['题库', '题干', '题型', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '答案', '解析', '知识点'];
  const examples = [
    kind === 'chapter' ? ['示例章节题库', '第一章', '在这里填写单选题题干。', 'single', '选项 A', '选项 B', '', '', '', '', 'A', '在这里填写解析。', '知识点一'] : [kind === 'official' ? '示例真题题库' : '示例模拟题库', '在这里填写单选题题干。', 'single', '选项 A', '选项 B', '', '', '', '', 'A', '在这里填写解析。', '知识点一'],
    kind === 'chapter' ? ['示例章节题库', '第一章', '在这里填写多选题题干。', 'multiple', '选项 A', '选项 B', '选项 C', '', '', '', 'A,C', '', '知识点二,知识点三'] : [kind === 'official' ? '示例真题题库' : '示例模拟题库', '在这里填写多选题题干。', 'multiple', '选项 A', '选项 B', '选项 C', '', '', '', 'A,C', '', '知识点二,知识点三'],
    kind === 'chapter' ? ['示例章节题库', '第一章', '在这里填写判断题题干。', 'true_false', '对', '错', '', '', '', '', 'A', '', '判断题'] : [kind === 'official' ? '示例真题题库' : '示例模拟题库', '在这里填写判断题题干。', 'true_false', '对', '错', '', '', '', '', 'A', '', '判断题'],
  ];
  [headers, ...examples].forEach((row, rowIndex) => row.forEach((value, columnIndex) => {
    const cell = worksheet.cell(rowIndex + 1, columnIndex + 1).value(value);
    if (rowIndex === 0) cell.style('bold', true);
  }));
  headers.forEach((_, index) => worksheet.column(index + 1).width(index === 0 ? 22 : index === 1 && kind === 'chapter' ? 18 : 26));
  return { fileName: `knowledge-question-bank-${kind}-template.xlsx`, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: await workbook.outputAsync('nodebuffer') };
}
