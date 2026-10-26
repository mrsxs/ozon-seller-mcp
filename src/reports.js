// Single-file offline report renderer; no network, no third-party libraries.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { outputDir } from './config.js';
import { redact } from './privacy.js';

const TEMPLATE = new URL('../assets/report.html', import.meta.url);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
const esc = (value) => text(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

export function validateReport(report) {
  if (!isObject(report)) throw new Error('report 必须为对象。');
  for (const key of ['title', 'scope']) {
    if (typeof report[key] !== 'string' || !report[key].trim()) throw new Error(`必须填写 ${key}，并说明查询覆盖范围。`);
  }
  const sections = report.sections ?? [];
  const metrics = report.metrics ?? [];
  if (!Array.isArray(sections) || sections.length > 20) throw new Error('sections 必须为最多 20 个章节的数组。');
  if (!Array.isArray(metrics) || metrics.length > 8) throw new Error('metrics 必须为最多 8 个指标的数组。');
  if (!Array.isArray(report.limitations ?? [])) throw new Error('limitations 必须为数组。');
  for (const metric of metrics) {
    if (!isObject(metric) || !('label' in metric) || !('value' in metric)) throw new Error('每个指标必须包含 label 和 value。');
  }
  for (const section of sections) {
    if (!isObject(section) || !section.title) throw new Error('每个章节必须填写 title。');
    const columns = section.columns ?? [];
    const rows = section.rows ?? [];
    if (!Array.isArray(columns) || columns.length < 1 || columns.length > 15) throw new Error('每个表格需要 1～15 列。');
    if (!Array.isArray(rows) || rows.length > 10000) throw new Error('每个表格最多展示 10000 行，请拆分报告。');
    const keys = [];
    for (const column of columns) {
      if (!isObject(column) || !column.key || !column.label) throw new Error('列需要 key 和 label。');
      if (!['text', 'number', 'money', 'status'].includes(column.type ?? 'text')) throw new Error('列类型只能为 text、number、money、status。');
      keys.push(column.key);
    }
    if (new Set(keys).size !== keys.length) throw new Error('表格列 key 不能重复。');
    if (rows.some((row) => !isObject(row))) throw new Error('每行数据必须为对象。');
  }
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
const moneyFormat = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function cell(value, column) {
  const kind = column.type ?? 'text';
  if (value === null || value === undefined) return '<span class="missing">—</span>';
  if (kind === 'number' || kind === 'money') {
    const number = typeof value === 'boolean' ? NaN : Number(value);
    if (value === '' || !Number.isFinite(number)) return esc(value);
    const formatted = kind === 'money' ? `${moneyFormat.format(number)} ${column.currency ?? ''}` : numberFormat.format(number);
    return esc(formatted.trim());
  }
  if (kind === 'status') return `<span class="badge">${esc(value)}</span>`;
  return esc(value);
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace('.', '-').replace('Z', '');

export function renderReport(input, filename = 'ozon-report.html') {
  validateReport(input);
  const report = redact(input);
  if (typeof filename !== 'string' || path.basename(filename) !== filename || /[/\\:]/.test(filename)
      || !filename.toLowerCase().endsWith('.html') || filename.length > 160) {
    throw new Error('filename 必须是无目录的 .html 文件名。');
  }
  const output = outputDir();
  mkdirSync(output, { recursive: true });
  let target = path.join(output, filename);
  let existing = null;
  try {
    existing = lstatSync(target);
  } catch {
    existing = null;
  }
  if (existing?.isSymbolicLink()) throw new Error('输出位置不能为符号链接。');
  // Keep previous user reports instead of silently replacing them.
  if (existing) {
    const base = `${filename.slice(0, -5)}-${stamp()}`;
    target = path.join(output, `${base}.html`);
    for (let n = 2; existsSync(target); n += 1) target = path.join(output, `${base}-${n}.html`);
  }

  const metrics = (report.metrics ?? []).map((m) => `<article class="metric"><div class="metric-label">${esc(m.label)}</div>`
    + `<div class="metric-value">${esc(m.value)}<small>${esc(m.unit ?? '')}</small></div><p>${esc(m.note ?? '')}</p></article>`).join('');
  const nav = [];
  const blocks = [];
  (report.sections ?? []).forEach((section, index) => {
    nav.push(`<a href="#section-${index}">${esc(section.title)}</a>`);
    const columns = section.columns;
    const rows = section.rows ?? [];
    const header = columns.map((c, i) => `<th scope="col" class="${c.type ?? 'text'}" aria-sort="none"><button type="button" data-column="${i}">${esc(c.label)}<span aria-hidden="true">↕</span></button></th>`).join('');
    let body = rows.map((row) => `<tr>${columns.map((c) => `<td class="${c.type ?? 'text'}">${cell(row[c.key], c)}</td>`).join('')}</tr>`).join('');
    if (!rows.length) body = `<tr><td colspan="${columns.length}" class="empty">当前查询范围内暂无记录</td></tr>`;
    blocks.push(`<section class="panel" id="section-${index}" data-section="${index}">
<div class="panel-head"><div><h2>${esc(section.title)}</h2><p>${esc(section.note ?? '')}</p></div><button class="export" type="button">导出当前筛选 CSV</button></div>
<div class="tools"><label>搜索 <input type="search" aria-label="搜索${esc(section.title)}" placeholder="输入名称、货号或状态"></label><span class="row-count" aria-live="polite">${rows.length.toLocaleString('en-US')} 条记录</span></div>
<div class="table-wrap" tabindex="0" role="region" aria-label="${esc(section.title)}数据表"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div></section>`);
  });
  const limitations = report.limitations ?? [];
  const notices = limitations.length
    ? `<aside class="notice"><strong>数据范围与说明</strong><ul>${limitations.map((v) => `<li>${esc(v)}</li>`).join('')}</ul></aside>` : '';
  const payload = JSON.stringify(report).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const replacements = {
    TITLE: esc(report.title), SUBTITLE: esc(report.subtitle ?? 'Ozon Seller · 店铺数据报告'), SCOPE: esc(report.scope),
    TIME: esc(report.queried_at ?? new Date().toISOString()), METRICS: metrics, NAV: nav.join(''),
    SECTIONS: blocks.join(''), NOTICES: notices, PAYLOAD: payload,
  };
  // One pass, so user values containing template markers remain literal data.
  const document = readFileSync(TEMPLATE, 'utf8').replace(/@@([A-Z]+)@@/g, (m, key) => replacements[key] ?? m);
  writeFileSync(target, document, { encoding: 'utf8', flag: 'wx' });
  return {
    path: target, title: report.title, sections: (report.sections ?? []).length,
    row_count: (report.sections ?? []).reduce((sum, s) => sum + (s.rows ?? []).length, 0),
    offline: true, scope: report.scope,
  };
}
