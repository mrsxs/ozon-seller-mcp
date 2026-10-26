import os from 'node:os';
import path from 'node:path';

function flag(name, fallback) {
  const value = (process.env[name] ?? fallback).trim().toLowerCase();
  if (value !== 'true' && value !== 'false') {
    throw new Error(`${name} 只能为 true 或 false；未填写时默认 ${fallback}。`);
  }
  return value === 'true';
}

// Fail closed: a typo must never silently enable writes.
export const readOnlyMode = () => flag('OZON_READ_ONLY', 'true');

export const compactEnabled = () => flag('OZON_COMPACT', 'true');

export function maxResultBytes() {
  const raw = (process.env.OZON_MAX_RESULT_KB ?? '80').trim();
  const kb = Number(raw);
  if (!Number.isInteger(kb) || kb < 8 || kb > 20000) {
    throw new Error('OZON_MAX_RESULT_KB 必须为 8～20000 的整数（单位 KB）。');
  }
  return kb * 1024;
}

export const toolsetSpec = () => (process.env.OZON_TOOLSET ?? 'core').trim() || 'core';

export function outputDir() {
  return path.resolve(process.env.OZON_OUTPUT_DIR || path.join(os.homedir(), '.accio', 'outputs', 'ozon'));
}
