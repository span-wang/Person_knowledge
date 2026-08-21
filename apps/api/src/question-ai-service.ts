import { randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import type {
  PracticeAttemptResult,
  QuestionAiExplanation,
  QuestionAiExplanationGenerateRequest,
  QuestionAiExplanationHistoryResponse,
  QuestionAiExplanationResponse,
  QuestionType,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createDatabasePool } from './database.js';
import { activeAiProviders, AiProviderApiError } from './ai-provider-service.js';

const defaultSystemPrompt = '你是一名严谨、清晰的中文学习助手。只根据题目提供的内容进行讲解，不编造题目之外的事实。';
const maxPromptLength = 4_000;
const maxExplanationLength = 20_000;
const requestTimeoutMs = 30_000;
const attemptResults = new Set<PracticeAttemptResult>(['unanswered', 'correct', 'incorrect']);
const questionTypes = new Set<QuestionType>(['single', 'multiple', 'true_false']);

export interface QuestionAiSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface QuestionAiServiceOptions {
  database: QuestionAiSqlExecutor;
  encryptionSecret: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class QuestionAiApiError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'QuestionAiApiError';
  }
}

export interface QuestionAiService {
  list(questionId: string): Promise<QuestionAiExplanationHistoryResponse>;
  generate(questionId: string, request?: QuestionAiExplanationGenerateRequest, options?: { signal?: AbortSignal }): Promise<QuestionAiExplanationResponse>;
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

function dateValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : textValue(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

function nodeText(value: unknown): string {
  if (!isRecord(value)) return '';
  if (value.type === 'image') return value.alt ? `[图片：${textValue(value.alt)}]` : '[图片]';
  if (value.type === 'math' || value.type === 'inlineMath') return value.value ? `[公式：${textValue(value.value)}]` : '[公式]';
  if (value.type === 'break') return '\n';
  if (Array.isArray(value.children)) return value.children.map(nodeText).join(value.type === 'tableRow' ? ' | ' : '');
  return typeof value.value === 'string' ? value.value : '';
}

function contentText(value: unknown): string {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map(nodeText).filter(Boolean).join('\n\n').trim() : '';
}

function optionsText(value: unknown): string {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return '';
  return parsed.map((item) => isRecord(item) ? `${textValue(item.key)}. ${contentText(item.content)}` : '').filter(Boolean).join('\n');
}

function answerText(value: unknown): string {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.map((item) => textValue(item).toUpperCase()).filter(Boolean).join('、') : '';
}

function normalizedId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128) throw new QuestionAiApiError(400, '题目标识无效。');
  return value.trim();
}

function normalizedPrompt(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.trim().length > maxPromptLength) throw new QuestionAiApiError(400, '临时提示词格式无效。');
  return value.trim();
}

function normalizedRequest(request: QuestionAiExplanationGenerateRequest | undefined) {
  if (request !== undefined && !isRecord(request)) throw new QuestionAiApiError(400, 'AI 请求格式无效。');
  const prompt = normalizedPrompt(request?.prompt);
  const rawAttempt = request?.attempt;
  if (rawAttempt === undefined || rawAttempt === null) return { prompt, attempt: null };
  if (!isRecord(rawAttempt) || !Array.isArray(rawAttempt.answer) && rawAttempt.answer !== null || typeof rawAttempt.result !== 'string' || !attemptResults.has(rawAttempt.result as PracticeAttemptResult)) {
    throw new QuestionAiApiError(400, '本次作答上下文格式无效。');
  }
  const answer = rawAttempt.answer === null ? null : rawAttempt.answer.map((item) => typeof item === 'string' ? item.trim().toUpperCase() : '');
  if (answer?.some((item) => !item || item.length > 2)) throw new QuestionAiApiError(400, '本次作答答案格式无效。');
  return { prompt, attempt: { answer, result: rawAttempt.result as PracticeAttemptResult } };
}

function cancelledError() { return new QuestionAiApiError(499, 'AI 请求已取消。'); }

function throwIfCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) throw cancelledError();
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

function responseContent(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || !isRecord(payload.choices[0])) return '';
  const message = payload.choices[0].message;
  if (!isRecord(message)) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) return message.content.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('').trim();
  return '';
}

async function readJson(response: Response): Promise<unknown> {
  try { return JSON.parse(await response.text()) as unknown; } catch { return null; }
}

function explanationFromRow(row: Record<string, unknown> | undefined, currentVersion: number): QuestionAiExplanation | null {
  if (!row) return null;
  const content = parseJson(row.content_json);
  const text = isRecord(content) && typeof content.text === 'string' ? content.text : '';
  if (!text) return null;
  return {
    id: textValue(row.id),
    questionId: textValue(row.question_id),
    questionVersion: numberValue(row.question_version),
    provider: textValue(row.provider),
    model: textValue(row.model),
    promptText: textValue(row.prompt_text),
    content: text,
    generatedAt: dateValue(row.generated_at),
    stale: numberValue(row.question_version) !== currentVersion,
  };
}

export class QuestionAiServiceImpl implements QuestionAiService {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: QuestionAiServiceOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutMs;
  }

  private async currentQuestion(questionId: string) {
    const [rows] = await this.options.database.execute(
      'SELECT id, question_type, stem_json, options_json, answer_json, analysis_json, knowledge_points_json, version FROM questions WHERE id = ? AND deleted_at IS NULL LIMIT 1',
      [questionId],
    );
    const row = rowsFrom(rows)[0];
    if (!row) throw new QuestionAiApiError(404, '题目不存在或已删除。');
    const type = textValue(row.question_type) as QuestionType;
    if (!questionTypes.has(type)) throw new QuestionAiApiError(409, '题型已损坏。');
    const knowledgePoints = parseJson(row.knowledge_points_json);
    return { id: textValue(row.id), type, version: numberValue(row.version), stem: contentText(row.stem_json), options: optionsText(row.options_json), answer: answerText(row.answer_json), analysis: row.analysis_json === null ? '' : contentText(row.analysis_json), knowledgePoints: Array.isArray(knowledgePoints) ? knowledgePoints.map(textValue).filter(Boolean).join('、') : '' };
  }

  async list(questionId: string): Promise<QuestionAiExplanationHistoryResponse> {
    const normalizedQuestionId = normalizedId(questionId);
    const question = await this.currentQuestion(normalizedQuestionId);
    const [rows] = await this.options.database.execute(
      'SELECT id, question_id, question_version, provider, model, prompt_text, content_json, generated_at FROM question_ai_explanations WHERE question_id = ? ORDER BY generated_at DESC, id DESC',
      [normalizedQuestionId],
    );
    return { questionId: normalizedQuestionId, currentQuestionVersion: question.version, explanations: rowsFrom(rows).map((row) => explanationFromRow(row, question.version)).filter((item): item is QuestionAiExplanation => item !== null) };
  }

  async generate(questionId: string, request: QuestionAiExplanationGenerateRequest = {}, options: { signal?: AbortSignal } = {}): Promise<QuestionAiExplanationResponse> {
    throwIfCancelled(options.signal);
    const normalizedQuestionId = normalizedId(questionId);
    const question = await this.currentQuestion(normalizedQuestionId);
    const normalized = normalizedRequest(request);
    const attemptText = normalized.attempt
      ? `本次作答：${normalized.attempt.answer?.join('、') || '未作答'}；判定：${normalized.attempt.result === 'correct' ? '正确' : normalized.attempt.result === 'incorrect' ? '错误' : '未作答'}`
      : '';
    const promptText = [
      '请用简体中文讲解以下题目。先说明考查要点，再解释正确答案和各选项的判断依据；如果提供了解析，请优先结合解析。',
      `题型：${question.type}`,
      `题干：\n${question.stem || '（无题干）'}`,
      `选项：\n${question.options || '（无选项）'}`,
      `标准答案：${question.answer || '（无答案）'}`,
      question.analysis ? `已有解析：\n${question.analysis}` : '',
      question.knowledgePoints ? `知识点：${question.knowledgePoints}` : '',
      attemptText,
      normalized.prompt ? `本次额外要求：${normalized.prompt}` : '',
    ].filter(Boolean).join('\n\n');
    let providers;
    try {
      providers = await activeAiProviders(this.options.database, this.options.encryptionSecret);
    } catch (error) {
      if (error instanceof AiProviderApiError) throw new QuestionAiApiError(error.statusCode, error.message);
      throw new QuestionAiApiError(503, '没有可用的已启用 AI Provider。');
    }
    let provider = providers[0]!;
    let content = '';
    let lastFailure: unknown;
    for (const candidate of providers) {
      throwIfCancelled(options.signal);
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      if (options.signal?.aborted) onAbort(); else options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await this.fetchImplementation(endpointFor(candidate.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
          body: JSON.stringify({ model: candidate.model, messages: [{ role: 'system', content: defaultSystemPrompt }, { role: 'user', content: promptText }] }),
          signal: controller.signal,
        });
        const payload = await readJson(response);
        throwIfCancelled(options.signal);
        if (!response.ok) throw new Error('AI Provider 返回错误。');
        content = responseContent(payload);
        if (!content || content.length > maxExplanationLength) throw new Error('AI 返回内容无效。');
        provider = candidate;
        break;
      } catch (error) {
        if (options.signal?.aborted) throw cancelledError();
        lastFailure = error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
    }
    if (!content) throw new QuestionAiApiError(502, lastFailure instanceof Error ? lastFailure.message : '所有 AI Provider 均请求失败。');
    const id = randomUUID();
    await this.options.database.execute(
      'INSERT INTO question_ai_explanations (id, question_id, question_version, provider_profile_id, provider, model, prompt_text, content_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, normalizedQuestionId, question.version, provider.id, provider.provider, provider.model, promptText, JSON.stringify({ text: content })],
    );
    const explanation: QuestionAiExplanation = { id, questionId: normalizedQuestionId, questionVersion: question.version, provider: provider.provider, model: provider.model, promptText, content, generatedAt: new Date().toISOString(), stale: false };
    return { explanation };
  }
}

export function createQuestionAiDatabase(pool: Pool): QuestionAiSqlExecutor {
  return { execute: (sql, values) => pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]> };
}

export function createQuestionAiService(options: Partial<QuestionAiServiceOptions> = {}): QuestionAiService {
  return new QuestionAiServiceImpl({ database: options.database ?? createQuestionAiDatabase(createDatabasePool()), encryptionSecret: options.encryptionSecret ?? config.ai.providerKeyEncryptionSecret, fetchImplementation: options.fetchImplementation, requestTimeoutMs: options.requestTimeoutMs });
}
