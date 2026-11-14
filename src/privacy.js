import { allSecrets } from './shops.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SECRET_KEYS = new Set(['api-key', 'api_key', 'authorization', 'client_secret', 'perf_client_secret', 'access_token']);

// Keep credentials out of both upstream error text and tool results: every shop's secrets,
// raw and trimmed (the trimmed form is what actually goes on the wire). The secret list is
// built once per call, not once per string in a large result.
export function redact(value) {
  return scrub(value, allSecrets());
}

function scrub(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) value = value.replaceAll(secret, '[已隐藏密钥]');
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, SECRET_KEYS.has(String(k).toLowerCase()) ? '[已隐藏]' : scrub(v, secrets)]));
  }
  return value;
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
