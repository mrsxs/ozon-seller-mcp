// Performance API inputs: path + query parameters (`params`) and the JSON request body (`body`),
// generated from the pinned spec with the same conversions and strictness as the Seller API.
import { ValidationError } from '../errors.js';
import { compileSchema, formatErrors, rejectUnknown, withDefinitions as resolveDefinitions } from '../schema.js';
import { ADS_SPEC, adsDeref, adsSource } from './spec.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Path segments are IDs or UUIDs; anything else (e.g. "..") could rewrite the URL to another endpoint.
export const SAFE_PATH_VALUE = '^[A-Za-z0-9_-]{1,128}$';

const withDefinitions = (source, location) => resolveDefinitions(source, ADS_SPEC.components.schemas, location);

function parameters(op) {
  const shared = ADS_SPEC.paths[op.source_path].parameters ?? [];
  return [...shared, ...(adsSource(op).parameters ?? [])].map(adsDeref);
}

export const pathParamNames = (op) => parameters(op).filter((p) => p.in === 'path').map((p) => p.name);

function paramSchema(param) {
  const schema = { ...(param.schema ?? {}) };
  if (param.description && !schema.description) schema.description = param.description;
  if (param.in === 'path' && !schema.pattern) schema.pattern = SAFE_PATH_VALUE;
  return schema;
}

const paramsCache = new Map();
export function adsParamsSchema(op) {
  if (paramsCache.has(op)) return paramsCache.get(op);
  // Header and cookie parameters are never taken from tool input.
  const accepted = parameters(op).filter((p) => p.in === 'path' || p.in === 'query');
  const source = {
    type: 'object',
    properties: Object.fromEntries(accepted.map((p) => [p.name, paramSchema(p)])),
    required: accepted.filter((p) => p.in === 'path' || p.required === true).map((p) => p.name),
    additionalProperties: false,
  };
  const result = withDefinitions(source, `${op.path}/parameters`);
  paramsCache.set(op, result);
  return result;
}

function requestBody(op) {
  const body = adsDeref(adsSource(op).requestBody);
  if (!body) return null;
  const contents = body.content ?? {};
  if (contents['application/json']) return contents['application/json'];
  const kinds = Object.keys(contents);
  if (kinds.length) throw new Error('未实现的请求媒体类型：' + kinds.join(', '));
  return null;
}

const bodyCache = new Map();
export function adsBodySchema(op) {
  if (bodyCache.has(op)) return bodyCache.get(op);
  const media = requestBody(op);
  // The top-level $ref is inlined so the body's own fields are visible to the model.
  const result = media ? { type: 'object', ...withDefinitions(adsDeref(media.schema) ?? { type: 'object' }, `${op.path}/requestBody`) } : null;
  bodyCache.set(op, result);
  return result;
}

const checkParams = (op) => compileSchema(`ads:params:${op.method} ${op.path}`, adsParamsSchema(op));
const checkBody = (op) => compileSchema(`ads:body:${op.method} ${op.path}`, adsBodySchema(op));

// Returns the body to send: {} for an operation with an optional empty body, undefined when it has none.
export function validateAdsRequest(op, params, body) {
  if (!isObject(params)) throw new ValidationError('params 必须为 JSON 对象（路径参数与查询参数）。');
  const paramCheck = checkParams(op);
  if (!paramCheck(params)) throw new ValidationError('params 校验失败；未发送请求。' + formatErrors(paramCheck.errors).join('；'));

  const schema = adsBodySchema(op);
  if (!schema) {
    if (body !== undefined && body !== null && !(isObject(body) && !Object.keys(body).length)) {
      throw new ValidationError('该接口没有请求体；查询条件请放在 params。');
    }
    return undefined;
  }
  const payload = body ?? {};
  if (!isObject(payload)) throw new ValidationError('body 必须为 JSON 对象。');
  const bodyCheck = checkBody(op);
  if (!bodyCheck(payload)) throw new ValidationError('body 校验失败；未发送请求。' + formatErrors(bodyCheck.errors).join('；'));
  rejectUnknown(payload, schema, schema);
  return payload;
}

function responseSchema(source) {
  const ok = adsDeref(source.responses?.['200']);
  const media = ok?.content?.['application/json'];
  return media?.schema ? withDefinitions(media.schema, 'response/200') : undefined;
}

export function describeAds(op) {
  const source = adsSource(op);
  const responseTypes = Object.fromEntries(Object.entries(source.responses ?? {})
    .map(([code, r]) => [code, Object.keys(adsDeref(r)?.content ?? {})]));
  return {
    ...op,
    description_ru: source.description ?? '',
    params_schema: adsParamsSchema(op),
    body_schema: adsBodySchema(op),
    official_example: requestBody(op)?.example,
    response_content_types: responseTypes,
    response_schema: op.json_variant_of ? undefined : responseSchema(source),
    note: '路径参数和查询参数放在 params，请求体放在 body；ID 按官方规范传字符串。'
      + (op.json_variant_of ? `该接口是 ${op.json_variant_of} 的 JSON 版本（官方说明中给出的地址），参数相同。` : ''),
  };
}
