import type { Pool } from 'mysql2/promise';
import {
  type ReviewAiExplanation,
  type ReviewAiExplanationGenerateRequest,
  type ReviewAiExplanationResponse,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createDatabasePool } from './database.js';
import { activeAiProviders, AiProviderApiError } from './ai-provider-service.js';

const defaultSystemPrompt = '你是一名严谨、清晰的中文学习助手。只根据闪卡提供的内容进行解释，不编造资料中没有的事实。';
const maxPromptLength = 4_000;
const maxExplanationLength = 20_000;
const requestTimeoutMs = 30_000;

export interface AiExplanationSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface AiExplanationServiceOptions {
  database: AiExplanationSqlExecutor;
  encryptionSecret: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class AiExplanationApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiExplanationApiError';
  }
}

export interface AiExplanationService {
  generate(
    cardId: string,
    request?: ReviewAiExplanationGenerateRequest,
    options?: { signal?: AbortSignal },
  ): Promise<ReviewAiExplanationResponse>;
}

function cancelledRequestError() {
  return new AiExplanationApiError(499, 'AI 请求已取消。');
}

function throwIfRequestCancelled(signal: AbortSignal | undefined) {
  if (signal?.aborted) {
    throw cancelledRequestError();
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

function dateValue(value: unknown): string {
  return value instanceof Date ? value.toISOString() : textValue(value);
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

function nodeText(value: unknown): string {
  if (!isRecord(value)) {
    return '';
  }
  if (value.type === 'image') {
    return value.alt ? `[图片：${textValue(value.alt)}]` : '[图片]';
  }
  if (value.type === 'math' || value.type === 'inlineMath') {
    return value.value ? `[公式：${textValue(value.value)}]` : '[公式]';
  }
  if (value.type === 'break') {
    return '\n';
  }
  if (Array.isArray(value.children)) {
    return value.children.map(nodeText).join(value.type === 'tableRow' ? ' | ' : '');
  }
  return typeof value.value === 'string' ? value.value : '';
}

function contentText(value: unknown): string {
  const parsed = parseJson(value);
  return Array.isArray(parsed)
    ? parsed.map(nodeText).filter(Boolean).join('\n\n').trim()
    : '';
}

function normalizedPrompt(value: unknown): string {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string' || value.trim().length > maxPromptLength) {
    throw new AiExplanationApiError(400, '临时提示词格式无效。');
  }
  return value.trim();
}

function explanationFromRow(row: Record<string, unknown> | undefined): ReviewAiExplanation | null {
  if (!row || !row.generated_at) {
    return null;
  }
  const content = parseJson(row.content_json);
  const text = isRecord(content) && typeof content.text === 'string' ? content.text : '';
  if (!text) {
    return null;
  }
  return {
    provider: textValue(row.provider),
    model: textValue(row.model),
    promptText: textValue(row.prompt_text),
    content: text,
    generatedAt: dateValue(row.generated_at),
  };
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
  if (typeof message.content === 'string') {
    return message.content.trim();
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();
  }
  return '';
}

async function readJson(response: Response): Promise<unknown> {
  let raw: string;
  try {
    raw = await response.text();
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export class AiExplanationServiceImpl implements AiExplanationService {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AiExplanationServiceOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? requestTimeoutMs;
  }

  async generate(
    cardId: string,
    request: ReviewAiExplanationGenerateRequest = {},
    options: { signal?: AbortSignal } = {},
  ): Promise<ReviewAiExplanationResponse> {
    throwIfRequestCancelled(options.signal);
    const normalizedCardId = cardId.trim();
    if (!normalizedCardId) {
      throw new AiExplanationApiError(400, '闪卡 ID 无效。');
    }
    const [cardRows] = await this.options.database.execute(
      `
        SELECT c.title, c.content_json
        FROM cards AS c
        INNER JOIN sections AS s ON s.id = c.section_id
        INNER JOIN chapters AS ch ON ch.id = s.chapter_id
        INNER JOIN materials AS m ON m.id = ch.material_id
        WHERE c.id = ?
          AND c.deleted_at IS NULL
          AND s.deleted_at IS NULL
          AND ch.deleted_at IS NULL
          AND m.deleted_at IS NULL
        LIMIT 1
      `,
      [normalizedCardId],
    );
    const card = rowsFrom(cardRows)[0];
    if (!card) {
      throw new AiExplanationApiError(404, '闪卡不存在或已删除。');
    }

    if (request !== undefined && !isRecord(request)) {
      throw new AiExplanationApiError(400, '临时提示词格式无效。');
    }
    const temporaryPrompt = normalizedPrompt(request?.prompt);
    const sourceText = contentText(card.content_json);
    const promptText = [
      '请用简体中文解释以下知识闪卡。',
      `标题：${textValue(card.title)}`,
      `正文：\n${sourceText || '（无正文）'}`,
      '要求：先给出核心结论，再按要点解释关键概念；如果存在易混淆点，请明确区分。',
      temporaryPrompt ? `本次额外要求：${temporaryPrompt}` : '',
    ].filter(Boolean).join('\n\n');

    let providers;
    try {
      providers = await activeAiProviders(this.options.database, this.options.encryptionSecret);
    } catch (error) {
      if (error instanceof AiProviderApiError) throw new AiExplanationApiError(error.statusCode, error.message);
      throw new AiExplanationApiError(503, '没有可用的已启用 AI Provider。');
    }
    let provider = providers[0]!;
    let content = '';
    let lastFailure: unknown;
    for (const candidate of providers) {
      throwIfRequestCancelled(options.signal);
      const controller = new AbortController();
      const onRequestAbort = () => controller.abort();
      const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
      if (options.signal?.aborted) onRequestAbort(); else options.signal?.addEventListener('abort', onRequestAbort, { once: true });
      try {
        const response = await this.fetchImplementation(endpointFor(candidate.baseUrl), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${candidate.apiKey}` },
          body: JSON.stringify({ model: candidate.model, messages: [{ role: 'system', content: defaultSystemPrompt }, { role: 'user', content: promptText }] }),
          signal: controller.signal,
        });
        const payload = await readJson(response);
        throwIfRequestCancelled(options.signal);
        if (!response.ok) throw new Error('AI Provider 返回错误。');
        content = responseContent(payload);
        if (!content || content.length > maxExplanationLength) throw new Error('AI 返回内容无效。');
        provider = candidate;
        break;
      } catch (error) {
        if (options.signal?.aborted) throw cancelledRequestError();
        lastFailure = error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onRequestAbort);
      }
    }
    if (!content) throw new AiExplanationApiError(502, lastFailure instanceof Error ? lastFailure.message : '所有 AI Provider 均请求失败。');

    await this.options.database.execute(
      `
        INSERT INTO ai_explanations
          (card_id, provider_profile_id, provider, model, prompt_text, content_json)
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          provider_profile_id = VALUES(provider_profile_id),
          provider = VALUES(provider),
          model = VALUES(model),
          prompt_text = VALUES(prompt_text),
          content_json = VALUES(content_json),
          generated_at = CURRENT_TIMESTAMP(3)
      `,
      [
        normalizedCardId,
        provider.id,
        provider.provider,
        provider.model,
        promptText,
        JSON.stringify({ text: content }),
      ],
    );
    const [savedRows] = await this.options.database.execute(
      `
        SELECT provider, model, prompt_text, content_json, generated_at
        FROM ai_explanations
        WHERE card_id = ?
        LIMIT 1
      `,
      [normalizedCardId],
    );
    const explanation = explanationFromRow(rowsFrom(savedRows)[0]) ?? {
      provider: provider.provider,
      model: provider.model,
      promptText,
      content,
      generatedAt: new Date().toISOString(),
    };
    return { explanation };
  }
}

export function createAiExplanationDatabase(pool: Pool): AiExplanationSqlExecutor {
  return {
    execute: (sql: string, values?: readonly unknown[]) =>
      pool.execute(sql, values as never[]) as unknown as Promise<[unknown, unknown]>,
  };
}

export function createAiExplanationService(
  options: Partial<AiExplanationServiceOptions> = {},
): AiExplanationService {
  return new AiExplanationServiceImpl({
    database: options.database ?? createAiExplanationDatabase(createDatabasePool()),
    encryptionSecret: options.encryptionSecret ?? config.ai.providerKeyEncryptionSecret,
    fetchImplementation: options.fetchImplementation,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}
