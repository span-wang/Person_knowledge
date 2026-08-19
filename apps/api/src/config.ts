import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse } from 'dotenv';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '../../..');

function loadLocalEnvironment() {
  const localValues: Record<string, string> = {};

  for (const fileName of ['.env', '.env.local']) {
    const filePath = path.join(projectRoot, fileName);
    if (existsSync(filePath)) {
      Object.assign(localValues, parse(readFileSync(filePath)));
    }
  }

  // 保留启动进程已有的环境变量，避免本机文件覆盖部署环境中的显式配置。
  for (const [key, value] of Object.entries(localValues)) {
    process.env[key] ??= value;
  }
}

function readPort(value: string | undefined) {
  const port = Number(value ?? 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('API_PORT 必须是 1 到 65535 之间的整数。');
  }
  return port;
}

function readNumber(value: string | undefined, fallback: number, label: string) {
  const numberValue = Number(value ?? fallback);
  if (!Number.isInteger(numberValue) || numberValue < 1) {
    throw new Error(`${label} 必须是大于 0 的整数。`);
  }
  return numberValue;
}

function readBoolean(value: string | undefined, fallback: boolean, label: string) {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  if (value.toLowerCase() === 'true') {
    return true;
  }
  if (value.toLowerCase() === 'false') {
    return false;
  }
  throw new Error(`${label} 必须是 true 或 false。`);
}

function readPath(value: string | undefined, fallback: string) {
  const configuredPath = value?.trim() || fallback;
  return path.normalize(path.isAbsolute(configuredPath) ? configuredPath : path.resolve(projectRoot, configuredPath));
}

loadLocalEnvironment();

const authUsername = process.env.AUTH_USERNAME?.trim() ?? '';
const authPasswordHash = process.env.AUTH_PASSWORD_HASH?.trim() ?? '';
if ((authUsername && !authPasswordHash) || (!authUsername && authPasswordHash)) {
  throw new Error('AUTH_USERNAME 和 AUTH_PASSWORD_HASH 必须同时配置。');
}
const publicAccessReady = readBoolean(process.env.PUBLIC_ACCESS_READY, false, 'PUBLIC_ACCESS_READY');
if (publicAccessReady && (!authUsername || !authPasswordHash)) {
  throw new Error('PUBLIC_ACCESS_READY=true 时必须配置单账号密码门禁。');
}

export const config = {
  port: readPort(process.env.API_PORT),
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
  webDist: process.env.WEB_DIST_DIR ? readPath(process.env.WEB_DIST_DIR, 'apps/web/dist') : undefined,
  database: {
    host: process.env.DATABASE_HOST ?? '127.0.0.1',
    port: readNumber(process.env.DATABASE_PORT, 3306, 'DATABASE_PORT'),
    user: process.env.DATABASE_USER ?? 'knowledge_flashcards_app',
    password: process.env.DATABASE_PASSWORD ?? '',
    name: process.env.DATABASE_NAME ?? 'knowledge_flashcards',
    connectionLimit: readNumber(process.env.DATABASE_CONNECTION_LIMIT, 5, 'DATABASE_CONNECTION_LIMIT'),
  },
  storage: {
    data: readPath(process.env.DATA_DIR, 'data'),
    resources: readPath(process.env.RESOURCES_DIR, 'resources'),
    backups: readPath(process.env.BACKUPS_DIR, 'backups'),
  },
  ai: {
    providerKeyEncryptionSecret: process.env.AI_PROVIDER_KEY_ENCRYPTION_SECRET ?? '',
  },
  auth: {
    enabled: Boolean(authUsername && authPasswordHash),
    username: authUsername,
    passwordHash: authPasswordHash,
    sessionTtlMs: readNumber(process.env.AUTH_SESSION_TTL_SECONDS, 60 * 60 * 24 * 30, 'AUTH_SESSION_TTL_SECONDS') * 1000,
    failureWindowMs: readNumber(process.env.AUTH_FAILURE_WINDOW_SECONDS, 15 * 60, 'AUTH_FAILURE_WINDOW_SECONDS') * 1000,
    failureLimit: readNumber(process.env.AUTH_FAILURE_LIMIT, 5, 'AUTH_FAILURE_LIMIT'),
    cookieSecure: readBoolean(process.env.AUTH_COOKIE_SECURE, false, 'AUTH_COOKIE_SECURE'),
  },
};
