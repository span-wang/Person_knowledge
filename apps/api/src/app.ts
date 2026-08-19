import { performance } from 'node:perf_hooks';
import path from 'node:path';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';
import {
  healthCheckPath,
  importApplyPath,
  importAiCorrectionPath,
  importPreviewPath,
  importTemplatePath,
  reviewCardPath,
  reviewCardHighlightPath,
  reviewCardsPath,
  reviewDashboardPath,
  reviewResourcePath,
  reviewStartPath,
  hierarchyPath,
  hierarchyTrashPath,
  aiProviderProfilesPath,
  reviewCardExplanationPath,
  dataMarkdownExportPath,
  dataJsonExportPath,
  dataJsonRestorePath,
  dataBackupsPath,
  hierarchyTrashPermanentPath,
  authLoginPath,
  authSessionPath,
  authLogoutPath,
  questionImportApplyPath,
  questionImportPreviewPath,
  questionImportTemplatePath,
  catalogCoursesPath,
  catalogMaterialsPath,
  catalogSubjectsPath,
  questionBanksPath,
  questionChaptersPath,
  questionsPath,
  practiceSessionsPath,
  practiceQuestionBanksPath,
  questionAiExplanationsPath,
  type AuthLoginRequest,
  type AuthSessionResponse,
  type AiProviderProfileCreateRequest,
  type AiProviderProfileUpdateRequest,
  type ReviewAiExplanationGenerateRequest,
  type ImportApplyRequest,
  type ImportAiCorrectionRequest,
  type ErrorResponse,
  type HealthResponse,
  type ReviewFilters,
  type ReviewHighlightCreateRequest,
  type ReviewCardContentUpdateRequest,
  type ReviewMasteryStatus,
  type ReviewStatusUpdateRequest,
  type ReviewStartScope,
  type HierarchyCreateRequest,
  type HierarchyMoveRequest,
  type HierarchyReorderRequest,
  type HierarchyRenameRequest,
  type CatalogCreateCourseRequest,
  type CatalogCreateSubjectRequest,
  type CatalogMoveSubjectRequest,
  type CatalogReorderRequest,
  type CatalogUpdateCourseRequest,
  type CatalogUpdateMaterialRequest,
  type CatalogUpdateSubjectRequest,
  type QuestionImportApplyRequest,
  type QuestionBankKind,
  type QuestionBankCreateRequest,
  type QuestionBankMoveChapterRequest,
  type QuestionBankReorderRequest,
  type QuestionBankRenameRequest,
  type QuestionChapterCreateRequest,
  type QuestionChapterReorderRequest,
  type QuestionChapterRenameRequest,
  type QuestionCreateRequest,
  type QuestionMoveRequest,
  type QuestionReorderRequest,
  type QuestionUpdateRequest,
  type PracticeAnswerRequest,
  type PracticeSessionStartRequest,
  type QuestionAiExplanationGenerateRequest,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createImportTemplate, createImportService, ImportApiError, type ImportService } from './import-service.js';
import { createReviewService, ReviewApiError, type ReviewEditLockCredentials, type ReviewService } from './review-service.js';
import { createResourceService, ResourceApiError, type ResourceService } from './resource-service.js';
import { createHierarchyService, HierarchyApiError, type HierarchyService } from './hierarchy-service.js';
import { AiProviderApiError, createAiProviderService, type AiProviderService } from './ai-provider-service.js';
import { AiExplanationApiError, createAiExplanationService, type AiExplanationService } from './ai-explanation-service.js';
import { DataGovernanceApiError, createDataGovernanceService, type DataGovernanceService } from './data-governance-service.js';
import { CatalogApiError, createCatalogService, type CatalogService } from './catalog-service.js';
import { hashFingerprint, type AuthService } from './auth.js';
import { createQuestionImportService, createQuestionImportTemplate, QuestionImportApiError, type QuestionImportService } from './question-import-service.js';
import { createQuestionBankService, QuestionBankApiError, type QuestionBankService } from './question-bank-service.js';
import { createQuestionService, QuestionApiError, type QuestionService } from './question-service.js';
import { createPracticeService, PracticeApiError, type PracticeService } from './practice-service.js';
import { createPracticeStatisticsService, PracticeStatisticsApiError, type PracticeStatisticsService } from './practice-statistics-service.js';
import { createQuestionAiService, QuestionAiApiError, type QuestionAiService } from './question-ai-service.js';

function createRequestLogger() {
  return (request: express.Request, response: express.Response, next: express.NextFunction) => {
    const startedAt = performance.now();
    response.on('finish', () => {
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'http_request',
          method: request.method,
          path: request.originalUrl,
          status: response.statusCode,
          durationMs: Math.round(performance.now() - startedAt),
        }),
      );
    });
    next();
  };
}

const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }

  if (error instanceof ImportApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof ReviewApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof ResourceApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof HierarchyApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof AiProviderApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof AiExplanationApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof DataGovernanceApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof CatalogApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof QuestionImportApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof QuestionBankApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof QuestionApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof PracticeApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof PracticeStatisticsApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (error instanceof QuestionAiApiError) {
    const body: ErrorResponse = { error: error.message };
    response.status(error.statusCode).json(body);
    return;
  }

  if (typeof error === 'object' && error !== null && 'type' in error && error.type === 'entity.too.large') {
    response.status(413).json({ error: '上传文件不能超过 5MB。' } satisfies ErrorResponse);
    return;
  }

  if (isRecordWithType(error, 'entity.too.large')) {
    const body: ErrorResponse = { error: '文件过大，请选择 25MB 以内的文件。' };
    response.status(413).json(body);
    return;
  }

  console.error(error);
  const body: ErrorResponse = { error: '服务器暂时无法处理请求。' };
  response.status(500).json(body);
};

function isRecordWithType(value: unknown, type: string): boolean {
  return typeof value === 'object' && value !== null && 'type' in value && value.type === type;
}

function readImportFileName(request: express.Request): string {
  const encoded = request.header('x-import-file-name');
  if (!encoded) {
    throw new ImportApiError(400, '缺少上传文件名。');
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

function readReviewFilters(request: express.Request): ReviewFilters {
  const textQuery = (name: string) =>
    typeof request.query[name] === 'string' ? request.query[name].trim() : undefined;
  const rawStatuses = textQuery('statuses');
  return {
    materialId: textQuery('materialId'),
    statuses: rawStatuses ? rawStatuses.split(',').filter(Boolean) as ReviewFilters['statuses'] : undefined,
  };
}

function readDeviceId(request: express.Request): string {
  const deviceId = request.header('x-device-id')?.trim();
  if (!deviceId || deviceId.length > 255) {
    throw new ReviewApiError(400, '设备标识无效。');
  }
  return deviceId;
}

function readEditLock(request: express.Request): ReviewEditLockCredentials {
  const deviceId = readDeviceId(request);
  const lockToken = request.header('x-editor-lock-token')?.trim();
  if (!lockToken || lockToken.length > 255) {
    throw new ReviewApiError(400, '编辑锁令牌无效。');
  }
  return { deviceId, lockToken };
}

function requestAbortSignal(request: express.Request, response: express.Response) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onResponseClose = () => {
    if (!response.writableEnded) {
      abort();
    }
  };
  request.once('aborted', abort);
  response.once('close', onResponseClose);
  return {
    signal: controller.signal,
    dispose: () => {
      request.off('aborted', abort);
      response.off('close', onResponseClose);
    },
  };
}

export interface AppDependencies {
  importService?: ImportService;
  questionImportService?: QuestionImportService;
  reviewService?: ReviewService;
  resourceService?: ResourceService;
  hierarchyService?: HierarchyService;
  aiProviderService?: AiProviderService;
  aiExplanationService?: AiExplanationService;
  dataGovernanceService?: DataGovernanceService;
  catalogService?: CatalogService;
  questionBankService?: QuestionBankService;
  questionService?: QuestionService;
  practiceService?: PracticeService;
  practiceStatisticsService?: PracticeStatisticsService;
  questionAiService?: QuestionAiService;
  authService?: AuthService;
}

export function createApp(startedAt = new Date(), dependencies: AppDependencies = {}) {
  const app = express();
  const importService = dependencies.importService ?? createImportService();
  const questionImportService = dependencies.questionImportService ?? createQuestionImportService();
  const reviewService = dependencies.reviewService ?? createReviewService();
  const resourceService = dependencies.resourceService ?? createResourceService();
  const hierarchyService = dependencies.hierarchyService ?? createHierarchyService();
  const aiProviderService = dependencies.aiProviderService ?? createAiProviderService();
  const aiExplanationService = dependencies.aiExplanationService ?? createAiExplanationService();
  const dataGovernanceService = dependencies.dataGovernanceService ?? createDataGovernanceService();
  const catalogService = dependencies.catalogService ?? createCatalogService();
  const questionBankService = dependencies.questionBankService ?? createQuestionBankService();
  const questionService = dependencies.questionService ?? createQuestionService();
  const practiceService = dependencies.practiceService ?? createPracticeService();
  const practiceStatisticsService = dependencies.practiceStatisticsService ?? createPracticeStatisticsService();
  const questionAiService = dependencies.questionAiService ?? createQuestionAiService();
  const authService = dependencies.authService;
  const jsonBodyParser = express.json({ limit: '50mb' });
  app.disable('x-powered-by');
  app.use(cors({ origin: config.webOrigin }));
  app.use((request, response, next) => {
    if (request.path === importPreviewPath || request.path === questionImportPreviewPath) {
      next();
      return;
    }
    jsonBodyParser(request, response, next);
  });
  app.use(createRequestLogger());

  app.get(authSessionPath, (request, response) => {
    const session = authService?.readSession(request.header('cookie')) ?? null;
    const body: AuthSessionResponse = !authService || !authService.enabled
      ? { authenticated: true, username: null, expiresAt: null }
      : session
      ? { authenticated: true, username: session.username, expiresAt: new Date(session.expiresAt).toISOString() }
      : { authenticated: false, username: null, expiresAt: null };
    response.status(200).json(body);
  });

  app.post(authLoginPath, (request, response) => {
    if (!authService?.enabled) {
      response.status(503).json({ error: '账号登录尚未配置。' } satisfies ErrorResponse);
      return;
    }
    const body = request.body as Partial<AuthLoginRequest>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const clientKey = hashFingerprint(request.ip || request.socket.remoteAddress || 'unknown');
    const result = authService.authenticate(username, password, clientKey);
    if (!result.ok) {
      if (result.retryAfterSeconds > 0) {
        response.setHeader('Retry-After', String(result.retryAfterSeconds));
      }
      response.status(result.retryAfterSeconds > 0 ? 429 : 401).json({ error: '用户名或密码错误。' } satisfies ErrorResponse);
      return;
    }
    response.setHeader('Set-Cookie', authService.cookie(result.token));
    const sessionBody: AuthSessionResponse = {
      authenticated: true,
      username: result.session.username,
      expiresAt: new Date(result.session.expiresAt).toISOString(),
    };
    response.status(200).json(sessionBody);
  });

  app.post(authLogoutPath, (request, response) => {
    authService?.revoke(request.header('cookie'));
    if (authService) {
      response.setHeader('Set-Cookie', authService.clearCookie());
    }
    response.status(204).end();
  });

  app.use((request, response, next) => {
    if (!authService?.enabled || !request.path.startsWith('/api/') ||
        request.path === healthCheckPath || request.path === authSessionPath ||
        request.path === authLoginPath || request.path === authLogoutPath) {
      next();
      return;
    }
    if (!authService.readSession(request.header('cookie'))) {
      response.status(401).json({ error: '请先登录。' } satisfies ErrorResponse);
      return;
    }
    next();
  });

  app.get(healthCheckPath, (_request, response) => {
    const body: HealthResponse = {
      service: 'api',
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt.getTime()) / 1000)),
    };
    response.status(200).json(body);
  });

  app.get(`${importTemplatePath}/:format`, async (request, response, next) => {
    try {
      const format = request.params.format;
      if (format !== 'json' && format !== 'excel') {
        throw new ImportApiError(404, '未找到导入模板。');
      }
      const template = await createImportTemplate(format);
      response.attachment(template.fileName);
      response.type(template.contentType).send(template.content);
    } catch (error) {
      next(error);
    }
  });

  app.get(`${questionImportTemplatePath}/:kind/:format`, async (request, response, next) => {
    try {
      const kind = request.params.kind as QuestionBankKind;
      const format = request.params.format;
      if (!['chapter', 'official', 'mock'].includes(kind) || !['json', 'excel'].includes(format)) {
        throw new QuestionImportApiError(404, '未找到题库导入模板。');
      }
      const template = await createQuestionImportTemplate(kind, format as 'json' | 'excel');
      response.attachment(template.fileName);
      response.type(template.contentType).send(template.content);
    } catch (error) {
      next(error);
    }
  });

  app.get(reviewDashboardPath, async (_request, response, next) => {
    try {
      response.status(200).json(await reviewService.dashboard());
    } catch (error) {
      next(error);
    }
  });

  app.get(hierarchyPath, async (_request, response, next) => {
    try {
      response.status(200).json(await hierarchyService.list());
    } catch (error) {
      next(error);
    }
  });

  app.get(catalogCoursesPath, async (_request, response, next) => {
    try {
      response.status(200).json(await catalogService.listCourses());
    } catch (error) {
      next(error);
    }
  });

  app.get(`${catalogCoursesPath}/:courseId/subjects`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.listCourseSubjects(request.params.courseId));
    } catch (error) {
      next(error);
    }
  });

  app.get(`${catalogSubjectsPath}/:subjectId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.getSubject(request.params.subjectId));
    } catch (error) {
      next(error);
    }
  });

  app.get(`${questionBanksPath}/subject/:subjectId`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.getDirectory(request.params.subjectId)); } catch (error) { next(error); }
  });
  app.get(`${questionBanksPath}/subject/:subjectId/trash`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.listTrash(request.params.subjectId)); } catch (error) { next(error); }
  });
  app.post(questionBanksPath, async (request, response, next) => {
    try { response.status(201).json(await questionBankService.createBank(request.body as QuestionBankCreateRequest)); } catch (error) { next(error); }
  });
  app.patch(`${questionBanksPath}/:bankId`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.renameBank(request.params.bankId, request.body as QuestionBankRenameRequest)); } catch (error) { next(error); }
  });
  app.post(`${questionBanksPath}/:bankId/reorder`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.reorderBank(request.params.bankId, request.body as QuestionBankReorderRequest)); } catch (error) { next(error); }
  });
  app.delete(`${questionBanksPath}/:bankId`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.deleteBank(request.params.bankId)); } catch (error) { next(error); }
  });
  app.post(`${questionBanksPath}/:bankId/restore`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.restoreBank(request.params.bankId)); } catch (error) { next(error); }
  });
  app.post(questionChaptersPath, async (request, response, next) => {
    try { response.status(201).json(await questionBankService.createChapter(request.body as QuestionChapterCreateRequest)); } catch (error) { next(error); }
  });
  app.patch(`${questionChaptersPath}/:chapterId`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.renameChapter(request.params.chapterId, request.body as QuestionChapterRenameRequest)); } catch (error) { next(error); }
  });
  app.post(`${questionChaptersPath}/:chapterId/move`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.moveChapter(request.params.chapterId, request.body as QuestionBankMoveChapterRequest)); } catch (error) { next(error); }
  });
  app.post(`${questionChaptersPath}/:chapterId/reorder`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.reorderChapter(request.params.chapterId, request.body as QuestionChapterReorderRequest)); } catch (error) { next(error); }
  });
  app.delete(`${questionChaptersPath}/:chapterId`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.deleteChapter(request.params.chapterId)); } catch (error) { next(error); }
  });
  app.post(`${questionChaptersPath}/:chapterId/restore`, async (request, response, next) => {
    try { response.status(200).json(await questionBankService.restoreChapter(request.params.chapterId)); } catch (error) { next(error); }
  });
  app.get(`${questionBanksPath}/:bankId/questions`, async (request, response, next) => {
    try { response.status(200).json(await questionService.list(request.params.bankId)); } catch (error) { next(error); }
  });
  app.get(`${questionBanksPath}/:bankId/questions/trash`, async (request, response, next) => {
    try { response.status(200).json(await questionService.listTrash(request.params.bankId)); } catch (error) { next(error); }
  });
  app.post(questionsPath, async (request, response, next) => {
    try { response.status(201).json(await questionService.create(request.body as QuestionCreateRequest)); } catch (error) { next(error); }
  });
  app.patch(`${questionsPath}/:questionId`, async (request, response, next) => {
    try { response.status(200).json(await questionService.update(request.params.questionId, request.body as QuestionUpdateRequest)); } catch (error) { next(error); }
  });
  app.post(`${questionsPath}/:questionId/move`, async (request, response, next) => {
    try { response.status(200).json(await questionService.move(request.params.questionId, request.body as QuestionMoveRequest)); } catch (error) { next(error); }
  });
  app.post(`${questionsPath}/:questionId/reorder`, async (request, response, next) => {
    try { response.status(200).json(await questionService.reorder(request.params.questionId, request.body as QuestionReorderRequest)); } catch (error) { next(error); }
  });
  app.delete(`${questionsPath}/:questionId`, async (request, response, next) => {
    try { response.status(200).json(await questionService.remove(request.params.questionId)); } catch (error) { next(error); }
  });
  app.post(`${questionsPath}/:questionId/restore`, async (request, response, next) => {
    try { response.status(200).json(await questionService.restore(request.params.questionId)); } catch (error) { next(error); }
  });
  app.get(`${practiceSessionsPath}/question-banks/:bankId`, async (request, response, next) => {
    try { response.status(200).json(await practiceService.listInProgress(request.params.bankId)); } catch (error) { next(error); }
  });
  app.post(practiceSessionsPath, async (request, response, next) => {
    try { response.status(201).json(await practiceService.start(request.body as PracticeSessionStartRequest)); } catch (error) { next(error); }
  });
  app.get(`${practiceSessionsPath}/:sessionId`, async (request, response, next) => {
    try { response.status(200).json(await practiceService.get(request.params.sessionId)); } catch (error) { next(error); }
  });
  app.put(`${practiceSessionsPath}/:sessionId/questions/:questionId`, async (request, response, next) => {
    try { response.status(200).json(await practiceService.answer(request.params.sessionId, request.params.questionId, request.body as PracticeAnswerRequest)); } catch (error) { next(error); }
  });
  app.post(`${practiceSessionsPath}/:sessionId/complete`, async (request, response, next) => {
    try { response.status(200).json(await practiceService.complete(request.params.sessionId)); } catch (error) { next(error); }
  });
  app.post(`${practiceSessionsPath}/:sessionId/abandon`, async (request, response, next) => {
    try { response.status(200).json(await practiceService.abandon(request.params.sessionId)); } catch (error) { next(error); }
  });
  app.get(`${practiceQuestionBanksPath}/:bankId/statistics`, async (request, response, next) => {
    try { response.status(200).json(await practiceStatisticsService.get(request.params.bankId)); } catch (error) { next(error); }
  });
  app.get(`${questionAiExplanationsPath}/:questionId`, async (request, response, next) => {
    try { response.status(200).json(await questionAiService.list(request.params.questionId)); } catch (error) { next(error); }
  });
  app.post(`${questionAiExplanationsPath}/:questionId`, async (request, response, next) => {
    const abort = requestAbortSignal(request, response);
    try {
      const result = await questionAiService.generate(request.params.questionId, request.body as QuestionAiExplanationGenerateRequest, { signal: abort.signal });
      if (!abort.signal.aborted) response.status(200).json(result);
    } catch (error) {
      if (!abort.signal.aborted) next(error);
    } finally { abort.dispose(); }
  });

  app.get(`${catalogMaterialsPath}/:materialId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.getMaterial(request.params.materialId));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${catalogMaterialsPath}/:materialId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.renameMaterial(
        request.params.materialId,
        request.body as CatalogUpdateMaterialRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.put(`${catalogMaterialsPath}/:materialId/cover`, express.raw({ type: () => true, limit: '5mb' }), async (request, response, next) => {
    try {
      if (!Buffer.isBuffer(request.body)) {
        throw new CatalogApiError(400, '封面文件无效。');
      }
      response.status(201).json({
        cover: await catalogService.replaceMaterialCover(
          request.params.materialId,
          request.body,
          request.header('content-type'),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${catalogMaterialsPath}/:materialId/cover`, async (request, response, next) => {
    try {
      await catalogService.removeMaterialCover(request.params.materialId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post(catalogCoursesPath, async (request, response, next) => {
    try {
      response.status(201).json(await catalogService.createCourse(request.body as CatalogCreateCourseRequest));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${catalogCoursesPath}/:courseId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.renameCourse(
        request.params.courseId,
        request.body as CatalogUpdateCourseRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${catalogCoursesPath}/:courseId/reorder`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.reorderCourse(
        request.params.courseId,
        request.body as CatalogReorderRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${catalogCoursesPath}/:courseId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.removeCourse(request.params.courseId));
    } catch (error) {
      next(error);
    }
  });

  app.post(catalogSubjectsPath, async (request, response, next) => {
    try {
      response.status(201).json(await catalogService.createSubject(request.body as CatalogCreateSubjectRequest));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${catalogSubjectsPath}/:subjectId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.renameSubject(
        request.params.subjectId,
        request.body as CatalogUpdateSubjectRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${catalogSubjectsPath}/:subjectId/move`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.moveSubject(
        request.params.subjectId,
        request.body as CatalogMoveSubjectRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${catalogSubjectsPath}/:subjectId/reorder`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.reorderSubject(
        request.params.subjectId,
        request.body as CatalogReorderRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${catalogSubjectsPath}/:subjectId`, async (request, response, next) => {
    try {
      response.status(200).json(await catalogService.removeSubject(request.params.subjectId));
    } catch (error) {
      next(error);
    }
  });

  app.get(hierarchyTrashPath, async (_request, response, next) => {
    try {
      response.status(200).json(await hierarchyService.listTrash());
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${hierarchyTrashPermanentPath}/:trashItemId/permanent`, async (request, response, next) => {
    try {
      response.status(200).json(await dataGovernanceService.permanentlyDeleteTrashItem(request.params.trashItemId));
    } catch (error) {
      next(error);
    }
  });

  app.get(`${dataMarkdownExportPath}/:materialId`, async (request, response, next) => {
    try {
      const result = await dataGovernanceService.exportMarkdown(request.params.materialId);
      response.attachment(result.fileName);
      response.type('text/markdown').send(result.content);
    } catch (error) {
      next(error);
    }
  });

  app.get(dataJsonExportPath, async (_request, response, next) => {
    try {
      response.status(200).json(await dataGovernanceService.exportJson());
    } catch (error) {
      next(error);
    }
  });

  app.get(dataBackupsPath, async (_request, response, next) => {
    try {
      response.status(200).json(await dataGovernanceService.listBackups());
    } catch (error) {
      next(error);
    }
  });

  app.post(dataBackupsPath, async (_request, response, next) => {
    try {
      response.status(201).json(await dataGovernanceService.createBackup());
    } catch (error) {
      next(error);
    }
  });

  app.post(`${dataBackupsPath}/:backupId/restore`, async (request, response, next) => {
    try {
      response.status(200).json(await dataGovernanceService.restoreBackup(request.params.backupId));
    } catch (error) {
      next(error);
    }
  });

  app.post(dataJsonRestorePath, async (request, response, next) => {
    try {
      response.status(200).json(await dataGovernanceService.restoreJson(request.body));
    } catch (error) {
      next(error);
    }
  });

  app.get(aiProviderProfilesPath, async (_request, response, next) => {
    try {
      response.status(200).json(await aiProviderService.list());
    } catch (error) {
      next(error);
    }
  });

  app.post(aiProviderProfilesPath, async (request, response, next) => {
    try {
      response.status(201).json(await aiProviderService.create(request.body as AiProviderProfileCreateRequest));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${aiProviderProfilesPath}/:profileId`, async (request, response, next) => {
    try {
      response.status(200).json(await aiProviderService.update(
        request.params.profileId,
        request.body as AiProviderProfileUpdateRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${aiProviderProfilesPath}/:profileId/activate`, async (request, response, next) => {
    try {
      response.status(200).json(await aiProviderService.activate(request.params.profileId));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${aiProviderProfilesPath}/:profileId`, async (request, response, next) => {
    try {
      response.status(200).json(await aiProviderService.remove(request.params.profileId));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${aiProviderProfilesPath}/:profileId/test`, async (request, response, next) => {
    try {
      response.status(200).json(await aiProviderService.testConnection(request.params.profileId));
    } catch (error) {
      next(error);
    }
  });

  app.post(hierarchyPath, async (request, response, next) => {
    try {
      response.status(201).json(await hierarchyService.create(request.body as HierarchyCreateRequest));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${hierarchyPath}/:entityType/:entityId`, async (request, response, next) => {
    try {
      const body = request.body as HierarchyRenameRequest;
      response.status(200).json(await hierarchyService.rename(request.params.entityType as never, request.params.entityId, body.title));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${hierarchyPath}/:entityType/:entityId/move`, async (request, response, next) => {
    try {
      response.status(200).json(await hierarchyService.move(
        request.params.entityType as never,
        request.params.entityId,
        request.body as HierarchyMoveRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${hierarchyPath}/:entityType/:entityId/reorder`, async (request, response, next) => {
    try {
      response.status(200).json(await hierarchyService.reorder(
        request.params.entityType as never,
        request.params.entityId,
        request.body as HierarchyReorderRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${hierarchyPath}/:entityType/:entityId`, async (request, response, next) => {
    try {
      response.status(200).json(await hierarchyService.softDelete(
        request.params.entityType as never,
        request.params.entityId,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.get(reviewStartPath, async (request, response, next) => {
    try {
      const rawScope = request.query.scope;
      const scope = (typeof rawScope === 'string' && rawScope ? rawScope : 'all') as ReviewStartScope;
      const materialId = typeof request.query.materialId === 'string' ? request.query.materialId : undefined;
      response.status(200).json(await reviewService.start(scope, materialId));
    } catch (error) {
      next(error);
    }
  });

  app.get(reviewCardsPath, async (request, response, next) => {
    try {
      const currentCardId = typeof request.query.cardId === 'string' ? request.query.cardId : undefined;
      response.status(200).json(await reviewService.listCards(readReviewFilters(request), currentCardId));
    } catch (error) {
      next(error);
    }
  });

  app.get(`${reviewCardPath}/first`, async (request, response, next) => {
    try {
      response.status(200).json(await reviewService.getFirstCard(readReviewFilters(request)));
    } catch (error) {
      next(error);
    }
  });

  app.get(`${reviewCardPath}/:cardId`, async (request, response, next) => {
    try {
      response.status(200).json(await reviewService.getCard(request.params.cardId, readReviewFilters(request)));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${reviewCardExplanationPath}/:cardId/explanation`, async (request, response, next) => {
    const abort = requestAbortSignal(request, response);
    try {
      const result = await aiExplanationService.generate(
        request.params.cardId,
        request.body as ReviewAiExplanationGenerateRequest,
        { signal: abort.signal },
      );
      if (!abort.signal.aborted) {
        response.status(200).json(result);
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        next(error);
      }
    } finally {
      abort.dispose();
    }
  });

  app.post(`${reviewCardPath}/:cardId/edit-lock`, async (request, response, next) => {
    try {
      response.status(201).json(await reviewService.acquireEditLock(request.params.cardId, readDeviceId(request)));
    } catch (error) {
      next(error);
    }
  });

  app.put(`${reviewCardPath}/:cardId/edit-lock`, async (request, response, next) => {
    try {
      response.status(200).json(await reviewService.renewEditLock(request.params.cardId, readEditLock(request)));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${reviewCardPath}/:cardId/edit-lock`, async (request, response, next) => {
    try {
      await reviewService.releaseEditLock(request.params.cardId, readEditLock(request));
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${reviewCardPath}/:cardId/status`, async (request, response, next) => {
    try {
      const body = request.body as Partial<ReviewStatusUpdateRequest>;
      response.status(200).json(await reviewService.updateStatus(
        request.params.cardId,
        body.status as ReviewMasteryStatus,
        readReviewFilters(request),
      ));
    } catch (error) {
      next(error);
    }
  });

  app.patch(`${reviewCardPath}/:cardId/content`, async (request, response, next) => {
    try {
      response.status(200).json(await reviewService.updateContent(
        request.params.cardId,
        request.body as ReviewCardContentUpdateRequest,
        readEditLock(request),
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post(`${reviewCardHighlightPath}/:cardId/highlights`, async (request, response, next) => {
    try {
      response.status(201).json(await reviewService.createHighlight(
        request.params.cardId,
        request.body as ReviewHighlightCreateRequest,
      ));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${reviewCardHighlightPath}/:cardId/highlights/:highlightId`, async (request, response, next) => {
    try {
      await reviewService.deleteHighlight(request.params.cardId, request.params.highlightId);
      response.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.get(`${reviewResourcePath}/:resourceId`, async (request, response, next) => {
    try {
      const resource = await resourceService.get(request.params.resourceId);
      response.type(resource.mimeType);
      response.sendFile(resource.absolutePath, (error) => {
        if (error && !response.headersSent) {
          next(error);
        }
      });
    } catch (error) {
      next(error);
    }
  });

  app.post(
    reviewResourcePath,
    express.raw({ type: 'image/*', limit: '5mb' }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body)) {
          throw new ResourceApiError(400, '图片内容无效。');
        }
        response.status(201).json({ resource: await resourceService.upload(request.body, request.header('content-type')) });
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    importPreviewPath,
    express.raw({ type: () => true, limit: '25mb' }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body)) {
          throw new ImportApiError(400, '上传文件内容无效。');
        }
        const result = await importService.preview(readImportFileName(request), request.body);
        response.status(200).json(result);
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(
    questionImportPreviewPath,
    express.raw({ type: () => true, limit: '25mb' }),
    async (request, response, next) => {
      try {
        if (!Buffer.isBuffer(request.body)) {
          throw new QuestionImportApiError(400, '上传文件内容无效。');
        }
        const courseId = typeof request.query.courseId === 'string' ? request.query.courseId : '';
        const subjectId = typeof request.query.subjectId === 'string' ? request.query.subjectId : '';
        const kind = typeof request.query.kind === 'string' ? request.query.kind as QuestionBankKind : '' as QuestionBankKind;
        response.status(200).json(await questionImportService.preview(readImportFileName(request), request.body, courseId, subjectId, kind));
      } catch (error) {
        next(error);
      }
    },
  );

  app.post(importApplyPath, async (request, response, next) => {
    try {
      const result = await importService.apply(request.body as ImportApplyRequest);
      response.status(200).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post(questionImportApplyPath, async (request, response, next) => {
    try {
      response.status(200).json(await questionImportService.apply(request.body as QuestionImportApplyRequest));
    } catch (error) {
      next(error);
    }
  });

  app.post(importAiCorrectionPath, async (request, response, next) => {
    try {
      response.status(200).json(await importService.correctFormat(request.body as ImportAiCorrectionRequest));
    } catch (error) {
      next(error);
    }
  });

  app.delete(`${importPreviewPath}/:previewId`, (request, response) => {
    importService.cancel(request.params.previewId);
    response.status(204).end();
  });

  app.delete(`${questionImportPreviewPath}/:previewId`, (request, response) => {
    questionImportService.cancel(request.params.previewId);
    response.status(204).end();
  });

  if (config.webDist) {
    const webDist = config.webDist;
    app.use(express.static(webDist, { index: 'index.html' }));
    app.get(/^(?!\/api(?:\/|$)).*/, (_request, response, next) => {
      response.sendFile(path.join(webDist, 'index.html'), (error) => {
        if (error) {
          next(error);
        }
      });
    });
  }

  app.use((_request, response) => {
    const body: ErrorResponse = { error: '未找到请求的资源。' };
    response.status(404).json(body);
  });

  app.use(errorHandler);
  return app;
}
