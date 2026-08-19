import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AiProviderApiError,
  AiProviderServiceImpl,
  encryptAiProviderApiKey,
  type AiProviderDatabase,
  type AiProviderSqlConnection,
} from './ai-provider-service.js';

type StoredProfile = {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyCiphertext: Buffer | null;
  isActive: boolean;
};

class FakeAiProviderDatabase implements AiProviderDatabase, AiProviderSqlConnection {
  readonly profiles: StoredProfile[] = [];

  async execute(sql: string, values: readonly unknown[] = []): Promise<[unknown, unknown]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized.startsWith('SELECT id, name, provider, base_url, model,')) {
      return [this.profiles
        .slice()
        .sort((left, right) => Number(right.isActive) - Number(left.isActive))
        .map((profile) => ({
          id: profile.id,
          name: profile.name,
          provider: profile.provider,
          base_url: profile.baseUrl,
          model: profile.model,
          has_api_key: profile.apiKeyCiphertext ? 1 : 0,
          is_active: profile.isActive ? 1 : 0,
        })), []];
    }
    if (normalized === 'UPDATE ai_provider_profiles SET is_active = FALSE WHERE is_active = TRUE') {
      for (const profile of this.profiles) {
        profile.isActive = false;
      }
      return [{ affectedRows: this.profiles.length }, []];
    }
    if (normalized.startsWith('INSERT INTO app_settings')) {
      return [{ affectedRows: 1 }, []];
    }
    if (normalized === 'SELECT setting_key FROM app_settings WHERE setting_key = ? FOR UPDATE') {
      return [[{ setting_key: values[0] }], []];
    }
    if (normalized.startsWith('INSERT INTO ai_provider_profiles')) {
      const [id, name, provider, baseUrl, model, apiKeyCiphertext, isActive] = values;
      this.profiles.push({
        id: String(id),
        name: String(name),
        provider: String(provider),
        baseUrl: String(baseUrl),
        model: String(model),
        apiKeyCiphertext: Buffer.isBuffer(apiKeyCiphertext) ? apiKeyCiphertext : null,
        isActive: Boolean(isActive),
      });
      return [{ affectedRows: 1 }, []];
    }
    if (normalized === 'SELECT id FROM ai_provider_profiles WHERE id = ? FOR UPDATE') {
      const profile = this.profiles.find((item) => item.id === values[0]);
      return [profile ? [{ id: profile.id }] : [], []];
    }
    if (normalized.startsWith('SELECT id, provider, base_url, model, api_key_ciphertext')) {
      const profile = this.profiles.find((item) => item.id === values[0]);
      return [profile ? [{
        id: profile.id,
        provider: profile.provider,
        base_url: profile.baseUrl,
        model: profile.model,
        api_key_ciphertext: profile.apiKeyCiphertext,
      }] : [], []];
    }
    if (normalized === 'UPDATE ai_provider_profiles SET is_active = TRUE WHERE id = ?') {
      const profile = this.profiles.find((item) => item.id === values[0]);
      if (profile) {
        profile.isActive = true;
      }
      return [{ affectedRows: profile ? 1 : 0 }, []];
    }
    if (normalized.startsWith('UPDATE ai_provider_profiles SET name = ?')) {
      const profile = this.profiles.find((item) => item.id === values[6]);
      if (!profile) {
        return [{ affectedRows: 0 }, []];
      }
      profile.name = String(values[0]);
      profile.provider = String(values[1]);
      profile.baseUrl = String(values[2]);
      profile.model = String(values[3]);
      if (Buffer.isBuffer(values[4])) {
        profile.apiKeyCiphertext = values[4];
      }
      return [{ affectedRows: 1 }, []];
    }
    if (normalized === 'DELETE FROM ai_provider_profiles WHERE id = ?') {
      const index = this.profiles.findIndex((item) => item.id === values[0]);
      if (index < 0) {
        return [{ affectedRows: 0 }, []];
      }
      this.profiles.splice(index, 1);
      return [{ affectedRows: 1 }, []];
    }
    throw new Error(`未处理的 SQL：${normalized}`);
  }

  async getConnection(): Promise<AiProviderSqlConnection> {
    return this;
  }

  async beginTransaction() {}
  async commit() {}
  async rollback() {}
  release() {}
}

const encryptionSecret = 'test-encryption-secret-must-have-at-least-thirty-two-characters';

test('Provider 配置只返回密钥状态，并在留空更新时保留密文', async () => {
  const database = new FakeAiProviderDatabase();
  const service = new AiProviderServiceImpl({ database, encryptionSecret });

  const created = await service.create({
    name: '主配置',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1/',
    model: 'gpt-5',
    apiKey: 'sk-test-secret',
    isActive: true,
  });

  assert.equal(created.profiles.length, 1);
  assert.equal(created.profiles[0]?.hasApiKey, true);
  assert.equal(created.profiles[0]?.isActive, true);
  assert.equal(created.profiles[0]?.baseUrl, 'https://api.openai.com/v1');
  assert.equal('apiKey' in created.profiles[0]!, false);
  const encryptedBeforeUpdate = database.profiles[0]!.apiKeyCiphertext!;
  assert.equal(encryptedBeforeUpdate.includes('sk-test-secret'), false);

  const updated = await service.update(created.profiles[0]!.id, {
    name: '主配置',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
  });

  assert.equal(updated.profiles[0]?.model, 'gpt-5-mini');
  assert.deepEqual(database.profiles[0]!.apiKeyCiphertext, encryptedBeforeUpdate);
});

test('启用项切换会取消其他配置的启用状态，并支持删除', async () => {
  const database = new FakeAiProviderDatabase();
  const service = new AiProviderServiceImpl({ database, encryptionSecret });
  const first = await service.create({
    name: 'OpenAI', provider: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5', apiKey: 'first-key', isActive: true,
  });
  const second = await service.create({
    name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'second-key', isActive: false,
  });

  const switched = await service.activate(second.profiles.find((profile) => profile.name === 'DeepSeek')!.id);
  assert.equal(switched.profiles.find((profile) => profile.name === 'OpenAI')?.isActive, false);
  assert.equal(switched.profiles.find((profile) => profile.name === 'DeepSeek')?.isActive, true);

  const removed = await service.remove(first.profiles[0]!.id);
  assert.equal(removed.profiles.length, 1);
  assert.equal(removed.profiles[0]?.name, 'DeepSeek');
});

test('未配置加密口令时拒绝写入 API Key', async () => {
  assert.throws(
    () => encryptAiProviderApiKey('secret', 'too-short'),
    (error: unknown) => error instanceof AiProviderApiError && error.statusCode === 503,
  );
});

test('连接测试只调用当前配置的兼容接口，不返回密钥', async () => {
  const database = new FakeAiProviderDatabase();
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const service = new AiProviderServiceImpl({
    database,
    encryptionSecret,
    fetchImplementation: async (input, init) => {
      requests.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') });
      return new Response('{"choices":[{"message":{"content":"连接成功"}}]}', { status: 200 });
    },
  });
  const created = await service.create({
    name: '测试配置',
    provider: 'openai',
    baseUrl: 'https://api.example.test/v1',
    model: 'gpt-test',
    apiKey: 'connection-secret',
    isActive: true,
  });
  const result = await service.testConnection(created.profiles[0]!.id);
  assert.deepEqual(result, { message: '连接成功' });
  assert.deepEqual(requests, [{ url: 'https://api.example.test/v1/chat/completions', authorization: 'Bearer connection-secret' }]);
  assert.doesNotMatch(JSON.stringify(result), /connection-secret/);
});
