import { allSecrets } from './shops.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SECRET_KEYS = new Set(['api-key', 'api_key', 'authorization', 'client_secret', 'perf_client_secret', 'access_token']);
const SECRET_MARK = '[已隐藏密钥]';
const TOKEN_MARK = '[已隐藏令牌]';

// Bearer tokens obtained at runtime (Performance API client-credentials tokens) are credentials
// too. A token that is still valid (the cached one included) or used by a request in flight is
// always listed, however many there are. Only history (expired, not in use) is ever dropped: after
// a grace period, or oldest first beyond MAX_HISTORY, so a late error or log line about a token
// that was just replaced is still covered.
const TOKEN_GRACE_MS = 15 * 60_000;
const MAX_HISTORY = 64;
const runtimeTokens = new Map(); // token -> { expiresAt, holds }, oldest first

export function rememberToken(token, expiresAt = Date.now()) {
  if (typeof token !== 'string' || !token) return;
  // The same entry object is kept, so a hold taken on it stays counted.
  const entry = runtimeTokens.get(token) ?? { holds: 0 };
  entry.expiresAt = expiresAt;
  runtimeTokens.delete(token);
  runtimeTokens.set(token, entry);
  pruneTokens();
}

// Marks a token as in use by a request; the returned function (idempotent) releases it.
export function holdToken(token) {
  const entry = runtimeTokens.get(token);
  if (!entry) return () => {};
  entry.holds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    entry.holds -= 1;
    pruneTokens();
  };
}

const inUse = (entry, now) => entry.holds > 0 || entry.expiresAt > now;

function pruneTokens(now = Date.now()) {
  const history = [...runtimeTokens].filter(([, entry]) => !inUse(entry, now));
  history.forEach(([token, entry], index) => {
    if (entry.expiresAt + TOKEN_GRACE_MS <= now || index < history.length - MAX_HISTORY) runtimeTokens.delete(token);
  });
}

export function forgetTokens() {
  runtimeTokens.clear();
}

function replacements() {
  const now = Date.now();
  const tokens = [...runtimeTokens]
    .filter(([, entry]) => inUse(entry, now) || entry.expiresAt + TOKEN_GRACE_MS > now)
    .map(([token]) => [token, TOKEN_MARK]);
  return [...allSecrets().map((secret) => [secret, SECRET_MARK]), ...tokens];
}

// The one redaction path for tool results, error text and logs: every shop's configured secrets,
// raw and trimmed (the trimmed form is what actually goes on the wire), plus the runtime tokens
// above. The list is built once per call, not once per string in a large result.
export function redact(value) {
  return scrub(value, replacements());
}

function scrub(value, pairs) {
  if (typeof value === 'string') {
    for (const [secret, mark] of pairs) value = value.replaceAll(secret, mark);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, pairs));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [scrub(k, pairs), SECRET_KEYS.has(String(k).toLowerCase()) ? '[已隐藏]' : scrub(v, pairs)]));
  }
  return value;
}

// For stderr: any thrown value (an Error's stack included) as redacted text. Never throws, since
// it runs inside the process-level error handlers.
export function redactText(value) {
  let text;
  try {
    text = typeof value === 'string' ? value : String(value?.stack ?? value);
  } catch {
    return '（无法转换为文本的错误）';
  }
  try {
    return redact(text);
  } catch {
    return '（错误内容脱敏失败，已省略）';
  }
}

const PRIVATE_FIELDS = new Set(['customer', 'addressee', 'address', 'phone', 'email', 'legal_info']);

// Customer contact and address data are omitted by default.
export function hidePersonal(value) {
  if (Array.isArray(value)) return value.map(hidePersonal);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([k]) => !PRIVATE_FIELDS.has(k))
      .map(([k, v]) => [k, hidePersonal(v)]));
  }
  return value;
}
