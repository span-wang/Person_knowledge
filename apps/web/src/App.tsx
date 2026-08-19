import { type ElementType, type FormEvent, type PointerEvent as ReactPointerEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { renderToString } from 'katex';
import { Archive, ArrowDown, ArrowUp, Download, FolderOpen, LogOut, Merge, MoreHorizontal, MoveRight, Pencil, Plus, RefreshCw, SlidersHorizontal, Sparkles, Trash2, Upload } from 'lucide-react';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import type {
  ImportCorrectionDocument,
  ImportIssueResponse,
  ImportPreviewChapter,
  ImportPreviewDocument,
  ImportPreviewResponse,
  ImportTemplateFormat,
  ReviewContentNode,
  ReviewCardSummary,
  ReviewCardNavigation,
  ReviewCardContentUpdateRequest,
  ReviewCardContentUpdateResponse,
  ReviewEditLock,
  ReviewDashboardResponse,
  ReviewFilters,
  ReviewHighlight,
  ReviewHighlightCreateRequest,
  ReviewAiExplanation,
  ReviewMasteryStatus,
  ReviewStartScope,
  AiProviderKind,
  AiProviderProfile,
  AiProviderProfileCreateRequest,
  AiProviderProfileUpdateRequest,
  HierarchyChapter,
  HierarchyEntityType,
  HierarchyResponse,
  HierarchySection,
  HierarchyTrashResponse,
  DataJsonExport,
  DataBackupsResponse,
  CatalogCoursesResponse,
  CatalogCourseSubjectsResponse,
  CatalogMasteryDistribution,
  CatalogMaterialResponse,
  CatalogStatusTrendPoint,
  CatalogSubjectResponse,
  QuestionBankDirectoryResponse,
  QuestionBankKind,
  QuestionBankQuestionsResponse,
  QuestionBankDirectoryItem,
  QuestionCreateRequest,
  QuestionQuestion,
  QuestionAiExplanationHistoryResponse,
  QuestionUpdateRequest,
  QuestionType,
  PracticeMode,
  PracticeSource,
  PracticeStatisticsResponse,
  PracticeSessionResponse,
  QuestionImportPreviewResponse,
  QuestionImportTemplateFormat,
} from '@knowledge-flashcards/shared';
import { reviewResourcePath } from '@knowledge-flashcards/shared';
import {
  applyImport,
  acquireReviewEditLock,
  cancelImport,
  correctImportFormat,
  downloadImportTemplate,
  createReviewHighlight,
  deleteReviewHighlight,
  fetchReviewCard,
  fetchFirstReviewCard,
  fetchReviewDashboard,
  generateReviewAiExplanation,
  previewImport,
  releaseReviewEditLock,
  renewReviewEditLock,
  startReview,
  updateReviewContent,
  updateReviewStatus,
  uploadReviewResource,
  createHierarchy,
  deleteHierarchy,
  fetchHierarchy,
  fetchHierarchyTrash,
  fetchCatalogCourses,
  fetchCatalogCourseSubjects,
  fetchCatalogMaterial,
  fetchCatalogSubject,
  fetchQuestionBankDirectory,
  fetchQuestionBankQuestions,
  fetchQuestionAiExplanations,
  generateQuestionAiExplanation,
  fetchQuestionTrash,
  createQuestionBank,
  renameQuestionBank,
  reorderQuestionBank,
  deleteQuestionBank,
  createQuestionChapter,
  renameQuestionChapter,
  moveQuestionChapter,
  reorderQuestionChapter,
  deleteQuestionChapter,
  fetchQuestionBankTrash,
  restoreQuestionBank,
  restoreQuestionChapter,
  downloadQuestionImportTemplate,
  previewQuestionImport,
  applyQuestionImport,
  cancelQuestionImport,
  createQuestion,
  updateQuestion,
  reorderQuestion,
  deleteQuestion,
  restoreQuestion,
  fetchInProgressPracticeSessions,
  fetchPracticeStatistics,
  startPracticeSession,
  fetchPracticeSession,
  answerPracticeQuestion,
  completePracticeSession,
  abandonPracticeSession,
  createCatalogCourse,
  createCatalogSubject,
  deleteCatalogCourse,
  deleteCatalogSubject,
  moveCatalogSubject,
  removeCatalogMaterialCover,
  moveHierarchy,
  renameCatalogCourse,
  renameCatalogSubject,
  renameHierarchy,
  reorderCatalogCourse,
  reorderCatalogSubject,
  reorderHierarchy,
  activateAiProviderProfile,
  createAiProviderProfile,
  deleteAiProviderProfile,
  fetchAiProviderProfiles,
  updateAiProviderProfile,
  testAiProviderProfile,
  downloadMaterialMarkdown,
  fetchDataJsonExport,
  restoreDataJsonExport,
  fetchDataBackups,
  createDataBackup,
  restoreDataBackup,
  permanentlyDeleteTrashItem,
  updateCatalogMaterialName,
  uploadCatalogMaterialCover,
  fetchAuthSession,
  login,
  logout,
} from './api';

type ImportState = 'idle' | 'previewing' | 'ready' | 'applying' | 'finished' | 'error';
type ImportFormat = 'markdown' | 'json' | 'excel';
type Appearance = 'minimal' | 'autumn';
type ColorMode = 'system' | 'light' | 'dark';
type CatalogManagementTarget = {
  kind: 'course' | 'subject';
  id: string;
  name: string;
  index: number;
  count: number;
  courseId?: string;
};

type CatalogMaterialSummary = CatalogSubjectResponse['materials'][number];

type MaterialDragSession = {
  material: CatalogMaterialSummary;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dragging: boolean;
};

const appearanceStorageKey = 'knowledge-flashcards-appearance';
const colorModeStorageKey = 'knowledge-flashcards-color-mode';
const aiMarkdownProcessor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

const importFormatOptions: Array<{ value: ImportFormat; label: string; accept: string }> = [
  { value: 'markdown', label: 'Markdown', accept: '.md,.zip,text/markdown,application/zip' },
  { value: 'json', label: 'JSON', accept: '.json,application/json' },
  { value: 'excel', label: 'Excel', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
];

function storedAppearance(): Appearance {
  try {
    return window.localStorage.getItem(appearanceStorageKey) === 'autumn' ? 'autumn' : 'minimal';
  } catch {
    return 'minimal';
  }
}

function storedColorMode(): ColorMode {
  try {
    const colorMode = window.localStorage.getItem(colorModeStorageKey);
    return colorMode === 'light' || colorMode === 'dark' ? colorMode : 'system';
  } catch {
    return 'system';
  }
}

function isRequestCancelled(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function isShortCloze(value: string): boolean {
  const visibleText = value.replace(/\\[a-zA-Z]+|[{}_^\\\s]/g, '');
  return Array.from(visibleText).length <= 2;
}

type MaterialsRoute =
  | { kind: 'courses' }
  | { kind: 'course'; courseId: string }
  | { kind: 'subject'; courseId: string; subjectId: string }
  | { kind: 'question-banks'; courseId: string; subjectId: string }
  | { kind: 'material'; courseId: string; subjectId: string; materialId: string }
  | { kind: 'manage' };

function decodeRouteSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded ? decoded : null;
  } catch {
    return null;
  }
}

function materialsRouteFromLocation(): MaterialsRoute | null {
  const segments = window.location.hash.slice(1).split('/').filter(Boolean);
  if (segments[0] !== 'materials') {
    return null;
  }
  if (segments.length === 1) {
    return { kind: 'courses' };
  }
  if (segments.length === 2 && segments[1] === 'manage') {
    return { kind: 'manage' };
  }
  if (segments.length === 3 && segments[1] === 'courses') {
    const courseId = decodeRouteSegment(segments[2]!);
    return courseId ? { kind: 'course', courseId } : { kind: 'courses' };
  }
  if (segments.length === 5 && segments[1] === 'courses' && segments[3] === 'subjects') {
    const courseId = decodeRouteSegment(segments[2]!);
    const subjectId = decodeRouteSegment(segments[4]!);
    return courseId && subjectId ? { kind: 'subject', courseId, subjectId } : { kind: 'courses' };
  }
  if (segments.length === 6 && segments[1] === 'courses' && segments[3] === 'subjects' && segments[5] === 'question-banks') {
    const courseId = decodeRouteSegment(segments[2]!);
    const subjectId = decodeRouteSegment(segments[4]!);
    return courseId && subjectId ? { kind: 'question-banks', courseId, subjectId } : { kind: 'courses' };
  }
  if (segments.length === 7 && segments[1] === 'courses' && segments[3] === 'subjects' && segments[5] === 'materials') {
    const courseId = decodeRouteSegment(segments[2]!);
    const subjectId = decodeRouteSegment(segments[4]!);
    const materialId = decodeRouteSegment(segments[6]!);
    return courseId && subjectId && materialId ? { kind: 'material', courseId, subjectId, materialId } : { kind: 'courses' };
  }
  return { kind: 'courses' };
}

function materialsRouteUrl(route: MaterialsRoute): string {
  if (route.kind === 'course') {
    return `#/materials/courses/${encodeURIComponent(route.courseId)}`;
  }
  if (route.kind === 'subject') {
    return `#/materials/courses/${encodeURIComponent(route.courseId)}/subjects/${encodeURIComponent(route.subjectId)}`;
  }
  if (route.kind === 'question-banks') {
    return `#/materials/courses/${encodeURIComponent(route.courseId)}/subjects/${encodeURIComponent(route.subjectId)}/question-banks`;
  }
  if (route.kind === 'material') {
    return `#/materials/courses/${encodeURIComponent(route.courseId)}/subjects/${encodeURIComponent(route.subjectId)}/materials/${encodeURIComponent(route.materialId)}`;
  }
  return route.kind === 'manage' ? '#/materials/manage' : '#/materials';
}

function LoginPanel({ onAuthenticated }: { onAuthenticated: (username: string | null) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await login({ username, password });
      onAuthenticated(session.username);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '登录失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="login-title">
        <p className="eyebrow">知识闪卡</p>
        <h1 id="login-title">登录</h1>
        <form className="auth-form" onSubmit={(event) => { void handleSubmit(event); }}>
          <label className="field-column">
            <span>用户名</span>
            <input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required />
          </label>
          <label className="field-column">
            <span>密码</span>
            <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error ? <p className="feedback-error" role="alert">{error}</p> : null}
          <button className="button-primary auth-submit" type="submit" disabled={busy}>
            {busy ? '登录中' : '登录'}
          </button>
        </form>
      </section>
    </main>
  );
}

function saveDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function correctionFromPreview(document: ImportPreviewDocument): ImportCorrectionDocument {
  return {
    title: document.title,
    chapters: document.chapters.map((chapter) => ({
      title: chapter.title,
      sections: chapter.sections.map((section) => ({
        title: section.title,
        cards: section.cards.map((card) => ({
          title: card.title,
          bodyText: card.bodyText,
        })),
      })),
    })),
  };
}

function updateChapterTitle(
  document: ImportCorrectionDocument,
  chapterIndex: number,
  title: string,
): ImportCorrectionDocument {
  return {
    ...document,
    chapters: document.chapters.map((chapter, index) =>
      index === chapterIndex ? { ...chapter, title } : chapter,
    ),
  };
}

function updateSectionTitle(
  document: ImportCorrectionDocument,
  chapterIndex: number,
  sectionIndex: number,
  title: string,
): ImportCorrectionDocument {
  return {
    ...document,
    chapters: document.chapters.map((chapter, currentChapterIndex) =>
      currentChapterIndex === chapterIndex
        ? {
            ...chapter,
            sections: chapter.sections.map((section, currentSectionIndex) =>
              currentSectionIndex === sectionIndex ? { ...section, title } : section,
            ),
          }
        : chapter,
    ),
  };
}

function updateCard(
  document: ImportCorrectionDocument,
  chapterIndex: number,
  sectionIndex: number,
  cardIndex: number,
  field: 'title' | 'bodyText',
  value: string,
): ImportCorrectionDocument {
  return {
    ...document,
    chapters: document.chapters.map((chapter, currentChapterIndex) =>
      currentChapterIndex === chapterIndex
        ? {
            ...chapter,
            sections: chapter.sections.map((section, currentSectionIndex) =>
              currentSectionIndex === sectionIndex
                ? {
                    ...section,
                    cards: section.cards.map((card, currentCardIndex) =>
                      currentCardIndex === cardIndex ? { ...card, [field]: value } : card,
                    ),
                  }
                : section,
            ),
          }
        : chapter,
    ),
  };
}

function locationText(fileName: string, line: number, column: number) {
  return `${fileName}:${line}:${column}`;
}

function importIssueKey(issue: ImportIssueResponse) {
  return JSON.stringify([issue.code, issue.location.fileName, issue.location.line, issue.location.column, issue.context]);
}

interface ImportCorrectionFeedback {
  issueKey: string;
  message: string;
}

function PreviewTree({
  preview,
  correction,
  onCorrectionChange,
}: {
  preview: ImportPreviewResponse;
  correction: ImportCorrectionDocument;
  onCorrectionChange: (next: ImportCorrectionDocument) => void;
}) {
  const document = preview.document;
  if (!document) {
    return null;
  }

  return (
    <div className="preview-tree">
      <label className="field-row">
        <span>资料标题</span>
        <input
          value={correction.title}
          onChange={(event) => onCorrectionChange({ ...correction, title: event.target.value })}
        />
      </label>
      {document.chapters.map((chapter, chapterIndex) => (
        <ChapterEditor
          key={`${chapter.location.fileName}-${chapter.location.line}-${chapterIndex}`}
          chapter={chapter}
          chapterIndex={chapterIndex}
          correction={correction}
          onCorrectionChange={onCorrectionChange}
        />
      ))}
    </div>
  );
}

function ChapterEditor({
  chapter,
  chapterIndex,
  correction,
  onCorrectionChange,
}: {
  chapter: ImportPreviewChapter;
  chapterIndex: number;
  correction: ImportCorrectionDocument;
  onCorrectionChange: (next: ImportCorrectionDocument) => void;
}) {
  const correctedChapter = correction.chapters[chapterIndex];
  if (!correctedChapter) {
    return null;
  }

  return (
    <fieldset className="level-group">
      <legend>第 {chapterIndex + 1} 章</legend>
      <label className="field-row">
        <span>章标题</span>
        <input
          value={correctedChapter.title}
          onChange={(event) =>
            onCorrectionChange(updateChapterTitle(correction, chapterIndex, event.target.value))
          }
        />
      </label>
      {chapter.sections.map((section, sectionIndex) => {
        const correctedSection = correctedChapter.sections[sectionIndex];
        if (!correctedSection) {
          return null;
        }
        return (
          <fieldset className="level-group section-group" key={`${section.location.fileName}-${section.location.line}`}>
            <legend>第 {sectionIndex + 1} 节</legend>
            <label className="field-row">
              <span>节标题</span>
              <input
                value={correctedSection.title}
                onChange={(event) =>
                  onCorrectionChange(updateSectionTitle(correction, chapterIndex, sectionIndex, event.target.value))
                }
              />
            </label>
            <div className="card-list">
              {section.cards.map((card, cardIndex) => {
                const correctedCard = correctedSection.cards[cardIndex];
                if (!correctedCard) {
                  return null;
                }
                return (
                  <article className="card-editor" key={`${card.location.fileName}-${card.location.line}`}>
                    <div className="card-meta">
                      <span>闪卡 {cardIndex + 1}</span>
                      <span>{locationText(card.location.fileName, card.location.line, card.location.column)}</span>
                    </div>
                    <label className="field-row">
                      <span>闪卡标题</span>
                      <input
                        value={correctedCard.title}
                        onChange={(event) =>
                          onCorrectionChange(
                            updateCard(
                              correction,
                              chapterIndex,
                              sectionIndex,
                              cardIndex,
                              'title',
                              event.target.value,
                            ),
                          )
                        }
                      />
                    </label>
                    <label className="field-row field-column">
                      <span>正文修正</span>
                      <textarea
                        rows={4}
                        value={correctedCard.bodyText}
                        onChange={(event) =>
                          onCorrectionChange(
                            updateCard(
                              correction,
                              chapterIndex,
                              sectionIndex,
                              cardIndex,
                              'bodyText',
                              event.target.value,
                            ),
                          )
                        }
                      />
                    </label>
                  </article>
                );
              })}
            </div>
          </fieldset>
        );
      })}
    </fieldset>
  );
}

function IssueList({
  preview,
  correcting,
  feedback,
  onCorrect,
}: {
  preview: ImportPreviewResponse;
  correcting: Set<string>;
  feedback: ImportCorrectionFeedback | null;
  onCorrect: (issueIndex: number, issueKey: string) => void;
}) {
  if (preview.issues.length === 0) {
    return null;
  }
  return (
    <section className="issue-section" aria-labelledby="issue-title">
      <div className="section-heading">
        <div className="issue-heading-title">
          <h2 id="issue-title">需要处理</h2>
          <span className="issue-count">{preview.issues.length}</span>
        </div>
      </div>
      <ol className="issue-list">
        {preview.issues.map((issue, index) => {
          const issueKey = importIssueKey(issue);
          return (
          <li key={issueKey}>
            <div className="issue-item-heading">
              <strong>{locationText(issue.location.fileName, issue.location.line, issue.location.column)}</strong>
              {preview.aiCorrectionAvailable && ['unsafe_html', 'invalid_formula', 'invalid_table'].includes(issue.code) ? (
                <button
                  className="button-secondary issue-ai-correction"
                  type="button"
                  title="只修正格式，不改写正文"
                  aria-label={`优化格式：${locationText(issue.location.fileName, issue.location.line, issue.location.column)}`}
                  disabled={correcting.has(issueKey)}
                  onClick={() => onCorrect(index, issueKey)}
                >
                  <Sparkles size={16} aria-hidden="true" />
                  {correcting.has(issueKey) ? '处理中' : '优化格式'}
                </button>
              ) : null}
            </div>
            <span>{issue.message}</span>
            <small>{issue.suggestion}</small>
            {issue.context.length > 0 ? <small>{issue.context.join(' / ')}</small> : null}
            {feedback?.issueKey === issueKey ? <small className="issue-ai-feedback">{feedback.message}</small> : null}
          </li>
          );
        })}
      </ol>
    </section>
  );
}

const masteryOptions: Array<{ value: ReviewMasteryStatus; label: string }> = [
  { value: 'unassessed', label: '未评估' },
  { value: 'mastered', label: '掌握' },
  { value: 'familiar', label: '了解' },
  { value: 'effort', label: '努力' },
];

const reviewStatusOptions = masteryOptions.filter((option) => option.value !== 'unassessed');

function masteryStatusLabel(status: ReviewMasteryStatus) {
  return masteryOptions.find((option) => option.value === status)?.label ?? '未评估';
}

function safeLink(url: string | undefined) {
  const normalized = url?.trim() ?? '';
  if (!normalized || normalized.startsWith('//')) {
    return null;
  }
  if (!/^[a-z][a-z\d+.-]*:/i.test(normalized) || /^(?:https?:|mailto:)/i.test(normalized)) {
    return normalized;
  }
  return null;
}

function Formula({
  value,
  display,
  highlight,
  clozeMode,
  revealed,
  onToggle,
  onReveal,
  readOnly = false,
}: {
  value: string;
  display: boolean;
  highlight: ReviewHighlight | undefined;
  clozeMode: boolean;
  revealed: boolean;
  onToggle: () => void;
  onReveal: () => void;
  readOnly?: boolean;
}) {
  const html = renderToString(value, { displayMode: display, throwOnError: false, trust: false });
  const masked = Boolean(highlight) && clozeMode && !revealed;
  const classes = [
    display ? 'formula formula-display' : 'formula formula-inline',
    readOnly ? '' : 'formula-action',
    highlight ? 'content-highlight' : '',
    masked ? 'content-cloze-mask' : '',
    masked && isShortCloze(value) ? 'content-cloze-mask-short' : '',
    clozeMode && highlight && revealed ? 'content-cloze-revealed' : '',
  ].filter(Boolean).join(' ');
  if (readOnly) {
    return <span className={classes} aria-label={display ? '公式' : undefined} dangerouslySetInnerHTML={{ __html: html }} />;
  }
  return (
    <button
      className={classes}
      type="button"
      aria-label={masked ? '显示公式重点' : highlight ? '取消公式高亮' : '标记公式重点'}
      aria-pressed={masked ? undefined : Boolean(highlight)}
      title={masked ? '显示公式重点' : highlight ? '取消公式高亮' : '标记公式重点'}
      onClick={masked ? onReveal : onToggle}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface ContentRenderOptions {
  highlights: ReviewHighlight[];
  clozeMode: boolean;
  revealedHighlightIds: ReadonlySet<string>;
  onRevealHighlight: (highlightId: string) => void;
  onFormulaToggle: (nodePath: string) => void;
  readOnly?: boolean;
}

const aiExplanationContentOptions: ContentRenderOptions = {
  highlights: [],
  clozeMode: false,
  revealedHighlightIds: new Set(),
  onRevealHighlight: () => {},
  onFormulaToggle: () => {},
  readOnly: true,
};

interface TextHighlightRange {
  id: string;
  start: number;
  end: number;
}

interface TextContentSegment {
  start: number;
  end: number;
  highlightIds: string[];
}

function textHighlightRanges(value: string, nodePath: string, highlights: ReviewHighlight[]): TextHighlightRange[] {
  return highlights
    .filter((highlight): highlight is ReviewHighlight & { anchor: { nodePath: string; start: number; end: number } } =>
      highlight.kind === 'text'
      && highlight.anchor.nodePath === nodePath
      && 'start' in highlight.anchor
      && highlight.anchor.start >= 0
      && highlight.anchor.end <= value.length
      && highlight.anchor.start < highlight.anchor.end,
    )
    .map((highlight) => ({ id: highlight.id, start: highlight.anchor.start, end: highlight.anchor.end }))
    .sort((left, right) => left.start - right.start || left.end - right.end || left.id.localeCompare(right.id));
}

function textContentSegments(value: string, nodePath: string, highlights: ReviewHighlight[]): TextContentSegment[] {
  const ranges = textHighlightRanges(value, nodePath, highlights);
  if (ranges.length === 0) {
    return [{ start: 0, end: value.length, highlightIds: [] }];
  }
  const boundaries = [...new Set([0, value.length, ...ranges.flatMap((range) => [range.start, range.end])])]
    .sort((left, right) => left - right);
  return boundaries.slice(0, -1).flatMap((start, index) => {
    const end = boundaries[index + 1]!;
    if (start === end) {
      return [];
    }
    return [{
      start,
      end,
      highlightIds: ranges
        .filter((range) => range.start <= start && range.end >= end)
        .map((range) => range.id),
    }];
  });
}

function HighlightedText({ value, nodePath, options }: { value: string; nodePath: string; options: ContentRenderOptions }) {
  const segments = textContentSegments(value, nodePath, options.highlights);
  if (segments.every((segment) => segment.highlightIds.length === 0)) {
    return <span data-highlight-path={nodePath}>{value}</span>;
  }
  const renderedSegments: ReactNode[] = [];
  segments.forEach((segment) => {
    const text = value.slice(segment.start, segment.end);
    if (segment.highlightIds.length === 0) {
      renderedSegments.push(<span key={`text-${segment.start}`}>{text}</span>);
      return;
    }
    const hiddenHighlightId = segment.highlightIds.find((id) => !options.revealedHighlightIds.has(id));
    if (options.clozeMode && hiddenHighlightId) {
      renderedSegments.push(
        <button
          className={`content-highlight content-cloze-mask ${isShortCloze(text) ? 'content-cloze-mask-short' : ''}`}
          data-cloze-highlight-id={hiddenHighlightId}
          type="button"
          key={`highlight-${segment.start}-${segment.end}`}
          aria-label="显示重点"
          title="显示重点"
          onClick={() => options.onRevealHighlight(hiddenHighlightId)}
        >
          {text}
        </button>,
      );
      return;
    }
    const wasRevealed = options.clozeMode
      && segment.highlightIds.some((id) => options.revealedHighlightIds.has(id));
    renderedSegments.push(
      <mark className={`content-highlight ${wasRevealed ? 'content-cloze-revealed' : ''}`} key={`highlight-${segment.start}-${segment.end}`}>
        {text}
      </mark>,
    );
  });
  return <span data-highlight-path={nodePath}>{renderedSegments}</span>;
}

function ContentNodes({ nodes, pathPrefix = '', options }: { nodes: ReviewContentNode[]; pathPrefix?: string; options: ContentRenderOptions }) {
  return <>{nodes.map((node, index) => {
    const nodePath = pathPrefix ? `${pathPrefix}.${index}` : String(index);
    return <ContentNode key={nodePath} node={node} nodePath={nodePath} options={options} />;
  })}</>;
}

const aiQuotedEmphasisPattern = /(\*{1,2})([“‘][^*\r\n]+?[”’])\1/g;

function quotedAiEmphasisNodes(value: string): ReviewContentNode[] {
  const nodes: ReviewContentNode[] = [];
  let offset = 0;
  for (const match of value.matchAll(aiQuotedEmphasisPattern)) {
    const start = match.index ?? 0;
    if (start > offset) {
      nodes.push({ type: 'text', value: value.slice(offset, start) });
    }
    nodes.push({
      type: match[1] === '**' ? 'strong' : 'emphasis',
      children: [{ type: 'text', value: match[2] }],
    });
    offset = start + match[0].length;
  }
  return nodes.length === 0 ? [{ type: 'text', value }] : [
    ...nodes,
    ...(offset < value.length ? [{ type: 'text', value: value.slice(offset) }] : []),
  ];
}

function normalizeAiMarkdownNodes(nodes: ReviewContentNode[]): ReviewContentNode[] {
  return nodes.flatMap((node) => {
    // CommonMark 将星号紧贴中文引号的强调视为普通文本，兼容常见模型输出。
    if (node.type === 'text') {
      return quotedAiEmphasisNodes(node.value ?? '');
    }
    return node.children ? [{ ...node, children: normalizeAiMarkdownNodes(node.children) }] : [node];
  });
}

function AiExplanationContent({ content }: { content: string }) {
  const nodes = useMemo(() => {
    try {
      return normalizeAiMarkdownNodes(aiMarkdownProcessor.parse(content).children as unknown as ReviewContentNode[]);
    } catch {
      return [{ type: 'paragraph', children: [{ type: 'text', value: content }] }];
    }
  }, [content]);
  return <ContentNodes nodes={nodes} pathPrefix="ai-explanation" options={aiExplanationContentOptions} />;
}

function TableRow({ node, nodePath, heading, options }: { node: ReviewContentNode; nodePath: string; heading: boolean; options: ContentRenderOptions }) {
  return (
    <tr>
      {(node.children ?? []).map((cell, index) => {
        const alignment = cell.align?.[0] ?? node.align?.[index];
        const className = alignment ? `content-align-${alignment}` : undefined;
        const cellPath = `${nodePath}.${index}`;
        return heading ? (
          <th className={className} key={cellPath} rowSpan={cell.rowSpan} colSpan={cell.colSpan}><ContentNodes nodes={cell.children ?? []} pathPrefix={cellPath} options={options} /></th>
        ) : (
          <td className={className} key={cellPath} rowSpan={cell.rowSpan} colSpan={cell.colSpan}><ContentNodes nodes={cell.children ?? []} pathPrefix={cellPath} options={options} /></td>
        );
      })}
    </tr>
  );
}

function ContentTable({ node, nodePath, options }: { node: ReviewContentNode; nodePath: string; options: ContentRenderOptions }) {
  const rows = node.children ?? [];
  const hasExplicitHeader = rows.some((row) => row.header === true);
  const firstRow = hasExplicitHeader ? undefined : rows[0];
  const headerRows = hasExplicitHeader ? rows.filter((row) => row.header === true) : firstRow ? [firstRow] : [];
  const bodyRows = hasExplicitHeader ? rows.filter((row) => row.header !== true) : rows.slice(1);
  return (
    <div className="content-table-scroll">
      <table className="content-table">
        {headerRows.length > 0 ? <thead>{headerRows.map((row) => {
          const rowIndex = rows.indexOf(row);
          return <TableRow key={`${nodePath}.${rowIndex}`} node={row} nodePath={`${nodePath}.${rowIndex}`} heading options={options} />;
        })}</thead> : null}
        {bodyRows.length > 0 ? <tbody>{bodyRows.map((row) => {
          const rowIndex = rows.indexOf(row);
          return <TableRow key={`${nodePath}.${rowIndex}`} node={row} nodePath={`${nodePath}.${rowIndex}`} heading={false} options={options} />;
        })}</tbody> : null}
      </table>
    </div>
  );
}

function ContentNode({ node, nodePath, options }: { node: ReviewContentNode; nodePath: string; options: ContentRenderOptions }) {
  const children = node.children ?? [];
  switch (node.type) {
    case 'text':
      return <HighlightedText value={node.value ?? ''} nodePath={nodePath} options={options} />;
    case 'paragraph':
      return <p><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></p>;
    case 'heading': {
      const content = <ContentNodes nodes={children} pathPrefix={nodePath} options={options} />;
      switch (node.depth) {
        case 1: return <h1>{content}</h1>;
        case 2: return <h2>{content}</h2>;
        case 3: return <h3>{content}</h3>;
        case 4: return <h4>{content}</h4>;
        case 5: return <h5>{content}</h5>;
        default: return <h6>{content}</h6>;
      }
    }
    case 'emphasis':
      return <em><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></em>;
    case 'strong':
      return <strong><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></strong>;
    case 'delete':
      return <del><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></del>;
    case 'inlineCode':
      return <code className="inline-code">{node.value ?? ''}</code>;
    case 'code':
      return <pre className="content-code"><code className={node.lang ? `language-${node.lang}` : undefined}>{node.value ?? ''}</code></pre>;
    case 'blockquote':
      return <blockquote><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></blockquote>;
    case 'list':
      return node.ordered
        ? <ol start={node.start ?? undefined}><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></ol>
        : <ul><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></ul>;
    case 'listItem':
      return <li><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></li>;
    case 'break':
      return <br />;
    case 'thematicBreak':
      return <hr />;
    case 'link': {
      const href = safeLink(node.url);
      return href
        ? <a href={href} title={node.title ?? undefined} target={href.startsWith('http') ? '_blank' : undefined} rel={href.startsWith('http') ? 'noreferrer' : undefined}><ContentNodes nodes={children} pathPrefix={nodePath} options={options} /></a>
        : <ContentNodes nodes={children} pathPrefix={nodePath} options={options} />;
    }
    case 'image': {
      const src = node.resourceId ? `${reviewResourcePath}/${encodeURIComponent(node.resourceId)}` : null;
      return src ? <img className="content-image" src={src} alt={node.alt ?? ''} title={node.title ?? undefined} /> : null;
    }
    case 'html':
      return null;
    case 'math':
    case 'inlineMath': {
      const highlight = options.highlights.find((item) => item.kind === 'formula' && item.anchor.nodePath === nodePath);
      return <Formula
        value={node.value ?? ''}
        display={node.type === 'math'}
        highlight={highlight}
        clozeMode={options.clozeMode}
        revealed={Boolean(highlight && options.revealedHighlightIds.has(highlight.id))}
        onToggle={() => options.onFormulaToggle(nodePath)}
        onReveal={() => highlight && options.onRevealHighlight(highlight.id)}
        readOnly={options.readOnly}
      />;
    }
    case 'table':
      return <ContentTable node={node} nodePath={nodePath} options={options} />;
    case 'tableRow':
    case 'tableCell':
      return <ContentNodes nodes={children} pathPrefix={nodePath} options={options} />;
    default:
      return node.value ?? <ContentNodes nodes={children} pathPrefix={nodePath} options={options} />;
  }
}

interface PendingTextHighlight {
  nodePath: string;
  start: number;
  end: number;
}

function textOffsetWithin(container: HTMLElement, node: Node, offset: number): number | null {
  try {
    // 通过 DOM Range 计算偏移，已存在的 mark 元素不会改变原文本位置。
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function selectedTextHighlights(root: HTMLElement): PendingTextHighlight[] {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    return [];
  }
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return [];
  }
  return [...root.querySelectorAll<HTMLElement>('[data-highlight-path]')].flatMap((container) => {
    const nodePath = container.dataset.highlightPath;
    if (!nodePath || !range.intersectsNode(container)) {
      return [];
    }
    const containerRange = document.createRange();
    containerRange.selectNodeContents(container);
    const startsBefore = range.compareBoundaryPoints(Range.START_TO_START, containerRange) <= 0;
    const endsAfter = range.compareBoundaryPoints(Range.END_TO_END, containerRange) >= 0;
    const start = startsBefore ? 0 : textOffsetWithin(container, range.startContainer, range.startOffset);
    const end = endsAfter ? container.textContent?.length ?? 0 : textOffsetWithin(container, range.endContainer, range.endOffset);
    return start !== null && end !== null && start < end ? [{ nodePath, start, end }] : [];
  });
}

function cloneContent(nodes: ReviewContentNode[]): ReviewContentNode[] {
  return nodes.map((node) => ({
    ...node,
    ...(node.children ? { children: cloneContent(node.children) } : {}),
  }));
}

function updateContentNode(
  nodes: ReviewContentNode[],
  nodePath: string,
  nextNode: ReviewContentNode,
): ReviewContentNode[] {
  const indexes = nodePath.split('.').map(Number);
  const updateAt = (current: ReviewContentNode[], depth: number): ReviewContentNode[] => current.map((node, index) => {
    if (index !== indexes[depth]) {
      return node;
    }
    if (depth === indexes.length - 1) {
      return nextNode;
    }
    return { ...node, children: updateAt(node.children ?? [], depth + 1) };
  });
  return updateAt(nodes, 0);
}

const MathField = 'math-field' as ElementType;

function FormulaEditor({ value, display, onChange }: { value: string; display: boolean; onChange: (value: string) => void }) {
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    void import('mathlive')
      .then(() => {
        if (active) {
          setReady(true);
        }
      })
      .catch(() => {
        if (active) {
          setFailed(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  if (failed) {
    return <span className="formula-editor-error">公式编辑器不可用。</span>;
  }
  if (!ready) {
    return <span className="formula-editor-loading">加载公式</span>;
  }
  return (
    <MathField
      className={`formula-editor ${display ? 'formula-editor-display' : 'formula-editor-inline'}`}
      value={value}
      virtualKeyboardMode="manual"
      aria-label="编辑公式"
      onInput={(event: React.FormEvent<HTMLElement>) => {
        onChange((event.currentTarget as HTMLElement & { value?: string }).value ?? '');
      }}
    />
  );
}

interface TableCellSelection {
  rowIndex: number;
  cellIndex: number;
}

interface TableCellPlacement extends TableCellSelection {
  node: ReviewContentNode;
  columnIndex: number;
  rowSpan: number;
  colSpan: number;
}

interface TableLayout {
  placements: TableCellPlacement[];
  grid: Array<Array<TableCellPlacement | undefined>>;
  columnCount: number;
}

function tableCellSpan(node: ReviewContentNode, property: 'rowSpan' | 'colSpan', maximum: number): number {
  const value = node[property];
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? Math.min(value, maximum)
    : 1;
}

function emptyTableCell(): ReviewContentNode {
  return { type: 'tableCell', children: [{ type: 'text', value: '' }] };
}

function tableLayout(rows: ReviewContentNode[]): TableLayout {
  const grid: Array<Array<TableCellPlacement | undefined>> = Array.from({ length: rows.length }, () => []);
  const placements: TableCellPlacement[] = [];
  let columnCount = 0;

  rows.forEach((row, rowIndex) => {
    let columnIndex = 0;
    (row.children ?? []).forEach((cell, cellIndex) => {
      while (grid[rowIndex]?.[columnIndex]) {
        columnIndex += 1;
      }
      const rowSpan = tableCellSpan(cell, 'rowSpan', Math.max(1, rows.length - rowIndex));
      const colSpan = tableCellSpan(cell, 'colSpan', 100);
      const placement = { node: cell, rowIndex, cellIndex, columnIndex, rowSpan, colSpan };
      placements.push(placement);
      for (let coveredRow = rowIndex; coveredRow < rowIndex + rowSpan; coveredRow += 1) {
        for (let coveredColumn = columnIndex; coveredColumn < columnIndex + colSpan; coveredColumn += 1) {
          grid[coveredRow]![coveredColumn] = placement;
        }
      }
      columnIndex += colSpan;
      columnCount = Math.max(columnCount, columnIndex);
    });
  });

  return { placements, grid, columnCount };
}

function selectedTableCell(layout: TableLayout, selection: TableCellSelection | null): TableCellPlacement | null {
  if (!selection) {
    return null;
  }
  return layout.placements.find((placement) => (
    placement.rowIndex === selection.rowIndex && placement.cellIndex === selection.cellIndex
  )) ?? null;
}

function withTableCellSpans(node: ReviewContentNode, rowSpan: number, colSpan: number): ReviewContentNode {
  const next = { ...node };
  if (rowSpan > 1) {
    next.rowSpan = rowSpan;
  } else {
    delete next.rowSpan;
  }
  if (colSpan > 1) {
    next.colSpan = colSpan;
  } else {
    delete next.colSpan;
  }
  return next;
}

function mergedTableCell(node: ReviewContentNode, other: ReviewContentNode, rowSpan: number, colSpan: number): ReviewContentNode {
  const first = node.children ?? [];
  const second = other.children ?? [];
  return withTableCellSpans({
    ...node,
    children: first.length > 0 && second.length > 0
      ? [...first, { type: 'break' }, ...second]
      : [...first, ...second],
  }, rowSpan, colSpan);
}

function tableWithInsertedRow(table: ReviewContentNode, selection: TableCellSelection | null): ReviewContentNode | null {
  const rows = table.children ?? [];
  if (rows.length === 0) {
    return {
      ...table,
      children: [{
        type: 'tableRow',
        children: [emptyTableCell(), emptyTableCell()],
      }],
    };
  }
  const layout = tableLayout(rows);
  const selected = selectedTableCell(layout, selection) ?? layout.placements.at(-1) ?? null;
  if (!selected || layout.columnCount === 0) {
    return null;
  }
  const insertionRow = selected.rowIndex + 1;
  const coveredColumns = new Set<number>();
  const nextRows = Array.from({ length: rows.length + 1 }, () => [] as Array<{ columnIndex: number; node: ReviewContentNode }>);

  layout.placements.forEach((placement) => {
    const crossesInsertion = placement.rowIndex < insertionRow && placement.rowIndex + placement.rowSpan > insertionRow;
    const targetRow = placement.rowIndex >= insertionRow ? placement.rowIndex + 1 : placement.rowIndex;
    const nextNode = crossesInsertion
      ? withTableCellSpans(placement.node, placement.rowSpan + 1, placement.colSpan)
      : placement.node;
    nextRows[targetRow]!.push({ columnIndex: placement.columnIndex, node: nextNode });
    if (crossesInsertion) {
      for (let column = placement.columnIndex; column < placement.columnIndex + placement.colSpan; column += 1) {
        coveredColumns.add(column);
      }
    }
  });
  for (let columnIndex = 0; columnIndex < layout.columnCount; columnIndex += 1) {
    if (!coveredColumns.has(columnIndex)) {
      nextRows[insertionRow]!.push({ columnIndex, node: emptyTableCell() });
    }
  }

  return {
    ...table,
    children: nextRows.map((cells, rowIndex) => ({
      ...rows[Math.min(rowIndex, rows.length - 1)]!,
      type: 'tableRow',
      children: cells.sort((left, right) => left.columnIndex - right.columnIndex).map((item) => item.node),
    })),
  };
}

function tableWithDeletedRow(table: ReviewContentNode, selection: TableCellSelection | null): ReviewContentNode | null {
  const rows = table.children ?? [];
  const layout = tableLayout(rows);
  const selected = selectedTableCell(layout, selection);
  if (!selected || rows.length <= 1) {
    return null;
  }
  const deletedRow = selected.rowIndex;
  const nextRows = Array.from({ length: rows.length - 1 }, () => [] as Array<{ columnIndex: number; node: ReviewContentNode }>);

  layout.placements.forEach((placement) => {
    let targetRow = placement.rowIndex;
    let nextNode = placement.node;
    if (placement.rowIndex < deletedRow) {
      if (placement.rowIndex + placement.rowSpan > deletedRow) {
        nextNode = withTableCellSpans(placement.node, placement.rowSpan - 1, placement.colSpan);
      }
    } else if (placement.rowIndex === deletedRow) {
      if (placement.rowSpan === 1) {
        return;
      }
      nextNode = withTableCellSpans(placement.node, placement.rowSpan - 1, placement.colSpan);
    } else {
      targetRow -= 1;
    }
    nextRows[targetRow]!.push({ columnIndex: placement.columnIndex, node: nextNode });
  });

  return {
    ...table,
    children: nextRows.map((cells, rowIndex) => ({
      ...rows[rowIndex >= deletedRow ? rowIndex + 1 : rowIndex]!,
      type: 'tableRow',
      children: cells.sort((left, right) => left.columnIndex - right.columnIndex).map((item) => item.node),
    })),
  };
}

function tableWithMergedCells(table: ReviewContentNode, selection: TableCellSelection | null, direction: 'horizontal' | 'vertical'): ReviewContentNode | null {
  const rows = table.children ?? [];
  const layout = tableLayout(rows);
  const selected = selectedTableCell(layout, selection);
  if (!selected) {
    return null;
  }
  const neighbor = direction === 'horizontal'
    ? layout.grid[selected.rowIndex]?.[selected.columnIndex + selected.colSpan]
    : layout.grid[selected.rowIndex + selected.rowSpan]?.[selected.columnIndex];
  if (!neighbor || neighbor === selected) {
    return null;
  }
  const compatible = direction === 'horizontal'
    ? neighbor.rowIndex === selected.rowIndex && neighbor.rowSpan === selected.rowSpan
    : neighbor.columnIndex === selected.columnIndex && neighbor.colSpan === selected.colSpan;
  if (!compatible) {
    return null;
  }
  const nextSpan = direction === 'horizontal'
    ? { rowSpan: selected.rowSpan, colSpan: selected.colSpan + neighbor.colSpan }
    : { rowSpan: selected.rowSpan + neighbor.rowSpan, colSpan: selected.colSpan };
  return {
    ...table,
    children: rows.map((row, rowIndex) => ({
      ...row,
      children: (row.children ?? [])
        .filter((_, cellIndex) => rowIndex !== neighbor.rowIndex || cellIndex !== neighbor.cellIndex)
        .map((cell, cellIndex) => rowIndex === selected.rowIndex && cellIndex === selected.cellIndex
          ? mergedTableCell(cell, neighbor.node, nextSpan.rowSpan, nextSpan.colSpan)
          : cell),
    })),
  };
}

function tableWithSplitCell(table: ReviewContentNode, selection: TableCellSelection | null): ReviewContentNode | null {
  const rows = table.children ?? [];
  const layout = tableLayout(rows);
  const selected = selectedTableCell(layout, selection);
  if (!selected || (selected.rowSpan === 1 && selected.colSpan === 1)) {
    return null;
  }
  const nextRows = Array.from({ length: rows.length }, () => [] as Array<{ columnIndex: number; node: ReviewContentNode }>);
  layout.placements.forEach((placement) => {
    if (placement !== selected) {
      nextRows[placement.rowIndex]!.push({ columnIndex: placement.columnIndex, node: placement.node });
      return;
    }
    for (let rowIndex = selected.rowIndex; rowIndex < selected.rowIndex + selected.rowSpan; rowIndex += 1) {
      for (let columnIndex = selected.columnIndex; columnIndex < selected.columnIndex + selected.colSpan; columnIndex += 1) {
        nextRows[rowIndex]!.push({
          columnIndex,
          node: rowIndex === selected.rowIndex && columnIndex === selected.columnIndex
            ? withTableCellSpans(selected.node, 1, 1)
            : emptyTableCell(),
        });
      }
    }
  });
  return {
    ...table,
    children: rows.map((row, rowIndex) => ({
      ...row,
      children: nextRows[rowIndex]!.sort((left, right) => left.columnIndex - right.columnIndex).map((item) => item.node),
    })),
  };
}

function VisualContentNodes({
  nodes,
  pathPrefix = '',
  onNodeChange,
  onUpload,
}: {
  nodes: ReviewContentNode[];
  pathPrefix?: string;
  onNodeChange: (nodePath: string, nextNode: ReviewContentNode) => void;
  onUpload: (file: File) => Promise<{ id: string }>;
}) {
  return (
    <>{nodes.map((node, index) => {
      const nodePath = pathPrefix ? `${pathPrefix}.${index}` : String(index);
      return (
        <VisualContentNode
          key={nodePath}
          node={node}
          nodePath={nodePath}
          onNodeChange={onNodeChange}
          onUpload={onUpload}
        />
      );
    })}</>
  );
}

function VisualContentNode({
  node,
  nodePath,
  onNodeChange,
  onUpload,
}: {
  node: ReviewContentNode;
  nodePath: string;
  onNodeChange: (nodePath: string, nextNode: ReviewContentNode) => void;
  onUpload: (file: File) => Promise<{ id: string }>;
}) {
  const children = node.children ?? [];
  const [tableSelection, setTableSelection] = useState<TableCellSelection | null>(null);
  const editText = (value: string) => onNodeChange(nodePath, { ...node, value });
  const editorChildren = (
    <VisualContentNodes
      nodes={children}
      pathPrefix={nodePath}
      onNodeChange={onNodeChange}
      onUpload={onUpload}
    />
  );

  switch (node.type) {
    case 'text':
      return <input className="inline-text-editor" aria-label="编辑文字" value={node.value ?? ''} onChange={(event) => editText(event.target.value)} />;
    case 'inlineCode':
      return <input className="inline-text-editor inline-code" aria-label="编辑代码" value={node.value ?? ''} onChange={(event) => editText(event.target.value)} />;
    case 'code':
      return <textarea className="content-code editor-code" aria-label="编辑代码" value={node.value ?? ''} onChange={(event) => editText(event.target.value)} />;
    case 'math':
    case 'inlineMath':
      return <FormulaEditor value={node.value ?? ''} display={node.type === 'math'} onChange={editText} />;
    case 'paragraph':
      return <div className="editor-paragraph">{editorChildren}</div>;
    case 'heading':
      return <div className="editor-heading">{editorChildren}</div>;
    case 'emphasis':
      return <em className="editor-inline-group">{editorChildren}</em>;
    case 'strong':
      return <strong className="editor-inline-group">{editorChildren}</strong>;
    case 'delete':
      return <del className="editor-inline-group">{editorChildren}</del>;
    case 'link':
      return <span className="editor-link">{editorChildren}</span>;
    case 'blockquote':
      return <blockquote className="editor-quote">{editorChildren}</blockquote>;
    case 'list':
      return node.ordered ? <ol className="editor-list">{editorChildren}</ol> : <ul className="editor-list">{editorChildren}</ul>;
    case 'listItem':
      return <li>{editorChildren}</li>;
    case 'break':
      return <br />;
    case 'thematicBreak':
      return <hr />;
    case 'table': {
      const rows = node.children ?? [];
      const layout = tableLayout(rows);
      const selected = selectedTableCell(layout, tableSelection);
      const applyTable = (nextTable: ReviewContentNode | null) => {
        if (nextTable) {
          onNodeChange(nodePath, nextTable);
          setTableSelection(null);
        }
      };
      return (
        <div className="editor-table-wrap">
          <table className="content-table editor-table">
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`${nodePath}.${rowIndex}`}>
                  {(row.children ?? []).map((cell, cellIndex) => (
                    <td
                      key={`${nodePath}.${rowIndex}.${cellIndex}`}
                      rowSpan={cell.rowSpan}
                      colSpan={cell.colSpan}
                      className={tableSelection?.rowIndex === rowIndex && tableSelection.cellIndex === cellIndex ? 'editor-table-cell-selected' : undefined}
                      tabIndex={0}
                      aria-selected={tableSelection?.rowIndex === rowIndex && tableSelection.cellIndex === cellIndex}
                      onClick={() => setTableSelection({ rowIndex, cellIndex })}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setTableSelection({ rowIndex, cellIndex });
                        }
                      }}
                    >
                      {cell.children?.length ? (
                        <VisualContentNodes
                          nodes={cell.children}
                          pathPrefix={`${nodePath}.${rowIndex}.${cellIndex}`}
                          onNodeChange={onNodeChange}
                          onUpload={onUpload}
                        />
                      ) : (
                        <input
                          className="inline-text-editor"
                          aria-label={`编辑第${rowIndex + 1}行第${cellIndex + 1}列`}
                          value=""
                          onChange={(event) => onNodeChange(
                            `${nodePath}.${rowIndex}.${cellIndex}`,
                            { ...cell, children: [{ type: 'text', value: event.target.value }] },
                          )}
                        />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="editor-table-tools" aria-label="表格操作">
            <button className="button-secondary editor-table-action" type="button" onClick={() => applyTable(tableWithInsertedRow(node, tableSelection))}>
              <Plus size={15} aria-hidden="true" />
              <span>加行</span>
            </button>
            <button className="button-secondary editor-table-action" type="button" disabled={!selected || rows.length <= 1} onClick={() => applyTable(tableWithDeletedRow(node, tableSelection))}>
              <Trash2 size={15} aria-hidden="true" />
              <span>删行</span>
            </button>
            <button className="button-secondary editor-table-action" type="button" disabled={!selected} onClick={() => applyTable(tableWithMergedCells(node, tableSelection, 'horizontal'))}>
              <Merge size={15} aria-hidden="true" />
              <span>横合并</span>
            </button>
            <button className="button-secondary editor-table-action" type="button" disabled={!selected} onClick={() => applyTable(tableWithMergedCells(node, tableSelection, 'vertical'))}>
              <Merge size={15} aria-hidden="true" />
              <span>竖合并</span>
            </button>
            <button className="button-secondary editor-table-action" type="button" disabled={!selected || (selected.rowSpan === 1 && selected.colSpan === 1)} onClick={() => applyTable(tableWithSplitCell(node, tableSelection))}>
              <span>拆分</span>
            </button>
          </div>
        </div>
      );
    }
    case 'image':
      return <ImageEditor node={node} nodePath={nodePath} onNodeChange={onNodeChange} onUpload={onUpload} />;
    default:
      return <>{editorChildren}</>;
  }
}

function ImageEditor({
  node,
  nodePath,
  onNodeChange,
  onUpload,
}: {
  node: ReviewContentNode;
  nodePath: string;
  onNodeChange: (nodePath: string, nextNode: ReviewContentNode) => void;
  onUpload: (file: File) => Promise<{ id: string }>;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const src = node.resourceId ? `${reviewResourcePath}/${encodeURIComponent(node.resourceId)}` : null;

  async function replaceImage(file: File | undefined) {
    if (!file) {
      return;
    }
    setUploading(true);
    setError('');
    try {
      const resource = await onUpload(file);
      onNodeChange(nodePath, { ...node, resourceId: resource.id });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '图片上传失败。');
    } finally {
      setUploading(false);
    }
  }

  return (
    <div className="image-editor">
      {src ? <img className="content-image" src={src} alt={node.alt ?? ''} /> : null}
      <label className="file-button editor-image-button">
        <span>{uploading ? '上传中' : '换图片'}</span>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={uploading} onChange={(event) => { void replaceImage(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      <label className="field-row field-column">
        <span>图片说明</span>
        <input value={node.alt ?? ''} onChange={(event) => onNodeChange(nodePath, { ...node, alt: event.target.value })} />
      </label>
      {error ? <p className="editor-error" role="alert">{error}</p> : null}
    </div>
  );
}

function AddImageButton({
  onUpload,
  onAdd,
}: {
  onUpload: (file: File) => Promise<{ id: string }>;
  onAdd: (resourceId: string) => void;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function addImage(file: File | undefined) {
    if (!file) {
      return;
    }
    setUploading(true);
    setError('');
    try {
      const resource = await onUpload(file);
      onAdd(resource.id);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '图片上传失败。');
    } finally {
      setUploading(false);
    }
  }

  return (
    <span className="editor-add-image-wrap">
      <label className="button-secondary editor-add-image">
        <span>{uploading ? '上传中' : '加图片'}</span>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" disabled={uploading} onChange={(event) => { void addImage(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      {error ? <small className="editor-error">{error}</small> : null}
    </span>
  );
}

function VisualCardEditor({
  card,
  onCancel,
  onSave,
  onUpload,
}: {
  card: ReviewCardSummary;
  onCancel: () => void;
  onSave: (request: ReviewCardContentUpdateRequest) => Promise<ReviewCardContentUpdateResponse>;
  onUpload: (file: File) => Promise<{ id: string }>;
}) {
  const [title, setTitle] = useState(card.title);
  const [content, setContent] = useState(() => cloneContent(card.content ?? []));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setTitle(card.title);
    setContent(cloneContent(card.content ?? []));
    setError('');
  }, [card.id]);

  function changeNode(nodePath: string, nextNode: ReviewContentNode) {
    setContent((current) => updateContentNode(current, nodePath, nextNode));
  }

  async function save() {
    setSaving(true);
    setError('');
    try {
      await onSave({ title, content });
      onCancel();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '正文保存失败。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="review-card editor-card" aria-label="编辑闪卡">
      <label className="field-row field-column editor-title-field">
        <span>闪卡标题</span>
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <div className="editor-content">
        {content.map((node, index) => (
          <div className="editor-block" key={String(index)}>
            <VisualContentNode node={node} nodePath={String(index)} onNodeChange={changeNode} onUpload={onUpload} />
            <button className="editor-remove" type="button" onClick={() => setContent((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label="删除内容">删除</button>
          </div>
        ))}
      </div>
      <div className="editor-add-tools" aria-label="新增内容">
        <button className="button-secondary" type="button" onClick={() => setContent((current) => [...current, { type: 'paragraph', children: [{ type: 'text', value: '' }] }])}>加段落</button>
        <button className="button-secondary" type="button" onClick={() => setContent((current) => [...current, { type: 'math', value: '' }])}>加公式</button>
        <button className="button-secondary" type="button" onClick={() => setContent((current) => [...current, { type: 'table', children: [
          { type: 'tableRow', children: [
            { type: 'tableCell', children: [{ type: 'text', value: '' }] },
            { type: 'tableCell', children: [{ type: 'text', value: '' }] },
          ] },
          { type: 'tableRow', children: [
            { type: 'tableCell', children: [{ type: 'text', value: '' }] },
            { type: 'tableCell', children: [{ type: 'text', value: '' }] },
          ] },
        ] }])}>加表格</button>
        <AddImageButton
          onUpload={onUpload}
          onAdd={(resourceId) => setContent((current) => [...current, { type: 'image', resourceId, alt: '' }])}
        />
      </div>
      {error ? <p className="editor-error" role="alert">{error}</p> : null}
      <footer className="editor-actions">
        <button className="button-secondary" type="button" disabled={saving} onClick={onCancel}>取消</button>
        <button className="button-primary" type="button" disabled={saving} onClick={() => { void save(); }}>{saving ? '保存中' : '应用'}</button>
      </footer>
    </section>
  );
}

const masteryStatusItems: Array<{ key: keyof CatalogMasteryDistribution; label: string }> = [
  { key: 'mastered', label: '掌握' },
  { key: 'familiar', label: '了解' },
  { key: 'effort', label: '努力' },
  { key: 'unassessed', label: '未评估' },
];

function trendSummary(trend: CatalogStatusTrendPoint[]): string {
  const first = trend[0];
  const last = trend.at(-1);
  if (!first || !last) return '最近 30 天暂无状态快照。';
  return `最近 30 天状态快照，${first.date} 至 ${last.date}；最新为掌握 ${last.mastered} 张、了解 ${last.familiar} 张、努力 ${last.effort} 张、未评估 ${last.unassessed} 张。`;
}

function CatalogFlashcardEditor({
  cardId,
  onClose,
  onSaved,
}: {
  cardId: string;
  onClose: () => void;
  onSaved: (result: ReviewCardContentUpdateResponse) => void;
}) {
  const [card, setCard] = useState<ReviewCardSummary | null>(null);
  const [lock, setLock] = useState<ReviewEditLock | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const lockRef = useRef<ReviewEditLock | null>(null);

  useEffect(() => {
    let disposed = false;

    async function openEditor() {
      setLoading(true);
      setError('');
      try {
        const response = await fetchReviewCard(cardId);
        if (disposed) {
          return;
        }
        const nextLock = await acquireReviewEditLock(cardId);
        if (disposed) {
          await releaseReviewEditLock(cardId, nextLock);
          return;
        }
        lockRef.current = nextLock;
        setCard(response.card);
        setLock(nextLock);
      } catch (requestError) {
        if (!disposed) {
          setError(requestError instanceof Error ? requestError.message : '无法进入编辑。');
        }
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    }

    void openEditor();
    return () => {
      disposed = true;
      const currentLock = lockRef.current;
      lockRef.current = null;
      if (currentLock) {
        void releaseReviewEditLock(cardId, currentLock);
      }
    };
  }, [cardId]);

  useEffect(() => {
    if (!lock) {
      return;
    }
    const lockToken = lock.lockToken;
    const timer = window.setInterval(() => {
      const currentLock = lockRef.current;
      if (!currentLock || currentLock.lockToken !== lockToken) {
        return;
      }
      void renewReviewEditLock(cardId, currentLock)
        .then((nextLock) => {
          if (lockRef.current?.lockToken === lockToken) {
            lockRef.current = nextLock;
            setLock(nextLock);
          }
        })
        .catch(() => {
          if (lockRef.current?.lockToken === lockToken) {
            lockRef.current = null;
            setLock(null);
            setError('编辑锁已失效，请取消后重新编辑。');
          }
        });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [cardId, lock?.lockToken]);

  async function saveContent(request: ReviewCardContentUpdateRequest) {
    const currentLock = lockRef.current;
    if (!currentLock) {
      throw new Error('编辑锁已失效，请取消后重新编辑。');
    }
    const result = await updateReviewContent(cardId, request, currentLock);
    onSaved(result);
    return result;
  }

  if (loading) {
    return <p className="catalog-flashcard-feedback" role="status">加载中</p>;
  }
  if (error || !card || !lock) {
    return <p className="catalog-flashcard-feedback feedback-error" role="alert">{error || '编辑锁已失效，请取消后重新编辑。'}</p>;
  }
  return <VisualCardEditor
    card={card}
    onCancel={onClose}
    onSave={saveContent}
    onUpload={async (file) => (await uploadReviewResource(file)).resource}
  />;
}

function CatalogMaterialDetail({
  response,
  onEdit,
  onReorderCard,
  onCardSaved,
}: {
  response: CatalogMaterialResponse;
  onEdit: () => void;
  onReorderCard: (cardId: string, direction: 'up' | 'down') => Promise<void>;
  onCardSaved: (result: ReviewCardContentUpdateResponse) => void;
}) {
  const { material } = response;
  const total = material.cardCount;
  const latestTrend = material.statusTrend.at(-1);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);
  const [reorderingCardId, setReorderingCardId] = useState<string | null>(null);
  const [cardActionError, setCardActionError] = useState('');
  const dateRange = material.statusTrend.length
    ? `${material.statusTrend[0]!.date.slice(5).replace('-', '/')} - ${material.statusTrend.at(-1)!.date.slice(5).replace('-', '/')}`
    : '';

  useEffect(() => {
    setEditingCardId(null);
    setReorderingCardId(null);
    setCardActionError('');
  }, [material.id]);

  async function reorderCard(cardId: string, direction: 'up' | 'down') {
    setReorderingCardId(cardId);
    setCardActionError('');
    try {
      await onReorderCard(cardId, direction);
    } catch (requestError) {
      setCardActionError(requestError instanceof Error ? requestError.message : '排序失败。');
    } finally {
      setReorderingCardId(null);
    }
  }

  return (
    <div className="catalog-detail-flow">
      <section className="catalog-detail-section catalog-detail-info" aria-labelledby="material-info-title">
        <div className="catalog-section-heading">
          <h2 id="material-info-title">资料信息</h2>
          <button className="catalog-edit" type="button" onClick={onEdit} aria-label="编辑资料" title="编辑资料">
            <Pencil size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="catalog-detail-info-row">
          <div className="catalog-detail-cover" aria-hidden="true">
            {material.cover ? <img src={`${reviewResourcePath}/${encodeURIComponent(material.cover.thumbnail.id)}`} alt="" /> : null}
          </div>
          <p>{material.cardCount} 张闪卡</p>
        </div>
      </section>

      <section className="catalog-detail-section" aria-labelledby="mastery-title">
        <h2 id="mastery-title">掌握分布</h2>
        {total > 0 ? (
          <>
            <div
              className="catalog-mastery-bar"
              role="img"
              aria-label={`当前掌握分布：掌握 ${material.masteryDistribution.mastered} 张、了解 ${material.masteryDistribution.familiar} 张、努力 ${material.masteryDistribution.effort} 张、未评估 ${material.masteryDistribution.unassessed} 张。`}
            >
              {masteryStatusItems.map((item) => (
                <span
                  className={`catalog-status-segment catalog-status-${item.key}`}
                  key={item.key}
                  style={{ width: `${(material.masteryDistribution[item.key] / total) * 100}%` }}
                  aria-hidden="true"
                />
              ))}
            </div>
            <ul className="catalog-status-legend" aria-label="掌握分布明细">
              {masteryStatusItems.map((item) => <li key={item.key}><span className={`catalog-status-dot catalog-status-${item.key}`} aria-hidden="true" />{item.label} {material.masteryDistribution[item.key]}</li>)}
            </ul>
          </>
        ) : <p className="empty-state">暂无闪卡</p>}
      </section>

      <section className="catalog-detail-section" aria-labelledby="trend-title">
        <div className="catalog-section-heading">
          <h2 id="trend-title">最近 30 天</h2>
          <small>{dateRange}</small>
        </div>
        {latestTrend && total > 0 ? (
          <>
            <div className="catalog-trend-chart" role="img" aria-label={trendSummary(material.statusTrend)}>
              {material.statusTrend.map((point) => (
                <div className="catalog-trend-day" key={point.date} aria-hidden="true">
                  <div className="catalog-trend-column">
                    <span className="catalog-status-segment catalog-status-unassessed" style={{ height: `${(point.unassessed / total) * 100}%` }} />
                    <span className="catalog-status-segment catalog-status-effort" style={{ height: `${(point.effort / total) * 100}%` }} />
                    <span className="catalog-status-segment catalog-status-familiar" style={{ height: `${(point.familiar / total) * 100}%` }} />
                    <span className="catalog-status-segment catalog-status-mastered" style={{ height: `${(point.mastered / total) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="catalog-trend-axis" aria-hidden="true"><span>{material.statusTrend[0]!.date.slice(5).replace('-', '/')}</span><span>{material.statusTrend.at(-1)!.date.slice(5).replace('-', '/')}</span></div>
          </>
        ) : <p className="empty-state">暂无状态快照</p>}
      </section>

      <section className="catalog-detail-section" aria-labelledby="material-content-title">
        <h2 id="material-content-title">内容</h2>
        {cardActionError ? <p className="feedback-error" role="alert">{cardActionError}</p> : null}
        {material.chapters.length ? (
          <div className="catalog-content-list">
            {material.chapters.map((chapter) => (
              <section className="catalog-chapter" key={chapter.id}>
                <h3>{chapter.title}</h3>
                {chapter.sections.map((section) => (
                  <div className="catalog-section" key={section.id}>
                    <h4>{section.title}</h4>
                    {section.cards.length ? (
                      <div className="catalog-flashcard-list" aria-label={`${section.title}闪卡`}>
                        {section.cards.map((card, cardIndex) => {
                          const editing = editingCardId === card.id;
                          const busy = reorderingCardId !== null;
                          return (
                            <article className="catalog-flashcard" key={card.id}>
                              <header className="catalog-flashcard-header">
                                <div className="catalog-flashcard-copy">
                                  <span className="catalog-flashcard-index">第 {cardIndex + 1} 张</span>
                                  <h5>{card.title}</h5>
                                </div>
                                <div className="catalog-flashcard-actions">
                                  <button
                                    className="catalog-edit"
                                    type="button"
                                    onClick={() => setEditingCardId(editing ? null : card.id)}
                                    disabled={busy || (editingCardId !== null && !editing)}
                                    aria-label={editing ? `收起${card.title}编辑` : `编辑${card.title}`}
                                    title={editing ? '收起编辑' : '编辑'}
                                  >
                                    <Pencil size={18} aria-hidden="true" />
                                  </button>
                                  <button
                                    className="catalog-edit"
                                    type="button"
                                    onClick={() => { void reorderCard(card.id, 'up'); }}
                                    disabled={busy || editingCardId !== null || cardIndex === 0}
                                    aria-label={`${card.title}上移`}
                                    title="上移"
                                  >
                                    <ArrowUp size={18} aria-hidden="true" />
                                  </button>
                                  <button
                                    className="catalog-edit"
                                    type="button"
                                    onClick={() => { void reorderCard(card.id, 'down'); }}
                                    disabled={busy || editingCardId !== null || cardIndex === section.cards.length - 1}
                                    aria-label={`${card.title}下移`}
                                    title="下移"
                                  >
                                    <ArrowDown size={18} aria-hidden="true" />
                                  </button>
                                </div>
                              </header>
                              {editing ? <CatalogFlashcardEditor cardId={card.id} onClose={() => setEditingCardId(null)} onSaved={onCardSaved} /> : null}
                            </article>
                          );
                        })}
                      </div>
                    ) : <p className="catalog-content-empty">暂无闪卡</p>}
                  </div>
                ))}
              </section>
            ))}
          </div>
        ) : <p className="empty-state">暂无章节</p>}
      </section>
    </div>
  );
}

function ImportDestinationPicker({
  courseId,
  subjectId,
  disabled,
  onChange,
}: {
  courseId: string;
  subjectId: string;
  disabled: boolean;
  onChange: (destination: { courseId: string; subjectId: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [courses, setCourses] = useState<CatalogCoursesResponse | null>(null);
  const [subjects, setSubjects] = useState<CatalogSubjectResponse['subject'][]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [createType, setCreateType] = useState<'course' | 'subject' | null>(null);
  const [draftName, setDraftName] = useState('');
  const [creating, setCreating] = useState(false);

  const selectedCourse = courses?.courses.find((course) => course.id === courseId) ?? null;
  const selectedSubject = subjects.find((subject) => subject.id === subjectId) ?? null;

  async function loadSubjects(courseIdToLoad: string) {
    const response = await fetchCatalogCourseSubjects(courseIdToLoad);
    setSubjects(response.subjects);
    return response.subjects;
  }

  async function openPicker() {
    setOpen(true);
    setLoading(true);
    setError('');
    try {
      const response = await fetchCatalogCourses();
      setCourses(response);
      if (!courseId || !response.courses.some((course) => course.id === courseId)) {
        setSubjects([]);
        if (courseId || subjectId) {
          onChange({ courseId: '', subjectId: '' });
        }
        return;
      }
      const nextSubjects = await loadSubjects(courseId);
      if (subjectId && !nextSubjects.some((subject) => subject.id === subjectId)) {
        onChange({ courseId, subjectId: '' });
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '归属加载失败。');
    } finally {
      setLoading(false);
    }
  }

  async function changeCourse(nextCourseId: string) {
    onChange({ courseId: nextCourseId, subjectId: '' });
    setSubjects([]);
    setError('');
    if (!nextCourseId) return;
    setLoading(true);
    try {
      await loadSubjects(nextCourseId);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '科目加载失败。');
    } finally {
      setLoading(false);
    }
  }

  async function createDestination(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draftName.trim();
    if (!createType || !name) {
      setError('请输入名称。');
      return;
    }
    if (createType === 'subject' && !courseId) {
      setError('请先选择课程。');
      return;
    }
    setCreating(true);
    setError('');
    try {
      if (createType === 'course') {
        const response = await createCatalogCourse(name);
        const createdCourse = response.courses[response.courses.length - 1];
        if (!createdCourse) throw new Error('新增课程后未找到课程。');
        setCourses(response);
        setSubjects([]);
        onChange({ courseId: createdCourse.id, subjectId: '' });
      } else {
        await createCatalogSubject(courseId, name);
        const nextSubjects = await loadSubjects(courseId);
        const createdSubject = nextSubjects[nextSubjects.length - 1];
        if (!createdSubject) throw new Error('新增科目后未找到科目。');
        onChange({ courseId, subjectId: createdSubject.id });
      }
      setDraftName('');
      setCreateType(null);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '新增失败。');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="import-destination" aria-labelledby="import-destination-title">
      <div>
        <h2 id="import-destination-title">归属</h2>
        <p>{selectedCourse && selectedSubject ? `${selectedCourse.name} / ${selectedSubject.name}` : '请选择课程和科目'}</p>
      </div>
      <button className="button-secondary" type="button" onClick={() => { void openPicker(); }} disabled={disabled}>选择归属</button>

      {open ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet sheet-tall import-destination-sheet" role="dialog" aria-modal="true" aria-labelledby="import-destination-sheet-title">
            <h2 id="import-destination-sheet-title">选择归属</h2>
            {createType ? (
              <form onSubmit={(event) => { void createDestination(event); }}>
                <label className="field-row field-column">
                  <span>{createType === 'course' ? '课程名称' : '科目名称'}</span>
                  <input value={draftName} onChange={(event) => setDraftName(event.target.value)} autoFocus disabled={creating} />
                </label>
                {error ? <p className="feedback-error" role="alert">{error}</p> : null}
                <div className="action-row">
                  <button className="button-secondary" type="button" onClick={() => { setCreateType(null); setDraftName(''); setError(''); }} disabled={creating}>取消</button>
                  <button className="button-primary" type="submit" disabled={creating || !draftName.trim()}>{creating ? '添加中' : '添加'}</button>
                </div>
              </form>
            ) : (
              <>
                <div className="field-row field-column">
                  <div className="import-destination-label">
                    <span>课程</span>
                    <button className="catalog-add" type="button" onClick={() => { setCreateType('course'); setDraftName(''); setError(''); }} disabled={loading} aria-label="新增课程" title="新增课程"><Plus size={20} aria-hidden="true" /></button>
                  </div>
                  <select aria-label="课程" value={courseId} onChange={(event) => { void changeCourse(event.target.value); }} disabled={loading}>
                    <option value="">请选择课程</option>
                    {courses?.courses.map((course) => <option value={course.id} key={course.id}>{course.name}</option>)}
                  </select>
                </div>
                <div className="field-row field-column">
                  <div className="import-destination-label">
                    <span>科目</span>
                    <button className="catalog-add" type="button" onClick={() => { setCreateType('subject'); setDraftName(''); setError(''); }} disabled={loading || !courseId} aria-label="新增科目" title="新增科目"><Plus size={20} aria-hidden="true" /></button>
                  </div>
                  <select aria-label="科目" value={subjectId} onChange={(event) => onChange({ courseId, subjectId: event.target.value })} disabled={loading || !courseId}>
                    <option value="">请选择科目</option>
                    {subjects.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}
                  </select>
                </div>
                {loading ? <p className="feedback-muted">加载中</p> : null}
                {error ? <p className="feedback-error" role="alert">{error}</p> : null}
                <div className="action-row">
                  <button className="button-primary" type="button" onClick={() => setOpen(false)} disabled={loading}>完成</button>
                </div>
              </>
            )}
          </section>
        </div>
      ) : null}
    </section>
  );
}

function CatalogPanel({
  route,
  onNavigate,
  onOpenManage,
  onAuthExpired,
}: {
  route: Exclude<MaterialsRoute, { kind: 'manage' } | { kind: 'question-banks' }>;
  onNavigate: (next: MaterialsRoute) => void;
  onOpenManage: () => void;
  onAuthExpired: () => void;
}) {
  const [courses, setCourses] = useState<CatalogCoursesResponse | null>(null);
  const [courseSubjects, setCourseSubjects] = useState<CatalogCourseSubjectsResponse | null>(null);
  const [subject, setSubject] = useState<CatalogSubjectResponse | null>(null);
  const [material, setMaterial] = useState<CatalogMaterialResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [createType, setCreateType] = useState<'course' | 'subject' | null>(null);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [actionTarget, setActionTarget] = useState<CatalogManagementTarget | null>(null);
  const [renameTarget, setRenameTarget] = useState<CatalogManagementTarget | null>(null);
  const [renameName, setRenameName] = useState('');
  const [moveTarget, setMoveTarget] = useState<CatalogManagementTarget | null>(null);
  const [moveCourses, setMoveCourses] = useState<CatalogCoursesResponse | null>(null);
  const [moveCourseId, setMoveCourseId] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<CatalogManagementTarget | null>(null);
  const [managementError, setManagementError] = useState('');
  const [managementLoading, setManagementLoading] = useState(false);
  const [managing, setManaging] = useState(false);
  const [actionError, setActionError] = useState('');
  const [materialEditorOpen, setMaterialEditorOpen] = useState(false);
  const [materialName, setMaterialName] = useState('');
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [removeCover, setRemoveCover] = useState(false);
  const [materialEditorError, setMaterialEditorError] = useState('');
  const [savingMaterial, setSavingMaterial] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const [materialDrag, setMaterialDrag] = useState<MaterialDragSession | null>(null);
  const [materialOverTrash, setMaterialOverTrash] = useState(false);
  const [deletingMaterialId, setDeletingMaterialId] = useState<string | null>(null);
  const materialDragTimerRef = useRef<number | null>(null);
  const materialDragRef = useRef<MaterialDragSession | null>(null);
  const suppressedMaterialOpenRef = useRef<string | null>(null);
  const materialTrashRef = useRef<HTMLDivElement>(null);
  const routeKey = route.kind === 'courses'
    ? route.kind
    : route.kind === 'course'
      ? `${route.kind}:${route.courseId}`
      : route.kind === 'subject'
        ? `${route.kind}:${route.courseId}:${route.subjectId}`
        : `${route.kind}:${route.courseId}:${route.subjectId}:${route.materialId}`;

  function clearMaterialDragTimer() {
    if (materialDragTimerRef.current !== null) {
      window.clearTimeout(materialDragTimerRef.current);
      materialDragTimerRef.current = null;
    }
  }

  function resetMaterialDrag() {
    clearMaterialDragTimer();
    materialDragRef.current = null;
    setMaterialDrag(null);
    setMaterialOverTrash(false);
  }

  useEffect(() => {
    let active = true;
    resetMaterialDrag();
    setLoading(true);
    setError('');
    setCourses(null);
    setCourseSubjects(null);
    setSubject(null);
    setMaterial(null);

    async function load() {
      try {
        if (route.kind === 'courses') {
          const response = await fetchCatalogCourses();
          if (active) setCourses(response);
        } else if (route.kind === 'course') {
          const response = await fetchCatalogCourseSubjects(route.courseId);
          if (active) setCourseSubjects(response);
        } else if (route.kind === 'subject') {
          const response = await fetchCatalogSubject(route.subjectId);
          if (active) setSubject(response);
        } else {
          const response = await fetchCatalogMaterial(route.materialId);
          if (active) setMaterial(response);
        }
      } catch (requestError) {
        if (!active) return;
        setError(requestError instanceof Error ? requestError.message : '资料加载失败。');
        onAuthExpired();
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => { active = false; };
  }, [route, routeKey, onAuthExpired, refreshKey]);

  useEffect(() => () => {
    clearMaterialDragTimer();
    materialDragRef.current = null;
  }, []);

  function isPointerOverMaterialTrash(x: number, y: number) {
    const bounds = materialTrashRef.current?.getBoundingClientRect();
    return Boolean(bounds && x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom);
  }

  function startMaterialLongPress(event: ReactPointerEvent<HTMLButtonElement>, target: CatalogMaterialSummary) {
    if (event.button !== 0 || !event.isPrimary || deletingMaterialId) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    const session: MaterialDragSession = {
      material: target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
    };
    materialDragRef.current = session;
    clearMaterialDragTimer();
    materialDragTimerRef.current = window.setTimeout(() => {
      const current = materialDragRef.current;
      if (!current || current.pointerId !== session.pointerId) {
        return;
      }
      current.dragging = true;
      setMaterialDrag({ ...current });
      navigator.vibrate?.(10);
    }, 420);
  }

  function moveMaterialLongPress(event: ReactPointerEvent<HTMLButtonElement>) {
    const current = materialDragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    const offsetX = event.clientX - current.startX;
    const offsetY = event.clientY - current.startY;
    if (!current.dragging) {
      if (Math.hypot(offsetX, offsetY) > 12) {
        clearMaterialDragTimer();
        materialDragRef.current = null;
      }
      return;
    }
    event.preventDefault();
    current.x = event.clientX;
    current.y = event.clientY;
    setMaterialDrag({ ...current });
    setMaterialOverTrash(isPointerOverMaterialTrash(current.x, current.y));
  }

  async function softDeleteMaterialFromGrid(target: CatalogMaterialSummary) {
    setDeletingMaterialId(target.id);
    setActionError('');
    try {
      await deleteHierarchy('material', target.id);
      setSubject((current) => current
        ? { ...current, materials: current.materials.filter((item) => item.id !== target.id) }
        : current);
      setStatusMessage('已移入回收站');
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : '删除失败。');
      onAuthExpired();
    } finally {
      setDeletingMaterialId(null);
    }
  }

  function finishMaterialLongPress(event: ReactPointerEvent<HTMLButtonElement>, cancelled = false) {
    const current = materialDragRef.current;
    if (!current || current.pointerId !== event.pointerId) {
      return;
    }
    clearMaterialDragTimer();
    materialDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!current.dragging) {
      return;
    }
    const droppedOnTrash = !cancelled && isPointerOverMaterialTrash(event.clientX, event.clientY);
    setMaterialDrag(null);
    setMaterialOverTrash(false);
    suppressedMaterialOpenRef.current = current.material.id;
    window.setTimeout(() => {
      if (suppressedMaterialOpenRef.current === current.material.id) {
        suppressedMaterialOpenRef.current = null;
      }
    }, 0);
    if (droppedOnTrash) {
      void softDeleteMaterialFromGrid(current.material);
    }
  }

  function openMaterialFromGrid(target: CatalogMaterialSummary) {
    if (suppressedMaterialOpenRef.current === target.id) {
      suppressedMaterialOpenRef.current = null;
      return;
    }
    if (route.kind === 'subject') {
      onNavigate({ kind: 'material', courseId: route.courseId, subjectId: route.subjectId, materialId: target.id });
    }
  }

  function openCreate(type: 'course' | 'subject') {
    setDraftName('');
    setCreateError('');
    setCreateType(type);
  }

  function closeCreate() {
    if (!creating) {
      setCreateType(null);
    }
  }

  function openActionMenu(target: CatalogManagementTarget) {
    setActionError('');
    setActionTarget(target);
  }

  function closeActionMenu() {
    if (!managing) {
      setActionTarget(null);
    }
  }

  function openRename(target: CatalogManagementTarget) {
    setActionTarget(null);
    setManagementError('');
    setRenameName(target.name);
    setRenameTarget(target);
  }

  function closeRename() {
    if (!managing) {
      setRenameTarget(null);
    }
  }

  function openMove(target: CatalogManagementTarget) {
    setActionTarget(null);
    setManagementError('');
    setMoveCourses(null);
    setMoveCourseId('');
    setMoveTarget(target);
    setManagementLoading(true);
    void fetchCatalogCourses().then((response) => {
      const destinations = response.courses.filter((course) => course.id !== target.courseId);
      setMoveCourses(response);
      setMoveCourseId(destinations[0]?.id ?? '');
    }).catch((requestError) => {
      setManagementError(requestError instanceof Error ? requestError.message : '课程加载失败。');
      onAuthExpired();
    }).finally(() => {
      setManagementLoading(false);
    });
  }

  function closeMove() {
    if (!managing) {
      setMoveTarget(null);
    }
  }

  function openDelete(target: CatalogManagementTarget) {
    setActionTarget(null);
    setManagementError('');
    setDeleteTarget(target);
  }

  function closeDelete() {
    if (!managing) {
      setDeleteTarget(null);
    }
  }

  async function submitRename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!renameTarget) return;
    const name = renameName.trim();
    if (!name) {
      setManagementError('请输入名称。');
      return;
    }
    setManaging(true);
    setManagementError('');
    try {
      if (renameTarget.kind === 'course') {
        await renameCatalogCourse(renameTarget.id, name);
        setStatusMessage('课程已改名');
      } else {
        await renameCatalogSubject(renameTarget.id, name);
        setStatusMessage('科目已改名');
      }
      setRenameTarget(null);
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setManagementError(requestError instanceof Error ? requestError.message : '改名失败。');
      onAuthExpired();
    } finally {
      setManaging(false);
    }
  }

  async function submitMove(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!moveTarget || moveTarget.kind !== 'subject' || !moveCourseId) return;
    setManaging(true);
    setManagementError('');
    try {
      await moveCatalogSubject(moveTarget.id, moveCourseId);
      setMoveTarget(null);
      setStatusMessage('科目已移动');
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setManagementError(requestError instanceof Error ? requestError.message : '移动失败。');
      onAuthExpired();
    } finally {
      setManaging(false);
    }
  }

  async function submitDelete() {
    if (!deleteTarget) return;
    setManaging(true);
    setManagementError('');
    try {
      if (deleteTarget.kind === 'course') {
        await deleteCatalogCourse(deleteTarget.id);
        setStatusMessage('课程已删除');
      } else {
        await deleteCatalogSubject(deleteTarget.id);
        setStatusMessage('科目已删除');
      }
      setDeleteTarget(null);
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setManagementError(requestError instanceof Error ? requestError.message : '删除失败。');
      onAuthExpired();
    } finally {
      setManaging(false);
    }
  }

  async function reorderCatalogItem(target: CatalogManagementTarget, direction: 'up' | 'down') {
    setActionTarget(null);
    setActionError('');
    setManaging(true);
    try {
      if (target.kind === 'course') {
        await reorderCatalogCourse(target.id, direction);
        setStatusMessage('课程顺序已更新');
      } else {
        await reorderCatalogSubject(target.id, direction);
        setStatusMessage('科目顺序已更新');
      }
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setActionError(requestError instanceof Error ? requestError.message : '排序失败。');
      onAuthExpired();
    } finally {
      setManaging(false);
    }
  }

  function openMaterialEditor() {
    if (!material) return;
    setMaterialName(material.material.name);
    setCoverFile(null);
    setRemoveCover(false);
    setMaterialEditorError('');
    setMaterialEditorOpen(true);
  }

  function closeMaterialEditor() {
    if (!savingMaterial) {
      setMaterialEditorOpen(false);
    }
  }

  function selectCover(file: File | undefined) {
    if (!file) return;
    const supportedTypes = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
    if (!supportedTypes.includes(file.type) || file.size > 5 * 1024 * 1024) {
      setMaterialEditorError('封面仅支持 5MB 以内的 PNG、JPEG、GIF 或 WebP。');
      return;
    }
    setCoverFile(file);
    setRemoveCover(false);
    setMaterialEditorError('');
  }

  async function submitMaterialEditor(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!material) return;
    const name = materialName.trim();
    if (!name) {
      setMaterialEditorError('请输入资料名称。');
      return;
    }
    setSavingMaterial(true);
    setMaterialEditorError('');
    try {
      if (name !== material.material.name) {
        await updateCatalogMaterialName(material.material.id, name);
      }
      if (coverFile) {
        await uploadCatalogMaterialCover(material.material.id, coverFile);
      } else if (removeCover && material.material.cover) {
        await removeCatalogMaterialCover(material.material.id);
      }
      setMaterialEditorOpen(false);
      setStatusMessage('资料已更新');
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setMaterialEditorError(requestError instanceof Error ? requestError.message : '资料更新失败。');
      onAuthExpired();
    } finally {
      setSavingMaterial(false);
    }
  }

  async function reorderMaterialCard(cardId: string, direction: 'up' | 'down') {
    if (!material) {
      throw new Error('资料不存在。');
    }
    try {
      const nextHierarchy = await reorderHierarchy('card', cardId, direction);
      const nextMaterial = nextHierarchy.materials.find((item) => item.id === material.material.id);
      if (!nextMaterial) {
        throw new Error('资料已不存在。');
      }
      setMaterial((current) => current && current.material.id === nextMaterial.id
        ? { material: { ...current.material, chapters: nextMaterial.chapters } }
        : current);
      setStatusMessage('闪卡顺序已更新');
    } catch (requestError) {
      onAuthExpired();
      throw requestError instanceof Error ? requestError : new Error('排序失败。');
    }
  }

  function handleMaterialCardSaved(result: ReviewCardContentUpdateResponse) {
    setMaterial((current) => current
      ? {
          material: {
            ...current.material,
            chapters: current.material.chapters.map((chapter) => ({
              ...chapter,
              sections: chapter.sections.map((section) => ({
                ...section,
                cards: section.cards.map((card) => card.id === result.card.id ? { ...card, title: result.card.title } : card),
              })),
            })),
          },
        }
      : current);
    setStatusMessage(result.invalidatedHighlightCount > 0
      ? `已保存，清除 ${result.invalidatedHighlightCount} 个重点`
      : '已保存');
  }

  async function submitCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = draftName.trim();
    if (!name || !createType) {
      setCreateError('请输入名称。');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      if (createType === 'course') {
        await createCatalogCourse(name);
        setStatusMessage('已添加课程');
      } else if (route.kind === 'course') {
        await createCatalogSubject(route.courseId, name);
        setStatusMessage('已添加科目');
      } else {
        return;
      }
      setCreateType(null);
      setRefreshKey((current) => current + 1);
    } catch (requestError) {
      setCreateError(requestError instanceof Error ? requestError.message : '添加失败。');
      onAuthExpired();
    } finally {
      setCreating(false);
    }
  }

  const title = route.kind === 'courses'
    ? '资料'
    : route.kind === 'course'
      ? courseSubjects?.course.name ?? '课程'
      : route.kind === 'subject'
        ? subject?.subject.name ?? '科目'
        : material?.material.name ?? '资料';
  const previousRoute: MaterialsRoute | null = route.kind === 'course'
    ? { kind: 'courses' }
    : route.kind === 'subject'
      ? { kind: 'course', courseId: route.courseId }
      : route.kind === 'material'
        ? { kind: 'subject', courseId: route.courseId, subjectId: route.subjectId }
        : null;

  return (
    <section className="catalog-panel" aria-labelledby="materials-title">
      <header className="page-header">
        <div>
          {previousRoute ? <button className="catalog-back" type="button" onClick={() => onNavigate(previousRoute)}>返回</button> : <p className="eyebrow">知识闪卡</p>}
          <h1 id="materials-title">{title}</h1>
        </div>
        <div className="header-actions">
          {route.kind === 'courses' || route.kind === 'course' ? (
            <button
              className="catalog-add"
              type="button"
              onClick={() => openCreate(route.kind === 'courses' ? 'course' : 'subject')}
              disabled={loading || creating}
              aria-label={route.kind === 'courses' ? '新增课程' : '新增科目'}
              title={route.kind === 'courses' ? '新增课程' : '新增科目'}
            >
              <Plus size={20} aria-hidden="true" />
            </button>
          ) : null}
          {route.kind === 'subject' ? (
            <button className="button-secondary" type="button" onClick={() => onNavigate({ kind: 'question-banks', courseId: route.courseId, subjectId: route.subjectId })}>题库</button>
          ) : null}
          <button className="icon-button" type="button" onClick={onOpenManage} aria-label="管理资料" title="管理资料">
            <Pencil size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="feedback" aria-live="polite">
        {loading ? <p className="feedback-muted">加载中</p> : null}
        {statusMessage ? <p className="feedback-success">{statusMessage}</p> : null}
        {actionError ? <p className="feedback-error" role="alert">{actionError}</p> : null}
        {error ? <p className="feedback-error">{error}</p> : null}
      </div>

      {!loading && error ? (
        <button className="button-secondary" type="button" onClick={() => onNavigate(previousRoute ?? { kind: 'courses' })}>返回</button>
      ) : null}

      {!loading && !error && route.kind === 'courses' ? (
        courses?.courses.length ? (
          <div className="catalog-list" aria-label="课程列表">
            {courses.courses.map((course, index) => (
              <div className="catalog-list-entry" key={course.id}>
                <button className="catalog-list-row" type="button" onClick={() => onNavigate({ kind: 'course', courseId: course.id })}>
                  <span>{course.name}</span>
                  <small>{course.subjectCount} 个科目</small>
                  <b aria-hidden="true">›</b>
                </button>
                <button
                  className="catalog-row-more"
                  type="button"
                  onClick={() => openActionMenu({ kind: 'course', id: course.id, name: course.name, index, count: courses.courses.length })}
                  disabled={managing}
                  aria-label={`${course.name}更多操作`}
                  title="更多操作"
                >
                  <MoreHorizontal size={20} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : <p className="empty-state">还没有课程</p>
      ) : null}

      {!loading && !error && route.kind === 'course' ? (
        courseSubjects?.subjects.length ? (
          <div className="catalog-list" aria-label="科目列表">
            {courseSubjects.subjects.map((item, index) => (
              <div className="catalog-list-entry" key={item.id}>
                <button className="catalog-list-row" type="button" onClick={() => onNavigate({ kind: 'subject', courseId: route.courseId, subjectId: item.id })}>
                  <span>{item.name}</span>
                  <small>{item.materialCount} 份资料</small>
                  <b aria-hidden="true">›</b>
                </button>
                <button
                  className="catalog-row-more"
                  type="button"
                  onClick={() => openActionMenu({ kind: 'subject', id: item.id, name: item.name, index, count: courseSubjects.subjects.length, courseId: route.courseId })}
                  disabled={managing}
                  aria-label={`${item.name}更多操作`}
                  title="更多操作"
                >
                  <MoreHorizontal size={20} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        ) : <p className="empty-state">还没有科目</p>
      ) : null}

      {!loading && !error && route.kind === 'subject' ? (
        subject?.materials.length ? (
          <div className="catalog-material-grid" aria-label="资料列表">
            {subject.materials.map((material) => (
              <button
                className={`catalog-material-card${materialDrag?.material.id === material.id ? ' catalog-material-card-dragging' : ''}`}
                type="button"
                key={material.id}
                onClick={() => openMaterialFromGrid(material)}
                onPointerDown={(event) => startMaterialLongPress(event, material)}
                onPointerMove={moveMaterialLongPress}
                onPointerUp={finishMaterialLongPress}
                onPointerCancel={(event) => finishMaterialLongPress(event, true)}
                onContextMenu={(event) => {
                  if (materialDragRef.current?.material.id === material.id) {
                    event.preventDefault();
                  }
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Delete' && !deletingMaterialId) {
                    event.preventDefault();
                    void softDeleteMaterialFromGrid(material);
                  }
                }}
                disabled={Boolean(deletingMaterialId)}
                aria-keyshortcuts="Delete"
                aria-label={`${material.name}，${material.cardCount} 张闪卡。长按拖到顶部回收站，或按 Delete 键移入回收站`}
              >
                <div className="catalog-cover" aria-hidden="true">
                  {material.cover ? <img src={`${reviewResourcePath}/${encodeURIComponent(material.cover.thumbnail.id)}`} alt="" /> : null}
                </div>
                <div className="catalog-material-copy">
                  <strong>{material.name}</strong>
                  <small>{material.cardCount} 张闪卡</small>
                </div>
              </button>
            ))}
          </div>
        ) : <p className="empty-state">还没有资料</p>
      ) : null}

      {materialDrag ? (
        <div className="catalog-material-drag-layer">
          <div
            className={`catalog-material-trash${materialOverTrash ? ' catalog-material-trash-active' : ''}`}
            ref={materialTrashRef}
            role="img"
            aria-label={materialOverTrash ? '回收站，松开以移入回收站' : '回收站'}
          >
            <Trash2 size={28} aria-hidden="true" />
          </div>
          <div className="catalog-material-drag-preview" aria-hidden="true" style={{ transform: `translate3d(${materialDrag.x}px, ${materialDrag.y}px, 0) translate3d(-50%, -50%, 0)` }}>
            <div className="catalog-material-drag-copy">
              <strong>{materialDrag.material.name}</strong>
              <small>{materialDrag.material.cardCount} 张闪卡</small>
            </div>
          </div>
        </div>
      ) : null}

      {!loading && !error && route.kind === 'material' && material ? (
        <CatalogMaterialDetail
          response={material}
          onEdit={openMaterialEditor}
          onReorderCard={reorderMaterialCard}
          onCardSaved={handleMaterialCardSaved}
        />
      ) : null}

      {actionTarget ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet catalog-actions-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-actions-title">
            <h2 id="catalog-actions-title">{actionTarget.kind === 'course' ? '课程操作' : '科目操作'}</h2>
            <div className="catalog-action-list">
              <button className="catalog-action-item" type="button" onClick={() => openRename(actionTarget)} disabled={managing}>
                <Pencil size={18} aria-hidden="true" />
                改名
              </button>
              {actionTarget.kind === 'subject' ? (
                <button className="catalog-action-item" type="button" onClick={() => openMove(actionTarget)} disabled={managing}>
                  <MoveRight size={18} aria-hidden="true" />
                  移动
                </button>
              ) : null}
              <button className="catalog-action-item" type="button" onClick={() => { void reorderCatalogItem(actionTarget, 'up'); }} disabled={managing || actionTarget.index === 0}>
                <ArrowUp size={18} aria-hidden="true" />
                上移
              </button>
              <button className="catalog-action-item" type="button" onClick={() => { void reorderCatalogItem(actionTarget, 'down'); }} disabled={managing || actionTarget.index + 1 >= actionTarget.count}>
                <ArrowDown size={18} aria-hidden="true" />
                下移
              </button>
              <button className="catalog-action-item danger-action" type="button" onClick={() => openDelete(actionTarget)} disabled={managing}>
                <Trash2 size={18} aria-hidden="true" />
                删除
              </button>
            </div>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={closeActionMenu} disabled={managing}>取消</button>
            </div>
          </section>
        </div>
      ) : null}

      {renameTarget ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-rename-title">
            <form onSubmit={(event) => { void submitRename(event); }}>
              <h2 id="catalog-rename-title">改名{renameTarget.kind === 'course' ? '课程' : '科目'}</h2>
              <label className="field-column">
                <span>{renameTarget.kind === 'course' ? '课程名称' : '科目名称'}</span>
                <input autoFocus value={renameName} maxLength={100} onChange={(event) => setRenameName(event.target.value)} disabled={managing} required />
              </label>
              {managementError ? <p className="feedback-error" role="alert">{managementError}</p> : null}
              <div className="action-row">
                <button className="button-secondary" type="button" onClick={closeRename} disabled={managing}>取消</button>
                <button className="button-primary" type="submit" disabled={managing || !renameName.trim()}>应用</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {moveTarget ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-move-title">
            <form onSubmit={(event) => { void submitMove(event); }}>
              <h2 id="catalog-move-title">移动科目</h2>
              <label className="field-column">
                <span>移动到课程</span>
                <select value={moveCourseId} onChange={(event) => setMoveCourseId(event.target.value)} disabled={managementLoading || managing}>
                  <option value="">{managementLoading ? '加载中' : '请选择课程'}</option>
                  {moveCourses?.courses.filter((course) => course.id !== moveTarget.courseId).map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}
                </select>
              </label>
              {!managementLoading && moveCourses?.courses.every((course) => course.id === moveTarget.courseId) ? <p className="feedback-muted">还没有其他课程</p> : null}
              {managementError ? <p className="feedback-error" role="alert">{managementError}</p> : null}
              <div className="action-row">
                <button className="button-secondary" type="button" onClick={closeMove} disabled={managing}>取消</button>
                <button className="button-primary" type="submit" disabled={managementLoading || managing || !moveCourseId}>应用</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {deleteTarget ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-delete-title">
            <h2 id="catalog-delete-title">删除{deleteTarget.kind === 'course' ? '课程' : '科目'}</h2>
            <p className="sheet-message">确定删除“{deleteTarget.name}”吗？</p>
            <p className="sheet-message">{deleteTarget.kind === 'course' ? '仅可删除不含科目的课程。' : '仅可删除不含资料的科目。'}</p>
            {managementError ? <p className="feedback-error" role="alert">{managementError}</p> : null}
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={closeDelete} disabled={managing}>取消</button>
              <button className="button-danger" type="button" onClick={() => { void submitDelete(); }} disabled={managing}>删除</button>
            </div>
          </section>
        </div>
      ) : null}

      {createType ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-create-title">
            <form onSubmit={(event) => { void submitCreate(event); }}>
              <h2 id="catalog-create-title">新增{createType === 'course' ? '课程' : '科目'}</h2>
              <label className="field-column">
                <span>{createType === 'course' ? '课程名称' : '科目名称'}</span>
                <input
                  autoFocus
                  value={draftName}
                  maxLength={100}
                  onChange={(event) => setDraftName(event.target.value)}
                  disabled={creating}
                  required
                />
              </label>
              {createError ? <p className="feedback-error" role="alert">{createError}</p> : null}
              <div className="action-row">
                <button className="button-secondary" type="button" onClick={closeCreate} disabled={creating}>取消</button>
                <button className="button-primary" type="submit" disabled={creating || !draftName.trim()}>添加</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}

      {materialEditorOpen && material ? (
        <div className="sheet-backdrop catalog-create-backdrop" role="presentation">
          <section className="sheet catalog-create-sheet catalog-material-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="catalog-material-editor-title">
            <form onSubmit={(event) => { void submitMaterialEditor(event); }}>
              <h2 id="catalog-material-editor-title">编辑资料</h2>
              <label className="field-column">
                <span>资料名称</span>
                <input
                  autoFocus
                  value={materialName}
                  maxLength={255}
                  onChange={(event) => setMaterialName(event.target.value)}
                  disabled={savingMaterial}
                  required
                />
              </label>
              <div className="catalog-cover-field">
                <span>封面</span>
                <div className="catalog-cover-field-row">
                  <div className="catalog-cover-preview" aria-hidden="true">
                    {!coverFile && !removeCover && material.material.cover ? <img src={`${reviewResourcePath}/${encodeURIComponent(material.material.cover.thumbnail.id)}`} alt="" /> : null}
                  </div>
                  <label className="button-secondary catalog-cover-file-button">
                    <span>选择图片</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/gif,image/webp"
                      onChange={(event) => selectCover(event.target.files?.[0])}
                      disabled={savingMaterial}
                    />
                  </label>
                  {material.material.cover && !coverFile && !removeCover ? (
                    <button className="catalog-cover-remove" type="button" onClick={() => setRemoveCover(true)} disabled={savingMaterial}>移除封面</button>
                  ) : null}
                </div>
                {coverFile ? <small className="file-name">{coverFile.name}</small> : null}
                {removeCover ? <small className="file-name">保存后移除封面</small> : null}
              </div>
              {materialEditorError ? <p className="feedback-error" role="alert">{materialEditorError}</p> : null}
              <div className="action-row">
                <button className="button-secondary" type="button" onClick={closeMaterialEditor} disabled={savingMaterial}>取消</button>
                <button className="button-primary" type="submit" disabled={savingMaterial || !materialName.trim()}>应用</button>
              </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function QuestionBankPanel({
  route,
  onNavigate,
  onOpenImport,
  onAuthExpired,
}: {
  route: Extract<MaterialsRoute, { kind: 'question-banks' }>;
  onNavigate: (next: MaterialsRoute) => void;
  onOpenImport: () => void;
  onAuthExpired: () => void;
}) {
  const [directory, setDirectory] = useState<QuestionBankDirectoryResponse | null>(null);
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof fetchQuestionBankTrash>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [draftKind, setDraftKind] = useState<QuestionBankKind>('chapter');
  const [draftName, setDraftName] = useState('');
  const [draftChapter, setDraftChapter] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ type: 'bank' | 'chapter'; id: string; name: string } | null>(null);
  const [renameName, setRenameName] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [moveChapterId, setMoveChapterId] = useState<string | null>(null);
  const [moveTargetBankId, setMoveTargetBankId] = useState('');
  const [selectedBankId, setSelectedBankId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');

  async function load() {
    setLoading(true); setError('');
    try { const [nextDirectory, nextTrash] = await Promise.all([fetchQuestionBankDirectory(route.subjectId), fetchQuestionBankTrash(route.subjectId)]); setDirectory(nextDirectory); setTrash(nextTrash); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '题库加载失败。'); onAuthExpired(); }
    finally { setLoading(false); }
  }
  useEffect(() => { void load(); }, [route.subjectId]);

  async function runMutation(action: () => Promise<QuestionBankDirectoryResponse>, success: string) {
    setBusy(true); setError('');
    try { setDirectory(await action()); setTrash(await fetchQuestionBankTrash(route.subjectId)); setStatus(success); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '操作失败。'); onAuthExpired(); }
    finally { setBusy(false); }
  }
  async function submitBank(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const name = draftName.trim(); if (!name) return;
    await runMutation(() => createQuestionBank(route.subjectId, draftKind, name), '题库已新增'); setDraftName('');
  }
  const labels: Record<QuestionBankKind, string> = { chapter: '章节题', official: '真题', mock: '模拟题' };
  return <section className="catalog-panel" aria-labelledby="question-bank-title">
    <header className="page-header"><div><button className="catalog-back" type="button" onClick={() => onNavigate({ kind: 'subject', courseId: route.courseId, subjectId: route.subjectId })}>返回</button><h1 id="question-bank-title">{directory?.subject.name ?? '题库'}</h1></div><div className="header-actions"><button className="button-secondary" type="button" onClick={() => onNavigate({ kind: 'subject', courseId: route.courseId, subjectId: route.subjectId })}>资料</button><button className="button-primary" type="button" onClick={onOpenImport}>导入</button></div></header>
    <div className="feedback" aria-live="polite">{loading ? <p className="feedback-muted">加载中</p> : null}{status ? <p className="feedback-success">{status}</p> : null}{error ? <p className="feedback-error" role="alert">{error}</p> : null}</div>
    <form className="question-bank-create" onSubmit={(event) => { void submitBank(event); }}><select value={draftKind} onChange={(event) => setDraftKind(event.target.value as QuestionBankKind)} disabled={busy}><option value="chapter">章节题</option><option value="official">真题</option><option value="mock">模拟题</option></select><input value={draftName} onChange={(event) => setDraftName(event.target.value)} placeholder="题库名称" maxLength={255} disabled={busy} /><button className="button-primary" type="submit" disabled={busy || !draftName.trim()}>新增</button></form>
    {!loading && directory ? <label className="field-column question-bank-selector"><span>打开题库</span><select value={selectedBankId ?? ''} onChange={(event) => setSelectedBankId(event.target.value || null)}><option value="">请选择题库</option>{(['chapter', 'official', 'mock'] as const).flatMap((kind) => directory.banks[kind].map((bank) => <option key={bank.id} value={bank.id}>{labels[kind]} · {bank.name}</option>))}</select></label> : null}
    {!loading && directory ? <div className="question-bank-groups">{(['chapter', 'official', 'mock'] as const).map((kind) => <section className="question-bank-group" key={kind} aria-labelledby={`question-bank-${kind}`}><div className="section-heading"><h2 id={`question-bank-${kind}`}>{labels[kind]}</h2><span>{directory.banks[kind].length}</span></div>{directory.banks[kind].length ? <ul className="catalog-list">{directory.banks[kind].map((bank, index, list) => <li className="question-bank-row" key={bank.id}><div className="question-bank-row-main"><strong>{bank.name}</strong><small>{bank.questionCount} 道题 · {bank.chapterCount} 个章节</small>{kind === 'chapter' && bank.chapters.length ? <ul className="question-chapter-list">{bank.chapters.map((chapter, chapterIndex) => <li key={chapter.id}><span>{chapter.title}</span><small>{chapter.questionCount} 道题</small><button type="button" onClick={() => { setRenameTarget({ type: 'chapter', id: chapter.id, name: chapter.title }); setRenameName(chapter.title); }} disabled={busy}>改名</button><button type="button" onClick={() => { setMoveChapterId(chapter.id); setMoveTargetBankId(bank.id); }} disabled={busy || directory.banks.chapter.length < 2}>移动</button><button type="button" onClick={() => void runMutation(() => reorderQuestionChapter(chapter.id, 'up'), '章节顺序已更新')} disabled={busy || chapterIndex === 0}>上移</button><button type="button" onClick={() => void runMutation(() => reorderQuestionChapter(chapter.id, 'down'), '章节顺序已更新')} disabled={busy || chapterIndex + 1 >= bank.chapters.length}>下移</button><button type="button" onClick={() => void runMutation(() => deleteQuestionChapter(chapter.id), '章节已移入回收站')} disabled={busy}>删除</button></li>)}</ul> : null}</div><div className="question-bank-actions"><button type="button" onClick={() => { setRenameTarget({ type: 'bank', id: bank.id, name: bank.name }); setRenameName(bank.name); }} disabled={busy}>改名</button><button type="button" onClick={() => void runMutation(() => reorderQuestionBank(bank.id, 'up'), '题库顺序已更新')} disabled={busy || index === 0}>上移</button><button type="button" onClick={() => void runMutation(() => reorderQuestionBank(bank.id, 'down'), '题库顺序已更新')} disabled={busy || index + 1 >= list.length}>下移</button><button className="danger-action" type="button" onClick={() => setDeleteTarget({ id: bank.id, name: bank.name })} disabled={busy}>删除</button>{kind === 'chapter' ? <button type="button" onClick={() => setDraftChapter(bank.id)} disabled={busy}>新增章节</button> : null}</div></li>)}</ul> : <p className="empty-state">暂无题库</p>}</section>)}</div> : null}
    {!loading && directory && selectedBankId ? <QuestionWorkspace bankId={selectedBankId} directory={directory} onClose={() => setSelectedBankId(null)} /> : null}
    {!loading && trash?.items.length ? <section className="question-bank-trash" aria-labelledby="question-bank-trash-title"><div className="section-heading"><h2 id="question-bank-trash-title">最近删除</h2><span>{trash.items.length}</span></div><ul className="catalog-list">{trash.items.map((item) => <li className="question-bank-row" key={`${item.entityType}:${item.entityId}`}><div><strong>{item.title}</strong><small>{item.entityType === 'question_bank' ? '题库' : '章节'}</small></div><button type="button" onClick={() => void runMutation(() => item.entityType === 'question_bank' ? restoreQuestionBank(item.entityId) : restoreQuestionChapter(item.entityId), '已恢复')} disabled={busy}>恢复</button></li>)}</ul></section> : null}
    {draftChapter ? <form className="sheet-inline-form" onSubmit={(event) => { event.preventDefault(); const input = (event.currentTarget.elements.namedItem('title') as HTMLInputElement).value.trim(); if (input) void runMutation(() => createQuestionChapter(draftChapter, input), '章节已新增').then(() => setDraftChapter(null)); }}><input name="title" placeholder="章节名称" autoFocus /><button className="button-secondary" type="button" onClick={() => setDraftChapter(null)}>取消</button><button className="button-primary" type="submit">新增</button></form> : null}
    {renameTarget ? <div className="sheet-backdrop" role="presentation"><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="question-bank-rename-title"><form onSubmit={(event) => { event.preventDefault(); const target = renameTarget; const name = renameName.trim(); if (name) void runMutation(() => target.type === 'bank' ? renameQuestionBank(target.id, name) : renameQuestionChapter(target.id, name), '已更新').then(() => setRenameTarget(null)); }}><h2 id="question-bank-rename-title">改名</h2><label className="field-column"><span>名称</span><input autoFocus value={renameName} maxLength={255} onChange={(event) => setRenameName(event.target.value)} /></label><div className="action-row"><button className="button-secondary" type="button" onClick={() => setRenameTarget(null)} disabled={busy}>取消</button><button className="button-primary" type="submit" disabled={busy || !renameName.trim()}>应用</button></div></form></section></div> : null}
    {deleteTarget ? <div className="sheet-backdrop" role="presentation"><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="question-bank-delete-title"><h2 id="question-bank-delete-title">删除题库</h2><p className="sheet-message">确定删除“{deleteTarget.name}”吗？</p><div className="action-row"><button className="button-secondary" type="button" onClick={() => setDeleteTarget(null)} disabled={busy}>取消</button><button className="button-danger" type="button" onClick={() => void runMutation(() => deleteQuestionBank(deleteTarget.id), '题库已移入回收站').then(() => setDeleteTarget(null))} disabled={busy}>删除</button></div></section></div> : null}
    {moveChapterId ? <div className="sheet-backdrop" role="presentation"><section className="sheet" role="dialog" aria-modal="true" aria-labelledby="question-chapter-move-title"><h2 id="question-chapter-move-title">移动章节</h2><label className="field-column"><span>目标题库</span><select value={moveTargetBankId} onChange={(event) => setMoveTargetBankId(event.target.value)}>{directory?.banks.chapter.map((bank) => <option key={bank.id} value={bank.id}>{bank.name}</option>)}</select></label><div className="action-row"><button className="button-secondary" type="button" onClick={() => setMoveChapterId(null)} disabled={busy}>取消</button><button className="button-primary" type="button" onClick={() => void runMutation(() => moveQuestionChapter(moveChapterId, moveTargetBankId), '章节已移动').then(() => setMoveChapterId(null))} disabled={busy}>应用</button></div></section></div> : null}
  </section>;
}

function emptyQuestionContent(): ReviewContentNode[] {
  return [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }];
}

function QuestionContentEditor({
  label,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  value: ReviewContentNode[] | null;
  onChange: (value: ReviewContentNode[] | null) => void;
  optional?: boolean;
}) {
  const nodes = value ?? [];
  const onNodeChange = (path: string, next: ReviewContentNode) => {
    onChange(updateContentNode(nodes, path, next));
  };
  const noUpload = async () => { throw new Error('题目暂不支持图片。'); };
  return (
    <fieldset className="question-content-editor">
      <legend>{label}</legend>
      {nodes.length ? nodes.map((node, index) => (
        <div className="question-content-block" key={String(index)}>
          <VisualContentNode node={node} nodePath={String(index)} onNodeChange={onNodeChange} onUpload={noUpload} />
          <button className="editor-remove" type="button" onClick={() => onChange(nodes.filter((_, itemIndex) => itemIndex !== index))} aria-label={`删除${label}内容`}>删除</button>
        </div>
      )) : <p className="feedback-muted">暂无内容</p>}
      <div className="editor-add-tools">
        <button className="button-secondary" type="button" onClick={() => onChange([...nodes, { type: 'paragraph', children: [{ type: 'text', value: '' }] }])}>加段落</button>
        <button className="button-secondary" type="button" onClick={() => onChange([...nodes, { type: 'math', value: '' }])}>加公式</button>
        {optional && nodes.length ? <button className="button-secondary" type="button" onClick={() => onChange(null)}>清空</button> : null}
      </div>
    </fieldset>
  );
}

function QuestionEditor({
  bank,
  banks,
  chapters,
  question,
  onCancel,
  onSave,
}: {
  bank: QuestionBankDirectoryItem;
  banks: QuestionBankDirectoryItem[];
  chapters: QuestionBankQuestionsResponse['chapters'];
  question: QuestionQuestion | null;
  onCancel: () => void;
  onSave: (request: QuestionCreateRequest | QuestionUpdateRequest, questionId?: string) => Promise<void>;
}) {
  const [questionBankId, setQuestionBankId] = useState(question?.questionBankId ?? bank.id);
  const [questionChapterId, setQuestionChapterId] = useState<string | null>(question?.questionChapterId ?? (bank.kind === 'chapter' ? chapters[0]?.id ?? null : null));
  const [stem, setStem] = useState<ReviewContentNode[]>(() => question?.stem ?? emptyQuestionContent());
  const [type, setType] = useState<QuestionType>(question?.type ?? 'single');
  const [options, setOptions] = useState(question?.options ?? [
    { key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }] },
    { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '' }] }] },
  ]);
  const [answer, setAnswer] = useState<string[]>(question?.answer ?? ['A']);
  const [analysis, setAnalysis] = useState<ReviewContentNode[] | null>(question?.analysis ?? null);
  const [knowledgePoints, setKnowledgePoints] = useState(question?.knowledgePoints.join('、') ?? '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const selectedBank = banks.find((item) => item.id === questionBankId) ?? bank;

  useEffect(() => {
    if (selectedBank.kind === 'chapter') {
      setQuestionChapterId((current) => selectedBank.chapters.some((chapter) => chapter.id === current) ? current : selectedBank.chapters[0]?.id ?? null);
    } else {
      setQuestionChapterId(null);
    }
  }, [questionBankId, selectedBank.kind, selectedBank.chapters]);

  useEffect(() => {
    if (type === 'true_false') {
      setOptions([
        { key: 'A', content: [{ type: 'paragraph', children: [{ type: 'text', value: '对' }] }] },
        { key: 'B', content: [{ type: 'paragraph', children: [{ type: 'text', value: '错' }] }] },
      ]);
      setAnswer((current) => [current[0] === 'B' ? 'B' : 'A']);
    } else if (type === 'single') {
      setAnswer((current) => [current[0] ?? 'A']);
    }
  }, [type]);

  async function save() {
    setSaving(true); setError('');
    try {
      const request = { questionBankId, questionChapterId: selectedBank.kind === 'chapter' ? questionChapterId : null, stem, type, options, answer, analysis, knowledgePoints: knowledgePoints.split(/[、,，]/).map((item) => item.trim()).filter(Boolean) };
      await onSave(request, question?.id);
      onCancel();
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '题目保存失败。');
    } finally { setSaving(false); }
  }

  function toggleAnswer(key: string) {
    setAnswer((current) => type === 'multiple' ? (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]) : [key]);
  }

  return (
    <div className="sheet-backdrop" role="presentation">
      <section className="sheet question-editor-sheet" role="dialog" aria-modal="true" aria-labelledby="question-editor-title">
        <header className="sheet-header"><h2 id="question-editor-title">{question ? '编辑题目' : '新增题目'}</h2></header>
        <div className="question-editor-scroll">
          <label className="field-column"><span>归属题库</span><select value={questionBankId} onChange={(event) => setQuestionBankId(event.target.value)}>{banks.map((item) => <option key={item.id} value={item.id}>{item.kind === 'chapter' ? '章节题' : item.kind === 'official' ? '真题' : '模拟题'} · {item.name}</option>)}</select></label>
          {selectedBank.kind === 'chapter' ? <label className="field-column"><span>章节</span><select value={questionChapterId ?? ''} onChange={(event) => setQuestionChapterId(event.target.value || null)}><option value="">请选择章节</option>{selectedBank.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}</select></label> : null}
          <QuestionContentEditor label="题干" value={stem} onChange={(next) => setStem(next ?? [])} />
          <label className="field-column"><span>题型</span><select value={type} onChange={(event) => setType(event.target.value as QuestionType)}><option value="single">单选题</option><option value="multiple">多选题</option><option value="true_false">判断题</option></select></label>
          <fieldset className="question-options-editor"><legend>选项与答案</legend>{options.map((option, index) => <div className="question-option-editor" key={option.key}><div className="question-option-heading"><strong>{option.key}</strong><label><input type={type === 'multiple' ? 'checkbox' : 'radio'} name="question-answer" checked={answer.includes(option.key)} onChange={() => toggleAnswer(option.key)} disabled={type === 'true_false'} />正确答案</label>{type !== 'true_false' && options.length > 2 ? <button className="editor-remove" type="button" onClick={() => { setOptions((current) => current.filter((_, itemIndex) => itemIndex !== index).map((item, itemIndex) => ({ ...item, key: String.fromCharCode(65 + itemIndex) }))); setAnswer((current) => current.filter((item) => item !== option.key).map((item) => item > option.key ? String.fromCharCode(item.charCodeAt(0) - 1) : item)); }}>删除选项</button> : null}</div><QuestionContentEditor label={`选项${option.key}`} value={option.content} onChange={(next) => setOptions((current) => current.map((item) => item.key === option.key ? { ...item, content: next ?? [] } : item))} /></div>)}{type !== 'true_false' && options.length < 6 ? <button className="button-secondary" type="button" onClick={() => setOptions((current) => [...current, { key: String.fromCharCode(65 + current.length), content: emptyQuestionContent() }])}>增加选项</button> : null}</fieldset>
          <QuestionContentEditor label="解析" value={analysis} optional onChange={setAnalysis} />
          <label className="field-column"><span>知识点</span><input value={knowledgePoints} onChange={(event) => setKnowledgePoints(event.target.value)} placeholder="多个知识点用顿号分隔" /></label>
          {error ? <p className="feedback-error" role="alert">{error}</p> : null}
        </div>
        <footer className="action-row"><button className="button-secondary" type="button" onClick={onCancel} disabled={saving}>取消</button><button className="button-primary" type="button" onClick={() => { void save(); }} disabled={saving}>{saving ? '保存中' : '应用'}</button></footer>
      </section>
    </div>
  );
}

function QuestionWorkspace({
  bankId,
  directory,
  onClose,
}: {
  bankId: string;
  directory: QuestionBankDirectoryResponse;
  onClose: () => void;
}) {
  const allBanks = [...directory.banks.chapter, ...directory.banks.official, ...directory.banks.mock];
  const bank = allBanks.find((item) => item.id === bankId);
  const [data, setData] = useState<QuestionBankQuestionsResponse | null>(null);
  const [trash, setTrash] = useState<Awaited<ReturnType<typeof fetchQuestionTrash>> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [editor, setEditor] = useState<QuestionQuestion | null | undefined>(undefined);
  const [practiceSessions, setPracticeSessions] = useState<Awaited<ReturnType<typeof fetchInProgressPracticeSessions>>['sessions']>([]);
  const [statistics, setStatistics] = useState<PracticeStatisticsResponse | null>(null);
  const [practiceScope, setPracticeScope] = useState('');
  const [activePractice, setActivePractice] = useState<PracticeSessionResponse | null>(null);
  const [aiQuestionId, setAiQuestionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { if (!bank) return; setLoading(true); setError(''); try { const [nextData, nextTrash, nextSessions, nextStatistics] = await Promise.all([fetchQuestionBankQuestions(bank.id), fetchQuestionTrash(bank.id), fetchInProgressPracticeSessions(bank.id), fetchPracticeStatistics(bank.id)]); setData(nextData); setTrash(nextTrash); setPracticeSessions(nextSessions.sessions); setStatistics(nextStatistics); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '题目加载失败。'); } finally { setLoading(false); } }, [bank?.id]);
  useEffect(() => { void load(); }, [load]);
  if (!bank) return null;
  const currentBank = bank;
  async function mutate(action: () => Promise<unknown>, message: string) { setBusy(true); setError(''); try { await action(); await load(); setStatus(message); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '操作失败。'); } finally { setBusy(false); } }
  async function saveQuestion(request: QuestionCreateRequest | QuestionUpdateRequest, questionId?: string) { await mutate(() => questionId ? updateQuestion(questionId, request) : createQuestion(request as QuestionCreateRequest), questionId ? '题目已保存' : '题目已新增'); }
  async function startPractice(mode: PracticeMode, source: PracticeSource = 'full', sourceSessionId: string | null = null) { setBusy(true); setError(''); try { setActivePractice(await startPracticeSession(currentBank.id, source === 'full' ? practiceScope || null : null, mode, source, sourceSessionId)); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '无法开始会话。'); } finally { setBusy(false); } }
  async function resumePractice(sessionId: string) { setBusy(true); setError(''); try { setActivePractice(await fetchPracticeSession(sessionId)); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '无法继续会话。'); } finally { setBusy(false); } }
  const typeLabels: Record<QuestionType, string> = { single: '单选', multiple: '多选', true_false: '判断' };
  return <section className="catalog-panel question-workspace" aria-labelledby="question-workspace-title"><header className="page-header"><div><button className="catalog-back" type="button" onClick={onClose}>返回题库</button><h1 id="question-workspace-title">{bank.name}</h1></div><button className="button-primary" type="button" onClick={() => setEditor(null)} disabled={busy}>新增题目</button></header><div className="feedback" aria-live="polite">{loading ? <p className="feedback-muted">加载中</p> : null}{status ? <p className="feedback-success">{status}</p> : null}{error ? <p className="feedback-error" role="alert">{error}</p> : null}</div><section className="practice-launch" aria-labelledby="practice-launch-title"><div className="section-heading"><h2 id="practice-launch-title">刷题</h2><span>{data?.questions.length ?? 0} 道题</span></div><div className="practice-launch-row"><label className="field-column"><span>范围</span><select value={practiceScope} onChange={(event) => setPracticeScope(event.target.value)} disabled={busy}><option value="">整套题库</option>{bank.kind === 'chapter' ? data?.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>) : null}</select></label><div className="practice-launch-actions"><button className="button-secondary" type="button" onClick={() => { void startPractice('cram'); }} disabled={busy || loading || !data?.questions.length}>背题</button><button className="button-primary" type="button" onClick={() => { void startPractice('test'); }} disabled={busy || loading || !data?.questions.length}>检测</button><button className="button-secondary" type="button" onClick={() => { void startPractice('test', 'aggregate_wrong'); }} disabled={busy || loading || !statistics?.aggregateWrongCount}>累计错题</button></div></div>{practiceSessions.length ? <div className="practice-resume-list"><h3>未完成</h3>{practiceSessions.map((item) => <div className="practice-resume-item" key={item.id}><span>{item.mode === 'cram' ? '背题' : '检测'} · {item.questionChapterId ? data?.chapters.find((chapter) => chapter.id === item.questionChapterId)?.title ?? '章节' : item.source === 'aggregate_wrong' ? '累计错题' : '整套题库'}</span><small>{item.answeredCount} / {item.questionCount} 已答</small><button type="button" onClick={() => { void resumePractice(item.id); }} disabled={busy}>继续</button></div>)}</div> : null}</section>{statistics ? <PracticeStatisticsPanel statistics={statistics} /> : null}{!loading && data ? <><div className="question-toolbar"><span>{data.questions.length} 道题</span><span>{data.chapters.length} 个章节</span></div><div className="question-list">{data.questions.length ? data.questions.map((question, index, list) => <article className="question-list-item" key={question.id}><div className="question-list-copy"><div className="question-meta"><span>{typeLabels[question.type]}</span><span>第 {question.version} 版</span>{question.questionChapterId ? <span>{data.chapters.find((chapter) => chapter.id === question.questionChapterId)?.title ?? '章节'}</span> : null}</div><div className="question-stem"><ContentNodes nodes={question.stem} options={aiExplanationContentOptions} /></div><small>答案：{question.answer.join('、')}</small></div><div className="question-row-actions"><button type="button" onClick={() => setEditor(question)} disabled={busy}>编辑</button><button type="button" onClick={() => setAiQuestionId((current) => current === question.id ? null : question.id)} disabled={busy}>{aiQuestionId === question.id ? '收起 AI' : 'AI 讲解'}</button><button type="button" onClick={() => void mutate(() => reorderQuestion(question.id, 'up'), '顺序已更新')} disabled={busy || index === 0}>上移</button><button type="button" onClick={() => void mutate(() => reorderQuestion(question.id, 'down'), '顺序已更新')} disabled={busy || index + 1 >= list.length}>下移</button><button className="danger-action" type="button" onClick={() => void mutate(() => deleteQuestion(question.id), '题目已移入回收站')} disabled={busy}>删除</button></div>{aiQuestionId === question.id ? <QuestionAiPanel question={question} /> : null}</article>) : <p className="empty-state">暂无题目</p>}</div>{trash?.items.length ? <section className="question-trash"><div className="section-heading"><h2>最近删除</h2><span>{trash.items.length}</span></div>{trash.items.map((item) => <div className="question-trash-item" key={item.id}><span>{item.title}</span><small>{typeLabels[item.type]}</small><button type="button" onClick={() => void mutate(() => restoreQuestion(item.id), '题目已恢复')} disabled={busy}>恢复</button></div>)}</section> : null}</> : null}{editor !== undefined ? <QuestionEditor bank={bank} banks={allBanks} chapters={data?.chapters ?? bank.chapters} question={editor} onCancel={() => setEditor(undefined)} onSave={saveQuestion} /> : null}{activePractice ? <PracticeSessionPanel initialSession={activePractice} onClose={() => setActivePractice(null)} onFinished={() => { void load(); }} onStartWrong={(sessionId) => { void startPractice('test', 'current_wrong', sessionId); }} /> : null}</section>;
}

function QuestionAiPanel({ question }: { question: QuestionQuestion }) {
  const [history, setHistory] = useState<QuestionAiExplanationHistoryResponse | null>(null);
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    let active = true;
    setLoading(true); setError('');
    void fetchQuestionAiExplanations(question.id).then((next) => { if (active) setHistory(next); }).catch((requestError) => { if (active) setError(requestError instanceof Error ? requestError.message : 'AI 历史加载失败。'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; abortRef.current?.abort(); };
  }, [question.id]);
  async function generate() {
    if (busy) return;
    const controller = new AbortController(); abortRef.current = controller; setBusy(true); setError('');
    try {
      const result = await generateQuestionAiExplanation(question.id, prompt.trim() ? { prompt: prompt.trim() } : {}, controller.signal);
      setHistory((current) => current ? { ...current, explanations: [result.explanation, ...current.explanations] } : { questionId: question.id, currentQuestionVersion: question.version, explanations: [result.explanation] });
      setPrompt('');
    } catch (requestError) {
      if (!isRequestCancelled(requestError)) setError(requestError instanceof Error ? requestError.message : 'AI 讲解失败。');
    } finally { if (abortRef.current === controller) { abortRef.current = null; setBusy(false); } }
  }
  function cancel() { abortRef.current?.abort(); }
  const explanations = history?.explanations ?? [];
  return <section className="question-ai-panel" aria-label="AI 讲解"><div className="question-ai-heading"><strong>AI 讲解</strong>{history ? <span>{explanations.length} 个版本</span> : null}</div>{loading ? <p className="feedback-muted">加载中</p> : null}{!loading && explanations.length === 0 ? <p className="empty-state">暂无讲解</p> : null}{explanations.map((explanation) => <details className="question-ai-version" key={explanation.id} open={explanation === explanations[0]}><summary>第 {explanation.questionVersion} 版 · {new Date(explanation.generatedAt).toLocaleString('zh-CN')}{explanation.stale ? ' · 题目已更新，讲解可能过时' : ''}</summary><div className="ai-explanation-content"><AiExplanationContent content={explanation.content} /></div></details>)}<label className="field-column"><span>临时提示词</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4000} rows={3} placeholder="可选" disabled={busy} /></label>{error ? <p className="feedback-error" role="alert">{error}</p> : null}<div className="action-row ai-explanation-actions">{busy ? <><span className="ai-generation-spinner" role="status" aria-label="正在生成 AI 讲解" /><button className="button-secondary icon-button ai-generation-cancel" type="button" onClick={cancel} aria-label="停止生成" title="停止生成"><span aria-hidden="true">■</span></button></> : <button className="button-primary" type="button" onClick={() => { void generate(); }}>{explanations.length ? '重新生成' : '生成'}</button>}</div></section>;
}

function PracticeStatisticsPanel({ statistics }: { statistics: PracticeStatisticsResponse }) {
  const renderLine = (line: PracticeStatisticsResponse['overall']) => <div className="practice-stat-line" key={line.key}><span>{line.label}</span><small>{line.answeredCount}/{line.questionCount} 已答 · {line.correctCount} 对 · {line.incorrectCount} 错 · {line.accuracy === null ? '—' : `${line.accuracy}%`}</small></div>;
  return <section className="practice-statistics" aria-labelledby="practice-statistics-title"><div className="section-heading"><h2 id="practice-statistics-title">统计</h2><span>累计错题 {statistics.aggregateWrongCount}</span></div><div className="practice-stat-overview">{renderLine(statistics.overall)}</div>{statistics.chapters.length ? <details><summary>章节</summary><div className="practice-stat-list">{statistics.chapters.map(renderLine)}</div></details> : null}<details><summary>题型</summary><div className="practice-stat-list">{statistics.types.map(renderLine)}</div></details><details><summary>模式</summary><div className="practice-stat-list">{statistics.modes.map(renderLine)}</div></details></section>;
}

function PracticeSessionPanel({
  initialSession,
  onClose,
  onFinished,
  onStartWrong,
}: {
  initialSession: PracticeSessionResponse;
  onClose: () => void;
  onFinished: (session: PracticeSessionResponse) => void;
  onStartWrong?: (sessionId: string) => void;
}) {
  const [session, setSession] = useState(initialSession);
  const [index, setIndex] = useState(initialSession.session.currentIndex);
  const [selected, setSelected] = useState<string[]>(initialSession.questions[initialSession.session.currentIndex]?.attempt.answer ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState<'correct' | 'incorrect' | null>(null);
  const maybeQuestion = session.questions[index];
  const completed = session.session.status === 'completed';

  useEffect(() => {
    setSelected(session.questions[index]?.attempt.answer ?? []);
  }, [index, session.questions]);

  useEffect(() => {
    setFeedback(null);
  }, [index]);

  if (!maybeQuestion) return null;
  const question = maybeQuestion;
  const isMultiple = question.type === 'multiple';
  const isCram = session.session.mode === 'cram';
  const last = index + 1 >= session.questions.length;

  function choose(key: string) {
    if (completed || busy || (isCram && question.attempt.answer !== null)) return;
    if (isMultiple) {
      setSelected((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
      return;
    }
    const nextAnswer = [key];
    setSelected(nextAnswer);
    void submit(nextAnswer, true);
  }

  async function submit(answerValue: string[] = selected, autoAdvance = false) {
    if (!answerValue.length || completed) return;
    setBusy(true); setError('');
    try {
      const next = await answerPracticeQuestion(session.session.id, question.id, answerValue);
      setSession(next);
      if (isCram) {
        const result = next.questions[index]?.attempt.result;
        setFeedback(result === 'correct' || result === 'incorrect' ? result : null);
        if (autoAdvance && !last) {
          window.setTimeout(() => setIndex((current) => Math.min(current + 1, next.questions.length - 1)), 750);
        }
      } else if (autoAdvance && !last) {
        setIndex((current) => Math.min(current + 1, next.questions.length - 1));
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '作答保存失败。');
    } finally { setBusy(false); }
  }

  async function finish() {
    setBusy(true); setError('');
    try { const next = await completePracticeSession(session.session.id); setSession(next); onFinished(next); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '完成会话失败。'); }
    finally { setBusy(false); }
  }

  async function abandon() {
    setBusy(true); setError('');
    try { const next = await abandonPracticeSession(session.session.id); onFinished(next); onClose(); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '放弃会话失败。'); }
    finally { setBusy(false); }
  }

  return <div className="sheet-backdrop practice-backdrop" role="presentation"><section className="sheet practice-sheet" role="dialog" aria-modal="true" aria-labelledby="practice-title"><header className="practice-header"><button className="catalog-back" type="button" onClick={onClose} disabled={busy}>返回</button><div><h2 id="practice-title">{isCram ? '背题' : '检测'}</h2><p>{index + 1} / {session.questions.length}</p></div>{!completed ? <button className="button-secondary" type="button" onClick={() => { void abandon(); }} disabled={busy}>放弃</button> : null}</header><div className="practice-progress"><span style={{ width: `${((index + 1) / session.questions.length) * 100}%` }} /></div><div className="practice-question"><div className="practice-stem"><ContentNodes nodes={question.stem} options={aiExplanationContentOptions} /></div><div className="practice-options" role={isMultiple ? 'group' : 'radiogroup'} aria-label="题目选项">{question.options.map((option) => { const selectedOption = selected.includes(option.key); const correct = question.correctAnswer?.includes(option.key); const incorrectSelected = Boolean(selectedOption && question.attempt.answer && question.attempt.result === 'incorrect' && !correct); const classes = ['practice-option', selectedOption ? 'practice-option-selected' : '', correct ? 'practice-option-correct' : '', incorrectSelected ? 'practice-option-incorrect' : ''].filter(Boolean).join(' '); return <button className={classes} key={option.key} type="button" onClick={() => choose(option.key)} disabled={busy || completed || (isCram && question.attempt.answer !== null)}><span className="practice-option-key">{option.key}</span><span className="practice-option-content"><ContentNodes nodes={option.content} options={aiExplanationContentOptions} /></span></button>; })}</div>{isCram && feedback ? <p className={feedback === 'correct' ? 'feedback-success' : 'feedback-error'}>{feedback === 'correct' ? '回答正确' : '回答错误'}</p> : null}{(completed || (isCram && question.attempt.answer !== null)) && question.analysis ? <section className="practice-analysis"><h3>解析</h3><ContentNodes nodes={question.analysis} options={aiExplanationContentOptions} /></section> : null}{completed && session.result ? <section className="practice-result" aria-label="检测结果"><strong>本次结果</strong><div><span>正确 {session.result.correctCount}</span><span>错误 {session.result.incorrectCount}</span><span>未答 {session.result.unansweredCount}</span><span>正确率 {session.result.accuracy === null ? '—' : `${session.result.accuracy}%`}</span></div>{session.result.incorrectCount && onStartWrong ? <button className="button-secondary" type="button" onClick={() => onStartWrong(session.session.id)} disabled={busy}>本次错题</button> : null}</section> : null}{error ? <p className="feedback-error" role="alert">{error}</p> : null}</div>{completed ? <footer className="action-row"><button className="button-primary" type="button" onClick={onClose}>完成</button></footer> : <footer className="practice-footer"><button className="button-secondary" type="button" onClick={() => setIndex((current) => Math.max(0, current - 1))} disabled={busy || index === 0}>上一题</button>{last ? <button className="button-primary" type="button" onClick={() => { void finish(); }} disabled={busy}>完成{isCram ? '背题' : '检测'}</button> : <button className="button-primary" type="button" onClick={() => { void submit(selected, !isMultiple); }} disabled={busy || !selected.length}>{isMultiple ? '确认并下一题' : '下一题'}</button>}</footer>}</section></div>;
}

function QuestionImportPanel({ target, onBack }: { target: { courseId: string; subjectId: string }; onBack: () => void }) {
  const [kind, setKind] = useState<QuestionBankKind>('chapter');
  const [format, setFormat] = useState<QuestionImportTemplateFormat>('json');
  const [preview, setPreview] = useState<QuestionImportPreviewResponse | null>(null);
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function chooseFile(file: File | undefined) {
    if (!file) return; setBusy(true); setError(''); setMessage(''); setFileName(file.name);
    try { setPreview(await previewQuestionImport(file, target.courseId, target.subjectId, kind)); }
    catch (requestError) { setError(requestError instanceof Error ? requestError.message : '解析失败。'); setPreview(null); }
    finally { setBusy(false); }
  }
  async function changeKind(nextKind: QuestionBankKind) {
    if (preview?.previewId) await cancelQuestionImport(preview.previewId);
    setKind(nextKind); setPreview(null); setFileName(''); setMessage(''); setError('');
  }
  async function downloadTemplate() {
    try { const response = await downloadQuestionImportTemplate(kind, format); const blob = await response.blob(); saveDownload(blob, `knowledge-question-bank-${kind}-template.${format === 'json' ? 'json' : 'xlsx'}`); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '模板下载失败。'); }
  }
  async function apply() {
    if (!preview?.previewId || !preview.valid) return; setBusy(true); setError('');
    try { const result = await applyQuestionImport(preview.previewId); setMessage(`已导入 ${result.questionBankName}，共 ${result.questionCount} 道题。`); setPreview(null); setFileName(''); } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '应用失败。'); } finally { setBusy(false); }
  }
  return <section className="import-panel" aria-labelledby="question-import-title"><header className="page-header"><div><button className="catalog-back" type="button" onClick={onBack}>返回</button><h1 id="question-import-title">导入题库</h1></div></header><div className="import-segmented" role="group" aria-label="题库类型">{(['chapter', 'official', 'mock'] as const).map((item) => <button key={item} className={kind === item ? 'import-format-button import-format-button-active' : 'import-format-button'} type="button" onClick={() => { void changeKind(item); }} disabled={busy}>{item === 'chapter' ? '章节题' : item === 'official' ? '真题' : '模拟题'}</button>)}</div><div className="import-segmented" role="group" aria-label="文件类型"><button className={format === 'json' ? 'import-format-button import-format-button-active' : 'import-format-button'} type="button" onClick={() => setFormat('json')}>JSON</button><button className={format === 'excel' ? 'import-format-button import-format-button-active' : 'import-format-button'} type="button" onClick={() => setFormat('excel')}>Excel</button><button className="icon-button" type="button" onClick={() => { void downloadTemplate(); }} aria-label="下载模板" title="下载模板"><Download size={18} aria-hidden="true" /></button></div><div className="question-import-actions"><label className="file-button" aria-label="选择文件" title="选择文件"><Upload size={18} aria-hidden="true" /><span>选择文件</span><input type="file" accept={format === 'json' ? '.json,application/json' : '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'} onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ''; }} disabled={busy} /></label><span className="file-name">{fileName}</span></div><div className="feedback" aria-live="polite">{busy ? <p className="feedback-muted">处理中</p> : null}{message ? <p className="feedback-success">{message}</p> : null}{error ? <p className="feedback-error" role="alert">{error}</p> : null}</div>{preview ? <section className="preview-panel" aria-labelledby="question-preview-title"><div className="section-heading"><h2 id="question-preview-title">预览</h2><span className={`validity validity-${preview.valid ? 'valid' : 'invalid'}`}>{preview.valid ? '可应用' : '不可应用'}</span></div><p className="file-name">{preview.sourceFileName} · {preview.document?.title ?? '未识别题库'}</p>{preview.issues.length ? <ul className="issue-list">{preview.issues.map((issue, index) => <li key={`${issue.code}-${index}`}><strong>{issue.location.line}:{issue.location.column}</strong><span>{issue.message}</span><small>{issue.suggestion}</small></li>)}</ul> : null}{preview.document ? <p className="feedback-muted">{preview.kind === 'chapter' ? `${preview.document.chapters.reduce((count, chapter) => count + chapter.questions.length, 0)} 道题，${preview.document.chapters.length} 个章节` : `${preview.document.questions.length} 道题`}</p> : null}<div className="action-row"><button className="button-secondary" type="button" onClick={() => { if (preview.previewId) void cancelQuestionImport(preview.previewId); setPreview(null); setFileName(''); }} disabled={busy}>取消</button><button className="button-primary" type="button" onClick={() => { void apply(); }} disabled={busy || !preview.valid}>应用</button></div></section> : null}</section>;
}

type HierarchyMoveTarget = {
  entityType: Exclude<HierarchyEntityType, 'material'>;
  entityId: string;
  title: string;
  options: Array<{ id: string; label: string }>;
};

function HierarchyPanel({
  hierarchy,
  trash,
  backups,
  loading,
  error,
  onChange,
  onRefresh,
  onTrashRefresh,
  onBackupsRefresh,
  onExportMaterial,
  onExportJson,
  onRestoreJson,
  onCreateBackup,
  onRestoreBackup,
  onPermanentDeleteTrashItem,
  onBrowseCatalog,
}: {
  hierarchy: HierarchyResponse | null;
  trash: HierarchyTrashResponse | null;
  backups: DataBackupsResponse | null;
  loading: boolean;
  error: string;
  onChange: (next: HierarchyResponse) => void;
  onRefresh: () => void;
  onTrashRefresh: () => void;
  onBackupsRefresh: () => void;
  onExportMaterial: (materialId: string, materialName: string) => Promise<void>;
  onExportJson: () => Promise<void>;
  onRestoreJson: (file: File) => Promise<void>;
  onCreateBackup: () => Promise<void>;
  onRestoreBackup: (backupId: string) => Promise<void>;
  onPermanentDeleteTrashItem: (trashItemId: string) => Promise<void>;
  onBrowseCatalog: () => void;
}) {
  const [localError, setLocalError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [backupsOpen, setBackupsOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<HierarchyMoveTarget | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ entityType: HierarchyEntityType; entityId: string; title: string } | null>(null);
  const [pendingRestoreFile, setPendingRestoreFile] = useState<File | null>(null);
  const [pendingBackupRestore, setPendingBackupRestore] = useState<{ id: string; startedAt: string } | null>(null);
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<{ id: string; title: string } | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set());

  const materials = hierarchy?.materials ?? [];
  const materialOptions = materials.map((material) => ({ id: material.id, label: material.name }));
  const sectionOptions = materials.flatMap((material) => material.chapters.flatMap((chapter) =>
    chapter.sections.map((section) => ({ id: section.id, label: `${material.name} / ${chapter.title} / ${section.title}` }))));

  async function mutate(action: () => Promise<HierarchyResponse>, successMessage: string) {
    setBusy(true);
    setLocalError('');
    setStatusMessage('');
    try {
      onChange(await action());
      onTrashRefresh();
      setStatusMessage(successMessage);
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  async function runDataAction(action: () => Promise<void>, successMessage: string) {
    setBusy(true);
    setLocalError('');
    setStatusMessage('');
    try {
      await action();
      setStatusMessage(successMessage);
    } catch (requestError) {
      setLocalError(requestError instanceof Error ? requestError.message : '操作失败。');
    } finally {
      setBusy(false);
    }
  }

  async function confirmRestore() {
    if (!pendingRestoreFile) {
      return;
    }
    const file = pendingRestoreFile;
    setPendingRestoreFile(null);
    await runDataAction(() => onRestoreJson(file), '已恢复');
  }

  async function confirmBackupRestore() {
    if (!pendingBackupRestore) {
      return;
    }
    const backupId = pendingBackupRestore.id;
    setPendingBackupRestore(null);
    await runDataAction(() => onRestoreBackup(backupId), '已恢复备份');
  }

  async function confirmPermanentDelete() {
    if (!pendingPermanentDelete) {
      return;
    }
    const trashItemId = pendingPermanentDelete.id;
    setPendingPermanentDelete(null);
    await runDataAction(() => onPermanentDeleteTrashItem(trashItemId), '已永久删除');
    onTrashRefresh();
  }

  function promptCreate(entityType: Exclude<HierarchyEntityType, 'material'>, parentId: string) {
    const labels = { chapter: '章标题', section: '节标题', card: '闪卡标题' } as const;
    const title = window.prompt(`输入${labels[entityType]}`);
    if (title !== null) {
      void mutate(() => createHierarchy({ entityType, parentId, title }), '已新增');
    }
  }

  function promptRename(entityType: HierarchyEntityType, entityId: string, currentTitle: string) {
    const title = window.prompt('输入新标题', currentTitle);
    if (title !== null && title.trim() !== currentTitle) {
      void mutate(() => renameHierarchy(entityType, entityId, title), '已改名');
    }
  }

  function openMove(entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, title: string, options: Array<{ id: string; label: string }>) {
    if (options.length === 0) {
      setLocalError('没有可移动的目标。');
      return;
    }
    setMoveTarget({ entityType, entityId, title, options });
  }

  function confirmDelete() {
    if (!pendingDelete) {
      return;
    }
    const target = pendingDelete;
    setPendingDelete(null);
    void mutate(() => deleteHierarchy(target.entityType, target.entityId), '已移入回收站');
  }

  return (
    <section className="hierarchy-panel" aria-labelledby="materials-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">知识闪卡</p>
          <h1 id="materials-title">资料</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={onBrowseCatalog} aria-label="目录" title="目录">
            <FolderOpen size={20} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => { setTrashOpen(true); onTrashRefresh(); }} disabled={busy} aria-label="回收站" title="回收站">
            <Trash2 size={20} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => { setBackupsOpen(true); onBackupsRefresh(); }} disabled={busy} aria-label="备份" title="备份">
            <Archive size={20} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={() => { void runDataAction(onExportJson, '已导出'); }} disabled={busy} aria-label="导出 JSON" title="导出 JSON">
            <Download size={20} aria-hidden="true" />
          </button>
          <label className="icon-button file-button-inline" aria-label="恢复 JSON" title="恢复 JSON">
            <Upload size={20} aria-hidden="true" />
            <input type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0] ?? null; event.target.value = ''; setPendingRestoreFile(file); }} disabled={busy} />
          </label>
          <button className="icon-button" type="button" onClick={onRefresh} disabled={busy || loading} aria-label="刷新资料" title="刷新资料">
            <RefreshCw size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="feedback" aria-live="polite">
        {loading ? <p className="feedback-muted">加载中</p> : null}
        {statusMessage ? <p className="feedback-success">{statusMessage}</p> : null}
        {error || localError ? <p className="feedback-error">{error || localError}</p> : null}
      </div>

      {!loading && materials.length === 0 ? <p className="empty-state">还没有资料</p> : null}
      <div className="hierarchy-list">
        {materials.map((material) => (
          <section className="hierarchy-material" key={material.id}>
            <div className="hierarchy-row hierarchy-material-row">
              <strong>{material.name}</strong>
              <div className="hierarchy-actions">
                <button type="button" onClick={() => { void runDataAction(() => onExportMaterial(material.id, material.name), '已导出'); }} disabled={busy}>导出</button>
                <button type="button" onClick={() => promptRename('material', material.id, material.name)} disabled={busy}>改名</button>
                <button type="button" className="danger-action" onClick={() => setPendingDelete({ entityType: 'material', entityId: material.id, title: material.name })} disabled={busy}>删除</button>
              </div>
            </div>
            <div className="hierarchy-children">
              {material.chapters.map((chapter, chapterIndex) => (
                <HierarchyChapterRow
                  key={chapter.id}
                  chapter={chapter}
                  chapterIndex={chapterIndex}
                  chapterCount={material.chapters.length}
                  busy={busy}
                  sectionOptions={sectionOptions}
                  materialOptions={materialOptions}
                  onCreate={promptCreate}
                  onRename={promptRename}
                  onMove={openMove}
                  onReorder={(direction) => { void mutate(() => reorderHierarchy('chapter', chapter.id, direction), '已排序'); }}
                  onReorderEntity={(entityType, entityId, direction) => { void mutate(() => reorderHierarchy(entityType, entityId, direction), '已排序'); }}
                  onDelete={(entityType, entityId, title) => setPendingDelete({ entityType, entityId, title })}
                  expandedSections={expandedSections}
                  onToggleSection={(sectionId) => setExpandedSections((current) => {
                    const next = new Set(current);
                    if (next.has(sectionId)) {
                      next.delete(sectionId);
                    } else {
                      next.add(sectionId);
                    }
                    return next;
                  })}
                />
              ))}
              <button className="hierarchy-add" type="button" onClick={() => promptCreate('chapter', material.id)} disabled={busy}>新增章</button>
            </div>
          </section>
        ))}
      </div>

      {moveTarget ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="move-title">
            <h2 id="move-title">移动{moveTarget.title}</h2>
            <label className="field-row field-column">
              <span>目标父级</span>
              <select defaultValue={moveTarget.options[0]?.id} id="move-parent">
                {moveTarget.options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            </label>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={() => setMoveTarget(null)}>取消</button>
              <button className="button-primary" type="button" onClick={() => {
                const parentId = (document.getElementById('move-parent') as HTMLSelectElement | null)?.value;
                if (parentId) {
                  void mutate(() => moveHierarchy(moveTarget.entityType, moveTarget.entityId, parentId), '已移动');
                }
                setMoveTarget(null);
              }} disabled={busy}>应用</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">移入回收站？</h2>
            <p className="sheet-message">{pendingDelete.title}及其下级内容将暂时隐藏。</p>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button-danger" type="button" onClick={confirmDelete} disabled={busy}>删除</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingRestoreFile ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="restore-title">
            <h2 id="restore-title">恢复数据？</h2>
            <p className="sheet-message">当前资料、复习记录和标注将被 JSON 内容替换。</p>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={() => setPendingRestoreFile(null)} disabled={busy}>取消</button>
              <button className="button-danger" type="button" onClick={() => { void confirmRestore(); }} disabled={busy}>恢复</button>
            </div>
          </section>
        </div>
      ) : null}

      {trashOpen ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet sheet-tall" role="dialog" aria-modal="true" aria-labelledby="trash-title">
            <div className="section-heading"><h2 id="trash-title">回收站</h2><button className="sheet-close" type="button" onClick={() => setTrashOpen(false)} aria-label="关闭">关闭</button></div>
            {trash?.items.length ? (
              <ul className="trash-list">
                {trash.items.map((item) => <li key={item.id}><div><strong>{item.title}</strong><small>{item.entityType} · {new Date(item.deletedAt).toLocaleString('zh-CN')}</small></div><button className="danger-action" type="button" onClick={() => setPendingPermanentDelete({ id: item.id, title: item.title })} disabled={busy}>永久删除</button></li>)}
              </ul>
            ) : <p className="empty-state">回收站为空</p>}
          </section>
        </div>
      ) : null}

      {backupsOpen ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet sheet-tall" role="dialog" aria-modal="true" aria-labelledby="backups-title">
            <div className="section-heading"><h2 id="backups-title">备份</h2><button className="sheet-close" type="button" onClick={() => setBackupsOpen(false)} aria-label="关闭">关闭</button></div>
            <div className="sheet-toolbar"><button className="button-primary" type="button" onClick={() => { void runDataAction(onCreateBackup, '已完成备份'); }} disabled={busy}>立即备份</button></div>
            {backups?.backups.length ? (
              <ul className="backup-list">
                {backups.backups.map((backup) => <li key={backup.id}><div><strong>{new Date(backup.startedAt).toLocaleString('zh-CN')}</strong><small>{backup.status === 'succeeded' ? '成功' : backup.status === 'running' ? '进行中' : '失败'} · {backup.fileManifest.length} 个文件</small>{backup.errorMessage ? <small className="feedback-error">{backup.errorMessage}</small> : null}</div>{backup.status === 'succeeded' ? <button type="button" onClick={() => setPendingBackupRestore({ id: backup.id, startedAt: backup.startedAt })} disabled={busy}>恢复</button> : null}</li>)}
              </ul>
            ) : <p className="empty-state">还没有备份</p>}
          </section>
        </div>
      ) : null}

      {pendingPermanentDelete ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="permanent-delete-title">
            <h2 id="permanent-delete-title">永久删除？</h2>
            <p className="sheet-message">{pendingPermanentDelete.title}及其下级内容将无法恢复。</p>
            <div className="action-row"><button className="button-secondary" type="button" onClick={() => setPendingPermanentDelete(null)} disabled={busy}>取消</button><button className="button-danger" type="button" onClick={() => { void confirmPermanentDelete(); }} disabled={busy}>删除</button></div>
          </section>
        </div>
      ) : null}

      {pendingBackupRestore ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="backup-restore-title">
            <h2 id="backup-restore-title">恢复备份？</h2>
            <p className="sheet-message">恢复前会自动保留当前数据，备份于 {new Date(pendingBackupRestore.startedAt).toLocaleString('zh-CN')}。</p>
            <div className="action-row"><button className="button-secondary" type="button" onClick={() => setPendingBackupRestore(null)} disabled={busy}>取消</button><button className="button-danger" type="button" onClick={() => { void confirmBackupRestore(); }} disabled={busy}>恢复</button></div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function HierarchyChapterRow({
  chapter,
  chapterIndex,
  chapterCount,
  busy,
  sectionOptions,
  materialOptions,
  onCreate,
  onRename,
  onMove,
  onReorder,
  onReorderEntity,
  onDelete,
  expandedSections,
  onToggleSection,
}: {
  chapter: HierarchyChapter;
  chapterIndex: number;
  chapterCount: number;
  busy: boolean;
  sectionOptions: Array<{ id: string; label: string }>;
  materialOptions: Array<{ id: string; label: string }>;
  onCreate: (entityType: Exclude<HierarchyEntityType, 'material'>, parentId: string) => void;
  onRename: (entityType: HierarchyEntityType, entityId: string, currentTitle: string) => void;
  onMove: (entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, title: string, options: Array<{ id: string; label: string }>) => void;
  onReorder: (direction: 'up' | 'down') => void;
  onReorderEntity: (entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, direction: 'up' | 'down') => void;
  onDelete: (entityType: HierarchyEntityType, entityId: string, title: string) => void;
  expandedSections: Set<string>;
  onToggleSection: (sectionId: string) => void;
}) {
  return (
    <section className="hierarchy-node">
      <div className="hierarchy-row">
        <span><b>章</b>{chapter.title}</span>
        <div className="hierarchy-actions">
          <button type="button" onClick={() => onRename('chapter', chapter.id, chapter.title)} disabled={busy}>改名</button>
          <button type="button" onClick={() => onReorder('up')} disabled={busy || chapterIndex === 0} aria-label="上移">↑</button>
          <button type="button" onClick={() => onReorder('down')} disabled={busy || chapterIndex === chapterCount - 1} aria-label="下移">↓</button>
          <button type="button" onClick={() => onMove('chapter', chapter.id, chapter.title, materialOptions)} disabled={busy}>移动</button>
          <button type="button" onClick={() => onDelete('chapter', chapter.id, chapter.title)} className="danger-action" disabled={busy}>删除</button>
        </div>
      </div>
      <div className="hierarchy-grandchildren">
        {chapter.sections.map((section, sectionIndex) => (
          <HierarchySectionRow
            key={section.id}
            section={section}
            sectionIndex={sectionIndex}
            sectionCount={chapter.sections.length}
            busy={busy}
            sectionOptions={sectionOptions}
            onCreate={onCreate}
            onRename={onRename}
            onMove={onMove}
            onReorder={(direction) => onReorderEntity('section', section.id, direction)}
            onReorderEntity={onReorderEntity}
            onDelete={onDelete}
            expanded={expandedSections.has(section.id)}
            onToggle={() => onToggleSection(section.id)}
          />
        ))}
        <button className="hierarchy-add" type="button" onClick={() => onCreate('section', chapter.id)} disabled={busy}>新增节</button>
      </div>
    </section>
  );
}

function HierarchySectionRow({
  section,
  sectionIndex,
  sectionCount,
  busy,
  sectionOptions,
  onCreate,
  onRename,
  onMove,
  onReorder,
  onReorderEntity,
  onDelete,
  expanded,
  onToggle,
}: {
  section: HierarchySection;
  sectionIndex: number;
  sectionCount: number;
  busy: boolean;
  sectionOptions: Array<{ id: string; label: string }>;
  onCreate: (entityType: Exclude<HierarchyEntityType, 'material'>, parentId: string) => void;
  onRename: (entityType: HierarchyEntityType, entityId: string, currentTitle: string) => void;
  onMove: (entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, title: string, options: Array<{ id: string; label: string }>) => void;
  onReorder: (direction: 'up' | 'down') => void;
  onReorderEntity: (entityType: Exclude<HierarchyEntityType, 'material'>, entityId: string, direction: 'up' | 'down') => void;
  onDelete: (entityType: HierarchyEntityType, entityId: string, title: string) => void;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="hierarchy-node">
      <div className="hierarchy-row">
        <span><b>节</b>{section.title}</span>
        <div className="hierarchy-actions">
          <button type="button" onClick={() => onRename('section', section.id, section.title)} disabled={busy}>改名</button>
          <button type="button" onClick={() => onMove('section', section.id, section.title, sectionOptions)} disabled={busy}>移动</button>
          <button type="button" onClick={() => onDelete('section', section.id, section.title)} className="danger-action" disabled={busy}>删除</button>
          <button type="button" onClick={() => onCreate('card', section.id)} disabled={busy}>新增卡</button>
          <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? '收起' : `展开 ${section.cards.length}`}</button>
        </div>
      </div>
      {expanded ? <div className="hierarchy-cards">
        {section.cards.map((card, cardIndex) => (
          <div className="hierarchy-row hierarchy-card-row" key={card.id}>
            <span><b>卡</b>{card.title}</span>
            <div className="hierarchy-actions">
              <button type="button" onClick={() => onRename('card', card.id, card.title)} disabled={busy}>改名</button>
              <button type="button" onClick={() => onReorderEntity('card', card.id, 'up')} disabled={busy || cardIndex === 0} aria-label="卡片上移">↑</button>
              <button type="button" onClick={() => onReorderEntity('card', card.id, 'down')} disabled={busy || cardIndex === section.cards.length - 1} aria-label="卡片下移">↓</button>
              <button type="button" onClick={() => onMove('card', card.id, card.title, sectionOptions)} disabled={busy}>移动</button>
              <button type="button" onClick={() => onDelete('card', card.id, card.title)} className="danger-action" disabled={busy}>删除</button>
            </div>
            <span className="hierarchy-order" aria-label={`第 ${cardIndex + 1} 张`}>{cardIndex + 1}</span>
          </div>
        ))}
      </div> : null}
      <div className="hierarchy-reorder" aria-label="节排序">
        <button type="button" onClick={() => onReorder('up')} disabled={busy || sectionIndex === 0} aria-label="节上移">↑</button>
        <button type="button" onClick={() => onReorder('down')} disabled={busy || sectionIndex === sectionCount - 1} aria-label="节下移">↓</button>
      </div>
    </section>
  );
}

function ReviewFilterSheet({
  dashboard,
  initialFilters,
  onApply,
  onClose,
}: {
  dashboard: ReviewDashboardResponse;
  initialFilters: ReviewFilters;
  onApply: (filters: ReviewFilters) => void;
  onClose: () => void;
}) {
  const [filters, setFilters] = useState<ReviewFilters>(initialFilters);

  function toggleStatus(status: ReviewMasteryStatus) {
    setFilters((current) => {
      const statuses = current.statuses ?? [];
      return {
        ...current,
        statuses: statuses.includes(status)
          ? statuses.filter((item) => item !== status)
          : [...statuses, status],
      };
    });
  }

  return (
    <div className="filter-sheet-backdrop" role="presentation">
      <section className="filter-sheet" role="dialog" aria-modal="true" aria-labelledby="filter-title">
        <header className="filter-sheet-header">
          <h2 id="filter-title">筛选</h2>
          <button className="button-secondary" type="button" onClick={onClose}>取消</button>
        </header>
        <div className="filter-fields">
          <label className="field-row">
            <span>资料</span>
            <select
              value={filters.materialId ?? ''}
              onChange={(event) => setFilters((current) => ({
                ...current,
                materialId: event.target.value || undefined,
              }))}
            >
              <option value="">全部资料</option>
              {dashboard.materials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}
            </select>
          </label>
          <fieldset className="status-filter">
            <legend>掌握状态</legend>
            <div className="status-options">
              {masteryOptions.map((option) => (
                <label key={option.value}>
                  <input
                    type="checkbox"
                    checked={filters.statuses?.includes(option.value) ?? false}
                    onChange={() => toggleStatus(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <footer className="action-row">
          <button className="button-secondary" type="button" onClick={() => setFilters({})}>重置</button>
          <button className="button-primary" type="button" onClick={() => onApply(filters)}>应用</button>
        </footer>
      </section>
    </div>
  );
}

function ReviewPanel({
  dashboard,
  card,
  navigation,
  loading,
  statusSaving,
  statusMessage,
  error,
  onRefresh,
  onStart,
  onNavigate,
  onUpdateStatus,
  onGenerateExplanation,
  onCreateHighlights,
  onDeleteHighlight,
  highlightSaving,
  onUpdateContent,
  onAcquireEditLock,
  onRenewEditLock,
  onReleaseEditLock,
  onUploadResource,
  onShowFilters,
  onBack,
}: {
  dashboard: ReviewDashboardResponse | null;
  card: ReviewCardSummary | null;
  navigation: ReviewCardNavigation | null;
  loading: boolean;
  statusSaving: boolean;
  statusMessage: string;
  error: string;
  onRefresh: () => void;
  onStart: (scope: ReviewStartScope, materialId?: string) => void;
  onNavigate: (cardId: string) => void;
  onUpdateStatus: (status: ReviewMasteryStatus) => void;
  onGenerateExplanation: (cardId: string, prompt: string, signal: AbortSignal) => Promise<ReviewAiExplanation>;
  onCreateHighlights: (requests: ReviewHighlightCreateRequest[]) => void;
  onDeleteHighlight: (highlightId: string) => void;
  highlightSaving: boolean;
  onUpdateContent: (request: ReviewCardContentUpdateRequest, lock: ReviewEditLock) => Promise<ReviewCardContentUpdateResponse>;
  onAcquireEditLock: (cardId: string) => Promise<ReviewEditLock>;
  onRenewEditLock: (cardId: string, lock: ReviewEditLock) => Promise<ReviewEditLock>;
  onReleaseEditLock: (cardId: string, lock: ReviewEditLock) => Promise<void>;
  onUploadResource: (file: File) => Promise<{ id: string }>;
  onShowFilters: () => void;
  onBack: () => void;
}) {
  const [pendingTextHighlights, setPendingTextHighlights] = useState<PendingTextHighlight[]>([]);
  const [currentMaterialId, setCurrentMaterialId] = useState('');
  const [clozeMode, setClozeMode] = useState(false);
  const [revealedHighlightIds, setRevealedHighlightIds] = useState<Set<string>>(() => new Set());
  const [memorizationMode, setMemorizationMode] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editLock, setEditLock] = useState<ReviewEditLock | null>(null);
  const [editLockLoading, setEditLockLoading] = useState(false);
  const [editLockError, setEditLockError] = useState('');
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [explanationPrompt, setExplanationPrompt] = useState('');
  const [explanationSaving, setExplanationSaving] = useState(false);
  const [explanationError, setExplanationError] = useState('');
  const editLockRef = useRef<{ cardId: string; lock: ReviewEditLock } | null>(null);
  const explanationAbortRef = useRef<AbortController | null>(null);
  const activeCardIdRef = useRef<string | null>(card?.id ?? null);
  const renewEditLockRef = useRef(onRenewEditLock);
  const releaseEditLockRef = useRef(onReleaseEditLock);
  activeCardIdRef.current = card?.id ?? null;
  renewEditLockRef.current = onRenewEditLock;
  releaseEditLockRef.current = onReleaseEditLock;

  useEffect(() => {
    if (!dashboard) {
      return;
    }
    setCurrentMaterialId((current) => (
      dashboard.materials.some((material) => material.id === current)
        ? current
        : dashboard.materials[0]?.id ?? ''
    ));
  }, [dashboard]);

  const currentMaterial = dashboard?.materials.find((material) => material.id === currentMaterialId)
    ?? dashboard?.materials[0]
    ?? null;

  async function releaseCurrentEditLock() {
    const currentLock = editLockRef.current;
    if (!currentLock) {
      return;
    }
    editLockRef.current = null;
    setEditLock(null);
    try {
      await releaseEditLockRef.current(currentLock.cardId, currentLock.lock);
    } catch {
      // 租约会自然过期，释放失败不阻塞用户退出编辑。
    }
  }

  useEffect(() => {
    explanationAbortRef.current?.abort();
    explanationAbortRef.current = null;
    setPendingTextHighlights([]);
    setRevealedHighlightIds(new Set());
    setEditing(false);
    setExplanationOpen(false);
    setExplanationPrompt('');
    setExplanationError('');
    if (memorizationMode && card) {
      setClozeMode(true);
    } else if (!card) {
      setClozeMode(false);
    }
    return () => {
      explanationAbortRef.current?.abort();
      void releaseCurrentEditLock();
    };
  }, [card?.id]);

  useEffect(() => {
    if (!card || !editing || !editLock) {
      return;
    }
    const cardId = card.id;
    const lockToken = editLock.lockToken;
    const timer = window.setInterval(() => {
      void renewEditLockRef.current(cardId, editLock)
        .then((nextLock) => {
          const currentLock = editLockRef.current;
          if (currentLock?.cardId === cardId && currentLock.lock.lockToken === lockToken) {
            currentLock.lock = nextLock;
            setEditLock(nextLock);
          }
        })
        .catch(() => {
          const currentLock = editLockRef.current;
          if (currentLock?.cardId === cardId && currentLock.lock.lockToken === lockToken) {
            editLockRef.current = null;
            setEditLock(null);
            setEditing(false);
            setEditLockError('编辑锁已失效，请重新进入编辑。');
          }
        });
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [card?.id, editLock?.lockToken, editing]);

  if (card) {
    const previousCardId = navigation?.previousCardId ?? null;
    const nextCardId = navigation?.nextCardId ?? null;
    const highlights = card.highlights ?? [];
    const effectiveClozeMode = memorizationMode || clozeMode;
    const allHighlightsRevealed = highlights.length > 0
      && highlights.every((highlight) => revealedHighlightIds.has(highlight.id));
    const options: ContentRenderOptions = {
      highlights,
      clozeMode: effectiveClozeMode,
      revealedHighlightIds,
      onRevealHighlight: (highlightId) => {
        setRevealedHighlightIds((current) => new Set(current).add(highlightId));
      },
      onFormulaToggle: (nodePath) => {
        if (highlightSaving) {
          return;
        }
        const existing = highlights.find((highlight) => highlight.kind === 'formula' && highlight.anchor.nodePath === nodePath);
        if (existing) {
          onDeleteHighlight(existing.id);
        } else {
          onCreateHighlights([{ kind: 'formula', anchor: { nodePath } }]);
        }
      },
    };
    const currentCardId = card.id;
    async function beginEditing() {
      setEditLockLoading(true);
      setEditLockError('');
      try {
        const nextLock = await onAcquireEditLock(currentCardId);
        if (activeCardIdRef.current !== currentCardId) {
          await releaseEditLockRef.current(currentCardId, nextLock);
          return;
        }
        editLockRef.current = { cardId: currentCardId, lock: nextLock };
        setEditLock(nextLock);
        setEditing(true);
      } catch (requestError) {
        setEditLockError(requestError instanceof Error ? requestError.message : '无法进入编辑。');
      } finally {
        setEditLockLoading(false);
      }
    }
    async function stopEditing() {
      setEditing(false);
      await releaseCurrentEditLock();
    }
    async function saveContent(request: ReviewCardContentUpdateRequest) {
      if (!editLock) {
        throw new Error('编辑锁已失效，请重新进入编辑。');
      }
      const result = await onUpdateContent(request, editLock);
      await releaseCurrentEditLock();
      setPendingTextHighlights([]);
      setClozeMode(false);
      setRevealedHighlightIds(new Set());
      return result;
    }
    async function generateExplanation() {
      if (explanationAbortRef.current) {
        return;
      }
      const controller = new AbortController();
      explanationAbortRef.current = controller;
      setExplanationSaving(true);
      setExplanationError('');
      try {
        await onGenerateExplanation(currentCardId, explanationPrompt, controller.signal);
        setExplanationOpen(true);
        setExplanationPrompt('');
      } catch (requestError) {
        if (!isRequestCancelled(requestError)) {
          setExplanationError(requestError instanceof Error ? requestError.message : 'AI 讲解失败。');
        }
      } finally {
        if (explanationAbortRef.current === controller) {
          explanationAbortRef.current = null;
          setExplanationSaving(false);
        }
      }
    }
    function cancelExplanation() {
      explanationAbortRef.current?.abort();
    }
    return (
      <section className="review-card-page" aria-labelledby="review-card-title">
        <div className="review-card-toolbar">
          <button className="button-secondary" type="button" onClick={onBack}>返回</button>
          <span className="review-context">{card.materialName} / {card.chapterTitle} / {card.sectionTitle}</span>
          {!editing ? <button className="button-secondary" type="button" disabled={editLockLoading} onClick={() => { void beginEditing(); }}>{editLockLoading ? '锁定中' : '编辑'}</button> : <span className="review-edit-lock" role="status">本机编辑</span>}
        </div>
        {editLockError ? <p className="review-edit-lock-error" role="alert">{editLockError}</p> : null}
        {editing ? (
          <VisualCardEditor
            card={card}
            onCancel={() => { void stopEditing(); }}
            onSave={saveContent}
            onUpload={onUploadResource}
          />
        ) : (
        <article className="review-card" aria-live="polite">
          <h2 id="review-card-title">{card.title}</h2>
          <div
            className="review-card-body"
            onMouseUp={(event) => {
              if (!effectiveClozeMode) {
                setPendingTextHighlights(selectedTextHighlights(event.currentTarget));
              }
            }}
            onTouchEnd={(event) => {
              if (!effectiveClozeMode) {
                setPendingTextHighlights(selectedTextHighlights(event.currentTarget));
              }
            }}
            onKeyUp={(event) => {
              if (!effectiveClozeMode) {
                setPendingTextHighlights(selectedTextHighlights(event.currentTarget));
              }
            }}
          >
            {card.content?.length ? <ContentNodes nodes={card.content} options={options} /> : (card.bodyText || '这张闪卡暂无正文。')}
          </div>
        </article>
        )}
        {!editing ? (
          <section className="ai-explanation" aria-labelledby="ai-explanation-title">
            <button
              className="ai-explanation-toggle"
              type="button"
              aria-expanded={explanationOpen}
              onClick={() => setExplanationOpen((current) => !current)}
            >
              <span id="ai-explanation-title">AI 讲解</span>
              <span aria-hidden="true">{explanationOpen ? '收起' : '展开'}</span>
            </button>
            {explanationOpen ? (
              <div className="ai-explanation-panel">
                {card.aiExplanation ? (
                  <div className="ai-explanation-content" aria-label="AI 讲解结果">
                    <AiExplanationContent content={card.aiExplanation.content} />
                  </div>
                ) : <p className="empty-state">暂无讲解</p>}
                <label className="field-row field-column">
                  <span>临时提示词</span>
                  <textarea
                    value={explanationPrompt}
                    onChange={(event) => setExplanationPrompt(event.target.value)}
                    maxLength={4000}
                    rows={3}
                    placeholder="可选"
                    disabled={explanationSaving}
                  />
                </label>
                {explanationError ? <p className="feedback-error" role="alert">{explanationError}</p> : null}
                <div className="action-row ai-explanation-actions">
                  {explanationSaving ? <>
                    <span className="ai-generation-spinner" role="status" aria-label="正在生成 AI 讲解" />
                    <button className="button-secondary icon-button ai-generation-cancel" type="button" onClick={cancelExplanation} aria-label="停止生成" title="停止生成">
                      <span aria-hidden="true">■</span>
                    </button>
                  </> : (
                    <button className="button-primary" type="button" onClick={() => { void generateExplanation(); }}>
                      {card.aiExplanation ? '重新生成' : '生成'}
                    </button>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}
        {!editing ? <>
        <div className="review-highlight-tools" aria-label="重点操作">
          <button
            className={`button-secondary ${effectiveClozeMode ? 'review-cloze-active' : ''}`}
            type="button"
            disabled={memorizationMode || highlights.length === 0}
            aria-pressed={effectiveClozeMode}
            onClick={() => {
              setClozeMode((current) => !current);
              setPendingTextHighlights([]);
              setRevealedHighlightIds(new Set());
              window.getSelection()?.removeAllRanges();
            }}
          >
            挖空
          </button>
          <button
            className="button-secondary"
            type="button"
            disabled={!effectiveClozeMode || highlights.length === 0 || allHighlightsRevealed}
            onClick={() => setRevealedHighlightIds(new Set(highlights.map((highlight) => highlight.id)))}
          >
            显示全部
          </button>
          <button
            className="button-secondary"
            type="button"
            disabled={effectiveClozeMode || pendingTextHighlights.length === 0 || loading || highlightSaving}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (pendingTextHighlights.length === 0) {
                return;
              }
              onCreateHighlights(pendingTextHighlights.map((anchor) => ({ kind: 'text', anchor })));
              setPendingTextHighlights([]);
              window.getSelection()?.removeAllRanges();
            }}
          >
            高亮
          </button>
        </div>
        <div className="review-status-bar" aria-label="掌握状态">
          <span className="review-status-label">状态：{masteryStatusLabel(card.masteryStatus)}</span>
          <div className="review-status-control" role="group" aria-label="设置掌握状态">
            {reviewStatusOptions.map((option) => (
              <button
                className={`review-status-button review-status-${option.value} ${card.masteryStatus === option.value ? 'review-status-active' : ''}`}
                type="button"
                key={option.value}
                onClick={() => onUpdateStatus(option.value)}
                disabled={loading || statusSaving}
                aria-pressed={card.masteryStatus === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
          {statusMessage || error ? (
            <span className={error ? 'review-status-error' : 'review-status-saved'} aria-live="polite">
              {error || statusMessage}
            </span>
          ) : null}
        </div>
        {navigation ? (
          <nav className="review-card-navigation" aria-label="闪卡切换">
            <button className="button-secondary icon-button" type="button" onClick={() => previousCardId && onNavigate(previousCardId)} disabled={!previousCardId || loading} aria-label="上一张">‹</button>
            <span>
              {navigation.currentIndex >= 0
                ? `${navigation.currentIndex + 1} / ${navigation.total}`
                : `已移出筛选（${navigation.total}）`}
            </span>
            <button className="button-secondary icon-button" type="button" onClick={() => nextCardId && onNavigate(nextCardId)} disabled={!nextCardId || loading} aria-label="下一张">›</button>
          </nav>
        ) : null}
        </> : null}
      </section>
    );
  }

  return (
    <section className="review-panel" aria-labelledby="review-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">知识闪卡</p>
          <h1 id="review-title">复习</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={onRefresh} disabled={loading} aria-label="刷新" title="刷新">
            <RefreshCw size={20} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={onShowFilters} disabled={loading || !currentMaterial} aria-label="筛选" title="筛选">
            <SlidersHorizontal size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="feedback" aria-live="polite">
        {loading ? <p className="feedback-muted">加载中</p> : null}
        {error ? <p className="feedback-error">{error}</p> : null}
      </div>

      {dashboard ? (
        <>
          <section className="review-section" aria-labelledby="current-material-title">
            <div className="section-heading">
              <h2 id="current-material-title">当前资料</h2>
            </div>
            <select
              className="review-current-material-select"
              value={currentMaterial?.id ?? ''}
              onChange={(event) => setCurrentMaterialId(event.target.value)}
              disabled={loading || dashboard.materials.length === 0}
              aria-label="选择当前学习资料"
            >
              {dashboard.materials.length === 0 ? <option value="">暂无资料</option> : null}
              {dashboard.materials.map((material) => <option key={material.id} value={material.id}>{material.name}</option>)}
            </select>
          </section>

          <ul className="review-stats" aria-label="复习数量">
            <li><strong>{currentMaterial?.cardCount ?? 0}</strong><span>闪卡</span></li>
            <li><strong>{currentMaterial?.masteredCount ?? 0}</strong><span>掌握</span></li>
            <li><strong>{currentMaterial?.familiarCount ?? 0}</strong><span>了解</span></li>
            <li><strong>{currentMaterial?.unassessedCount ?? 0}</strong><span>未评估</span></li>
            <li><strong>{currentMaterial?.effortCount ?? 0}</strong><span>努力</span></li>
          </ul>

          <section className="review-section" aria-label="复习模式">
            <label className="review-memorization-toggle">
              <span>背默模式</span>
              <input
                className="review-memorization-switch"
                type="checkbox"
                checked={memorizationMode}
                onChange={(event) => {
                  setMemorizationMode(event.target.checked);
                  setClozeMode(false);
                  setRevealedHighlightIds(new Set());
                }}
              />
            </label>
          </section>

          <section className="review-section" aria-labelledby="shortcut-title">
            <div className="section-heading">
              <h2 id="shortcut-title">开始</h2>
            </div>
            <div className="review-shortcuts">
              <button className="shortcut-button" type="button" onClick={() => currentMaterial && onStart('all', currentMaterial.id)} disabled={!currentMaterial || currentMaterial.cardCount === 0 || loading}>
                <span>全部</span><small>{currentMaterial?.cardCount ?? 0}</small>
              </button>
              <button className="shortcut-button" type="button" onClick={() => currentMaterial && onStart('unassessed', currentMaterial.id)} disabled={!currentMaterial || currentMaterial.unassessedCount === 0 || loading}>
                <span>未评估</span><small>{currentMaterial?.unassessedCount ?? 0}</small>
              </button>
              <button className="shortcut-button" type="button" onClick={() => currentMaterial && onStart('effort', currentMaterial.id)} disabled={!currentMaterial || currentMaterial.effortCount === 0 || loading}>
                <span>努力</span><small>{currentMaterial?.effortCount ?? 0}</small>
              </button>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

const aiProviderLabels: Record<AiProviderKind, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  openrouter: 'OpenRouter',
  custom: '自定义',
};

const aiProviderDefaultBaseUrls: Record<AiProviderKind, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  custom: '',
};

const aiModelSuggestions = [
  'gpt-5',
  'gpt-4.1',
  'deepseek-chat',
  'deepseek-reasoner',
];

type AiProviderDraft = {
  id: string | null;
  name: string;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  isActive: boolean;
};

function newAiProviderDraft(isActive: boolean): AiProviderDraft {
  return {
    id: null,
    name: '',
    provider: 'openai',
    baseUrl: aiProviderDefaultBaseUrls.openai,
    model: '',
    apiKey: '',
    isActive,
  };
}

function AiProviderSettingsPanel({
  appearance,
  onAppearanceChange,
  colorMode,
  onColorModeChange,
  authUsername,
  onLogout,
}: {
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  colorMode: ColorMode;
  onColorModeChange: (colorMode: ColorMode) => void;
  authUsername: string | null;
  onLogout: () => void;
}) {
  const [profiles, setProfiles] = useState<AiProviderProfile[]>([]);
  const [draft, setDraft] = useState<AiProviderDraft | null>(null);
  const [pendingDelete, setPendingDelete] = useState<AiProviderProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');

  async function loadProfiles() {
    setLoading(true);
    setError('');
    try {
      const result = await fetchAiProviderProfiles();
      setProfiles(result.profiles);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '配置加载失败。');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadProfiles();
  }, []);

  function openNew() {
    setStatusMessage('');
    setError('');
    setDraft(newAiProviderDraft(profiles.length === 0));
  }

  function openEdit(profile: AiProviderProfile) {
    setStatusMessage('');
    setError('');
    setDraft({
      id: profile.id,
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl,
      model: profile.model,
      apiKey: '',
      isActive: profile.isActive,
    });
  }

  async function saveDraft() {
    if (!draft) {
      return;
    }
    setBusy(true);
    setError('');
    setStatusMessage('');
    try {
      const nextProfiles = draft.id
        ? await updateAiProviderProfile(draft.id, {
            name: draft.name,
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            model: draft.model,
            ...(draft.apiKey.trim() ? { apiKey: draft.apiKey } : {}),
          } satisfies AiProviderProfileUpdateRequest)
        : await createAiProviderProfile({
            name: draft.name,
            provider: draft.provider,
            baseUrl: draft.baseUrl,
            model: draft.model,
            apiKey: draft.apiKey,
            isActive: draft.isActive,
          } satisfies AiProviderProfileCreateRequest);
      setProfiles(nextProfiles.profiles);
      setDraft(null);
      setStatusMessage('已保存');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }

  async function activate(profileId: string) {
    setBusy(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await activateAiProviderProfile(profileId);
      setProfiles(result.profiles);
      setStatusMessage('已切换');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '切换失败。');
    } finally {
      setBusy(false);
    }
  }

  async function testProfile(profileId: string) {
    setBusy(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await testAiProviderProfile(profileId);
      setStatusMessage(result.message);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '连接测试失败。');
    } finally {
      setBusy(false);
    }
  }

  async function removeProfile() {
    if (!pendingDelete) {
      return;
    }
    setBusy(true);
    setError('');
    setStatusMessage('');
    try {
      const result = await deleteAiProviderProfile(pendingDelete.id);
      setProfiles(result.profiles);
      setPendingDelete(null);
      setStatusMessage('已删除');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '删除失败。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel" aria-labelledby="settings-title">
      <header className="page-header">
        <div>
          <p className="eyebrow">知识闪卡</p>
          <h1 id="settings-title">设置</h1>
        </div>
        <div className="header-actions">
          <button className="icon-button" type="button" onClick={() => { void loadProfiles(); }} disabled={busy || loading} aria-label="刷新" title="刷新">
            <RefreshCw size={20} aria-hidden="true" />
          </button>
          <button className="icon-button" type="button" onClick={openNew} disabled={busy} aria-label="新增 AI 配置" title="新增 AI 配置">
            <Plus size={20} aria-hidden="true" />
          </button>
        </div>
      </header>

      <div className="feedback" aria-live="polite">
        {loading ? <p className="feedback-muted">加载中</p> : null}
        {statusMessage ? <p className="feedback-success">{statusMessage}</p> : null}
        {error ? <p className="feedback-error">{error}</p> : null}
      </div>

      <section className="settings-group" aria-labelledby="appearance-settings-title">
        <div className="section-heading settings-group-heading">
          <h2 id="appearance-settings-title">外观</h2>
        </div>
        <div className="appearance-options" role="radiogroup" aria-labelledby="appearance-settings-title">
          <label className="appearance-option">
            <input type="radio" name="appearance" value="minimal" checked={appearance === 'minimal'} onChange={() => onAppearanceChange('minimal')} />
            <span className="appearance-swatch appearance-swatch-minimal" aria-hidden="true" />
            <span>简约</span>
          </label>
          <label className="appearance-option">
            <input type="radio" name="appearance" value="autumn" checked={appearance === 'autumn'} onChange={() => onAppearanceChange('autumn')} />
            <span className="appearance-swatch appearance-swatch-autumn" aria-hidden="true" />
            <span>秋日枫叶</span>
          </label>
        </div>
        <div className="color-mode-control" role="radiogroup" aria-label="显示模式">
          <label className="color-mode-option">
            <input type="radio" name="color-mode" value="system" checked={colorMode === 'system'} onChange={() => onColorModeChange('system')} />
            <span>跟随系统</span>
          </label>
          <label className="color-mode-option">
            <input type="radio" name="color-mode" value="light" checked={colorMode === 'light'} onChange={() => onColorModeChange('light')} />
            <span>浅色</span>
          </label>
          <label className="color-mode-option">
            <input type="radio" name="color-mode" value="dark" checked={colorMode === 'dark'} onChange={() => onColorModeChange('dark')} />
            <span>深色</span>
          </label>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="ai-settings-title">
        <div className="section-heading settings-group-heading">
          <h2 id="ai-settings-title">AI</h2>
          <span className="settings-count">{profiles.length}</span>
        </div>
        {profiles.length > 0 ? (
          <ul className="settings-profile-list">
            {profiles.map((profile) => (
              <li className="settings-profile-row" key={profile.id}>
                <label className="settings-profile-main">
                  <input
                    type="radio"
                    name="active-ai-provider"
                    checked={profile.isActive}
                    onChange={() => { void activate(profile.id); }}
                    disabled={busy}
                    aria-label={`启用${profile.name}`}
                  />
                  <span>
                    <strong>{profile.name}</strong>
                    <small>{aiProviderLabels[profile.provider]} · {profile.model}</small>
                    <small>{profile.hasApiKey ? '密钥已保存' : '未配置密钥'} · {profile.baseUrl}</small>
                  </span>
                </label>
                <div className="settings-profile-actions">
                  <button type="button" onClick={() => { void testProfile(profile.id); }} disabled={busy}>测试</button>
                  <button type="button" onClick={() => openEdit(profile)} disabled={busy}>编辑</button>
                  <button className="danger-action" type="button" onClick={() => setPendingDelete(profile)} disabled={busy}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        ) : !loading ? (
          <p className="empty-state settings-empty">暂无配置</p>
        ) : null}
      </section>

      <section className="settings-group" aria-labelledby="account-settings-title">
        <div className="section-heading settings-group-heading">
          <h2 id="account-settings-title">账号</h2>
        </div>
        <div className="settings-account-row">
          <span>当前账号</span>
          <strong>{authUsername ?? '已登录'}</strong>
          <button className="settings-account-logout" type="button" onClick={onLogout}>
            <LogOut size={18} aria-hidden="true" />
            退出
          </button>
        </div>
      </section>

      {draft ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet sheet-tall" role="dialog" aria-modal="true" aria-labelledby="provider-editor-title">
            <div className="section-heading">
              <h2 id="provider-editor-title">{draft.id ? '编辑配置' : '新增配置'}</h2>
              <button className="sheet-close" type="button" onClick={() => setDraft(null)} disabled={busy}>关闭</button>
            </div>
            <div className="settings-form">
              <label className="field-row field-column">
                <span>名称</span>
                <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} maxLength={100} autoComplete="off" />
              </label>
              <label className="field-row field-column">
                <span>Provider</span>
                <select
                  value={draft.provider}
                  onChange={(event) => {
                    const provider = event.target.value as AiProviderKind;
                    setDraft({ ...draft, provider, baseUrl: aiProviderDefaultBaseUrls[provider] });
                  }}
                >
                  {Object.entries(aiProviderLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </label>
              <label className="field-row field-column">
                <span>接口地址</span>
                <input value={draft.baseUrl} onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} maxLength={1024} inputMode="url" autoComplete="url" />
              </label>
              <label className="field-row field-column">
                <span>模型</span>
                <input list="ai-model-suggestions" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} maxLength={255} autoComplete="off" />
                <datalist id="ai-model-suggestions">
                  {aiModelSuggestions.map((model) => <option key={model} value={model} />)}
                </datalist>
              </label>
              <label className="field-row field-column">
                <span>API Key</span>
                <input type="password" value={draft.apiKey} onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} placeholder={draft.id ? '留空保留' : '请输入密钥'} maxLength={4096} autoComplete="new-password" />
              </label>
              {!draft.id ? (
                <label className="settings-active-toggle">
                  <input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />
                  <span>设为当前</span>
                </label>
              ) : null}
            </div>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={() => setDraft(null)} disabled={busy}>取消</button>
              <button className="button-primary" type="button" onClick={() => { void saveDraft(); }} disabled={busy}>{busy ? '保存中' : '保存'}</button>
            </div>
          </section>
        </div>
      ) : null}

      {pendingDelete ? (
        <div className="sheet-backdrop" role="presentation">
          <section className="sheet" role="dialog" aria-modal="true" aria-labelledby="provider-delete-title">
            <h2 id="provider-delete-title">删除配置？</h2>
            <p className="sheet-message">{pendingDelete.name}的配置将被删除。</p>
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={() => setPendingDelete(null)} disabled={busy}>取消</button>
              <button className="button-danger" type="button" onClick={() => { void removeProfile(); }} disabled={busy}>删除</button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export default function App() {
  const [authState, setAuthState] = useState<'checking' | 'authenticated' | 'unauthenticated'>('checking');
  const [authUsername, setAuthUsername] = useState<string | null>(null);
  const [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const [colorMode, setColorMode] = useState<ColorMode>(storedColorMode);
  const [view, setView] = useState<'review' | 'materials' | 'import' | 'settings'>(() =>
    materialsRouteFromLocation() ? 'materials' : 'review');
  const [materialsRoute, setMaterialsRoute] = useState<MaterialsRoute>(() =>
    materialsRouteFromLocation() ?? { kind: 'courses' });
  const [reviewDashboard, setReviewDashboard] = useState<ReviewDashboardResponse | null>(null);
  const [reviewCard, setReviewCard] = useState<ReviewCardSummary | null>(null);
  const [reviewNavigation, setReviewNavigation] = useState<ReviewCardNavigation | null>(null);
  const [reviewFilters, setReviewFilters] = useState<ReviewFilters>({});
  const [showReviewFilters, setShowReviewFilters] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(true);
  const [reviewStatusSaving, setReviewStatusSaving] = useState(false);
  const [reviewHighlightSaving, setReviewHighlightSaving] = useState(false);
  const [reviewStatusMessage, setReviewStatusMessage] = useState('');
  const [reviewError, setReviewError] = useState('');
  const [hierarchy, setHierarchy] = useState<HierarchyResponse | null>(null);
  const [hierarchyTrash, setHierarchyTrash] = useState<HierarchyTrashResponse | null>(null);
  const [dataBackups, setDataBackups] = useState<DataBackupsResponse | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(false);
  const [hierarchyError, setHierarchyError] = useState('');
  const [importState, setImportState] = useState<ImportState>('idle');
  const [importFormat, setImportFormat] = useState<ImportFormat>('markdown');
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [correction, setCorrection] = useState<ImportCorrectionDocument | null>(null);
  const [importCorrecting, setImportCorrecting] = useState<Set<string>>(new Set());
  const [importCorrectionFeedback, setImportCorrectionFeedback] = useState<ImportCorrectionFeedback | null>(null);
  const importPreviewRevisionRef = useRef(0);
  const importPreviewIdRef = useRef<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [importDestination, setImportDestination] = useState({ courseId: '', subjectId: '' });
  const [questionImportTarget, setQuestionImportTarget] = useState<{ courseId: string; subjectId: string } | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    document.documentElement.dataset.appearance = appearance;
    try {
      window.localStorage.setItem(appearanceStorageKey, appearance);
    } catch {
      // 受限浏览器仍可在当前会话使用外观设置。
    }
  }, [appearance]);

  useEffect(() => {
    document.documentElement.dataset.colorMode = colorMode;
    document.documentElement.style.colorScheme = colorMode === 'system' ? '' : colorMode;
    try {
      window.localStorage.setItem(colorModeStorageKey, colorMode);
    } catch {
      // 受限浏览器仍可在当前会话使用显示模式。
    }
  }, [colorMode]);

  async function loadReviewDashboard() {
    setReviewLoading(true);
    setReviewError('');
    try {
      setReviewDashboard(await fetchReviewDashboard());
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '复习面板加载失败。');
    } finally {
      setReviewLoading(false);
    }
  }

  async function loadHierarchy() {
    setHierarchyLoading(true);
    setHierarchyError('');
    try {
      const [nextHierarchy, nextTrash, nextBackups] = await Promise.all([fetchHierarchy(), fetchHierarchyTrash(), fetchDataBackups()]);
      setHierarchy(nextHierarchy);
      setHierarchyTrash(nextTrash);
      setDataBackups(nextBackups);
    } catch (requestError) {
      setHierarchyError(requestError instanceof Error ? requestError.message : '资料加载失败。');
    } finally {
      setHierarchyLoading(false);
    }
  }

  async function loadHierarchyTrash() {
    try {
      setHierarchyTrash(await fetchHierarchyTrash());
    } catch (requestError) {
      setHierarchyError(requestError instanceof Error ? requestError.message : '回收站加载失败。');
    }
  }

  async function loadDataBackups() {
    try {
      setDataBackups(await fetchDataBackups());
    } catch (requestError) {
      setHierarchyError(requestError instanceof Error ? requestError.message : '备份加载失败。');
    }
  }

  useEffect(() => {
    void fetchAuthSession()
      .then((session) => {
        setAuthUsername(session.username);
        setAuthState(session.authenticated ? 'authenticated' : 'unauthenticated');
      })
      .catch(() => setAuthState('unauthenticated'));
  }, []);

  useEffect(() => {
    if (authState === 'authenticated') {
      void loadReviewDashboard();
    }
  }, [authState]);

  useEffect(() => {
    function synchronizeLocation() {
      const nextRoute = materialsRouteFromLocation();
      if (nextRoute) {
        setMaterialsRoute(nextRoute);
        setView('materials');
        setReviewCard(null);
      } else {
        setView('review');
      }
    }

    window.addEventListener('popstate', synchronizeLocation);
    window.addEventListener('hashchange', synchronizeLocation);
    return () => {
      window.removeEventListener('popstate', synchronizeLocation);
      window.removeEventListener('hashchange', synchronizeLocation);
    };
  }, []);

  const handleCatalogAuthExpired = useCallback(() => {
    void fetchAuthSession()
      .then((session) => {
        if (!session.authenticated) {
          setAuthUsername(null);
          setAuthState('unauthenticated');
        }
      })
      .catch(() => {
        setAuthUsername(null);
        setAuthState('unauthenticated');
      });
  }, []);

  if (authState === 'checking') {
    return <main className="auth-shell"><p className="feedback-muted">加载中</p></main>;
  }

  if (authState === 'unauthenticated') {
    return <LoginPanel onAuthenticated={(username) => { setAuthUsername(username); setAuthState('authenticated'); }} />;
  }

  async function handleLogout() {
    await logout();
    setAuthUsername(null);
    setAuthState('unauthenticated');
  }

  function navigateToMaterials(nextRoute: MaterialsRoute) {
    const nextUrl = materialsRouteUrl(nextRoute);
    if (window.location.hash !== nextUrl) {
      window.history.pushState(null, '', nextUrl);
    }
    setMaterialsRoute(nextRoute);
    setView('materials');
    setReviewCard(null);
  }

  function navigateToView(nextView: 'review' | 'import' | 'settings') {
    if (window.location.hash) {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
    }
    setView(nextView);
    setReviewCard(null);
  }

  async function handleStartReview(scope: ReviewStartScope, materialId?: string) {
    setReviewLoading(true);
    setReviewError('');
    setReviewStatusMessage('');
    try {
      const result = await startReview(scope, materialId);
      const filters: ReviewFilters = {
        materialId,
        statuses: scope === 'all' ? undefined : [scope],
      };
      setReviewFilters(filters);
      setReviewNavigation(result.navigation);
      setReviewCard(result.card);
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '没有可复习的闪卡。');
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleNavigateReviewCard(cardId: string) {
    setReviewLoading(true);
    setReviewError('');
    setReviewStatusMessage('');
    try {
      const result = await fetchReviewCard(cardId, reviewFilters);
      setReviewNavigation(result.navigation);
      setReviewCard(result.card);
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '闪卡加载失败。');
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleApplyReviewFilters(filters: ReviewFilters) {
    setReviewLoading(true);
    setReviewError('');
    setReviewStatusMessage('');
    try {
      const firstCard = await fetchFirstReviewCard(filters);
      setReviewFilters(filters);
      setReviewNavigation(firstCard.navigation);
      setReviewCard(firstCard.card);
      setShowReviewFilters(false);
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '筛选失败。');
    } finally {
      setReviewLoading(false);
    }
  }

  async function handleUpdateReviewStatus(status: ReviewMasteryStatus) {
    if (!reviewCard || reviewCard.masteryStatus === status) {
      return;
    }
    const nextCardId = reviewNavigation?.nextCardId;
    setReviewStatusSaving(true);
    setReviewStatusMessage('');
    setReviewError('');
    try {
      const updatedCard = await updateReviewStatus(reviewCard.id, status, reviewFilters);
      const activeCard = nextCardId
        ? await fetchReviewCard(nextCardId, reviewFilters)
        : updatedCard;
      const dashboard = await fetchReviewDashboard();
      setReviewCard(activeCard.card);
      setReviewNavigation(activeCard.navigation);
      setReviewDashboard(dashboard);
      setReviewStatusMessage('已保存');
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '状态保存失败。');
    } finally {
      setReviewStatusSaving(false);
    }
  }

  async function handleGenerateReviewExplanation(cardId: string, prompt: string, signal: AbortSignal): Promise<ReviewAiExplanation> {
    setReviewError('');
    setReviewStatusMessage('');
    const explanation = await generateReviewAiExplanation(cardId, prompt.trim() ? { prompt: prompt.trim() } : {}, signal);
    setReviewCard((current) => current && current.id === cardId ? { ...current, aiExplanation: explanation } : current);
    setReviewDashboard((current) => current
      ? {
          ...current,
          materials: current.materials.map((material) => material.continueCard?.id === cardId
            ? { ...material, continueCard: { ...material.continueCard, aiExplanation: explanation } }
            : material),
        }
      : current);
    setReviewStatusMessage('已生成');
    return explanation;
  }

  async function handleCreateReviewHighlights(requests: ReviewHighlightCreateRequest[]) {
    if (!reviewCard || requests.length === 0) {
      return;
    }
    setReviewHighlightSaving(true);
    setReviewError('');
    setReviewStatusMessage('');
    try {
      const results = await Promise.all(requests.map((request) => createReviewHighlight(reviewCard.id, request)));
      setReviewCard((current) => {
        if (!current || current.id !== reviewCard.id) {
          return current;
        }
        const highlights = current.highlights ?? [];
        const added = results.map((result) => result.highlight)
          .filter((highlight) => !highlights.some((existing) => existing.id === highlight.id));
        return added.length > 0 ? { ...current, highlights: [...highlights, ...added] } : { ...current, highlights };
      });
      setReviewStatusMessage('已保存');
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '高亮保存失败。');
    } finally {
      setReviewHighlightSaving(false);
    }
  }

  async function handleDeleteReviewHighlight(highlightId: string) {
    if (!reviewCard) {
      return;
    }
    setReviewHighlightSaving(true);
    setReviewError('');
    setReviewStatusMessage('');
    try {
      await deleteReviewHighlight(reviewCard.id, highlightId);
      setReviewCard((current) => current && current.id === reviewCard.id
        ? { ...current, highlights: (current.highlights ?? []).filter((highlight) => highlight.id !== highlightId) }
        : current);
      setReviewStatusMessage('已取消');
    } catch (requestError) {
      setReviewError(requestError instanceof Error ? requestError.message : '高亮取消失败。');
    } finally {
      setReviewHighlightSaving(false);
    }
  }

  async function handleUpdateReviewContent(request: ReviewCardContentUpdateRequest, lock: ReviewEditLock) {
    if (!reviewCard) {
      throw new Error('闪卡不存在。');
    }
    setReviewError('');
    setReviewStatusMessage('');
    const result = await updateReviewContent(reviewCard.id, request, lock);
    setReviewCard(result.card);
    setReviewDashboard((current) => current
      ? {
          ...current,
          materials: current.materials.map((material) => material.continueCard?.id === result.card.id
            ? { ...material, continueCard: result.card }
            : material),
        }
      : current);
    setReviewStatusMessage(result.invalidatedHighlightCount > 0
      ? `已保存，清除 ${result.invalidatedHighlightCount} 个重点`
      : '已保存');
    return result;
  }

  async function handleAcquireReviewEditLock(cardId: string) {
    return acquireReviewEditLock(cardId);
  }

  async function handleRenewReviewEditLock(cardId: string, lock: ReviewEditLock) {
    return renewReviewEditLock(cardId, lock);
  }

  async function handleReleaseReviewEditLock(cardId: string, lock: ReviewEditLock) {
    await releaseReviewEditLock(cardId, lock);
  }

  async function handleUploadReviewResource(file: File) {
    const result = await uploadReviewResource(file);
    return result.resource;
  }

  async function handleExportMaterial(materialId: string, materialName: string) {
    const response = await downloadMaterialMarkdown(materialId);
    const blob = await response.blob();
    saveDownload(blob, `${materialName || '资料'}.md`);
  }

  async function handleExportJson() {
    const payload = await fetchDataJsonExport();
    saveDownload(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'knowledge-flashcards.json');
  }

  async function handleRestoreJson(file: File) {
    let payload: unknown;
    try {
      payload = JSON.parse(await file.text());
    } catch {
      throw new Error('JSON 文件格式无效。');
    }
    await restoreDataJsonExport(payload as DataJsonExport);
    await Promise.all([loadHierarchy(), loadReviewDashboard()]);
    setReviewCard(null);
    setReviewNavigation(null);
  }

  async function handleCreateBackup() {
    await createDataBackup();
    await loadDataBackups();
  }

  async function handleRestoreBackup(backupId: string) {
    await restoreDataBackup(backupId);
    await Promise.all([loadHierarchy(), loadReviewDashboard()]);
    setReviewCard(null);
    setReviewNavigation(null);
  }

  async function handlePermanentDeleteTrashItem(trashItemId: string) {
    await permanentlyDeleteTrashItem(trashItemId);
  }

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) {
      return;
    }
    setSelectedFileName(file.name);
    setPreview(null);
    setImportCorrecting(new Set());
    setImportCorrectionFeedback(null);
    importPreviewRevisionRef.current = 0;
    importPreviewIdRef.current = null;
    setCorrection(null);
    setImportDestination({ courseId: '', subjectId: '' });
    setMessage('');
    setError('');
    setImportState('previewing');
    try {
      const result = await previewImport(file);
      setPreview(result);
      importPreviewRevisionRef.current = result.revision;
      importPreviewIdRef.current = result.previewId;
      setCorrection(result.document ? correctionFromPreview(result.document) : null);
      setImportState(result.valid ? 'ready' : 'error');
      if (result.duplicateMaterial) {
        setMessage(`已存在：${result.duplicateMaterial.name}，应用时将跳过。`);
      }
    } catch (requestError) {
      setImportState('error');
      setError(requestError instanceof Error ? requestError.message : '文件解析失败。');
    }
  }

  function handleImportFormatChange(nextFormat: ImportFormat) {
    if (nextFormat === importFormat || importState === 'previewing' || importState === 'applying') {
      return;
    }
    if (preview?.previewId) {
      void cancelImport(preview.previewId);
    }
    setImportFormat(nextFormat);
    setPreview(null);
    setImportCorrecting(new Set());
    setImportCorrectionFeedback(null);
    importPreviewRevisionRef.current = 0;
    importPreviewIdRef.current = null;
    setCorrection(null);
    setSelectedFileName(null);
    setImportDestination({ courseId: '', subjectId: '' });
    setMessage('');
    setError('');
    setImportState('idle');
  }

  async function handleDownloadImportTemplate(format: ImportTemplateFormat) {
    setError('');
    try {
      const response = await downloadImportTemplate(format);
      const blob = await response.blob();
      saveDownload(blob, format === 'json' ? 'knowledge-flashcards-template.json' : 'knowledge-flashcards-template.xlsx');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : '模板下载失败。');
    }
  }

  async function handleCancel() {
    if (preview?.previewId) {
      await cancelImport(preview.previewId);
    }
    setPreview(null);
    setImportCorrecting(new Set());
    setImportCorrectionFeedback(null);
    importPreviewRevisionRef.current = 0;
    importPreviewIdRef.current = null;
    setCorrection(null);
    setSelectedFileName(null);
    setImportDestination({ courseId: '', subjectId: '' });
    setMessage('');
    setError('');
    setImportState('idle');
  }

  async function handleAiImportCorrection(issueIndex: number, issueKey: string) {
    if (!preview?.previewId || !preview.aiCorrectionAvailable || importCorrecting.has(issueKey)) {
      return;
    }
    setImportCorrecting((current) => new Set(current).add(issueKey));
    setImportCorrectionFeedback(null);
    setError('');
    try {
      const result = await correctImportFormat({ previewId: preview.previewId, issueIndex });
      if (result.previewId !== preview.previewId || importPreviewIdRef.current !== preview.previewId || result.revision < importPreviewRevisionRef.current) {
        return;
      }
      importPreviewRevisionRef.current = result.revision;
      setPreview(result);
      setCorrection(result.document ? correctionFromPreview(result.document) : null);
      setImportState(result.valid ? 'ready' : 'error');
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'AI 格式修正失败。';
      setImportCorrectionFeedback({ issueKey, message });
    } finally {
      setImportCorrecting((current) => {
        const next = new Set(current);
        next.delete(issueKey);
        return next;
      });
    }
  }

  async function handleApply() {
    if (!preview?.previewId || !correction || !preview.valid) {
      return;
    }
    setImportState('applying');
    setError('');
    try {
      const result = await applyImport({
        previewId: preview.previewId,
        document: correction,
        ...importDestination,
        skipDuplicate: true,
      });
      if (result.status === 'applied') {
        setMessage(`已导入 ${result.materialName}，共 ${result.cardCount} 张闪卡。`);
      } else {
        setMessage(`已跳过：${result.material.name}。`);
      }
      setPreview(null);
      setCorrection(null);
      setSelectedFileName(null);
      setImportDestination({ courseId: '', subjectId: '' });
      setImportState('finished');
      await loadReviewDashboard();
    } catch (requestError) {
      const nextError = requestError instanceof Error ? requestError.message : '应用失败。';
      setError(nextError);
      if (nextError.includes('重新选择文件')) {
        setPreview(null);
        setCorrection(null);
        setSelectedFileName(null);
        setImportState('error');
        return;
      }
      setImportState('ready');
    }
  }

  const canApply = importState === 'ready' && Boolean(
    preview?.valid && preview.previewId && correction && importDestination.courseId && importDestination.subjectId,
  );
  const activeImportFormat = importFormatOptions.find((option) => option.value === importFormat) ?? importFormatOptions[0]!;
  const catalogRoute = materialsRoute.kind === 'manage' || materialsRoute.kind === 'question-banks' ? null : materialsRoute;

  return (
    <main className="app-shell">
      <section className="content">
        <nav className="app-nav" aria-label="主导航">
          <button className={`nav-item ${view === 'review' ? 'nav-item-active' : ''}`} type="button" onClick={() => { navigateToView('review'); void loadReviewDashboard(); }}>复习</button>
          <button className={`nav-item ${view === 'materials' ? 'nav-item-active' : ''}`} type="button" onClick={() => navigateToMaterials({ kind: 'courses' })}>资料</button>
          <button className={`nav-item ${view === 'import' ? 'nav-item-active' : ''}`} type="button" onClick={() => { setQuestionImportTarget(null); navigateToView('import'); }}>导入</button>
          <button className={`nav-item ${view === 'settings' ? 'nav-item-active' : ''}`} type="button" onClick={() => navigateToView('settings')}>设置</button>
        </nav>

        {view === 'review' ? (
          <ReviewPanel
            dashboard={reviewDashboard}
            card={reviewCard}
            navigation={reviewNavigation}
            loading={reviewLoading}
            statusSaving={reviewStatusSaving}
            statusMessage={reviewStatusMessage}
            error={reviewError}
            onRefresh={() => { void loadReviewDashboard(); }}
            onStart={handleStartReview}
            onNavigate={handleNavigateReviewCard}
            onUpdateStatus={handleUpdateReviewStatus}
            onGenerateExplanation={handleGenerateReviewExplanation}
            onCreateHighlights={handleCreateReviewHighlights}
            onDeleteHighlight={handleDeleteReviewHighlight}
            highlightSaving={reviewHighlightSaving}
            onUpdateContent={handleUpdateReviewContent}
            onAcquireEditLock={handleAcquireReviewEditLock}
            onRenewEditLock={handleRenewReviewEditLock}
            onReleaseEditLock={handleReleaseReviewEditLock}
            onUploadResource={handleUploadReviewResource}
            onShowFilters={() => setShowReviewFilters(true)}
            onBack={() => { setReviewCard(null); void loadReviewDashboard(); }}
          />
        ) : view === 'materials' && materialsRoute.kind === 'manage' ? (
          <HierarchyPanel
            hierarchy={hierarchy}
            trash={hierarchyTrash}
            backups={dataBackups}
            loading={hierarchyLoading}
            error={hierarchyError}
            onChange={setHierarchy}
            onRefresh={() => { void loadHierarchy(); }}
            onTrashRefresh={() => { void loadHierarchyTrash(); }}
            onBackupsRefresh={() => { void loadDataBackups(); }}
            onExportMaterial={handleExportMaterial}
            onExportJson={handleExportJson}
            onRestoreJson={handleRestoreJson}
            onCreateBackup={handleCreateBackup}
            onRestoreBackup={handleRestoreBackup}
            onPermanentDeleteTrashItem={handlePermanentDeleteTrashItem}
            onBrowseCatalog={() => navigateToMaterials({ kind: 'courses' })}
          />
        ) : view === 'materials' && materialsRoute.kind === 'question-banks' ? (
          <QuestionBankPanel
            route={materialsRoute}
            onNavigate={navigateToMaterials}
            onOpenImport={() => { setQuestionImportTarget({ courseId: materialsRoute.courseId, subjectId: materialsRoute.subjectId }); navigateToView('import'); }}
            onAuthExpired={handleCatalogAuthExpired}
          />
        ) : view === 'materials' && catalogRoute ? (
          <CatalogPanel
            route={catalogRoute}
            onNavigate={navigateToMaterials}
            onOpenManage={() => { navigateToMaterials({ kind: 'manage' }); void loadHierarchy(); }}
            onAuthExpired={handleCatalogAuthExpired}
          />
        ) : view === 'import' && questionImportTarget ? (
          <QuestionImportPanel
            target={questionImportTarget}
            onBack={() => { setQuestionImportTarget(null); navigateToMaterials({ kind: 'question-banks', ...questionImportTarget }); }}
          />
        ) : view === 'settings' ? (
          <AiProviderSettingsPanel
            appearance={appearance}
            onAppearanceChange={setAppearance}
            colorMode={colorMode}
            onColorModeChange={setColorMode}
            authUsername={authUsername}
            onLogout={() => { void handleLogout(); }}
          />
        ) : (
        <section aria-labelledby="page-title">
        <header className="page-header">
          <div>
            <p className="eyebrow">知识闪卡</p>
            <h1 id="page-title">导入</h1>
          </div>
          <div className="header-actions import-header-actions">
            <div className="import-format-control" role="group" aria-label="导入格式">
              {importFormatOptions.map((option) => (
                <button
                  className={`import-format-button ${option.value === importFormat ? 'import-format-button-active' : ''}`}
                  type="button"
                  key={option.value}
                  aria-pressed={option.value === importFormat}
                  disabled={importState === 'previewing' || importState === 'applying'}
                  onClick={() => handleImportFormatChange(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            {importFormat !== 'markdown' ? (
              <button
                className="icon-button"
                type="button"
                title={`下载 ${activeImportFormat.label} 模板`}
                aria-label={`下载 ${activeImportFormat.label} 模板`}
                onClick={() => { void handleDownloadImportTemplate(importFormat); }}
              >
                <Download size={18} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
            <label className="file-button header-upload-button" aria-label="选择文件" title="选择文件">
              <Upload size={20} aria-hidden="true" />
              <input type="file" accept={activeImportFormat.accept} onChange={handleFileChange} />
            </label>
          </div>
        </header>

        <div className="feedback" aria-live="polite">
          {importState === 'previewing' ? <p className="feedback-muted">解析中</p> : null}
          {importState === 'applying' ? <p className="feedback-muted">应用中</p> : null}
          {message ? <p className="feedback-success">{message}</p> : null}
          {error ? <p className="feedback-error">{error}</p> : null}
        </div>

        {selectedFileName && preview ? (
          <section className="preview-panel" aria-labelledby="preview-title">
            <div className="section-heading preview-heading">
              <div>
                <h2 id="preview-title">预览</h2>
                <p className="file-name">{preview.sourceFileName}</p>
              </div>
              <span className={`validity validity-${preview.valid ? 'valid' : 'invalid'}`}>
                {preview.valid ? '可应用' : '不可应用'}
              </span>
            </div>
            <IssueList
              preview={preview}
              correcting={importCorrecting}
              feedback={importCorrectionFeedback}
              onCorrect={(issueIndex, issueKey) => { void handleAiImportCorrection(issueIndex, issueKey); }}
            />
            <ImportDestinationPicker
              courseId={importDestination.courseId}
              subjectId={importDestination.subjectId}
              disabled={importState === 'applying'}
              onChange={setImportDestination}
            />
            {preview.resources.length > 0 ? (
              <section className="resource-section" aria-labelledby="resource-title">
                <div className="section-heading">
                  <h2 id="resource-title">资源</h2>
                  <span className="resource-count">{preview.resources.length}</span>
                </div>
                <ul className="resource-list">
                  {preview.resources.map((resource) => (
                    <li key={resource.relativePath}>
                      <span>{resource.relativePath}</span>
                      <small>{resource.mimeType} · {resource.byteLength} B</small>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            {correction ? (
              <PreviewTree
                preview={preview}
                correction={correction}
                onCorrectionChange={setCorrection}
              />
            ) : null}
            <div className="action-row">
              <button className="button-secondary" type="button" onClick={handleCancel} disabled={importState === 'applying'}>
                取消
              </button>
              <button className="button-primary" type="button" onClick={handleApply} disabled={!canApply}>
                应用
              </button>
            </div>
          </section>
        ) : null}

        {!selectedFileName && (importState === 'idle' || importState === 'finished' || importState === 'error') ? (
          <p className="empty-state">选择一个资料文件</p>
        ) : null}
        </section>
        )}
        {showReviewFilters && reviewDashboard ? (
          <ReviewFilterSheet
            dashboard={reviewDashboard}
            initialFilters={reviewFilters}
            onApply={(filters) => { void handleApplyReviewFilters(filters); }}
            onClose={() => setShowReviewFilters(false)}
          />
        ) : null}
      </section>
    </main>
  );
}
