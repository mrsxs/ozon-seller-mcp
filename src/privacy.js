const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SECRET_KEYS = new Set(['api-key', 'api_key', 'authorization']);

// Keep credentials out of both upstream error text and tool results.
export function redact(value) {
  if (typeof value === 'string') {
    for (const name of ['OZON_API_KEY', 'OZON_ACCESS_TOKEN']) {
      const secret = process.env[name] ?? '';
      if (secret) value = value.replaceAll(secret, '[已隐藏密钥]');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(redact);
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .map(([k, v]) => [k, SECRET_KEYS.has(String(k).toLowerCase()) ? '[已隐藏]' : redact(v)]));
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
