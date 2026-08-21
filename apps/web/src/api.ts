import {
  importApplyPath,
  importAiCorrectionPath,
  importPreviewPath,
  importTemplatePath,
  reviewCardPath,
  reviewCardNotesPath,
  reviewCardHighlightPath,
  reviewCardStatusPath,
  reviewCardExplanationPath,
  studyAssistantPath,
  reviewCardsPath,
  reviewDashboardPath,
  reviewWorkspacePath,
  learningInsightsPath,
  reviewResourcePath,
  reviewStartPath,
  globalSearchPath,
  hierarchyPath,
  hierarchyTrashPath,
  catalogCoursesPath,
  catalogMaterialsPath,
  catalogSubjectsPath,
  questionBanksPath,
  questionAiExplanationsPath,
  questionChaptersPath,
  questionReviewNotesPath,
  wrongAnswerReviewPath,
  questionsPath,
  practiceSessionsPath,
  practiceQuestionBanksPath,
  practiceSubjectFavoritesPath,
  aiProviderProfilesPath,
  dataMarkdownExportPath,
  dataJsonExportPath,
  dataJsonRestorePath,
  dataBackupsPath,
  hierarchyTrashPermanentPath,
  authLoginPath,
  authSessionPath,
  authLogoutPath,
  type ErrorResponse,
  type HealthResponse,
  type ImportApplyRequest,
  type ImportApplyResponse,
  type ImportAiCorrectionRequest,
  type ImportPreviewResponse,
  type ImportTemplateFormat,
  type ReviewCardResponse,
  type ReviewCardContentUpdateRequest,
  type ReviewCardContentUpdateResponse,
  type CardReviewNote,
  type CardReviewNoteUpdateRequest,
  type ReviewCardsResponse,
  type ReviewDashboardResponse,
  type ReviewWorkspaceContextUpdateRequest,
  type ReviewWorkspaceResponse,
  type LearningInsightsPeriod,
  type LearningInsightsResponse,
  type ReviewEditLock,
  type ReviewEditLockResponse,
  type ReviewFilters,
  type ReviewMasteryStatus,
  type ReviewHighlightCreateRequest,
  type ReviewHighlightResponse,
  type ReviewResourceUploadResponse,
  type ReviewStartScope,
  type GlobalSearchFilters,
  type GlobalSearchResponse,
  type ReviewStatusUpdateRequest,
  type ReviewAiExplanation,
  type ReviewAiExplanationGenerateRequest,
  type StudyAssistantStreamEvent,
  type HierarchyCreateRequest,
  type HierarchyEntityType,
  type HierarchyMoveRequest,
  type HierarchyReorderRequest,
  type HierarchyRenameRequest,
  type HierarchyResponse,
  type HierarchyTrashResponse,
  type CatalogCoursesResponse,
  type CatalogCourseSubjectsResponse,
  type CatalogMaterialCoverUploadResponse,
  type CatalogMaterialResponse,
  type CatalogSubjectResponse,
  type QuestionBankDirectoryResponse,
  type QuestionBankKind,
  type QuestionBankTrashResponse,
  type QuestionBankQuestionsResponse,
  type QuestionAiExplanationGenerateRequest,
  type QuestionAiExplanationHistoryResponse,
  type QuestionAiExplanationResponse,
  type QuestionCreateRequest,
  type QuestionFavoriteUpdateRequest,
  type QuestionReviewNote,
  type QuestionReviewNoteUpdateRequest,
  type WrongAnswerFilterRequest,
  type WrongAnswerFilterResponse,
  type WrongAnswerPracticeStartRequest,
  type QuestionMutationResponse,
  type QuestionTrashResponse,
  type QuestionUpdateRequest,
  type PracticeSessionListResponse,
  type PracticeSessionResponse,
  type PracticeFavoriteSessionStartRequest,
  type PracticeSessionOptions,
  type PracticeAnswerResponse,
  type PracticeMode,
  type PracticeSource,
  type PracticeStatisticsResponse,
  questionImportPreviewPath,
  questionImportApplyPath,
  questionImportTemplatePath,
  type QuestionImportPreviewResponse,
  type QuestionImportTemplateFormat,
  type AiProviderProfileCreateRequest,
  type AiProviderProfileStateUpdateRequest,
  type AiProviderProfileUpdateRequest,
  type AiProviderProfilesReorderRequest,
  type AiProviderProfilesResponse,
  type AiProviderConnectionTestResponse,
  type DataJsonExport,
  type DataBackupsResponse,
  type DataRestoreResponse,
  type AuthLoginRequest,
  type AuthSessionResponse,
} from '@knowledge-flashcards/shared';

const deviceIdStorageKey = 'knowledge-flashcards.device-id';

function getDeviceId(): string {
  const existing = window.localStorage.getItem(deviceIdStorageKey);
  if (existing) {
    return existing;
  }
  const deviceId = typeof window.crypto.randomUUID === 'function'
    ? window.crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  window.localStorage.setItem(deviceIdStorageKey, deviceId);
  return deviceId;
}

function editLockHeaders(lock?: ReviewEditLock): HeadersInit {
  return {
    'X-Device-Id': getDeviceId(),
    ...(lock ? { 'X-Editor-Lock-Token': lock.lockToken } : {}),
  };
}

export async function fetchHealth() {
  const response = await fetch('/api/health');
  if (!response.ok) {
    throw new Error('服务暂时不可用。');
  }
  return (await response.json()) as HealthResponse;
}

export async function fetchAuthSession(): Promise<AuthSessionResponse> {
  const response = await fetch(authSessionPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AuthSessionResponse;
}

export async function login(request: AuthLoginRequest): Promise<AuthSessionResponse> {
  const response = await fetch(authLoginPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AuthSessionResponse;
}

export async function logout(): Promise<void> {
  const response = await fetch(authLogoutPath, { method: 'POST' });
  if (!response.ok && response.status !== 204) {
    throw await readError(response);
  }
}

async function readError(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as ErrorResponse;
    if (body.error) {
      return new Error(body.error);
    }
  } catch {
    // 服务器可能返回空响应或非 JSON 错误。
  }
  return new Error('服务暂时无法处理请求。');
}

export async function previewImport(file: File): Promise<ImportPreviewResponse> {
  const response = await fetch(importPreviewPath, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-Import-File-Name': encodeURIComponent(file.name),
    },
    body: file,
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ImportPreviewResponse;
}

export async function applyImport(request: ImportApplyRequest): Promise<ImportApplyResponse> {
  const response = await fetch(importApplyPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ImportApplyResponse;
}

export async function correctImportFormat(request: ImportAiCorrectionRequest): Promise<ImportPreviewResponse> {
  const response = await fetch(importAiCorrectionPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ImportPreviewResponse;
}

export async function cancelImport(previewId: string): Promise<void> {
  await fetch(`${importPreviewPath}/${encodeURIComponent(previewId)}`, { method: 'DELETE' });
}

export async function downloadImportTemplate(format: ImportTemplateFormat): Promise<Response> {
  const response = await fetch(`${importTemplatePath}/${format}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return response;
}

export async function fetchReviewDashboard(): Promise<ReviewDashboardResponse> {
  const response = await fetch(reviewDashboardPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewDashboardResponse;
}

export async function fetchGlobalSearch(filters: GlobalSearchFilters, signal?: AbortSignal): Promise<GlobalSearchResponse> {
  const params = new URLSearchParams({ q: filters.query });
  if (filters.courseId) params.set('courseId', filters.courseId);
  if (filters.subjectId) params.set('subjectId', filters.subjectId);
  if (filters.types?.length) params.set('types', filters.types.join(','));
  const response = await fetch(`${globalSearchPath}?${params.toString()}`, { signal });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as GlobalSearchResponse;
}

export async function fetchReviewWorkspace(options: { courseId?: string; subjectId?: string | null } = {}): Promise<ReviewWorkspaceResponse> {
  const params = new URLSearchParams();
  if (options.courseId) params.set('courseId', options.courseId);
  if (options.subjectId !== undefined) params.set('subjectId', options.subjectId ?? 'all');
  const response = await fetch(`${reviewWorkspacePath}${params.toString() ? `?${params.toString()}` : ''}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as ReviewWorkspaceResponse;
}

export async function fetchLearningInsights(options: { periodDays?: LearningInsightsPeriod; courseId?: string; subjectId?: string | null } = {}): Promise<LearningInsightsResponse> {
  const params = new URLSearchParams();
  if (options.periodDays) params.set('periodDays', String(options.periodDays));
  if (options.courseId) params.set('courseId', options.courseId);
  if (options.subjectId !== undefined) params.set('subjectId', options.subjectId ?? 'all');
  const response = await fetch(`${learningInsightsPath}?${params.toString()}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as LearningInsightsResponse;
}

export async function updateReviewWorkspace(request: ReviewWorkspaceContextUpdateRequest): Promise<ReviewWorkspaceResponse> {
  const response = await fetch(reviewWorkspacePath, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as ReviewWorkspaceResponse;
}

export async function startReview(scope: ReviewStartScope, materialId?: string): Promise<ReviewCardResponse> {
  const params = new URLSearchParams({ scope });
  if (materialId) {
    params.set('materialId', materialId);
  }
  const response = await fetch(`${reviewStartPath}?${params.toString()}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardResponse;
}

function reviewFiltersQuery(filters: ReviewFilters): URLSearchParams {
  const params = new URLSearchParams();
  if (filters.materialId) {
    params.set('materialId', filters.materialId);
  }
  if (filters.statuses?.length) {
    params.set('statuses', filters.statuses.join(','));
  }
  return params;
}

export async function fetchReviewCard(cardId: string, filters: ReviewFilters = {}): Promise<ReviewCardResponse> {
  const query = reviewFiltersQuery(filters).toString();
  const response = await fetch(`${reviewCardPath}/${encodeURIComponent(cardId)}${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardResponse;
}

export async function fetchFirstReviewCard(filters: ReviewFilters): Promise<ReviewCardResponse> {
  const query = reviewFiltersQuery(filters).toString();
  const response = await fetch(`${reviewCardPath}/first${query ? `?${query}` : ''}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardResponse;
}

export async function generateReviewAiExplanation(
  cardId: string,
  request: ReviewAiExplanationGenerateRequest = {},
  signal?: AbortSignal,
): Promise<ReviewAiExplanation> {
  const response = await fetch(`${reviewCardExplanationPath}/${encodeURIComponent(cardId)}/explanation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return ((await response.json()) as { explanation: ReviewAiExplanation }).explanation;
}

async function readStudyAssistantStream(response: Response, onDelta: (content: string) => void | Promise<void>): Promise<void> {
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('学习助手未收到流式响应，请检查当前 AI Provider 是否支持 stream。');
  }
  if (!response.body) throw new Error('问答响应为空。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const consume = async (block: string) => {
    const data = block.split('\n').map((line) => line.replace(/\r$/, '')).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    let event: StudyAssistantStreamEvent;
    try {
      event = JSON.parse(data) as StudyAssistantStreamEvent;
    } catch {
      throw new Error('问答响应格式无效。');
    }
    if (event.type === 'delta') await onDelta(event.content);
    if (event.type === 'error') throw new Error(event.error);
  };
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      await consume(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) await consume(buffer);
}

export async function streamFlashcardStudyAssistant(cardId: string, prompt: string, onDelta: (content: string) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${studyAssistantPath}/cards/${encodeURIComponent(cardId)}`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!response.ok) throw await readError(response);
  await readStudyAssistantStream(response, onDelta);
}

export async function streamPracticeStudyAssistant(sessionId: string, questionId: string, prompt: string, onDelta: (content: string) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  const response = await fetch(`${studyAssistantPath}/practice-sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`, {
    method: 'POST',
    headers: { Accept: 'text/event-stream', 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
    signal,
  });
  if (!response.ok) throw await readError(response);
  await readStudyAssistantStream(response, onDelta);
}

export async function updateReviewStatus(
  cardId: string,
  status: ReviewMasteryStatus,
  filters: ReviewFilters = {},
): Promise<ReviewCardResponse> {
  const body: ReviewStatusUpdateRequest = { status };
  const query = reviewFiltersQuery(filters).toString();
  const response = await fetch(`${reviewCardStatusPath}/${encodeURIComponent(cardId)}/status${query ? `?${query}` : ''}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardResponse;
}

export async function updateReviewContent(
  cardId: string,
  request: ReviewCardContentUpdateRequest,
  lock: ReviewEditLock,
): Promise<ReviewCardContentUpdateResponse> {
  const response = await fetch(`${reviewCardPath}/${encodeURIComponent(cardId)}/content`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...editLockHeaders(lock) },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardContentUpdateResponse;
}

export async function fetchCardReviewNote(cardId: string): Promise<CardReviewNote | null> {
  const response = await fetch(`${reviewCardNotesPath}/${encodeURIComponent(cardId)}/note`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as CardReviewNote | null;
}

export async function saveCardReviewNote(cardId: string, request: CardReviewNoteUpdateRequest): Promise<CardReviewNote | null> {
  const response = await fetch(`${reviewCardNotesPath}/${encodeURIComponent(cardId)}/note`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as CardReviewNote | null;
}

export async function acquireReviewEditLock(cardId: string): Promise<ReviewEditLock> {
  const response = await fetch(`${reviewCardPath}/${encodeURIComponent(cardId)}/edit-lock`, {
    method: 'POST',
    headers: editLockHeaders(),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return ((await response.json()) as ReviewEditLockResponse).lock;
}

export async function renewReviewEditLock(cardId: string, lock: ReviewEditLock): Promise<ReviewEditLock> {
  const response = await fetch(`${reviewCardPath}/${encodeURIComponent(cardId)}/edit-lock`, {
    method: 'PUT',
    headers: editLockHeaders(lock),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return ((await response.json()) as ReviewEditLockResponse).lock;
}

export async function releaseReviewEditLock(cardId: string, lock: ReviewEditLock): Promise<void> {
  const response = await fetch(`${reviewCardPath}/${encodeURIComponent(cardId)}/edit-lock`, {
    method: 'DELETE',
    headers: editLockHeaders(lock),
  });
  if (!response.ok) {
    throw await readError(response);
  }
}

export async function uploadReviewResource(file: File): Promise<ReviewResourceUploadResponse> {
  const response = await fetch(reviewResourcePath, {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewResourceUploadResponse;
}

export async function createReviewHighlight(
  cardId: string,
  request: ReviewHighlightCreateRequest,
): Promise<ReviewHighlightResponse> {
  const response = await fetch(`${reviewCardHighlightPath}/${encodeURIComponent(cardId)}/highlights`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewHighlightResponse;
}

export async function deleteReviewHighlight(cardId: string, highlightId: string): Promise<void> {
  const response = await fetch(
    `${reviewCardHighlightPath}/${encodeURIComponent(cardId)}/highlights/${encodeURIComponent(highlightId)}`,
    { method: 'DELETE' },
  );
  if (!response.ok) {
    throw await readError(response);
  }
}

export async function fetchReviewCards(
  filters: ReviewFilters,
  currentCardId?: string,
): Promise<ReviewCardsResponse> {
  const params = new URLSearchParams();
  if (filters.materialId) {
    params.set('materialId', filters.materialId);
  }
  if (filters.statuses?.length) {
    params.set('statuses', filters.statuses.join(','));
  }
  if (currentCardId) {
    params.set('cardId', currentCardId);
  }
  const query = params.toString();
  const response = await fetch(query ? `${reviewCardsPath}?${query}` : reviewCardsPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as ReviewCardsResponse;
}

export async function fetchHierarchy(): Promise<HierarchyResponse> {
  const response = await fetch(hierarchyPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function fetchHierarchyTrash(): Promise<HierarchyTrashResponse> {
  const response = await fetch(hierarchyTrashPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyTrashResponse;
}

export async function fetchCatalogCourses(): Promise<CatalogCoursesResponse> {
  const response = await fetch(catalogCoursesPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function fetchCatalogCourseSubjects(courseId: string): Promise<CatalogCourseSubjectsResponse> {
  const response = await fetch(`${catalogCoursesPath}/${encodeURIComponent(courseId)}/subjects`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCourseSubjectsResponse;
}

export async function fetchCatalogSubject(subjectId: string): Promise<CatalogSubjectResponse> {
  const response = await fetch(`${catalogSubjectsPath}/${encodeURIComponent(subjectId)}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogSubjectResponse;
}

export async function fetchCatalogMaterial(materialId: string): Promise<CatalogMaterialResponse> {
  const response = await fetch(`${catalogMaterialsPath}/${encodeURIComponent(materialId)}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogMaterialResponse;
}

export async function updateCatalogMaterialName(materialId: string, name: string): Promise<CatalogMaterialResponse> {
  const response = await fetch(`${catalogMaterialsPath}/${encodeURIComponent(materialId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogMaterialResponse;
}

export async function uploadCatalogMaterialCover(materialId: string, file: File): Promise<CatalogMaterialCoverUploadResponse> {
  const response = await fetch(`${catalogMaterialsPath}/${encodeURIComponent(materialId)}/cover`, {
    method: 'PUT',
    body: file,
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogMaterialCoverUploadResponse;
}

export async function removeCatalogMaterialCover(materialId: string): Promise<void> {
  const response = await fetch(`${catalogMaterialsPath}/${encodeURIComponent(materialId)}/cover`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
}

export async function createCatalogCourse(name: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(catalogCoursesPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function createCatalogSubject(courseId: string, name: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(catalogSubjectsPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId, name }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function renameCatalogCourse(courseId: string, name: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogCoursesPath}/${encodeURIComponent(courseId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function reorderCatalogCourse(courseId: string, direction: 'up' | 'down'): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogCoursesPath}/${encodeURIComponent(courseId)}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function deleteCatalogCourse(courseId: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogCoursesPath}/${encodeURIComponent(courseId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function renameCatalogSubject(subjectId: string, name: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogSubjectsPath}/${encodeURIComponent(subjectId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function moveCatalogSubject(subjectId: string, courseId: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogSubjectsPath}/${encodeURIComponent(subjectId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseId }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function reorderCatalogSubject(subjectId: string, direction: 'up' | 'down'): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogSubjectsPath}/${encodeURIComponent(subjectId)}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ direction }),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function deleteCatalogSubject(subjectId: string): Promise<CatalogCoursesResponse> {
  const response = await fetch(`${catalogSubjectsPath}/${encodeURIComponent(subjectId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as CatalogCoursesResponse;
}

export async function fetchQuestionBankDirectory(subjectId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionBanksPath}/subject/${encodeURIComponent(subjectId)}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function fetchQuestionBankTrash(subjectId: string): Promise<QuestionBankTrashResponse> {
  const response = await fetch(`${questionBanksPath}/subject/${encodeURIComponent(subjectId)}/trash`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionBankTrashResponse;
}
export async function downloadQuestionImportTemplate(kind: QuestionBankKind, format: QuestionImportTemplateFormat): Promise<Response> {
  const response = await fetch(`${questionImportTemplatePath}/${kind}/${format}`);
  if (!response.ok) throw await readError(response);
  return response;
}
export async function previewQuestionImport(file: File, courseId: string, subjectId: string, kind: QuestionBankKind): Promise<QuestionImportPreviewResponse> {
  const response = await fetch(`${questionImportPreviewPath}?${new URLSearchParams({ courseId, subjectId, kind })}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Import-File-Name': encodeURIComponent(file.name) }, body: file });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionImportPreviewResponse;
}
export async function applyQuestionImport(previewId: string) {
  const response = await fetch(questionImportApplyPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId }) });
  if (!response.ok) throw await readError(response);
  return await response.json() as { questionBankName: string; questionCount: number; questionChapterCount: number };
}
export async function cancelQuestionImport(previewId: string): Promise<void> {
  await fetch(`${questionImportPreviewPath}/${encodeURIComponent(previewId)}`, { method: 'DELETE' });
}
export async function createQuestionBank(subjectId: string, kind: QuestionBankKind, name: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(questionBanksPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId, kind, name }) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function renameQuestionBank(bankId: string, name: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function reorderQuestionBank(bankId: string, direction: 'up' | 'down'): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function deleteQuestionBank(bankId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}`, { method: 'DELETE' });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function restoreQuestionBank(bankId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}/restore`, { method: 'POST' });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function restoreQuestionChapter(chapterId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionChaptersPath}/${encodeURIComponent(chapterId)}/restore`, { method: 'POST' });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function createQuestionChapter(questionBankId: string, title: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(questionChaptersPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId, title }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function renameQuestionChapter(chapterId: string, title: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionChaptersPath}/${encodeURIComponent(chapterId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function moveQuestionChapter(chapterId: string, questionBankId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionChaptersPath}/${encodeURIComponent(chapterId)}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function reorderQuestionChapter(chapterId: string, direction: 'up' | 'down'): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionChaptersPath}/${encodeURIComponent(chapterId)}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}
export async function deleteQuestionChapter(chapterId: string): Promise<QuestionBankDirectoryResponse> {
  const response = await fetch(`${questionChaptersPath}/${encodeURIComponent(chapterId)}`, { method: 'DELETE' });
  if (!response.ok) throw await readError(response); return (await response.json()) as QuestionBankDirectoryResponse;
}

export async function fetchQuestionBankQuestions(bankId: string): Promise<QuestionBankQuestionsResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}/questions`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionBankQuestionsResponse;
}

export async function fetchQuestionAiExplanations(questionId: string): Promise<QuestionAiExplanationHistoryResponse> {
  const response = await fetch(`${questionAiExplanationsPath}/${encodeURIComponent(questionId)}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionAiExplanationHistoryResponse;
}

export async function generateQuestionAiExplanation(
  questionId: string,
  request: QuestionAiExplanationGenerateRequest = {},
  signal?: AbortSignal,
): Promise<QuestionAiExplanationResponse> {
  const response = await fetch(`${questionAiExplanationsPath}/${encodeURIComponent(questionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionAiExplanationResponse;
}

export async function fetchQuestionTrash(bankId: string): Promise<QuestionTrashResponse> {
  const response = await fetch(`${questionBanksPath}/${encodeURIComponent(bankId)}/questions/trash`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionTrashResponse;
}

export async function createQuestion(request: QuestionCreateRequest): Promise<QuestionMutationResponse> {
  const response = await fetch(questionsPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function updateQuestion(questionId: string, request: QuestionUpdateRequest): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function setQuestionFavorite(questionId: string, isFavorite: boolean): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}/favorite`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ isFavorite } satisfies QuestionFavoriteUpdateRequest) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function fetchQuestionReviewNote(questionId: string): Promise<QuestionReviewNote | null> {
  const response = await fetch(`${questionReviewNotesPath}/${encodeURIComponent(questionId)}/review-note`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionReviewNote | null;
}

export async function saveQuestionReviewNote(questionId: string, request: QuestionReviewNoteUpdateRequest | string): Promise<QuestionReviewNote | null> {
  const body: QuestionReviewNoteUpdateRequest = typeof request === 'string' ? { noteText: request } : request;
  const response = await fetch(`${questionReviewNotesPath}/${encodeURIComponent(questionId)}/review-note`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionReviewNote | null;
}

export async function fetchWrongAnswers(filters: WrongAnswerFilterRequest): Promise<WrongAnswerFilterResponse> {
  const params = new URLSearchParams({ subjectId: filters.subjectId });
  if (filters.knowledgePoint) params.set('knowledgePoint', filters.knowledgePoint);
  if (filters.type) params.set('type', filters.type);
  if (filters.since) params.set('since', filters.since);
  const response = await fetch(`${wrongAnswerReviewPath}?${params.toString()}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as WrongAnswerFilterResponse;
}

export async function startWrongAnswerPractice(request: WrongAnswerPracticeStartRequest): Promise<PracticeSessionResponse> {
  const response = await fetch(`${wrongAnswerReviewPath}/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function moveQuestion(questionId: string, questionBankId: string, questionChapterId: string | null): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId, questionChapterId }) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function reorderQuestion(questionId: string, direction: 'up' | 'down'): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction }) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function deleteQuestion(questionId: string): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}`, { method: 'DELETE' });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function restoreQuestion(questionId: string): Promise<QuestionMutationResponse> {
  const response = await fetch(`${questionsPath}/${encodeURIComponent(questionId)}/restore`, { method: 'POST' });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as QuestionMutationResponse;
}

export async function fetchInProgressPracticeSessions(bankId: string): Promise<PracticeSessionListResponse> {
  const response = await fetch(`${practiceSessionsPath}/question-banks/${encodeURIComponent(bankId)}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionListResponse;
}

export async function startPracticeSession(questionBankId: string, questionChapterId: string | null, mode: PracticeMode, source: PracticeSource = 'full', sourceSessionId: string | null = null, options: PracticeSessionOptions = {}): Promise<PracticeSessionResponse> {
  const response = await fetch(practiceSessionsPath, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ questionBankId, questionChapterId, mode, source, sourceSessionId, ...options }) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function startFavoritePracticeSession(subjectId: string, mode: PracticeMode, options: PracticeSessionOptions = {}): Promise<PracticeSessionResponse> {
  const response = await fetch(`${practiceSubjectFavoritesPath}/${encodeURIComponent(subjectId)}/favorites/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subjectId, mode, ...options } satisfies PracticeFavoriteSessionStartRequest) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function fetchPracticeStatistics(bankId: string): Promise<PracticeStatisticsResponse> {
  const response = await fetch(`${practiceQuestionBanksPath}/${encodeURIComponent(bankId)}/statistics`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeStatisticsResponse;
}

export async function fetchPracticeSession(sessionId: string): Promise<PracticeSessionResponse> {
  const response = await fetch(`${practiceSessionsPath}/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function answerPracticeQuestion(sessionId: string, questionId: string, answer: string[]): Promise<PracticeAnswerResponse> {
  const response = await fetch(`${practiceSessionsPath}/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(questionId)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ answer }) });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeAnswerResponse;
}

export async function completePracticeSession(sessionId: string): Promise<PracticeSessionResponse> {
  const response = await fetch(`${practiceSessionsPath}/${encodeURIComponent(sessionId)}/complete`, { method: 'POST' });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function abandonPracticeSession(sessionId: string): Promise<PracticeSessionResponse> {
  const response = await fetch(`${practiceSessionsPath}/${encodeURIComponent(sessionId)}/abandon`, { method: 'POST' });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as PracticeSessionResponse;
}

export async function createHierarchy(request: HierarchyCreateRequest): Promise<HierarchyResponse> {
  const response = await fetch(hierarchyPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function renameHierarchy(
  entityType: HierarchyEntityType,
  entityId: string,
  title: string,
): Promise<HierarchyResponse> {
  const request: HierarchyRenameRequest = { title };
  const response = await fetch(`${hierarchyPath}/${entityType}/${encodeURIComponent(entityId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function moveHierarchy(
  entityType: Exclude<HierarchyEntityType, 'material'>,
  entityId: string,
  parentId: string,
): Promise<HierarchyResponse> {
  const request: HierarchyMoveRequest = { parentId };
  const response = await fetch(`${hierarchyPath}/${entityType}/${encodeURIComponent(entityId)}/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function reorderHierarchy(
  entityType: Exclude<HierarchyEntityType, 'material'>,
  entityId: string,
  direction: 'up' | 'down',
): Promise<HierarchyResponse> {
  const request: HierarchyReorderRequest = { direction };
  const response = await fetch(`${hierarchyPath}/${entityType}/${encodeURIComponent(entityId)}/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function deleteHierarchy(entityType: HierarchyEntityType, entityId: string): Promise<HierarchyResponse> {
  const response = await fetch(`${hierarchyPath}/${entityType}/${encodeURIComponent(entityId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as HierarchyResponse;
}

export async function fetchAiProviderProfiles(): Promise<AiProviderProfilesResponse> {
  const response = await fetch(aiProviderProfilesPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function createAiProviderProfile(
  request: AiProviderProfileCreateRequest,
): Promise<AiProviderProfilesResponse> {
  const response = await fetch(aiProviderProfilesPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function updateAiProviderProfile(
  profileId: string,
  request: AiProviderProfileUpdateRequest,
): Promise<AiProviderProfilesResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/${encodeURIComponent(profileId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function activateAiProviderProfile(profileId: string): Promise<AiProviderProfilesResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/${encodeURIComponent(profileId)}/activate`, { method: 'POST' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function updateAiProviderProfileState(
  profileId: string,
  request: AiProviderProfileStateUpdateRequest,
): Promise<AiProviderProfilesResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/${encodeURIComponent(profileId)}/state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function reorderAiProviderProfiles(
  request: AiProviderProfilesReorderRequest,
): Promise<AiProviderProfilesResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/order`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (!response.ok) throw await readError(response);
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function deleteAiProviderProfile(profileId: string): Promise<AiProviderProfilesResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/${encodeURIComponent(profileId)}`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderProfilesResponse;
}

export async function testAiProviderProfile(profileId: string): Promise<AiProviderConnectionTestResponse> {
  const response = await fetch(`${aiProviderProfilesPath}/${encodeURIComponent(profileId)}/test`, { method: 'POST' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as AiProviderConnectionTestResponse;
}

export async function downloadMaterialMarkdown(materialId: string): Promise<Response> {
  const response = await fetch(`${dataMarkdownExportPath}/${encodeURIComponent(materialId)}`);
  if (!response.ok) {
    throw await readError(response);
  }
  return response;
}

export async function fetchDataJsonExport(): Promise<DataJsonExport> {
  const response = await fetch(dataJsonExportPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as DataJsonExport;
}

export async function restoreDataJsonExport(payload: DataJsonExport): Promise<DataRestoreResponse> {
  const response = await fetch(dataJsonRestorePath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as DataRestoreResponse;
}

export async function fetchDataBackups(): Promise<DataBackupsResponse> {
  const response = await fetch(dataBackupsPath);
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as DataBackupsResponse;
}

export async function createDataBackup() {
  const response = await fetch(dataBackupsPath, { method: 'POST' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as { backup: DataBackupsResponse['backups'][number] };
}

export async function restoreDataBackup(backupId: string): Promise<DataRestoreResponse> {
  const response = await fetch(`${dataBackupsPath}/${encodeURIComponent(backupId)}/restore`, { method: 'POST' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as DataRestoreResponse;
}

export async function permanentlyDeleteTrashItem(trashItemId: string) {
  const response = await fetch(`${hierarchyTrashPermanentPath}/${encodeURIComponent(trashItemId)}/permanent`, { method: 'DELETE' });
  if (!response.ok) {
    throw await readError(response);
  }
  return (await response.json()) as { deletedEntityCount: number; deletedResourceCount: number };
}
