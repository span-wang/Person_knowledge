import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export interface AuthConfig {
  enabled: boolean;
  username: string;
  passwordHash: string;
  sessionTtlMs: number;
  failureWindowMs: number;
  failureLimit: number;
  cookieSecure: boolean;
}

export interface AuthSession {
  username: string;
  expiresAt: number;
}

export interface AuthService {
  readonly enabled: boolean;
  authenticate(username: string, password: string, clientKey: string):
    | { ok: true; token: string; session: AuthSession }
    | { ok: false; retryAfterSeconds: number };
  readSession(cookieHeader: string | undefined): AuthSession | null;
  revoke(cookieHeader: string | undefined): void;
  cookie(token: string): string;
  clearCookie(): string;
}

interface FailureState {
  count: number;
  resetAt: number;
}

const HASH_ALGORITHM = 'sha256';
const HASH_KEY_LENGTH = 64;

export function hashPassword(password: string, salt = randomBytes(16).toString('base64url')): string {
  const digest = scryptSync(password, salt, HASH_KEY_LENGTH).toString('base64url');
  return `scrypt$${salt}$${digest}`;
}

export function verifyPassword(password: string, encodedHash: string): boolean {
  const parts = encodedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  try {
    const expected = Buffer.from(parts[2]!, 'base64url');
    const actual = scryptSync(password, parts[1]!, expected.length || HASH_KEY_LENGTH);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) {
      return value.join('=') || null;
    }
  }
  return null;
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds: number): string {
  return [
    `kf_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function createAuthService(config: AuthConfig): AuthService {
  const sessions = new Map<string, AuthSession>();
  const failures = new Map<string, FailureState>();

  function prune(now: number) {
    for (const [token, session] of sessions) {
      if (session.expiresAt <= now) {
        sessions.delete(token);
      }
    }
    for (const [key, state] of failures) {
      if (state.resetAt <= now) {
        failures.delete(key);
      }
    }
  }

  return {
    enabled: config.enabled,
    authenticate(username, password, clientKey) {
      if (!config.enabled) {
        return { ok: false, retryAfterSeconds: 0 };
      }
      const now = Date.now();
      prune(now);
      const current = failures.get(clientKey);
      if (current && current.count >= config.failureLimit) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) };
      }
      const valid = username === config.username && verifyPassword(password, config.passwordHash);
      if (!valid) {
        const next = current && current.resetAt > now
          ? { count: current.count + 1, resetAt: current.resetAt }
          : { count: 1, resetAt: now + config.failureWindowMs };
        failures.set(clientKey, next);
        return {
          ok: false,
          retryAfterSeconds: next.count >= config.failureLimit
            ? Math.max(1, Math.ceil((next.resetAt - now) / 1000))
            : 0,
        };
      }
      failures.delete(clientKey);
      const token = randomBytes(32).toString('base64url');
      const session = { username: config.username, expiresAt: now + config.sessionTtlMs };
      sessions.set(token, session);
      return { ok: true, token, session };
    },
    readSession(cookieHeader) {
      const token = parseCookie(cookieHeader, 'kf_session');
      if (!token) {
        return null;
      }
      const session = sessions.get(token);
      if (!session || session.expiresAt <= Date.now()) {
        sessions.delete(token);
        return null;
      }
      return session;
    },
    revoke(cookieHeader) {
      const token = parseCookie(cookieHeader, 'kf_session');
      if (token) {
        sessions.delete(token);
      }
    },
    cookie(token) {
      return sessionCookie(token, config.cookieSecure, Math.floor(config.sessionTtlMs / 1000));
    },
    clearCookie() {
      return sessionCookie('', config.cookieSecure, 0);
    },
  };
}

export function createPasswordHash(password: string): string {
  return hashPassword(password);
}

export function hashFingerprint(value: string): string {
  return createHash(HASH_ALGORITHM).update(value).digest('hex');
}
