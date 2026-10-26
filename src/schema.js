// Tool input schemas are generated from the pinned official OpenAPI snapshot.
// Conversions only repair OpenAPI authoring errors; they never invent business values.
import Ajv2020 from 'ajv/dist/2020.js';
import { readOnlyMode } from './config.js';
import { ReadOnlyError, ValidationError } from './errors.js';
import { OPERATIONS, SPEC, mediaSource, operationSource } from './spec.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const unique = (values) => [...new Map(values.map((v) => [JSON.stringify(v), v])).values()];

const MASKS = {
  'HH:MM': '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$',
  'YYYY-MM-DD': '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
  'YYYY-MM-DDThh:mm:ssZ': '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?Z$',
  'YYYY-MM-DDThh:mm:ss.mcsZ': '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]+Z$',
  '+86(XXX)XXXX-XXXX': '^\\+86\\([0-9]{3}\\)[0-9]{4}-[0-9]{4}$',
  '+7(XXX)XXX-XX-XX': '^\\+7\\([0-9]{3}\\)[0-9]{3}-[0-9]{2}-[0-9]{2}$',
  '7XXXXXXXXXX': '^7[0-9]{10}$',
};

export const UNDECLARED_REQUIRED = '官方 required 列出了该字段，但规范未定义其类型与含义。需要时按官方文档填写；本服务不做本地类型校验，以 Ozon 返回为准。';

export function transform(schema, refs, location = '$') {
  if (!isObject(schema)) return schema;
  let result = structuredClone(schema);
  if (result.description === null) delete result.description;
  if ('type' in result && result.type === null) {
    delete result.type;
    result.not = {};
    result.description = (result.description ?? '') + '\n官方未定义此字段类型（type=null）。当前禁止传入该字段，未猜测类型。';
  }
  if (result.type === 'int') result.type = 'integer';
  if (result.type === 'bool') result.type = 'boolean';
  if ('enum' in result && result.enum === null) {
    const values = [...(result.description ?? '').matchAll(/^\s*-\s*`([^`]+)`/gm)].map((m) => m[1]);
    if (values.length && 'default' in result && !values.includes(result.default)) values.push(result.default);
    if (values.length) result.enum = unique(values);
    else delete result.enum;
  }
  if ('pattern' in result) {
    const source = String(result.pattern).trim();
    if (source in MASKS) {
      result.pattern = MASKS[source];
      if (source === 'YYYY-MM-DD') result.format ??= 'date';
      else if (source.startsWith('YYYY-MM-DDT')) result.format ??= 'date-time';
    }
    try {
      new RegExp(result.pattern, 'u');
    } catch {
      throw new Error('官方正则无法解析，尚未核对：' + location);
    }
  }
  // `required: true` on a property is an authoring error; the parent promotes it below.
  if (typeof result.required === 'boolean') delete result.required;
  if ('$ref' in result) {
    const prefix = '#/components/schemas/';
    if (!result.$ref.startsWith(prefix)) throw new Error('不支持的 schema 引用：' + result.$ref);
    const name = result.$ref.slice(prefix.length);
    refs.add(name);
    result.$ref = '#/$defs/' + name;
  }
  for (const key of ['properties', 'patternProperties']) {
    if (!isObject(result[key])) continue;
    if (key === 'properties') {
      const promoted = Object.entries(result[key]).filter(([, v]) => isObject(v) && v.required === true).map(([k]) => k);
      if (promoted.length) result.required = [...new Set([...(result.required ?? []), ...promoted])];
    }
    result[key] = Object.fromEntries(Object.entries(result[key])
      .map(([k, v]) => [k, transform(v, refs, `${location}/${key}/${k}`)]));
  }
  for (const key of ['items', 'additionalProperties', 'not', 'if', 'then', 'else']) {
    if (isObject(result[key]) || typeof result[key] === 'boolean') result[key] = transform(result[key], refs, `${location}/${key}`);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(result[key])) result[key] = result[key].map((v, i) => transform(v, refs, `${location}/${key}/${i}`));
  }
  // A required name with no property definition (8 cases, e.g. quant_size on /v2/products/stocks)
  // made the request impossible to satisfy. Declare it untyped and optional; Ozon has the final word.
  if (Array.isArray(result.required) && isObject(result.properties)) {
    const undeclared = result.required.filter((name) => !(name in result.properties));
    if (undeclared.length) {
      result.required = result.required.filter((name) => name in result.properties);
      for (const name of undeclared) result.properties[name] = { description: UNDECLARED_REQUIRED };
    }
  }
  // OAS 3.0 -> JSON Schema 2020-12 compatibility conversions, not parameter changes.
  if (result.type === 'file') {
    result.type = 'string';
    result.format = 'binary';
    result.description = (result.description ?? '') + '\nMCP 传入本机文件绝对路径；服务在写模式下将文件作为 multipart 上传。';
  }
  for (const [key, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']]) {
    if (typeof result[key] === 'boolean') {
      const exclusive = result[key];
      delete result[key];
      if (exclusive && bound in result) {
        result[key] = result[bound];
        delete result[bound];
      }
    }
  }
  const nullable = result.nullable;
  delete result.nullable;
  if (nullable) {
    if (typeof result.type === 'string') result.type = [result.type, 'null'];
    else result = { anyOf: [result, { type: 'null' }] };
  }
  return result;
}

const schemaCache = new Map();

export function inputSchema(name) {
  if (schemaCache.has(name)) return schemaCache.get(name);
  const op = OPERATIONS.get(name);
  const [, media] = mediaSource(op);
  const source = media.schema || { type: 'object', properties: {}, additionalProperties: false };
  const refs = new Set();
  const result = transform(source, refs, op.path + '/requestBody');
  const definitions = {};
  let pending;
  while ((pending = [...refs].filter((r) => !(r in definitions))).length) {
    for (const encoded of pending) {
      const schemaName = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      definitions[encoded] = transform(SPEC.components.schemas[schemaName], refs, '#/components/schemas/' + schemaName);
    }
  }
  if (Object.keys(definitions).length) result.$defs = definitions;
  result.type ??= 'object';
  schemaCache.set(name, result);
  return result;
}

// ---- validation ---------------------------------------------------------------

const INT_RANGES = {
  int64: [-(2n ** 63n), 2n ** 63n],
  int32: [-(2n ** 31n), 2n ** 31n],
  uint64: [0n, 2n ** 64n],
};

function intFormat(format, value) {
  if (value === null) return true;
  const [min, max] = INT_RANGES[format];
  if (typeof value === 'string') {
    const re = format === 'uint64' ? /^[0-9]+$/ : /^-?[0-9]+$/;
    if (!re.test(value)) return false;
    const n = BigInt(value);
    return n >= min && n < max;
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) return false;
  const n = BigInt(value);
  return n >= min && n < max;
}

function isDate(value) {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  if (y < 1 || m < 1 || m > 12 || d < 1) return false;
  return d <= daysIn(y, m);
}
const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

// Formats without a checker are ignored, matching the Python jsonschema behaviour this replaces.
function validationCopy(node) {
  if (Array.isArray(node)) return node.map(validationCopy);
  if (!isObject(node)) return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'format' && typeof value === 'string') {
      if (value in INT_RANGES) out.ozonIntFormat = value;
      else if (value === 'date') out.format = 'date';
    } else if (['properties', 'patternProperties', '$defs'].includes(key) && isObject(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, validationCopy(v)]));
    } else if (['items', 'additionalProperties', 'not', 'if', 'then', 'else'].includes(key)) {
      out[key] = validationCopy(value);
    } else if (['oneOf', 'anyOf', 'allOf'].includes(key) && Array.isArray(value)) {
      out[key] = value.map(validationCopy);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, verbose: true, logger: false });
ajv.addFormat('date', { type: 'string', validate: isDate });
ajv.addKeyword({ keyword: 'ozonIntFormat', schemaType: 'string', validate: intFormat });

const validators = new Map();
export function compileSchema(key, schema) {
  if (!validators.has(key)) validators.set(key, ajv.compile(validationCopy(schema)));
  return validators.get(key);
}

const pointerToPath = (pointer) => '$' + pointer.split('/').slice(1)
  .map((p) => p.replaceAll('~1', '/').replaceAll('~0', '~'))
  .map((p) => (/^[0-9]+$/.test(p) ? `[${p}]` : '.' + p)).join('');

// Values are never echoed: request arguments may contain private data.
export function formatErrors(errors, limit = 8) {
  const messages = errors.map((error) => {
    const at = pointerToPath(error.instancePath);
    if (error.keyword === 'required') return `${at} 缺少必填字段 ${error.params.missingProperty}`;
    if (error.keyword === 'additionalProperties') return `${at} 存在官方规范未定义的字段 ${error.params.additionalProperty}`;
    const keyword = error.keyword === 'ozonIntFormat' ? 'format' : error.keyword;
    return `${at} 不符合 ${keyword} 约束（规则：${JSON.stringify(error.schema)}）`;
  });
  return [...new Set(messages)].slice(0, limit);
}

function expandLocal(schema, root) {
  if (isObject(schema) && typeof schema.$ref === 'string') {
    return schema.$ref.slice(2).split('/').reduce((node, part) => node[part.replaceAll('~1', '/').replaceAll('~0', '~')], root);
  }
  return schema;
}

function knownProperties(schema, root, seen = new Set()) {
  if (!isObject(schema) || seen.has(schema)) return [{}, false];
  seen.add(schema);
  const expanded = expandLocal(schema, root);
  if (expanded !== schema) return knownProperties(expanded, root, seen);
  const properties = { ...(schema.properties ?? {}) };
  // Explicit dictionaries remain dictionaries, not closed model objects.
  let open = 'additionalProperties' in schema && schema.additionalProperties !== false;
  for (const kind of ['allOf', 'oneOf', 'anyOf']) {
    for (const branch of schema[kind] ?? []) {
      const [found, branchOpen] = knownProperties(branch, root, seen);
      Object.assign(properties, found);
      open ||= branchOpen;
    }
  }
  return [properties, open];
}

function rejectUnknown(value, schema, root, location = '$') {
  schema = expandLocal(schema, root);
  if (!isObject(schema)) return;
  if (isObject(value)) {
    const [properties, open] = knownProperties(schema, root);
    if (Object.keys(properties).length && !open) {
      const unknown = Object.keys(value).filter((k) => !(k in properties)).sort();
      if (unknown.length) throw new ValidationError(`${location} 存在官方规范未定义的字段：${unknown.join(', ')}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (key in properties) rejectUnknown(item, properties[key], root, `${location}.${key}`);
    }
  } else if (Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) => rejectUnknown(item, schema.items, root, `${location}[${index}]`));
  }
}

export function validate(name, args) {
  if (!isObject(args)) throw new ValidationError('工具参数必须为 JSON 对象。');
  const schema = inputSchema(name);
  const check = compileSchema('op:' + name, schema);
  if (!check(args)) throw new ValidationError('参数校验失败；未发送请求。' + formatErrors(check.errors).join('；'));
  rejectUnknown(args, schema, schema);
}

export function enforceMode(op) {
  if (readOnlyMode() && !op.read_only) {
    throw new ReadOnlyError('OZON_READ_ONLY=true：此接口为写操作或副作用未确认，已在发送前拦截。');
  }
}

export function describe(name) {
  const op = OPERATIONS.get(name);
  const source = operationSource(op);
  const [mediaType, media] = mediaSource(op);
  return {
    ...op,
    description_ru: source.description ?? '',
    request_media_type: mediaType,
    input_schema: inputSchema(name),
    official_example: media.example,
    responses: source.responses ?? {},
    note: '参数结构以俄文主规范为准；中文仅补充名称与说明。示例可能与 schema 不一致，调用以前置校验为准。',
  };
}
