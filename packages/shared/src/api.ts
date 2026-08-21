export const healthCheckPath = '/api/health';

export interface HealthResponse {
  service: 'api';
  status: 'ok';
  timestamp: string;
  uptimeSeconds: number;
}

export interface ErrorResponse {
  error: string;
}

export const authLoginPath = '/api/auth/login';
export const authSessionPath = '/api/auth/session';
export const authLogoutPath = '/api/auth/logout';

export interface AuthSessionResponse {
  authenticated: boolean;
  username: string | null;
  expiresAt: string | null;
}

export interface AuthLoginRequest {
  username: string;
  password: string;
}

export const importPreviewPath = '/api/import/preview';
export const importApplyPath = '/api/import/apply';
export const importTemplatePath = '/api/import/templates';
export const importAiCorrectionPath = '/api/import/ai-correction';

export type ImportSourceType = 'markdown' | 'zip' | 'json' | 'excel';
export type ImportTemplateFormat = 'json' | 'excel';

export interface ImportSourceLocation {
  fileName: string;
  line: number;
  column: number;
}

export interface ImportIssueResponse {
  code: string;
  message: string;
  suggestion: string;
  location: ImportSourceLocation;
  context: string[];
}

export interface ImportPreviewCard {
  title: string;
  location: ImportSourceLocation;
  bodyText: string;
}

export interface ImportPreviewSection {
  title: string;
  location: ImportSourceLocation;
  cards: ImportPreviewCard[];
}

export interface ImportPreviewChapter {
  title: string;
  location: ImportSourceLocation;
  sections: ImportPreviewSection[];
}

export interface ImportPreviewDocument {
  title: string;
  location: ImportSourceLocation;
  chapters: ImportPreviewChapter[];
}

export interface ImportCorrectionCard {
  title: string;
  bodyText: string;
}

export interface ImportCorrectionSection {
  title: string;
  cards: ImportCorrectionCard[];
}

export interface ImportCorrectionChapter {
  title: string;
  sections: ImportCorrectionSection[];
}

export interface ImportCorrectionDocument {
  title: string;
  chapters: ImportCorrectionChapter[];
}

export interface ImportResourcePreview {
  relativePath: string;
  byteLength: number;
  mimeType: string;
}

export interface ImportDuplicateMaterial {
  id: string;
  name: string;
  importedAt: string | null;
}

export interface ImportPreviewResponse {
  previewId: string | null;
  revision: number;
  sourceFileName: string;
  sourceType: ImportSourceType | null;
  markdownFileName: string | null;
  sourceSha256: string;
  valid: boolean;
  duplicate: boolean;
  duplicateMaterial: ImportDuplicateMaterial | null;
  document: ImportPreviewDocument | null;
  resources: ImportResourcePreview[];
  issues: ImportIssueResponse[];
  aiCorrectionAvailable: boolean;
}

export interface ImportAiCorrectionRequest {
  previewId: string;
  issueIndex: number;
}

export interface ImportApplyRequest {
  previewId: string;
  document: ImportCorrectionDocument;
  courseId: string;
  subjectId: string;
  skipDuplicate?: boolean;
}

export interface ImportAppliedResponse {
  status: 'applied';
  materialId: string;
  materialName: string;
  chapterCount: number;
  sectionCount: number;
  cardCount: number;
  resourceCount: number;
}

export interface ImportSkippedResponse {
  status: 'skipped';
  reason: 'duplicate';
  material: ImportDuplicateMaterial;
}

export type ImportApplyResponse = ImportAppliedResponse | ImportSkippedResponse;

export const questionImportPreviewPath = '/api/question-import/preview';
export const questionImportApplyPath = '/api/question-import/apply';
export const questionImportTemplatePath = '/api/question-import/templates';

export type QuestionImportSourceType = 'json' | 'excel';
export type QuestionImportTemplateFormat = 'json' | 'excel';

export interface QuestionImportSourceLocation {
  fileName: string;
  line: number;
  column: number;
}

export interface QuestionImportIssueResponse {
  code: string;
  message: string;
  suggestion: string;
  location: QuestionImportSourceLocation;
  context: string[];
}

export interface QuestionImportPreviewOption {
  key: string;
  text: string;
}

export interface QuestionImportPreviewQuestion {
  stemText: string;
  type: QuestionType;
  options: QuestionImportPreviewOption[];
  answer: string[];
  analysisText: string | null;
  knowledgePoints: string[];
  location: QuestionImportSourceLocation;
}

export interface QuestionImportPreviewChapter {
  title: string;
  location: QuestionImportSourceLocation;
  questions: QuestionImportPreviewQuestion[];
}

export interface QuestionImportPreviewDocument {
  title: string;
  kind: QuestionBankKind;
  chapters: QuestionImportPreviewChapter[];
  questions: QuestionImportPreviewQuestion[];
}

export interface QuestionImportDuplicateQuestionBank {
  id: string;
  name: string;
}

export interface QuestionImportPreviewResponse {
  previewId: string | null;
  sourceFileName: string;
  sourceType: QuestionImportSourceType | null;
  sourceSha256: string;
  courseId: string;
  subjectId: string;
  kind: QuestionBankKind;
  valid: boolean;
  duplicate: boolean;
  duplicateQuestionBank: QuestionImportDuplicateQuestionBank | null;
  document: QuestionImportPreviewDocument | null;
  issues: QuestionImportIssueResponse[];
}

export interface QuestionImportApplyRequest {
  previewId: string;
}

export interface QuestionImportAppliedResponse {
  questionBankId: string;
  questionBankName: string;
  kind: QuestionBankKind;
  questionChapterCount: number;
  questionCount: number;
}

export const reviewDashboardPath = '/api/review/dashboard';
export const reviewWorkspacePath = '/api/review/workspace';
export const learningInsightsPath = '/api/review/insights';
export const reviewStartPath = '/api/review/start';
export const reviewCardPath = '/api/review/cards';
export const reviewCardsPath = '/api/review/cards';
export const reviewCardNotesPath = '/api/review/cards';
export const reviewResourcePath = '/api/review/resources';
export const reviewCardHighlightPath = '/api/review/cards';
export const reviewCardExplanationPath = '/api/review/cards';
export const studyAssistantPath = '/api/study-assistant';

export type ReviewStartScope = 'all' | 'unassessed' | 'effort';
export type ReviewMasteryStatus = 'unassessed' | 'mastered' | 'familiar' | 'effort';
export type ReviewHighlightKind = 'text' | 'formula';

export interface ReviewTextHighlightAnchor {
  nodePath: string;
  start: number;
  end: number;
}

export interface ReviewFormulaHighlightAnchor {
  nodePath: string;
}

export type ReviewHighlightAnchor = ReviewTextHighlightAnchor | ReviewFormulaHighlightAnchor;

export interface ReviewHighlight {
  id: string;
  kind: ReviewHighlightKind;
  anchor: ReviewHighlightAnchor;
}

export interface ReviewHighlightCreateRequest {
  kind: ReviewHighlightKind;
  anchor: ReviewHighlightAnchor;
}

export interface ReviewHighlightResponse {
  highlight: ReviewHighlight;
}

export interface ReviewAiExplanation {
  provider: string;
  model: string;
  promptText: string;
  content: string;
  generatedAt: string;
}

export interface ReviewAiExplanationGenerateRequest {
  prompt?: string;
}

export interface ReviewAiExplanationResponse {
  explanation: ReviewAiExplanation;
}

export interface StudyAssistantAskRequest {
  prompt: string;
}

export interface StudyAssistantResponse {
  content: string;
}

export type StudyAssistantStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'done' }
  | { type: 'error'; error: string };

export interface ReviewContentNode {
  type: string;
  value?: string;
  url?: string;
  resourceId?: string;
  resourcePath?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  meta?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  display?: boolean;
  align?: Array<'left' | 'center' | 'right' | null>;
  header?: boolean;
  rowSpan?: number;
  colSpan?: number;
  children?: ReviewContentNode[];
}

export interface ReviewFilters {
  materialId?: string;
  statuses?: ReviewMasteryStatus[];
}

export interface ReviewCardSummary {
  id: string;
  title: string;
  materialId: string;
  materialName: string;
  chapterTitle: string;
  sectionTitle: string;
  bodyText: string;
  content?: ReviewContentNode[];
  highlights?: ReviewHighlight[];
  aiExplanation?: ReviewAiExplanation | null;
  masteryStatus: ReviewMasteryStatus;
  review: ReviewRecordSummary;
}

export interface ReviewRecordSummary {
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  statusChangedAt: string | null;
  viewCount: number;
}

export interface ReviewMaterialSummary {
  id: string;
  name: string;
  cardCount: number;
  masteredCount: number;
  familiarCount: number;
  unassessedCount: number;
  effortCount: number;
  continueCard: ReviewCardSummary | null;
}

export interface ReviewDashboardResponse {
  counts: {
    materialCount: number;
    cardCount: number;
    unassessedCount: number;
    effortCount: number;
  };
  materials: ReviewMaterialSummary[];
}

export type ReviewWorkspaceMode = 'flashcards' | 'questions';

export interface ReviewWorkspaceContext {
  courseId: string;
  subjectId: string | null;
  mode: ReviewWorkspaceMode;
  expandedMaterialId: string | null;
}

export interface ReviewWorkspaceCourseSummary {
  id: string;
  name: string;
  isSystem: boolean;
  subjectCount: number;
  materialCount: number;
  flashcardCount: number;
  questionBankCount: number;
  questionCount: number;
  hasContinue: boolean;
}

export interface ReviewWorkspaceSubjectSummary {
  id: string;
  courseId: string;
  name: string;
  isSystem: boolean;
  materialCount: number;
  flashcardCount: number;
  questionBankCount: number;
  questionCount: number;
}

export interface ReviewWorkspaceMaterialSummary {
  id: string;
  subjectId: string;
  name: string;
  cardCount: number;
  masteredCount: number;
  familiarCount: number;
  effortCount: number;
  unassessedCount: number;
  lastCardId: string | null;
  lastCardTitle: string | null;
  lastViewedAt: string | null;
  cover: CatalogMaterialCover | null;
}

export interface ReviewWorkspaceQuestionBankSummary {
  id: string;
  subjectId: string;
  kind: QuestionBankKind;
  name: string;
  questionCount: number;
  chapterCount: number;
  chapters: Array<{
    id: string;
    title: string;
    questionCount: number;
  }>;
  inProgressCount: number;
  latestSessionId: string | null;
  latestSessionMode: PracticeMode | null;
  latestSessionUpdatedAt: string | null;
}

export interface ReviewWorkspaceFavoritePracticeSummary {
  subjectId: string;
  questionCount: number;
  inProgressCount: number;
  latestSessionId: string | null;
  latestSessionMode: PracticeMode | null;
  latestSessionUpdatedAt: string | null;
}

export type ReviewWorkspaceContinue =
  | {
      kind: 'flashcard';
      courseId: string;
      subjectId: string;
      materialId: string;
      cardId: string;
      materialName: string;
      cardTitle: string;
      updatedAt: string;
    }
  | {
      kind: 'practice';
      courseId: string;
      subjectId: string;
      questionBankId: string | null;
      questionBankName: string;
      sessionId: string;
      mode: PracticeMode;
      source: PracticeSource;
      updatedAt: string;
    };

export interface ReviewWorkspaceResponse {
  context: ReviewWorkspaceContext;
  courses: ReviewWorkspaceCourseSummary[];
  currentCourse: ReviewWorkspaceCourseSummary;
  subjects: ReviewWorkspaceSubjectSummary[];
  flashcards: {
    materialCount: number;
    cardCount: number;
    unassessedCount: number;
    effortCount: number;
    materials: ReviewWorkspaceMaterialSummary[];
  };
  questions: {
    questionBankCount: number;
    questionCount: number;
    inProgressCount: number;
    aggregateWrongCount: number;
    banks: ReviewWorkspaceQuestionBankSummary[];
    favorites: ReviewWorkspaceFavoritePracticeSummary[];
  };
  continue: ReviewWorkspaceContinue | null;
}

export interface ReviewWorkspaceContextUpdateRequest {
  courseId: string;
  subjectId: string | null;
  mode: ReviewWorkspaceMode;
  expandedMaterialId: string | null;
}

export type LearningInsightsPeriod = 7 | 30;

export interface LearningInsightsResponse {
  periodDays: LearningInsightsPeriod;
  timezone: 'Asia/Shanghai';
  from: string;
  to: string;
  flashcards: {
    reviewedCount: number;
    daily: Array<{ date: string; count: number }>;
  };
  masteryChanges: {
    total: number;
    daily: Array<{ date: string; count: number }>;
    byStatus: Record<ReviewMasteryStatus, number>;
  };
  practice: {
    answeredCount: number;
    correctCount: number;
    incorrectCount: number;
    accuracy: number | null;
    daily: Array<{ date: string; answeredCount: number; correctCount: number }>;
  };
  weakKnowledgePoints: Array<{
    knowledgePoint: string;
    answeredCount: number;
    incorrectCount: number;
    accuracy: number;
  }>;
}

export interface ReviewCardResponse {
  card: ReviewCardSummary;
  navigation: ReviewCardNavigation;
}

export interface ReviewCardNavigation {
  previousCardId: string | null;
  nextCardId: string | null;
  currentIndex: number;
  total: number;
}

export interface ReviewCardContentUpdateRequest {
  title: string;
  content: ReviewContentNode[];
}

export interface ReviewCardContentUpdateResponse {
  card: ReviewCardSummary;
  invalidatedHighlightCount: number;
}

export interface ReviewEditLock {
  lockToken: string;
  expiresAt: string;
}

export interface ReviewEditLockResponse {
  lock: ReviewEditLock;
}

export interface ReviewResourceUploadResponse {
  resource: {
    id: string;
    mimeType: string;
  };
}

export interface ReviewCardsResponse {
  cards: ReviewCardNavigationItem[];
  currentIndex: number;
}

export interface ReviewCardNavigationItem {
  id: string;
}

export interface ReviewStatusUpdateRequest {
  status: ReviewMasteryStatus;
}

export const reviewCardStatusPath = '/api/review/cards';

export const globalSearchPath = '/api/search';
export type GlobalSearchContentType = 'material' | 'card' | 'question';

export interface GlobalSearchFilters {
  query: string;
  courseId?: string;
  subjectId?: string;
  types?: GlobalSearchContentType[];
}

export interface GlobalSearchResult {
  type: GlobalSearchContentType;
  id: string;
  title: string;
  summary: string;
  course: { id: string; name: string };
  subject: { id: string; name: string };
  materialId: string | null;
  cardId: string | null;
  questionBankId: string | null;
  questionId: string | null;
}

export interface GlobalSearchResponse {
  query: string;
  resultLimitPerType: number;
  results: GlobalSearchResult[];
}

export const hierarchyPath = '/api/hierarchy';
export const hierarchyTrashPath = '/api/trash';

export const catalogPath = '/api/catalog';
export const catalogCoursesPath = '/api/catalog/courses';
export const catalogSubjectsPath = '/api/catalog/subjects';
export const catalogMaterialsPath = '/api/catalog/materials';
export const questionBanksPath = '/api/question-banks';
export const questionChaptersPath = '/api/question-chapters';
export const questionsPath = '/api/questions';
export const questionFavoritePath = '/api/questions';
export const questionReviewNotesPath = '/api/questions';
export const questionAiExplanationsPath = '/api/question-ai-explanations';
export const practiceSessionsPath = '/api/practice/sessions';
export const practiceQuestionBanksPath = '/api/practice/question-banks';
export const practiceSubjectFavoritesPath = '/api/practice/subjects';
export const wrongAnswerReviewPath = '/api/practice/wrong-answers';

export type CatalogSortDirection = 'up' | 'down';

export interface CatalogCourse {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  subjectCount: number;
}

export interface CatalogSubject {
  id: string;
  courseId: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  materialCount: number;
}

export interface CatalogResource {
  id: string;
  mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  width: number | null;
  height: number | null;
  sha256: string;
}

export interface CatalogMaterialCover {
  id: string;
  original: CatalogResource;
  thumbnail: CatalogResource;
}

export interface CatalogMaterialCard {
  id: string;
  courseId: string;
  subjectId: string;
  name: string;
  cardCount: number;
  cover: CatalogMaterialCover | null;
}

export interface CatalogCoursesResponse {
  courses: CatalogCourse[];
}

export interface CatalogCourseSubjectsResponse {
  course: CatalogCourse;
  subjects: CatalogSubject[];
}

export interface CatalogSubjectResponse {
  course: CatalogCourse;
  subject: CatalogSubject;
  materials: CatalogMaterialCard[];
}

export interface CatalogMasteryDistribution {
  mastered: number;
  familiar: number;
  effort: number;
  unassessed: number;
}

export interface CatalogStatusTrendPoint extends CatalogMasteryDistribution {
  date: string;
}

export interface CatalogMaterialDetail extends CatalogMaterialCard {
  chapters: HierarchyChapter[];
  masteryDistribution: CatalogMasteryDistribution;
  statusTrend: CatalogStatusTrendPoint[];
}

export interface CatalogMaterialResponse {
  material: CatalogMaterialDetail;
}

export interface CatalogCreateCourseRequest {
  name: string;
}

export interface CatalogUpdateCourseRequest {
  name: string;
}

export interface CatalogCreateSubjectRequest {
  courseId: string;
  name: string;
}

export interface CatalogUpdateSubjectRequest {
  name: string;
}

export interface CatalogMoveSubjectRequest {
  courseId: string;
}

export interface CatalogReorderRequest {
  direction: CatalogSortDirection;
}

export interface CatalogUpdateMaterialRequest {
  name: string;
}

export interface CatalogMaterialCoverUploadResponse {
  cover: CatalogMaterialCover;
}

export interface CatalogMutationResponse {
  courses: CatalogCourse[];
}

export interface QuestionBankSummary {
  id: string;
  subjectId: string;
  kind: QuestionBankKind;
  name: string;
  sortOrder: number;
  questionCount: number;
  chapterCount: number;
}

export interface QuestionChapterSummary {
  id: string;
  questionBankId: string;
  title: string;
  sortOrder: number;
  questionCount: number;
}

export interface QuestionBankDirectoryItem extends QuestionBankSummary {
  chapters: QuestionChapterSummary[];
}

export interface QuestionBankDirectoryResponse {
  course: CatalogCourse;
  subject: CatalogSubject;
  banks: Record<QuestionBankKind, QuestionBankDirectoryItem[]>;
}

export interface QuestionBankCreateRequest {
  subjectId: string;
  kind: QuestionBankKind;
  name: string;
}

export interface QuestionBankRenameRequest {
  name: string;
}

export interface QuestionBankReorderRequest {
  direction: CatalogSortDirection;
}

export interface QuestionBankMoveChapterRequest {
  questionBankId: string;
}

export interface QuestionChapterCreateRequest {
  questionBankId: string;
  title: string;
}

export interface QuestionChapterRenameRequest {
  title: string;
}

export interface QuestionChapterReorderRequest {
  direction: CatalogSortDirection;
}

export interface QuestionBankMutationResponse {
  directory: QuestionBankDirectoryResponse;
}

export interface QuestionBankTrashItem {
  entityType: 'question_bank' | 'question_chapter';
  entityId: string;
  title: string;
  deletedAt: string;
}

export interface QuestionBankTrashResponse {
  items: QuestionBankTrashItem[];
}

export interface QuestionQuestion {
  id: string;
  questionBankId: string;
  questionChapterId: string | null;
  stem: ReviewContentNode[];
  type: QuestionType;
  options: QuestionOptionContent[];
  answer: string[];
  analysis: ReviewContentNode[] | null;
  knowledgePoints: string[];
  isFavorite: boolean;
  version: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  reviewNote: string | null;
}

export interface HandwrittenPoint {
  x: number;
  y: number;
}

export interface HandwrittenStroke {
  points: HandwrittenPoint[];
}

export interface CardReviewNote {
  cardId: string;
  noteText: string;
  strokes: HandwrittenStroke[];
  updatedAt: string;
}

export interface CardReviewNoteUpdateRequest {
  noteText: string;
  strokes: HandwrittenStroke[];
}

export interface QuestionReviewNote {
  questionId: string;
  noteText: string;
  strokes: HandwrittenStroke[];
  updatedAt: string;
}

export interface QuestionReviewNoteUpdateRequest {
  noteText?: string;
  strokes?: HandwrittenStroke[];
}

export interface WrongAnswerFilterRequest {
  subjectId: string;
  knowledgePoint?: string;
  type?: QuestionType;
  since?: string;
}

export interface WrongAnswerFilterResponse {
  subjectId: string;
  items: Array<{
    question: QuestionQuestion;
    knowledgePoints: string[];
    latestWrongAt: string;
    note: QuestionReviewNote | null;
  }>;
}

export interface QuestionAiExplanation {
  id: string;
  questionId: string;
  questionVersion: number;
  provider: string;
  model: string;
  promptText: string;
  content: string;
  generatedAt: string;
  stale: boolean;
}

export interface QuestionAiExplanationAttemptContext {
  answer: string[] | null;
  result: PracticeAttemptResult;
}

export interface QuestionAiExplanationGenerateRequest {
  prompt?: string;
  attempt?: QuestionAiExplanationAttemptContext;
}

export interface QuestionAiExplanationResponse {
  explanation: QuestionAiExplanation;
}

export interface QuestionAiExplanationHistoryResponse {
  questionId: string;
  currentQuestionVersion: number;
  explanations: QuestionAiExplanation[];
}

export interface QuestionBankQuestionsResponse {
  bank: QuestionBankSummary;
  chapters: QuestionChapterSummary[];
  questions: QuestionQuestion[];
}

export interface QuestionCreateRequest {
  questionBankId: string;
  questionChapterId: string | null;
  stem: ReviewContentNode[];
  type: QuestionType;
  options: QuestionOptionContent[];
  answer: string[];
  analysis: ReviewContentNode[] | null;
  knowledgePoints: string[];
}

export type QuestionUpdateRequest = Omit<QuestionCreateRequest, 'questionBankId'> & { questionBankId?: string };

export interface QuestionMoveRequest {
  questionBankId: string;
  questionChapterId: string | null;
}

export interface QuestionReorderRequest {
  direction: CatalogSortDirection;
}

export interface QuestionMutationResponse {
  questions: QuestionBankQuestionsResponse;
}

export interface QuestionFavoriteUpdateRequest {
  isFavorite: boolean;
}

export interface QuestionTrashItem {
  id: string;
  questionBankId: string;
  questionChapterId: string | null;
  title: string;
  type: QuestionType;
  deletedAt: string;
}

export interface QuestionTrashResponse {
  items: QuestionTrashItem[];
}

export interface PracticeAttemptView {
  questionId: string;
  questionVersion: number;
  answer: string[] | null;
  result: PracticeAttemptResult;
  answeredAt: string | null;
}

export interface PracticeQuestionView {
  id: string;
  questionChapterId: string | null;
  isFavorite: boolean;
  stem: ReviewContentNode[];
  type: QuestionType;
  options: QuestionOptionContent[];
  analysis: ReviewContentNode[] | null;
  reviewNote: QuestionReviewNote | null;
  attempt: PracticeAttemptView;
  correctAnswer?: string[];
}

export interface PracticeSessionSummary {
  id: string;
  questionBankId: string | null;
  subjectId: string | null;
  questionChapterId: string | null;
  mode: PracticeMode;
  source: PracticeSource;
  status: PracticeSessionStatus;
  questionCount: number;
  answeredCount: number;
  currentIndex: number;
  startedAt: string;
  completedAt: string | null;
  updatedAt: string;
}

export interface PracticeSessionResponse {
  session: PracticeSessionSummary;
  questions: PracticeQuestionView[];
  result?: PracticeResultSummary;
}

export interface PracticeAnswerResponse {
  session: PracticeSessionSummary;
  question: PracticeQuestionView;
}

export interface PracticeSessionListResponse {
  sessions: PracticeSessionSummary[];
}

export interface PracticeSessionStartRequest {
  questionBankId: string;
  questionChapterId: string | null;
  mode: PracticeMode;
  source?: PracticeSource;
  sourceSessionId?: string | null;
  questionCount?: number | null;
  shuffle?: boolean;
  unattemptedOnly?: boolean;
}

export interface PracticeSessionOptions {
  questionCount?: number | null;
  shuffle?: boolean;
  unattemptedOnly?: boolean;
}

export interface PracticeFavoriteSessionStartRequest extends PracticeSessionOptions {
  subjectId: string;
  mode: PracticeMode;
}

export interface WrongAnswerPracticeStartRequest extends WrongAnswerFilterRequest, PracticeSessionOptions { mode: PracticeMode; }

export interface PracticeAnswerRequest {
  answer: string[];
}

export interface PracticeResultSummary {
  questionCount: number;
  answeredCount: number;
  unansweredCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracy: number | null;
}

export interface PracticeStatisticsLine extends PracticeResultSummary {
  key: string;
  label: string;
  latestCompletedAt: string | null;
}

export interface PracticeStatisticsResponse {
  bank: QuestionBankSummary;
  overall: PracticeStatisticsLine;
  chapters: Array<PracticeStatisticsLine & { id: string }>;
  types: Array<PracticeStatisticsLine & { type: QuestionType }>;
  modes: Array<PracticeStatisticsLine & { mode: PracticeMode }>;
  aggregateWrongCount: number;
}

export const aiProviderProfilesPath = '/api/settings/ai-providers';

export type AiProviderKind = 'openai' | 'deepseek' | 'openrouter' | 'custom';

export interface AiProviderProfile {
  id: string;
  name: string;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  isActive: boolean;
  priority: number;
}

export interface AiProviderProfilesResponse {
  profiles: AiProviderProfile[];
}

export interface AiProviderConnectionTestResponse {
  message: string;
}

export interface AiProviderProfileCreateRequest {
  name: string;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  isActive: boolean;
}

export interface AiProviderProfileUpdateRequest {
  name: string;
  provider: AiProviderKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface AiProviderProfileStateUpdateRequest {
  isActive: boolean;
}

export interface AiProviderProfilesReorderRequest {
  profileIds: string[];
}

export type HierarchyEntityType = 'material' | 'chapter' | 'section' | 'card';
export type HierarchySortDirection = 'up' | 'down';

export interface HierarchyCard {
  id: string;
  title: string;
  sortOrder: number;
}

export interface HierarchySection {
  id: string;
  title: string;
  sortOrder: number;
  cards: HierarchyCard[];
}

export interface HierarchyChapter {
  id: string;
  title: string;
  sortOrder: number;
  sections: HierarchySection[];
}

export interface HierarchyMaterial {
  id: string;
  name: string;
  chapters: HierarchyChapter[];
}

export interface HierarchyResponse {
  materials: HierarchyMaterial[];
}

export interface HierarchyCreateRequest {
  entityType: Exclude<HierarchyEntityType, 'material'>;
  parentId: string;
  title: string;
}

export interface HierarchyRenameRequest {
  title: string;
}

export interface HierarchyMoveRequest {
  parentId: string;
}

export interface HierarchyReorderRequest {
  direction: HierarchySortDirection;
}

export interface HierarchyMutationResponse {
  hierarchy: HierarchyResponse;
}

export interface HierarchyTrashItem {
  id: string;
  entityType: HierarchyEntityType;
  entityId: string;
  title: string;
  deletedAt: string;
  expiresAt: string | null;
}

export interface HierarchyTrashResponse {
  items: HierarchyTrashItem[];
}

export const dataMarkdownExportPath = '/api/data/export/markdown';
export const dataJsonExportPath = '/api/data/export/json';
export const dataJsonRestorePath = '/api/data/restore/json';
export const dataBackupsPath = '/api/data/backups';
export const hierarchyTrashPermanentPath = '/api/trash';

export interface DataExportMaterial {
  id: string;
  name: string;
  sourceFilename: string;
  sourceSha256: string;
  importedAt: string;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  subjectId?: string;
}

export interface DataExportCourse {
  id: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportSubject {
  id: string;
  courseId: string;
  name: string;
  sortOrder: number;
  isSystem: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportMaterialCover {
  id: string;
  materialId: string;
  originalResourceId: string;
  thumbnailResourceId: string;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportReviewStatusHistory {
  id: string;
  cardId: string;
  fromStatus: ReviewMasteryStatus | null;
  toStatus: ReviewMasteryStatus;
  changedAt: string;
  source: 'import' | 'review' | 'migration' | 'restore';
}

export interface DataExportChapter {
  id: string;
  materialId: string;
  title: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportSection {
  id: string;
  chapterId: string;
  title: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportCard {
  id: string;
  sectionId: string;
  title: string;
  content: ReviewContentNode[];
  masteryStatus: ReviewMasteryStatus;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportResource {
  id: string;
  relativePath: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sha256: string;
  createdAt: string;
  deletedAt: string | null;
  contentBase64: string | null;
}

export interface DataExportHighlight {
  id: string;
  cardId: string;
  kind: ReviewHighlightKind;
  anchor: ReviewHighlightAnchor;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportReviewRecord {
  cardId: string;
  firstViewedAt: string | null;
  lastViewedAt: string | null;
  statusChangedAt: string | null;
  viewCount: number;
}

export interface DataExportAiExplanation {
  cardId: string;
  provider: string;
  model: string;
  promptText: string;
  content: string;
  generatedAt: string;
}

export type DataExportTrashEntityType = HierarchyEntityType | 'question_bank' | 'question_chapter' | 'question';

export type QuestionBankKind = 'chapter' | 'official' | 'mock';
export type QuestionType = 'single' | 'multiple' | 'true_false';
export type PracticeMode = 'cram' | 'test';
export type PracticeSource = 'full' | 'current_wrong' | 'aggregate_wrong' | 'favorite';
export type PracticeSessionStatus = 'in_progress' | 'completed' | 'abandoned';
export type PracticeAttemptResult = 'unanswered' | 'correct' | 'incorrect';

export interface QuestionOptionContent {
  key: string;
  content: ReviewContentNode[];
}

export interface DataExportQuestionBank {
  id: string;
  subjectId: string;
  kind: QuestionBankKind;
  name: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportQuestionChapter {
  id: string;
  questionBankId: string;
  title: string;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportQuestion {
  id: string;
  questionBankId: string;
  questionChapterId: string | null;
  stem: ReviewContentNode[];
  type: QuestionType;
  options: QuestionOptionContent[];
  answer: string[];
  analysis: ReviewContentNode[] | null;
  knowledgePoints: string[];
  isFavorite: boolean;
  version: number;
  sortOrder: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  reviewNote?: string | null;
}

export interface DataExportQuestionReviewNote {
  questionId: string;
  noteText: string;
  strokes?: HandwrittenStroke[];
  updatedAt: string;
}

export interface DataExportCardReviewNote {
  cardId: string;
  noteText: string;
  strokes: HandwrittenStroke[];
  updatedAt: string;
}

export interface DataExportQuestionAiExplanation {
  id: string;
  questionId: string;
  questionVersion: number;
  provider: string;
  model: string;
  promptText: string;
  content: string;
  generatedAt: string;
}

export interface DataExportPracticeSession {
  id: string;
  questionBankId: string | null;
  subjectId: string | null;
  questionChapterId: string | null;
  mode: PracticeMode;
  source: PracticeSource;
  scope: Record<string, unknown>;
  status: PracticeSessionStatus;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportPracticeAttempt {
  id: string;
  practiceSessionId: string;
  questionId: string;
  questionVersion: number;
  sortOrder: number;
  snapshot: Record<string, unknown>;
  answer: string[] | null;
  result: PracticeAttemptResult;
  answeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DataExportTrashItem {
  id: string;
  entityType: DataExportTrashEntityType;
  entityId: string;
  payload: Record<string, unknown>;
  deletedAt: string;
  expiresAt: string | null;
  restoredAt: string | null;
}

export type DataExportAppSetting =
  | { settingKey: 'review.lastCardId'; settingValue: { cardId: string } }
  | { settingKey: 'review.lastCards'; settingValue: { cardIdsByMaterial: Record<string, string> } }
  | {
      settingKey: 'review.workspaceContext';
      settingValue: {
        courseId: string | null;
        subjectsByCourse: Record<string, string | null>;
        modesByCourse: Record<string, ReviewWorkspaceMode>;
        expandedMaterialsByCourse: Record<string, string | null>;
      };
    };

export interface DataJsonExportV1 {
  format: 'knowledge-flashcards-json';
  version: 1;
  exportedAt: string;
  materials: DataExportMaterial[];
  chapters: DataExportChapter[];
  sections: DataExportSection[];
  cards: DataExportCard[];
  resources: DataExportResource[];
  highlights: DataExportHighlight[];
  reviewRecords: DataExportReviewRecord[];
  aiExplanations: DataExportAiExplanation[];
  trashItems: DataExportTrashItem[];
  appSettings: DataExportAppSetting[];
  courses?: DataExportCourse[];
  subjects?: DataExportSubject[];
  materialCovers?: DataExportMaterialCover[];
  reviewStatusHistory?: DataExportReviewStatusHistory[];
}

export interface DataJsonExportV2 extends Omit<DataJsonExportV1, 'version'> {
  version: 2;
  questionBanks: DataExportQuestionBank[];
  questionChapters: DataExportQuestionChapter[];
  questions: DataExportQuestion[];
  questionAiExplanations: DataExportQuestionAiExplanation[];
  practiceSessions: DataExportPracticeSession[];
  practiceAttempts: DataExportPracticeAttempt[];
  questionReviewNotes?: DataExportQuestionReviewNote[];
  cardReviewNotes?: DataExportCardReviewNote[];
}

export type DataJsonExport = DataJsonExportV1 | DataJsonExportV2;

export interface DataRestoreResponse {
  materialCount: number;
  chapterCount: number;
  sectionCount: number;
  cardCount: number;
  resourceCount: number;
  highlightCount: number;
  courseCount?: number;
  subjectCount?: number;
  materialCoverCount?: number;
  reviewStatusHistoryCount?: number;
  questionBankCount?: number;
  questionChapterCount?: number;
  questionCount?: number;
  questionAiExplanationCount?: number;
  practiceSessionCount?: number;
  practiceAttemptCount?: number;
  questionReviewNoteCount?: number;
  cardReviewNoteCount?: number;
}

export type DataBackupStatus = 'running' | 'succeeded' | 'failed';

export interface DataBackupFileManifest {
  path: string;
  byteLength: number;
  sha256: string;
}

export interface DataBackupSummary {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  status: DataBackupStatus;
  fileManifest: DataBackupFileManifest[];
  errorMessage: string | null;
}

export interface DataBackupsResponse {
  backups: DataBackupSummary[];
}

export interface DataBackupResponse {
  backup: DataBackupSummary;
}

export interface DataPermanentDeleteResponse {
  deletedEntityCount: number;
  deletedResourceCount: number;
}
