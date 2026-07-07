const LOGIN_FAILURE_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const LOGIN_FAILURE_LIMIT = 5;

type LoginFailureRecord = {
  readonly count: number;
  readonly firstFailureAt: number;
  readonly lockedUntil: number | null;
};

export type LoginAttempt = {
  readonly username: string;
  readonly clientIp: string;
  readonly key: string;
};

const loginFailures = new Map<string, LoginFailureRecord>();

export function createLoginAttempt(username: string, clientIp: string): LoginAttempt {
  return {
    username,
    clientIp,
    key: `${clientIp}::${username.trim().toLowerCase()}`,
  };
}

export function isLoginLocked(attempt: LoginAttempt, now = Date.now()): boolean {
  const record = loginFailures.get(attempt.key);
  if (!record) return false;
  if (record.lockedUntil && record.lockedUntil > now) return true;
  if (record.lockedUntil || now - record.firstFailureAt > LOGIN_FAILURE_WINDOW_MS) {
    loginFailures.delete(attempt.key);
  }
  return false;
}

export function recordLoginFailure(attempt: LoginAttempt, now = Date.now()): void {
  const current = loginFailures.get(attempt.key);
  const withinWindow = current ? now - current.firstFailureAt <= LOGIN_FAILURE_WINDOW_MS : false;
  const count = withinWindow && current ? current.count + 1 : 1;
  const firstFailureAt = withinWindow && current ? current.firstFailureAt : now;
  const lockedUntil = count >= LOGIN_FAILURE_LIMIT ? now + LOGIN_LOCKOUT_MS : null;
  loginFailures.set(attempt.key, { count, firstFailureAt, lockedUntil });
  if (lockedUntil) {
    console.warn(`[Local Auth] Login locked for ${attempt.clientIp}::${attempt.username}`);
  }
}

export function clearLoginFailures(attempt: LoginAttempt): void {
  loginFailures.delete(attempt.key);
}
