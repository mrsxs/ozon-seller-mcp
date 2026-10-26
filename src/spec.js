// Pinned official OpenAPI snapshot; nothing is fetched at runtime.
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const load = (file) => JSON.parse(readFileSync(new URL(file, ROOT), 'utf8'));

export const SPEC = load('spec/openapi-ru.json');
export const CATALOG = load('spec/operations.json');
export const OPERATIONS = new Map(CATALOG.operations.map((op) => [op.tool_name, op]));
const BY_ENDPOINT = new Map(CATALOG.operations.map((op) => [`${op.method} ${op.path}`, op]));

export function findOperation(endpoint, method = 'POST') {
  return BY_ENDPOINT.get(`${String(method).toUpperCase()} ${endpoint}`);
}

export function endpointKeys() {
  return [...BY_ENDPOINT.keys()];
}

const unescapePointer = (part) => part.replaceAll('~1', '/').replaceAll('~0', '~');

export function deref(value) {
  while (value && typeof value === 'object' && '$ref' in value) {
    const ref = value.$ref;
    if (!ref.startsWith('#/')) throw new Error('规范包含外部引用，禁止自动联网解析。');
    value = ref.slice(2).split('/').reduce((node, part) => node[unescapePointer(part)], SPEC);
  }
  return value;
}

export function operationSource(op) {
  return SPEC.paths[op.path][op.method.toLowerCase()];
}

export function mediaSource(op) {
  const body = deref(operationSource(op).requestBody || {});
  const contents = body.content || {};
  if (contents['application/json']) return ['application/json', contents['application/json']];
  if (contents['multipart/form-data']) return ['multipart/form-data', contents['multipart/form-data']];
  const kinds = Object.keys(contents);
  if (kinds.length) throw new Error('未实现的请求媒体类型：' + kinds.join(', '));
  return [null, {}];
}
