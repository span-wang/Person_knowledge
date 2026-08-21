import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'mysql2/promise';
import {
  type AiProviderKind,
  type AiProviderProfile,
  type AiProviderProfileCreateRequest,
  type AiProviderProfileStateUpdateRequest,
  type AiProviderProfileUpdateRequest,
  type AiProviderProfilesReorderRequest,
  type AiProviderProfilesResponse,
} from '@knowledge-flashcards/shared';
import { config } from './config.js';
import { createDatabasePool } from './database.js';

const supportedProviders = new Set<AiProviderKind>(['openai', 'deepseek', 'openrouter', 'custom']);
const activeProfileMutexKey = 'ai.activeProfileMutex';

export interface AiProviderSqlExecutor {
  execute(sql: string, values?: readonly unknown[]): Promise<[unknown, unknown]>;
}

export interface AiProviderSqlConnection extends AiProviderSqlExecutor {
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  release(): void;
}

export interface AiProviderDatabase extends AiProviderSqlExecutor {
  getConnection(): Promise<AiProviderSqlConnection>;
}

export interface AiProviderServiceOptions {
  database: AiProviderDatabase;
  encryptionSecret: string;
  fetchImplementation?: typeof fetch;
  requestTimeoutMs?: number;
}

export class AiProviderApiError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiProviderApiError';
  }
}

export interface AiProviderService {
  list(): Promise<AiProviderProfilesResponse>;
  create(request: AiProviderProfileCreateRequest): Promise<AiProviderProfilesResponse>;
  update(profileId: string, request: AiProviderProfileUpdateRequest): Promise<AiProviderProfilesResponse>;
  activate(profileId: string): Promise<AiProviderProfilesResponse>;
  setState(profileId: string, request: AiProviderProfileStateUpdateRequest): Promise<AiProviderProfilesResponse>;
  reorder(request: AiProviderProfilesReorderRequest): Promise<AiProviderProfilesResponse>;
  remove(profileId: string): Promise<AiProviderProfilesResponse>;
  testConnection(profileId: string): Promise<{ message: string }>;
}

export interface ActiveAiProvider {
  id: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
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

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === '1';
}

function affectedRows(value: unknown): number {
  return isRecord(value) && typeof value.affectedRows === 'number' ? value.affectedRows : 0;
}

function nonNegativeInteger(value: unknown): number {
  const result = Number(value);
  return Number.isInteger(result) && result >= 0 ? result : 0;
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new AiProviderApiError(400, `${label}格式无效。`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new AiProviderApiError(400, `${label}格式无效。`);
  }
  return normalized;
}

function normalizedProvider(value: unknown): AiProviderKind {
  const provider = requiredText(value, 'Provider', 100) as AiProviderKind;
  if (!supportedProviders.has(provider)) {
    throw new AiProviderApiError(400, 'Provider 类型无效。');
  }
  return provider;
}

function normalizedBaseUrl(value: unknown): string {
  const baseUrl = requiredText(value, '接口地址', 1024);
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AiProviderApiError(400, '接口地址格式无效。');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new AiProviderApiError(400, '接口地址必须使用 HTTP(S)，且不能包含账号密码。');
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizedApiKey(value: unknown): string {
  const apiKey = requiredText(value, 'API Key', 4096);
  return apiKey;
}

function normalizedProfileId(value: string): string {
  return requiredText(value, '配置标识', 255);
}

function profileFromRow(row: Record<string, unknown>): AiProviderProfile | null {
  const provider = textValue(row.provider) as AiProviderKind;
  if (typeof row.id !== 'string' || !supportedProviders.has(provider)) {
    return null;
  }
  return {
    id: row.id,
    name: textValue(row.name),
    provider,
    baseUrl: textValue(row.base_url),
    model: textValue(row.model),
    hasApiKey: booleanValue(row.has_api_key),
    isActive: booleanValue(row.is_active),
    priority: nonNegativeInteger(row.priority),
  };
}

function encryptionKey(secret: string): Buffer {
  if (!secret.trim() || secret.trim().length < 32) {
    throw new AiProviderApiError(503, 'AI 密钥加密未配置。');
  }
  return createHash('sha256').update(secret, 'utf8').digest();
}

function providerEndpoint(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

export function encryptAiProviderApiKey(apiKey: string, secret: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.from(`v1:${Buffer.concat([iv, authTag, ciphertext]).toString('base64url')}`, 'utf8');
}

export function decryptAiProviderApiKey(ciphertext: Buffer | Uint8Array | string, secret: string): string {
  const encoded = Buffer.from(ciphertext).toString('utf8');
  const [version, payload] = encoded.split(':', 2);
  if (version !== 'v1' || !payload) {
    throw new AiProviderApiError(503, 'AI 密钥存储格式无效。');
  }
  let packed: Buffer;
  try {
    packed = Buffer.from(payload, 'base64url');
  } catch {
    throw new AiProviderApiError(503, 'AI 密钥存储格式无效。');
  }
  if (packed.length <= 28) {
    throw new AiProviderApiError(503, 'AI 密钥存储格式无效。');
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(secret), packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    throw new AiProviderApiError(503, 'AI 密钥解密失败。');
  }
}

export async function activeAiProviders(
  database: AiProviderSqlExecutor,
  encryptionSecret: string,
): Promise<ActiveAiProvider[]> {
  const [rows] = await database.execute(`
    SELECT id, provider, base_url, model, api_key_ciphertext
    FROM ai_provider_profiles
    WHERE is_active = TRUE
    ORDER BY priority ASC, updated_at DESC, id
  `);
  const configured = rowsFrom(rows);
  if (configured.length === 0) {
    throw new AiProviderApiError(503, '尚未配置启用的 AI Provider。');
  }

  const providers: ActiveAiProvider[] = [];
  for (const profile of configured) {
    if (!profile.api_key_ciphertext) continue;
    try {
      providers.push({
        id: textValue(profile.id),
        provider: textValue(profile.provider),
        baseUrl: textValue(profile.base_url),
        model: textValue(profile.model),
        apiKey: decryptAiProviderApiKey(profile.api_key_ciphertext as Buffer, encryptionSecret),
      });
    } catch {
      // 单个渠道密钥失效时继续尝试优先级更低的候选渠道。
    }
  }
  if (providers.length === 0) {
    throw new AiProviderApiError(503, '没有可用的已启用 AI Provider。');
  }
  return providers;
}

export class AiProviderServiceImpl implements AiProviderService {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: AiProviderServiceOptions) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  }

  async list(): Promise<AiProviderProfilesResponse> {
    const [rows] = await this.options.database.execute(
      `
        SELECT id, name, provider, base_url, model,
          api_key_ciphertext IS NOT NULL AS has_api_key,
          is_active, priority
        FROM ai_provider_profiles
        ORDER BY is_active DESC, priority ASC, updated_at DESC, id
      `,
    );
    return {
      profiles: rowsFrom(rows)
        .map((row) => profileFromRow(row))
        .filter((profile): profile is AiProviderProfile => profile !== null),
    };
  }

  async create(request: AiProviderProfileCreateRequest): Promise<AiProviderProfilesResponse> {
    const profile = this.normalizeProfile(request);
    const apiKey = normalizedApiKey(request.apiKey);
    if (typeof request.isActive !== 'boolean') {
      throw new AiProviderApiError(400, '启用状态格式无效。');
    }
    const connection = await this.options.database.getConnection();
    try {
      await connection.beginTransaction();
      const priority = request.isActive ? await this.nextActivePriority(connection) : 0;
      await connection.execute(
        `
          INSERT INTO ai_provider_profiles
            (id, name, provider, base_url, model, api_key_ciphertext, is_active, priority)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [randomUUID(), profile.name, profile.provider, profile.baseUrl, profile.model, encryptAiProviderApiKey(apiKey, this.options.encryptionSecret), request.isActive, priority],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return this.list();
  }

  async update(profileId: string, request: AiProviderProfileUpdateRequest): Promise<AiProviderProfilesResponse> {
    const id = normalizedProfileId(profileId);
    const profile = this.normalizeProfile(request);
    const connection = await this.options.database.getConnection();
    try {
      await connection.beginTransaction();
      const apiKeyCiphertext = request.apiKey === undefined || request.apiKey === ''
        ? null
        : encryptAiProviderApiKey(normalizedApiKey(request.apiKey), this.options.encryptionSecret);
      const [result] = await connection.execute(
        `
          UPDATE ai_provider_profiles
          SET name = ?, provider = ?, base_url = ?, model = ?,
            api_key_ciphertext = CASE WHEN ? IS NULL THEN api_key_ciphertext ELSE ? END
          WHERE id = ?
        `,
        [profile.name, profile.provider, profile.baseUrl, profile.model, apiKeyCiphertext, apiKeyCiphertext, id],
      );
      if (affectedRows(result) === 0) {
        throw new AiProviderApiError(404, 'Provider 配置不存在。');
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return this.list();
  }

  async activate(profileId: string): Promise<AiProviderProfilesResponse> {
    return this.setState(profileId, { isActive: true });
  }

  async setState(profileId: string, request: AiProviderProfileStateUpdateRequest): Promise<AiProviderProfilesResponse> {
    const id = normalizedProfileId(profileId);
    if (!isRecord(request) || typeof request.isActive !== 'boolean') {
      throw new AiProviderApiError(400, '启用状态格式无效。');
    }
    const connection = await this.options.database.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockActiveProfileUpdates(connection);
      const [existingRows] = await connection.execute(
        'SELECT id FROM ai_provider_profiles WHERE id = ? FOR UPDATE',
        [id],
      );
      if (rowsFrom(existingRows).length === 0) {
        throw new AiProviderApiError(404, 'Provider 配置不存在。');
      }
      if (request.isActive) {
        const priority = await this.nextActivePriority(connection);
        await connection.execute('UPDATE ai_provider_profiles SET is_active = TRUE, priority = ? WHERE id = ?', [priority, id]);
      } else {
        await connection.execute('UPDATE ai_provider_profiles SET is_active = FALSE, priority = 0 WHERE id = ?', [id]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return this.list();
  }

  async reorder(request: AiProviderProfilesReorderRequest): Promise<AiProviderProfilesResponse> {
    if (!isRecord(request) || !Array.isArray(request.profileIds) || request.profileIds.length === 0) {
      throw new AiProviderApiError(400, 'Provider 排序格式无效。');
    }
    const profileIds = request.profileIds.map((id) => typeof id === 'string' ? normalizedProfileId(id) : '');
    if (profileIds.some((id) => !id) || new Set(profileIds).size !== profileIds.length) {
      throw new AiProviderApiError(400, 'Provider 排序格式无效。');
    }
    const connection = await this.options.database.getConnection();
    try {
      await connection.beginTransaction();
      await this.lockActiveProfileUpdates(connection);
      const [rows] = await connection.execute('SELECT id FROM ai_provider_profiles WHERE is_active = TRUE FOR UPDATE');
      const activeIds = rowsFrom(rows).map((row) => textValue(row.id));
      if (activeIds.length !== profileIds.length || activeIds.some((id) => !profileIds.includes(id))) {
        throw new AiProviderApiError(409, 'Provider 候选池已变化，请刷新后重试。');
      }
      for (const [index, id] of profileIds.entries()) {
        await connection.execute('UPDATE ai_provider_profiles SET priority = ? WHERE id = ? AND is_active = TRUE', [index + 1, id]);
      }
      await connection.commit();
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
    return this.list();
  }

  async remove(profileId: string): Promise<AiProviderProfilesResponse> {
    const id = normalizedProfileId(profileId);
    const [result] = await this.options.database.execute(
      'DELETE FROM ai_provider_profiles WHERE id = ?',
      [id],
    );
    if (affectedRows(result) === 0) {
      throw new AiProviderApiError(404, 'Provider 配置不存在。');
    }
    return this.list();
  }

  async testConnection(profileId: string): Promise<{ message: string }> {
    const id = normalizedProfileId(profileId);
    const [rows] = await this.options.database.execute(
      `
        SELECT id, provider, base_url, model, api_key_ciphertext
        FROM ai_provider_profiles
        WHERE id = ?
        LIMIT 1
      `,
      [id],
    );
    const profile = rowsFrom(rows)[0];
    if (!profile) {
      throw new AiProviderApiError(404, 'Provider 配置不存在。');
    }
    if (!profile.api_key_ciphertext) {
      throw new AiProviderApiError(400, '当前配置尚未保存 API Key。');
    }
    let apiKey: string;
    try {
      apiKey = decryptAiProviderApiKey(profile.api_key_ciphertext as Buffer, this.options.encryptionSecret);
    } catch (error) {
      if (error instanceof AiProviderApiError) {
        throw error;
      }
      throw new AiProviderApiError(503, 'AI 密钥解密失败。');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response: Response;
    try {
      response = await this.fetchImplementation(providerEndpoint(textValue(profile.base_url)), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: textValue(profile.model),
          messages: [{ role: 'user', content: '请只回复：连接成功' }],
          max_tokens: 8,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AiProviderApiError(502, error instanceof Error && error.name === 'AbortError' ? '连接测试超时。' : '连接测试失败。');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      throw new AiProviderApiError(502, 'Provider 连接测试失败。');
    }
    return { message: '连接成功' };
  }

  private normalizeProfile(request: { name: unknown; provider: unknown; baseUrl: unknown; model: unknown }) {
    return {
      name: requiredText(request.name, '配置名称', 100),
      provider: normalizedProvider(request.provider),
      baseUrl: normalizedBaseUrl(request.baseUrl),
      model: requiredText(request.model, '模型', 255),
    };
  }

  private async lockActiveProfileUpdates(connection: AiProviderSqlConnection) {
    await connection.execute(
      `
        INSERT INTO app_settings (setting_key, setting_value)
        VALUES (?, JSON_OBJECT())
        ON DUPLICATE KEY UPDATE setting_key = VALUES(setting_key)
      `,
      [activeProfileMutexKey],
    );
    await connection.execute(
      'SELECT setting_key FROM app_settings WHERE setting_key = ? FOR UPDATE',
      [activeProfileMutexKey],
    );
  }

  private async nextActivePriority(connection: AiProviderSqlConnection): Promise<number> {
    const [rows] = await connection.execute('SELECT COALESCE(MAX(priority), 0) + 1 AS next_priority FROM ai_provider_profiles WHERE is_active = TRUE FOR UPDATE');
    return Math.max(1, nonNegativeInteger(rowsFrom(rows)[0]?.next_priority));
  }
}

export function createAiProviderDatabase(pool: Pool): AiProviderDatabase {
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

export function createAiProviderService(
  options: Partial<AiProviderServiceOptions> = {},
): AiProviderService {
  return new AiProviderServiceImpl({
    database: options.database ?? createAiProviderDatabase(createDatabasePool()),
    encryptionSecret: options.encryptionSecret ?? config.ai.providerKeyEncryptionSecret,
    fetchImplementation: options.fetchImplementation,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}
