import path from 'node:path';
import XlsxPopulate from 'xlsx-populate';
import JSZip from 'jszip';
import katex from 'katex';
import { parseFragment } from 'parse5';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { toString } from 'mdast-util-to-string';

type MDASTPosition = {
  start: { line: number; column: number; offset?: number };
  end: { line: number; column: number; offset?: number };
};

type MDASTNode = {
  type: string;
  position?: MDASTPosition;
  children?: MDASTNode[];
  value?: string;
  url?: string;
  title?: string | null;
  alt?: string | null;
  depth?: number;
  lang?: string | null;
  meta?: string | null;
  checked?: boolean | null;
  spread?: boolean;
  ordered?: boolean;
  start?: number | null;
  align?: Array<'left' | 'center' | 'right' | null>;
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
};

export type ImportSourceType = 'markdown' | 'zip' | 'json' | 'excel';

export interface SourceLocation {
  fileName: string;
  line: number;
  column: number;
}

export type ImportIssueCode =
  | 'invalid_extension'
  | 'parse_error'
  | 'empty_title'
  | 'unsupported_heading_level'
  | 'multiple_materials'
  | 'missing_parent'
  | 'unassigned_content'
  | 'unsafe_html'
  | 'invalid_formula'
  | 'invalid_table'
  | 'invalid_image_path'
  | 'missing_image'
  | 'archive_path_traversal'
  | 'archive_markdown_count'
  | 'archive_read_error'
  | 'json_read_error'
  | 'json_schema_error'
  | 'excel_read_error'
  | 'excel_schema_error';

export interface ImportIssue {
  code: ImportIssueCode;
  message: string;
  suggestion: string;
  location: SourceLocation;
  context: string[];
}

export interface ContentNode {
  type: string;
  position?: MDASTPosition;
  value?: string;
  url?: string;
  resourcePath?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  display?: boolean;
  align?: Array<'left' | 'center' | 'right' | null>;
  rowSpan?: number;
  colSpan?: number;
  children?: ContentNode[];
  [key: string]: unknown;
}

export interface ParsedCard {
  title: string;
  location: SourceLocation;
  content: ContentNode[];
  highlights: ImportedHighlight[];
  aiFormatCorrected?: boolean;
}

export interface ImportedTextHighlight {
  kind: 'text';
  anchor: { nodePath: string; start: number; end: number };
  target: string;
  occurrence?: number;
  inline?: boolean;
}

export interface ImportedFormulaHighlight {
  kind: 'formula';
  anchor: { nodePath: string };
  target: string;
  occurrence?: number;
}

export type ImportedHighlight = ImportedTextHighlight | ImportedFormulaHighlight;

export interface ParsedSection {
  title: string;
  location: SourceLocation;
  cards: ParsedCard[];
}

export interface ParsedChapter {
  title: string;
  location: SourceLocation;
  sections: ParsedSection[];
}

export interface ParsedMaterial {
  title: string;
  location: SourceLocation;
  chapters: ParsedChapter[];
}

export interface ImageReference {
  url: string;
  resourcePath: string | null;
  location: SourceLocation;
}

export interface MarkdownParseResult {
  document: ParsedMaterial | null;
  issues: ImportIssue[];
  imageReferences: ImageReference[];
}

export interface ImportResource {
  relativePath: string;
  content: Buffer;
}

export interface ImportPackageResult {
  sourceType: ImportSourceType | null;
  sourceFileName: string;
  markdownFileName: string | null;
  document: ParsedMaterial | null;
  resources: ImportResource[];
  imageReferences: ImageReference[];
  issues: ImportIssue[];
  valid: boolean;
}

export interface ParseMarkdownOptions {
  fileName: string;
  resourcePaths?: Iterable<string>;
}

export interface ImportTemplate {
  fileName: string;
  contentType: string;
  content: Buffer | string;
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function locationOf(fileName: string, node: MDASTNode, fallbackLine = 1): SourceLocation {
  return {
    fileName,
    line: node.position?.start.line ?? fallbackLine,
    column: node.position?.start.column ?? 1,
  };
}

function positionOf(node: MDASTNode) {
  return node.position;
}

function issue(
  code: ImportIssueCode,
  message: string,
  suggestion: string,
  fileName: string,
  node: MDASTNode | undefined,
  context: string[],
): ImportIssue {
  return {
    code,
    message,
    suggestion,
    location: locationOf(fileName, node ?? { type: 'root' }),
    context: [...context],
  };
}

type HtmlNode = {
  nodeName?: string;
  tagName?: string;
  value?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: HtmlNode[];
};

const supportedHtmlTags = new Set(['br', 'p', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td']);
const supportedHtmlAttributes = new Set(['align']);

function htmlAttribute(node: HtmlNode, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function htmlChildren(node: HtmlNode): HtmlNode[] {
  return node.childNodes ?? [];
}

function htmlTextNode(node: HtmlNode): ContentNode {
  return { type: 'text', value: node.value ?? '' };
}

function htmlInlineNodes(
  nodes: HtmlNode[],
  fileName: string,
  sourceNode: MDASTNode,
  context: string[],
): { nodes: ContentNode[]; invalid: boolean } {
  const result: ContentNode[] = [];
  let invalid = false;
  for (const child of nodes) {
    const tag = (child.tagName ?? child.nodeName ?? '').toLowerCase();
    if (child.nodeName === '#text') {
      if (child.value) result.push(htmlTextNode(child));
      continue;
    }
    if (child.nodeName === '#comment') continue;
    if (!supportedHtmlTags.has(tag) || (child.attrs ?? []).some((attribute) => !supportedHtmlAttributes.has(attribute.name.toLowerCase()))) {
      invalid = true;
      continue;
    }
    if (tag === 'br') {
      result.push({ type: 'break' });
      continue;
    }
    if (tag === 'p' || tag === 'div') {
      const nested = htmlInlineNodes(htmlChildren(child), fileName, sourceNode, context);
      invalid ||= nested.invalid;
      result.push(...nested.nodes);
      continue;
    }
    if (tag === 'table' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr' || tag === 'th' || tag === 'td') {
      invalid = true;
      continue;
    }
  }
  return { nodes: result, invalid };
}

function htmlTableNode(
  node: HtmlNode,
  fileName: string,
  sourceNode: MDASTNode,
  issues: ImportIssue[],
  context: string[],
): ContentNode | null {
  const rows: ContentNode[] = [];
  const visitRows = (current: HtmlNode, section: 'head' | 'body' = 'body') => {
    for (const child of htmlChildren(current)) {
      const tag = (child.tagName ?? child.nodeName ?? '').toLowerCase();
      if (child.nodeName === '#text' || child.nodeName === '#comment') continue;
      if ((child.attrs ?? []).some((attribute) => !supportedHtmlAttributes.has(attribute.name.toLowerCase()))) return false;
      if (tag === 'tr') {
        const cells: ContentNode[] = [];
        let hasHeaderCell = false;
        for (const cell of htmlChildren(child)) {
          const cellTag = (cell.tagName ?? cell.nodeName ?? '').toLowerCase();
          if (cellTag !== 'th' && cellTag !== 'td') continue;
          hasHeaderCell ||= cellTag === 'th';
          const inline = htmlInlineNodes(htmlChildren(cell), fileName, sourceNode, context);
          if (inline.invalid) return false;
          const align = htmlAttribute(cell, 'align');
          cells.push({
            type: 'tableCell',
            ...(align === 'left' || align === 'center' || align === 'right' ? { align: [align] } : {}),
            children: inline.nodes,
          });
        }
        rows.push({ type: 'tableRow', header: section === 'head' || hasHeaderCell, children: cells });
      } else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
        if (!visitRows(child, tag === 'thead' ? 'head' : 'body')) return false;
      } else if (tag.trim()) {
        return false;
      }
    }
    return true;
  };
  if (!visitRows(node)) return null;
  const expectedCells = (rows[0]?.children?.length ?? 0);
  if (expectedCells > 0 && rows.some((row) => (row.children?.length ?? 0) !== expectedCells)) {
    issues.push(issue(
      'invalid_table',
      `表格列数不一致：应为 ${expectedCells} 列。`,
      '让表头和每一行数据保持相同列数。',
      fileName,
      sourceNode,
      context,
    ));
  }
  return { type: 'table', children: rows };
}

function convertHtmlFragment(
  value: string,
  fileName: string,
  sourceNode: MDASTNode,
  issues: ImportIssue[],
  context: string[],
): ContentNode[] | null {
  const fragment = parseFragment(value) as unknown as HtmlNode;
  const roots = htmlChildren(fragment).filter((child) => child.nodeName !== '#text' || Boolean(child.value?.trim()));
  if (roots.length === 0) return null;
  if (roots.some((child) => (child.nodeName === '#comment' ? false : (child.attrs ?? []).some((attribute) => !supportedHtmlAttributes.has(attribute.name.toLowerCase()))))) {
    return null;
  }
  const tableRoots = roots.filter((child) => (child.tagName ?? child.nodeName ?? '').toLowerCase() === 'table');
  if (tableRoots.length > 0) {
    if (roots.length !== 1) return null;
    const table = htmlTableNode(tableRoots[0]!, fileName, sourceNode, issues, context);
    return table ? [table] : null;
  }
  if (roots.every((child) => ['p', 'div'].includes((child.tagName ?? child.nodeName ?? '').toLowerCase()))) {
    const paragraphs: ContentNode[] = [];
    for (const root of roots) {
      const inline = htmlInlineNodes(htmlChildren(root), fileName, sourceNode, context);
      if (inline.invalid) return null;
      paragraphs.push({ type: 'paragraph', children: inline.nodes });
    }
    return paragraphs;
  }
  const inline = htmlInlineNodes(roots, fileName, sourceNode, context);
  return inline.invalid ? null : inline.nodes;
}

function normalizeResourcePath(fileName: string, url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('\0')) {
    return null;
  }

  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(trimmed) || trimmed.startsWith('/')) {
    return null;
  }

  let decoded: string;
  try {
    decoded = decodeURIComponent(trimmed.split(/[?#]/, 1)[0] ?? '');
  } catch {
    return null;
  }

  if (!decoded || decoded.includes('\\')) {
    return null;
  }

  if (decoded.split('/').some((segment) => segment === '..')) {
    return null;
  }

  const markdownDirectory = path.posix.dirname(fileName.replaceAll('\\', '/'));
  const normalized = path.posix.normalize(path.posix.join(markdownDirectory, decoded));
  if (normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null;
  }

  return normalized;
}

function convertNode(
  node: MDASTNode,
  fileName: string,
  resourcePaths: Set<string> | undefined,
  imageReferences: ImageReference[],
  issues: ImportIssue[],
  context: string[],
): ContentNode[] {
  const converted: ContentNode = {
    type: node.type,
    ...(positionOf(node) ? { position: positionOf(node) } : {}),
  };

  if (node.type === 'html') {
    const htmlNodes = convertHtmlFragment(node.value ?? '', fileName, node, issues, context);
    if (htmlNodes) return htmlNodes;
    issues.push(issue(
      'unsafe_html',
      '正文包含不支持或不安全的 HTML，导入已阻止该节点。',
      '只使用换行和 table/tr/th/td 等安全 HTML，或改用 Markdown 语法后重试。',
      fileName,
      node,
      context,
    ));
    converted.value = node.value ?? '';
    return [converted];
  }

  if (node.type === 'math' || node.type === 'inlineMath') {
    try {
      katex.renderToString(node.value ?? '', {
        displayMode: node.type === 'math',
        throwOnError: true,
      });
    } catch (error) {
      issues.push(
        issue(
          'invalid_formula',
          `公式语法无效：${error instanceof Error ? error.message : '无法解析公式'}。`,
          '修正 LaTeX 公式后重试。',
          fileName,
          node,
          context,
        ),
      );
    }
  }

  if (node.type === 'image') {
    const url = node.url ?? '';
    const resourcePath = normalizeResourcePath(fileName, url);
    const location = locationOf(fileName, node);
    imageReferences.push({ url, resourcePath, location });
    if (!resourcePath) {
      issues.push(
        issue(
          'invalid_image_path',
          `图片路径“${url}”不是安全的相对路径。`,
          '使用相对于 Markdown 文件的图片路径，不要使用绝对路径、协议地址或 ..。',
          fileName,
          node,
          context,
        ),
      );
    } else if (resourcePaths && !resourcePaths.has(resourcePath)) {
      issues.push(
        issue(
          'missing_image',
          `找不到图片资源“${resourcePath}”。`,
          '将图片放入 ZIP 并保持引用路径与文件名一致。',
          fileName,
          node,
          context,
        ),
      );
    }
    converted.url = url;
    converted.resourcePath = resourcePath ?? undefined;
    converted.alt = node.alt ?? null;
    converted.title = node.title ?? null;
    return [converted];
  }

  if (node.value !== undefined) {
    converted.value = node.value;
  }
  if (node.type === 'math' || node.type === 'inlineMath') {
    converted.display = node.type === 'math';
  }
  if (node.type === 'code') {
    converted.lang = node.lang ?? null;
    converted.meta = node.meta ?? null;
  }
  if (node.type === 'link') {
    converted.url = node.url ?? '';
    converted.title = node.title ?? null;
  }
  if (node.type === 'table') {
    converted.align = node.align ?? [];
    const rows = node.children ?? [];
    const expectedCells = rows[0]?.children?.length ?? 0;
    if (expectedCells > 0) {
      for (const row of rows) {
        const actualCells = row.children?.length ?? 0;
        if (actualCells !== expectedCells) {
          issues.push(
            issue(
              'invalid_table',
              `表格列数不一致：应为 ${expectedCells} 列，当前为 ${actualCells} 列。`,
              '让表头、分隔行和每一行数据保持相同列数。',
              fileName,
              row,
              context,
            ),
          );
        }
      }
    }
  }
  if (node.type === 'tableRow' && typeof node.header === 'boolean') {
    converted.header = node.header;
  }
  if (node.children) {
    const children: ContentNode[] = [];
    for (const child of node.children) {
      const convertedChild = convertNode(child, fileName, resourcePaths, imageReferences, issues, context);
      if (convertedChild) {
        children.push(...convertedChild);
      }
    }
    converted.children = children;
  }
  return [converted];
}

export function parseMarkdown(source: string, options: ParseMarkdownOptions): MarkdownParseResult {
  const issues: ImportIssue[] = [];
  const imageReferences: ImageReference[] = [];
  const resourcePaths = options.resourcePaths ? new Set(options.resourcePaths) : undefined;
  let tree: MDASTNode;

  try {
    tree = markdownProcessor.parse(source) as unknown as MDASTNode;
  } catch (error) {
    issues.push(
      issue(
        'parse_error',
        `Markdown 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        '检查 Markdown 语法后重试。',
        options.fileName,
        undefined,
        [],
      ),
    );
    return { document: null, issues, imageReferences };
  }

  let material: ParsedMaterial | null = null;
  let currentChapter: ParsedChapter | null = null;
  let currentSection: ParsedSection | null = null;
  let currentCard: ParsedCard | null = null;

  for (const node of tree.children ?? []) {
    if (node.type !== 'heading') {
      if (!currentCard) {
        issues.push(
          issue(
            'unassigned_content',
            '正文没有归属到闪卡。',
            '将正文放到 #### 闪卡标题之后，或删除这段内容。',
            options.fileName,
            node,
            [material?.title, currentChapter?.title, currentSection?.title].filter(
              (item): item is string => Boolean(item),
            ),
          ),
        );
        continue;
      }

      const converted = convertNode(
        node,
        options.fileName,
        resourcePaths,
        imageReferences,
        issues,
        [material?.title, currentChapter?.title, currentSection?.title, currentCard.title].filter(
          (item): item is string => Boolean(item),
        ),
      );
      if (converted) {
        currentCard.content.push(...converted);
      }
      continue;
    }

    const depth = node.depth ?? 0;
    const title = toString(node).trim();
    if (!title) {
      issues.push(
        issue(
          'empty_title',
          `第 ${depth} 级标题为空。`,
          '为标题填写非空名称。',
          options.fileName,
          node,
          [material?.title, currentChapter?.title, currentSection?.title, currentCard?.title].filter(
            (item): item is string => Boolean(item),
          ),
        ),
      );
      continue;
    }

    if (depth < 1 || depth > 4) {
      issues.push(
        issue(
          'unsupported_heading_level',
          `不支持第 ${depth} 级标题“${title}”。`,
          '只使用 # 资料、## 章、### 节和 #### 闪卡四级标题。',
          options.fileName,
          node,
          [material?.title, currentChapter?.title, currentSection?.title, currentCard?.title].filter(
            (item): item is string => Boolean(item),
          ),
        ),
      );
      continue;
    }

    const headingLocation = locationOf(options.fileName, node);
    if (depth === 1) {
      if (material) {
        issues.push(
          issue(
            'multiple_materials',
            `资料标题重复：“${title}”。`,
            '一个 Markdown 文件只保留一个 # 资料标题。',
            options.fileName,
            node,
            [material.title],
          ),
        );
        currentChapter = null;
        currentSection = null;
        currentCard = null;
        continue;
      }
      material = { title, location: headingLocation, chapters: [] };
      currentChapter = null;
      currentSection = null;
      currentCard = null;
      continue;
    }

    if (depth === 2) {
      if (!material) {
        issues.push(
          issue(
            'missing_parent',
            `章“${title}”缺少 # 资料标题。`,
            '先添加一个 # 资料标题，再添加 ## 章标题。',
            options.fileName,
            node,
            [],
          ),
        );
        continue;
      }
      currentChapter = { title, location: headingLocation, sections: [] };
      material.chapters.push(currentChapter);
      currentSection = null;
      currentCard = null;
      continue;
    }

    if (depth === 3) {
      if (!currentChapter) {
        issues.push(
          issue(
            'missing_parent',
            `节“${title}”缺少 ## 章标题。`,
            '先添加 ## 章标题，再添加 ### 节标题。',
            options.fileName,
            node,
            material ? [material.title] : [],
          ),
        );
        continue;
      }
      currentSection = { title, location: headingLocation, cards: [] };
      currentChapter.sections.push(currentSection);
      currentCard = null;
      continue;
    }

    if (!currentSection) {
      issues.push(
        issue(
          'missing_parent',
          `闪卡“${title}”缺少 ### 节标题。`,
          '先添加 ### 节标题，再添加 #### 闪卡标题。',
          options.fileName,
          node,
          [material?.title, currentChapter?.title].filter((item): item is string => Boolean(item)),
        ),
      );
      continue;
    }
    currentCard = { title, location: headingLocation, content: [], highlights: [] };
    currentSection.cards.push(currentCard);
  }

  return { document: material, issues, imageReferences };
}

function contentIssuesWithOffset(issues: ImportIssue[], lineOffset: number) {
  if (lineOffset === 0) {
    return issues;
  }
  return issues.map((item) => ({
    ...item,
    location: { ...item.location, line: item.location.line + lineOffset },
  }));
}

export function parseContentMarkdown(
  source: string,
  options: ParseMarkdownOptions,
  context: string[],
  lineOffset = 0,
): { content: ContentNode[]; issues: ImportIssue[]; imageReferences: ImageReference[] } {
  const issues: ImportIssue[] = [];
  const imageReferences: ImageReference[] = [];
  const resourcePaths = options.resourcePaths ? new Set(options.resourcePaths) : undefined;
  let tree: MDASTNode;
  try {
    tree = markdownProcessor.parse(source) as unknown as MDASTNode;
  } catch (error) {
    issues.push(
      issue(
        'parse_error',
        `Markdown 解析失败：${error instanceof Error ? error.message : '未知错误'}`,
        '检查正文 Markdown 语法后重试。',
        options.fileName,
        undefined,
        context,
      ),
    );
    return { content: [], issues: contentIssuesWithOffset(issues, lineOffset), imageReferences };
  }

  const content: ContentNode[] = [];
  for (const node of tree.children ?? []) {
    const converted = convertNode(node, options.fileName, resourcePaths, imageReferences, issues, context);
    if (converted) {
      content.push(...converted);
    }
  }
  return { content, issues: contentIssuesWithOffset(issues, lineOffset), imageReferences };
}

function schemaIssue(
  code: 'json_schema_error' | 'excel_schema_error',
  message: string,
  suggestion: string,
  fileName: string,
  line: number,
  context: string[],
): ImportIssue {
  return {
    code,
    message,
    suggestion,
    location: { fileName, line, column: 1 },
    context,
  };
}

function requiredText(
  value: unknown,
  name: string,
  code: 'json_schema_error' | 'excel_schema_error',
  fileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  issues.push(schemaIssue(code, `${name}不能为空。`, '填写非空文本后重新导入。', fileName, line, context));
  return null;
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null && !Array.isArray(item));
}

function findHighlightMatches(
  content: ContentNode[],
  field: 'text' | 'formula',
  target: string,
): Array<ImportedHighlight> {
  const matches: ImportedHighlight[] = [];
  const visit = (nodes: ContentNode[], prefix = '') => {
    nodes.forEach((node, index) => {
      const nodePath = prefix ? `${prefix}.${index}` : String(index);
      if (field === 'text' && node.type === 'text' && typeof node.value === 'string') {
        let start = node.value.indexOf(target);
        while (start !== -1) {
          matches.push({ kind: 'text', anchor: { nodePath, start, end: start + target.length }, target, occurrence: undefined });
          start = node.value.indexOf(target, start + 1);
        }
      }
      if (field === 'formula' && (node.type === 'math' || node.type === 'inlineMath') && node.value === target) {
        matches.push({ kind: 'formula', anchor: { nodePath }, target, occurrence: undefined });
      }
      if (node.children) {
        visit(node.children, nodePath);
      }
    });
  };
  visit(content);
  return matches;
}

interface InlineTextMarker {
  id: number;
  target: string;
}

const inlineHighlightTokenPattern = /\uE000jsonhighlight(\d+)(start|end)\uE001/g;

function inlineHighlightToken(id: number, boundary: 'start' | 'end') {
  return `\uE000jsonhighlight${id}${boundary}\uE001`;
}

function prepareInlineTextMarkers(
  body: string,
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): { body: string; markers: InlineTextMarker[] } {
  const markers: InlineTextMarker[] = [];
  let invalid = false;
  const transformed = body.replace(/\[\[hl:([\s\S]*?)\]\]/g, (source, target: string) => {
    if (!target || target.includes('[[hl:')) {
      invalid = true;
      return source;
    }
    const id = markers.length;
    markers.push({ id, target });
    return `${inlineHighlightToken(id, 'start')}${target}${inlineHighlightToken(id, 'end')}`;
  });
  if (invalid || transformed.includes('[[hl:')) {
    issues.push(schemaIssue(
      'json_schema_error',
      'body 中的内联高亮必须使用完整且不可嵌套的 [[hl:原文]] 格式。',
      '每处文本高亮单独写为 [[hl:原文]]；不要嵌套标记，也不要省略 ]]。',
      sourceFileName,
      line,
      context,
    ));
  }
  return { body: transformed, markers };
}

function importedInlineTextHighlights(
  content: ContentNode[],
  markers: InlineTextMarker[],
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): ImportedHighlight[] {
  if (markers.length === 0) {
    return [];
  }

  const markerById = new Map(markers.map((marker) => [marker.id, marker]));
  const resolved: ImportedHighlight[] = [];
  const seen = new Set<number>();
  let invalid = false;
  const visit = (nodes: ContentNode[], prefix = '') => {
    nodes.forEach((node, index) => {
      const nodePath = prefix ? `${prefix}.${index}` : String(index);
      if (node.type === 'text' && typeof node.value === 'string') {
        const value = node.value;
        const tokens = [...value.matchAll(inlineHighlightTokenPattern)];
        if (tokens.length > 0) {
          let cleanValue = '';
          let cursor = 0;
          let active: { id: number; start: number } | null = null;
          for (const token of tokens) {
            const tokenIndex = token.index ?? 0;
            const id = Number(token[1]);
            const boundary = token[2];
            cleanValue += value.slice(cursor, tokenIndex);
            cursor = tokenIndex + token[0].length;
            if (!markerById.has(id) || boundary === undefined) {
              invalid = true;
              continue;
            }
            if (boundary === 'start') {
              if (active) {
                invalid = true;
                continue;
              }
              active = { id, start: cleanValue.length };
              continue;
            }
            if (!active || active.id !== id || seen.has(id)) {
              invalid = true;
              continue;
            }
            const marker = markerById.get(id)!;
            const end = cleanValue.length;
            if (cleanValue.slice(active.start, end) !== marker.target) {
              invalid = true;
              continue;
            }
            resolved.push({
              kind: 'text',
              target: marker.target,
              occurrence: undefined,
              inline: true,
              anchor: { nodePath, start: active.start, end },
            });
            seen.add(id);
            active = null;
          }
          cleanValue += value.slice(cursor);
          if (active) {
            invalid = true;
          }
          node.value = cleanValue;
        }
      }
      if (node.children) {
        visit(node.children, nodePath);
      }
    });
  };
  visit(content);

  const containsUnresolvedToken = (nodes: ContentNode[]): boolean => nodes.some((node) => (
    (typeof node.value === 'string' && node.value.includes('\uE000jsonhighlight'))
    || (node.children ? containsUnresolvedToken(node.children) : false)
  ));
  if (invalid || seen.size !== markers.length || containsUnresolvedToken(content)) {
    issues.push(schemaIssue(
      'json_schema_error',
      'body 内联高亮只能包裹同一个 Markdown 普通文本节点中的原文。',
      '使用 [[hl:原文]] 标记一段不含 Markdown 语法的连续原文；不要让标记内容跨粗体、链接、公式、代码或表格单元格。',
      sourceFileName,
      line,
      context,
    ));
    return [];
  }
  return resolved;
}

function textAnchorMatches(content: ContentNode[], highlight: ImportedTextHighlight): boolean {
  const parts = highlight.anchor.nodePath.split('.').map((part) => Number(part));
  let nodes = content;
  let node: ContentNode | undefined;
  for (const index of parts) {
    node = nodes[index];
    if (!node) {
      return false;
    }
    nodes = node.children ?? [];
  }
  return node?.type === 'text'
    && typeof node.value === 'string'
    && node.value.slice(highlight.anchor.start, highlight.anchor.end) === highlight.target;
}

function selectHighlightOccurrence(matches: ImportedHighlight[], occurrence: number | undefined): ImportedHighlight | null {
  if (matches.length === 0 || (occurrence === undefined && matches.length !== 1)) {
    return null;
  }
  const match = matches[(occurrence ?? 1) - 1];
  return match ? { ...match, occurrence } : null;
}

export function resolveImportedHighlights(
  content: ContentNode[],
  highlights: ImportedHighlight[],
  preserveInlineAnchors = true,
): ImportedHighlight[] | null {
  const resolved: ImportedHighlight[] = [];
  for (const highlight of highlights) {
    const match = preserveInlineAnchors && highlight.kind === 'text' && highlight.inline && textAnchorMatches(content, highlight)
      ? highlight
      : selectHighlightOccurrence(
        findHighlightMatches(content, highlight.kind === 'text' ? 'text' : 'formula', highlight.target),
        highlight.occurrence,
      );
    if (!match) {
      return null;
    }
    if (!resolved.some((existing) => existing.kind === match.kind && JSON.stringify(existing.anchor) === JSON.stringify(match.anchor))) {
      resolved.push(match);
    }
  }
  return resolved;
}

function importedHighlights(
  value: unknown,
  content: ContentNode[],
  sourceFileName: string,
  line: number,
  context: string[],
  issues: ImportIssue[],
): ImportedHighlight[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    issues.push(schemaIssue('json_schema_error', 'highlights 必须是数组。', '删除该字段，或使用文本或公式高亮对象数组。', sourceFileName, line, context));
    return [];
  }

  const results: ImportedHighlight[] = [];
  value.forEach((item, index) => {
    if (!isRecord(item)) {
      issues.push(schemaIssue('json_schema_error', `第 ${index + 1} 条高亮必须是对象。`, '使用 { "text": "目标文本" } 或 { "formula": "公式" }。', sourceFileName, line, context));
      return;
    }
    const text = typeof item.text === 'string' ? item.text : null;
    const formula = typeof item.formula === 'string' ? item.formula : null;
    if ((text === null && formula === null) || (text !== null && formula !== null) || !(text ?? formula)?.trim()) {
      issues.push(schemaIssue('json_schema_error', `第 ${index + 1} 条高亮必须且只能填写非空 text 或 formula。`, '文本使用 text，公式使用 formula，二者不能同时填写。', sourceFileName, line, context));
      return;
    }
    if (item.occurrence !== undefined && (typeof item.occurrence !== 'number' || !Number.isInteger(item.occurrence) || item.occurrence < 1)) {
      issues.push(schemaIssue('json_schema_error', `第 ${index + 1} 条高亮的 occurrence 必须是从 1 开始的整数。`, '删除 occurrence 以要求唯一匹配，或填写目标出现的序号。', sourceFileName, line, context));
      return;
    }
    const target = (text ?? formula)!.trim();
    const occurrence = item.occurrence as number | undefined;
    const matches = findHighlightMatches(content, text === null ? 'formula' : 'text', target);
    const match = selectHighlightOccurrence(matches, occurrence);
    if (!match) {
      const description = text === null ? '公式' : '文本';
      const reason = matches.length === 0 ? '未在当前卡片 body 中找到' : occurrence ? '指定的 body 出现序号超出匹配数量' : '在当前卡片 body 中重复出现且未指定 occurrence';
      issues.push(schemaIssue('json_schema_error', `第 ${index + 1} 条${description}高亮${reason}。`, occurrence ? '检查文本、公式或 occurrence 是否与当前卡片正文一致。' : '为重复内容补充从 1 开始的 occurrence。', sourceFileName, line, context));
      return;
    }
    if (match && !results.some((existing) => existing.kind === match.kind && JSON.stringify(existing.anchor) === JSON.stringify(match.anchor))) {
      results.push(match);
    }
  });
  return results;
}

function parseJsonImport(sourceFileName: string, source: Buffer): ImportPackageResult {
  const issues: ImportIssue[] = [];
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(source.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('根节点必须是对象。');
    }
    payload = parsed as Record<string, unknown>;
  } catch (error) {
    issues.push({
      code: 'json_read_error',
      message: `JSON 文件无法读取：${error instanceof Error ? error.message : '未知错误'}。`,
      suggestion: '使用下载的 JSON 模板并确认文件未损坏。',
      location: { fileName: sourceFileName, line: 1, column: 1 },
      context: [],
    });
    return {
      sourceType: 'json', sourceFileName, markdownFileName: null, document: null,
      resources: [], imageReferences: [], issues, valid: false,
    };
  }

  if (payload.format !== 'knowledge-flashcards-material' || payload.version !== 1) {
    issues.push(schemaIssue(
      'json_schema_error',
      'JSON 格式或版本不匹配。',
      '使用导入页下载的 JSON 模板，不要选择完整备份文件。',
      sourceFileName,
      1,
      [],
    ));
  }
  const title = requiredText(payload.title, '资料标题', 'json_schema_error', sourceFileName, 1, [], issues);
  if (!Array.isArray(payload.chapters)) {
    issues.push(schemaIssue('json_schema_error', 'chapters 必须是数组。', '使用下载的 JSON 模板保留 chapters 字段。', sourceFileName, 1, []));
  }

  const chapters: ParsedChapter[] = [];
  const imageReferences: ImageReference[] = [];
  for (const [chapterIndex, chapterValue] of recordArray(payload.chapters).entries()) {
    const chapterLine = chapterIndex + 1;
    const chapterTitle = requiredText(
      chapterValue.title,
      `第 ${chapterIndex + 1} 章标题`,
      'json_schema_error',
      sourceFileName,
      chapterLine,
      title ? [title] : [],
      issues,
    );
    if (!Array.isArray(chapterValue.sections)) {
      issues.push(schemaIssue(
        'json_schema_error',
        `第 ${chapterIndex + 1} 章的 sections 必须是数组。`,
        '使用下载的 JSON 模板保留 sections 字段。',
        sourceFileName,
        chapterLine,
        [title, chapterTitle].filter((item): item is string => Boolean(item)),
      ));
    }
    const sections: ParsedSection[] = [];
    for (const [sectionIndex, sectionValue] of recordArray(chapterValue.sections).entries()) {
      const sectionLine = sectionIndex + 1;
      const sectionTitle = requiredText(
        sectionValue.title,
        `第 ${sectionIndex + 1} 节标题`,
        'json_schema_error',
        sourceFileName,
        sectionLine,
        [title, chapterTitle].filter((item): item is string => Boolean(item)),
        issues,
      );
      if (!Array.isArray(sectionValue.cards)) {
        issues.push(schemaIssue(
          'json_schema_error',
          `第 ${sectionIndex + 1} 节的 cards 必须是数组。`,
          '使用下载的 JSON 模板保留 cards 字段。',
          sourceFileName,
          sectionLine,
          [title, chapterTitle, sectionTitle].filter((item): item is string => Boolean(item)),
        ));
      }
      const cards: ParsedCard[] = [];
      for (const [cardIndex, cardValue] of recordArray(sectionValue.cards).entries()) {
        const cardLine = cardIndex + 1;
        const context = [title, chapterTitle, sectionTitle].filter((item): item is string => Boolean(item));
        const cardTitle = requiredText(
          cardValue.title,
          `第 ${cardIndex + 1} 张闪卡标题`,
          'json_schema_error',
          sourceFileName,
          cardLine,
          context,
          issues,
        );
        if (typeof cardValue.body !== 'string') {
          issues.push(schemaIssue(
            'json_schema_error',
            `闪卡“${cardTitle ?? `第 ${cardIndex + 1} 张`}”的 body 必须是字符串。`,
            '使用 Markdown 文本填写 body 字段。',
            sourceFileName,
            cardLine,
            context,
          ));
          continue;
        }
        if (!cardTitle) {
          continue;
        }
        const cardContext = [...context, cardTitle];
        const inlineMarkers = prepareInlineTextMarkers(cardValue.body, sourceFileName, cardLine, cardContext, issues);
        const parsedContent = parseContentMarkdown(
          inlineMarkers.body,
          { fileName: sourceFileName, resourcePaths: [] },
          cardContext,
        );
        issues.push(...parsedContent.issues);
        imageReferences.push(...parsedContent.imageReferences);
        const inlineHighlights = importedInlineTextHighlights(
          parsedContent.content,
          inlineMarkers.markers,
          sourceFileName,
          cardLine,
          cardContext,
          issues,
        );
        const declaredHighlights = importedHighlights(
          cardValue.highlights,
          parsedContent.content,
          sourceFileName,
          cardLine,
          cardContext,
          issues,
        );
        cards.push({
          title: cardTitle,
          location: { fileName: sourceFileName, line: cardLine, column: 1 },
          content: parsedContent.content,
          highlights: [...inlineHighlights, ...declaredHighlights].filter((highlight, index, values) => !values.some(
            (existing, existingIndex) => existingIndex < index
              && existing.kind === highlight.kind
              && JSON.stringify(existing.anchor) === JSON.stringify(highlight.anchor),
          )),
        });
      }
      if (sectionTitle) {
        sections.push({
          title: sectionTitle,
          location: { fileName: sourceFileName, line: sectionLine, column: 1 },
          cards,
        });
      }
    }
    if (chapterTitle) {
      chapters.push({
        title: chapterTitle,
        location: { fileName: sourceFileName, line: chapterLine, column: 1 },
        sections,
      });
    }
  }

  return {
    sourceType: 'json',
    sourceFileName,
    markdownFileName: null,
    document: title ? { title, location: { fileName: sourceFileName, line: 1, column: 1 }, chapters } : null,
    resources: [],
    imageReferences,
    issues,
    valid: issues.length === 0 && title !== null,
  };
}

function excelCellText(value: unknown) {
  return value === null || value === undefined ? '' : String(value).trim();
}

async function parseExcelImport(sourceFileName: string, source: Buffer): Promise<ImportPackageResult> {
  const issues: ImportIssue[] = [];
  let workbook: Awaited<ReturnType<typeof XlsxPopulate.fromDataAsync>>;
  try {
    workbook = await XlsxPopulate.fromDataAsync(source);
  } catch (error) {
    issues.push({
      code: 'excel_read_error',
      message: `Excel 文件无法读取：${error instanceof Error ? error.message : '未知错误'}。`,
      suggestion: '使用导入页下载的 Excel 模板，并确认文件未损坏。',
      location: { fileName: sourceFileName, line: 1, column: 1 },
      context: [],
    });
    return {
      sourceType: 'excel', sourceFileName, markdownFileName: null, document: null,
      resources: [], imageReferences: [], issues, valid: false,
    };
  }

  const worksheet = workbook.sheet('闪卡');
  const headers = ['资料', '章', '节', '闪卡', '正文'];
  if (!worksheet) {
    issues.push(schemaIssue(
      'excel_schema_error',
      '找不到“闪卡”工作表。',
      '使用导入页下载的 Excel 模板，且不要修改工作表名称。',
      sourceFileName,
      1,
      [],
    ));
    return {
      sourceType: 'excel', sourceFileName, markdownFileName: null, document: null,
      resources: [], imageReferences: [], issues, valid: false,
    };
  }
  const rows = worksheet.usedRange().value();
  const table = Array.isArray(rows) ? rows : [];
  const headerRow = Array.isArray(table[0]) ? table[0] : [];
  const actualHeaders = headers.map((_, index) => excelCellText(headerRow[index]));
  if (actualHeaders.some((value, index) => value !== headers[index])) {
    issues.push(schemaIssue(
      'excel_schema_error',
      'Excel 列标题不匹配。',
      '首行必须依次为：资料、章、节、闪卡、正文。',
      sourceFileName,
      1,
      [],
    ));
    return {
      sourceType: 'excel', sourceFileName, markdownFileName: null, document: null,
      resources: [], imageReferences: [], issues, valid: false,
    };
  }

  const chapterByTitle = new Map<string, ParsedChapter>();
  const sectionByKey = new Map<string, ParsedSection>();
  const imageReferences: ImageReference[] = [];
  let materialTitle: string | null = null;
  let rowCount = 0;
  for (const [rowIndex, rowValue] of table.slice(1).entries()) {
    const rowNumber = rowIndex + 2;
    const row = Array.isArray(rowValue) ? rowValue : [];
    const values = headers.map((_, index) => excelCellText(row[index]));
    if (values.every((value) => !value)) {
      continue;
    }
    rowCount += 1;
    const [nextMaterialTitle, chapterTitle, sectionTitle, cardTitle, body] = values;
    const context = materialTitle ? [materialTitle] : [];
    const validMaterialTitle = requiredText(nextMaterialTitle, '资料', 'excel_schema_error', sourceFileName, rowNumber, context, issues);
    const validChapterTitle = requiredText(chapterTitle, '章', 'excel_schema_error', sourceFileName, rowNumber, context, issues);
    const validSectionTitle = requiredText(sectionTitle, '节', 'excel_schema_error', sourceFileName, rowNumber, context, issues);
    const validCardTitle = requiredText(cardTitle, '闪卡', 'excel_schema_error', sourceFileName, rowNumber, context, issues);
    if (!validMaterialTitle || !validChapterTitle || !validSectionTitle || !validCardTitle) {
      continue;
    }
    if (materialTitle && materialTitle !== validMaterialTitle) {
      issues.push(schemaIssue(
        'excel_schema_error',
        `资料列必须保持一致，当前为“${validMaterialTitle}”。`,
        `将本行资料修改为“${materialTitle}”，或拆分为单独文件。`,
        sourceFileName,
        rowNumber,
        [materialTitle],
      ));
      continue;
    }
    materialTitle ??= validMaterialTitle;
    let chapter = chapterByTitle.get(validChapterTitle);
    if (!chapter) {
      chapter = {
        title: validChapterTitle,
        location: { fileName: sourceFileName, line: rowNumber, column: 1 },
        sections: [],
      };
      chapterByTitle.set(validChapterTitle, chapter);
    }
    const sectionKey = `${validChapterTitle}\u0000${validSectionTitle}`;
    let section = sectionByKey.get(sectionKey);
    if (!section) {
      section = {
        title: validSectionTitle,
        location: { fileName: sourceFileName, line: rowNumber, column: 1 },
        cards: [],
      };
      sectionByKey.set(sectionKey, section);
      chapter.sections.push(section);
    }
    const cardContext = [materialTitle, validChapterTitle, validSectionTitle, validCardTitle]
      .filter((item): item is string => Boolean(item));
    const parsedContent = parseContentMarkdown(
      body ?? '',
      { fileName: sourceFileName, resourcePaths: [] },
      cardContext,
      rowNumber - 1,
    );
    issues.push(...parsedContent.issues);
    imageReferences.push(...parsedContent.imageReferences);
    section.cards.push({
      title: validCardTitle,
      location: { fileName: sourceFileName, line: rowNumber, column: 1 },
      content: parsedContent.content,
      highlights: [],
    });
  }

  if (rowCount === 0) {
    issues.push(schemaIssue(
      'excel_schema_error',
      'Excel 没有可导入的闪卡行。',
      '从第 2 行开始填写至少一张闪卡。',
      sourceFileName,
      2,
      [],
    ));
  }
  return {
    sourceType: 'excel',
    sourceFileName,
    markdownFileName: null,
    document: materialTitle
      ? { title: materialTitle, location: { fileName: sourceFileName, line: 2, column: 1 }, chapters: [...chapterByTitle.values()] }
      : null,
    resources: [],
    imageReferences,
    issues,
    valid: issues.length === 0 && materialTitle !== null,
  };
}

export async function createImportTemplate(format: 'json' | 'excel'): Promise<ImportTemplate> {
  const document = {
    format: 'knowledge-flashcards-material',
    version: 1,
    __使用说明: [
      '这是单资料内容导入模板；正文 body 使用 Markdown、GFM 表格和公式语法。',
      '以下 __ 开头的说明字段仅供阅读，导入时会自动忽略；请保留 format、version、title、chapters、sections、cards、title、body 和 highlights 字段。',
      '文本高亮以 body 内的 [[hl:原文]] 为主；导入后标记会自动移除，只保留正常正文和结构化高亮。',
      'highlights 数组是兼容格式：公式仍使用 formula；旧 JSON 的 text 与 occurrence 继续支持。',
    ],
    __文本高亮主协议: {
      syntax: '直接在 body 中把需要高亮的原文写成 [[hl:原文]]。',
      repeatedText: '同一词无论出现多少次，都在每个需要高亮的位置分别包裹 [[hl:...]]；不需要计算 occurrence。',
      output: '导入时会移除 [[hl: 和 ]]，正文恢复为原文，并按标记所在位置生成高亮锚点。',
      exactText: '标记内部必须是 body 中该位置的连续原文，不能留空或嵌套标记。',
      nodeBoundary: '一处标记必须完整落在同一个 Markdown 普通文本节点内；可以位于单个表格单元格内，但不能跨粗体、链接、公式、代码、图片或表格单元格。需要标记多种 Markdown 内容时，请分别标记其中的普通文本。',
    },
    __highlights兼容格式: {
      formula: '公式高亮。填写公式内容，不要填写 $ 或 $$ 包裹符号；按完整公式标记。',
      text: '仅用于兼容旧 JSON。目标文本唯一时可写 { "text": "原文" }。新文件请改用 body 内联标记。',
      occurrence: '仅用于兼容旧 JSON。重复目标可用从 1 开始的 occurrence 指定当前卡片 body 中的第 N 次命中。',
    },
    title: '示例资料',
    chapters: [
      {
        title: '第一章',
        sections: [
          {
            title: '第一节',
            cards: [
              {
                title: '示例闪卡',
                body: '第一类[[hl:危险源]]决定事故后果；第二类[[hl:危险源]]决定事故发生可能性。牛顿第二定律为 $F = ma$。',
                highlights: [
                  { formula: 'F = ma' },
                ],
              },
            ],
          },
        ],
      },
      {
        title: '第二章',
        sections: [
          {
            title: '第一节',
            cards: [
              {
                title: '第二章示例闪卡',
                body: '在这里填写第二章的知识点正文。',
                highlights: [],
              },
            ],
          },
        ],
      },
    ],
  };
  if (format === 'json') {
    return {
      fileName: 'knowledge-flashcards-template.json',
      contentType: 'application/json; charset=utf-8',
      content: `${JSON.stringify(document, null, 2)}\n`,
    };
  }

  const workbook = await XlsxPopulate.fromBlankAsync();
  const worksheet = workbook.sheet(0);
  if (!worksheet) {
    throw new Error('无法创建 Excel 模板。');
  }
  worksheet.name('闪卡');
  const rows = [
    ['资料', '章', '节', '闪卡', '正文'],
    ['示例资料', '第一章', '第一节', '示例闪卡', '正文支持 **Markdown**、公式 $x^2$ 和 GFM 表格。'],
  ];
  for (const [rowIndex, row] of rows.entries()) {
    for (const [columnIndex, value] of row.entries()) {
      const cell = worksheet.cell(rowIndex + 1, columnIndex + 1).value(value);
      if (rowIndex === 0) {
        cell.style('bold', true);
      }
    }
  }
  [20, 20, 20, 24, 56].forEach((width, index) => worksheet.column(index + 1).width(width));
  return {
    fileName: 'knowledge-flashcards-template.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    content: await workbook.outputAsync('nodebuffer'),
  };
}

function archiveIssue(
  code: ImportIssueCode,
  message: string,
  suggestion: string,
  archiveFileName: string,
  entryName?: string,
): ImportIssue {
  return {
    code,
    message,
    suggestion,
    location: { fileName: archiveFileName, line: 1, column: 1 },
    context: entryName ? [entryName] : [],
  };
}

function normalizeArchiveEntryName(name: string): string | null {
  if (!name || name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    return null;
  }
  const normalized = path.posix.normalize(name);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../') || normalized.startsWith('/')) {
    return null;
  }
  return normalized;
}

export async function parseImportPackage(
  sourceFileName: string,
  source: string | Buffer,
): Promise<ImportPackageResult> {
  const extension = path.extname(sourceFileName).toLowerCase();
  if (extension === '.md') {
    const markdown = parseMarkdown(String(source), { fileName: sourceFileName });
    return {
      sourceType: 'markdown',
      sourceFileName,
      markdownFileName: sourceFileName,
      document: markdown.document,
      resources: [],
      imageReferences: markdown.imageReferences,
      issues: markdown.issues,
      valid: markdown.issues.length === 0,
    };
  }

  if (extension === '.json') {
    return parseJsonImport(sourceFileName, Buffer.isBuffer(source) ? source : Buffer.from(source));
  }

  if (extension === '.xlsx') {
    return parseExcelImport(sourceFileName, Buffer.isBuffer(source) ? source : Buffer.from(source));
  }

  if (extension !== '.zip') {
    const invalidExtension = archiveIssue(
      'invalid_extension',
      `不支持的文件类型“${extension || '无扩展名'}”。`,
      '只选择 .md、.zip、.json 或 .xlsx 文件。',
      sourceFileName,
    );
    return {
      sourceType: null,
      sourceFileName,
      markdownFileName: null,
      document: null,
      resources: [],
      imageReferences: [],
      issues: [invalidExtension],
      valid: false,
    };
  }

  const issues: ImportIssue[] = [];
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(source, { checkCRC32: true });
  } catch (error) {
    issues.push(
      archiveIssue(
        'archive_read_error',
        `ZIP 文件无法读取：${error instanceof Error ? error.message : '未知错误'}`,
        '重新压缩资料包后重试，并确认文件没有损坏。',
        sourceFileName,
      ),
    );
    return {
      sourceType: 'zip',
      sourceFileName,
      markdownFileName: null,
      document: null,
      resources: [],
      imageReferences: [],
      issues,
      valid: false,
    };
  }

  const entries = Object.values(archive.files);
  const safeFiles: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  for (const entry of entries) {
    const safeName = normalizeArchiveEntryName(entry.name);
    if (!safeName) {
      issues.push(
        archiveIssue(
          'archive_path_traversal',
          `ZIP 条目路径“${entry.name}”不安全。`,
          '删除绝对路径、Windows 路径或包含 .. 的条目后重新打包。',
          sourceFileName,
          entry.name,
        ),
      );
      continue;
    }
    if (!entry.dir) {
      safeFiles.push({ name: safeName, entry });
    }
  }

  const markdownFiles = safeFiles.filter(({ name }) => path.posix.extname(name).toLowerCase() === '.md');
  if (markdownFiles.length !== 1) {
    issues.push(
      archiveIssue(
        'archive_markdown_count',
        `ZIP 中必须恰好包含一个 Markdown 文件，当前为 ${markdownFiles.length} 个。`,
        '保留一个 .md 文件，并删除其他 Markdown 文件。',
        sourceFileName,
      ),
    );
  }

  if (issues.length > 0 || markdownFiles.length !== 1) {
    return {
      sourceType: 'zip',
      sourceFileName,
      markdownFileName: markdownFiles.length === 1 ? markdownFiles[0]?.name ?? null : null,
      document: null,
      resources: [],
      imageReferences: [],
      issues,
      valid: false,
    };
  }

  const markdownFile = markdownFiles[0];
  if (!markdownFile) {
    issues.push(
      archiveIssue(
        'archive_markdown_count',
        'ZIP 中没有可读取的 Markdown 文件。',
        '保留一个可读取的 .md 文件后重新打包。',
        sourceFileName,
      ),
    );
    return {
      sourceType: 'zip',
      sourceFileName,
      markdownFileName: null,
      document: null,
      resources: [],
      imageReferences: [],
      issues,
      valid: false,
    };
  }
  const resources: ImportResource[] = [];
  const resourcePaths = new Set<string>();
  for (const file of safeFiles) {
    if (file.name === markdownFile.name) {
      continue;
    }
    const content = await file.entry.async('nodebuffer');
    resources.push({ relativePath: file.name, content });
    resourcePaths.add(file.name);
  }

  let markdownSource: string;
  try {
    markdownSource = await markdownFile.entry.async('string');
  } catch (error) {
    issues.push(
      archiveIssue(
        'archive_read_error',
        `Markdown 条目无法读取：${error instanceof Error ? error.message : '未知错误'}`,
        '重新压缩资料包后重试。',
        sourceFileName,
        markdownFile.name,
      ),
    );
    return {
      sourceType: 'zip',
      sourceFileName,
      markdownFileName: markdownFile.name,
      document: null,
      resources,
      imageReferences: [],
      issues,
      valid: false,
    };
  }

  const markdown = parseMarkdown(markdownSource, {
    fileName: markdownFile.name,
    resourcePaths,
  });
  issues.push(...markdown.issues);
  return {
    sourceType: 'zip',
    sourceFileName,
    markdownFileName: markdownFile.name,
    document: markdown.document,
    resources,
    imageReferences: markdown.imageReferences,
    issues,
    valid: issues.length === 0,
  };
}
