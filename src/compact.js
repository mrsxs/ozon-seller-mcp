// Shrink tool results before they reach the model's context window.
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isEmpty = (v) => v === null || v === undefined || v === '' ||
  (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);

// Drop null / "" / [] / {} recursively. 0 and false are real values and stay.
export function dropEmpty(value) {
  if (Array.isArray(value)) return value.map(dropEmpty).filter((v) => !isEmpty(v));
  if (isObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const next = dropEmpty(v);
      if (!isEmpty(next)) out[k] = next;
    }
    return out;
  }
  return value;
}

export const byteSize = (value) => Buffer.byteLength(JSON.stringify(value) ?? '');

function arrays(node, path, found) {
  if (Array.isArray(node)) {
    if (node.length > 1) found.push({ node, path, bytes: byteSize(node) });
    node.forEach((item, i) => arrays(item, `${path}[${i}]`, found));
  } else if (isObject(node)) {
    for (const [k, v] of Object.entries(node)) arrays(v, `${path}.${k}`, found);
  }
  return found;
}

// Cut the largest arrays until the JSON fits; report exactly what was cut.
export function fitToBudget(value, maxBytes) {
  let size = byteSize(value);
  if (size <= maxBytes) return { value, truncated: [] };
  const data = structuredClone(value);
  const truncated = new Map();
  for (let round = 0; round < 30 && size > maxBytes; round += 1) {
    const [largest] = arrays(data, '$', []).sort((a, b) => b.bytes - a.bytes);
    if (!largest) break;
    const { node, path, bytes } = largest;
    const total = truncated.get(path)?.total ?? node.length;
    const perItem = bytes / node.length;
    const keep = Math.max(1, Math.min(node.length - 1, Math.floor(node.length - (size - maxBytes) / perItem) - 1));
    node.length = keep;
    truncated.set(path, { path, kept: keep, total });
    size = byteSize(data);
  }
  if (size > maxBytes) {
    const text = JSON.stringify(data);
    return {
      value: { partial_json_text: text.slice(0, Math.floor(maxBytes / 3)) },
      truncated: [...truncated.values(), { path: '$', kept: 'text-prefix', total: `${Math.round(size / 1024)}KB` }],
    };
  }
  return { value: data, truncated: [...truncated.values()] };
}
