// Ozon advertising reports: ';'-separated CSV, sometimes with a title line above the header.
// Values stay strings: "1 000" and "12,5" are locale-formatted and converted only where the meaning is known.
const DELIMITERS = [';', '\t', ','];

function splitRecords(text, delimiter) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      quoted = true;
    } else if (c === delimiter) {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) records.push([...record, field]);
  return records.filter((r) => r.some((v) => v.trim() !== ''));
}

// Ozon writes ';'. A ',' is only the delimiter when nothing else splits the lines,
// because Russian decimals ("12,50") and titles contain commas.
function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).filter((line) => line.trim()).slice(0, 5).join('\n');
  return DELIMITERS.find((delimiter) => splitRecords(sample, delimiter).some((r) => r.length > 1)) ?? DELIMITERS[0];
}

export function parseCsv(text) {
  const clean = String(text ?? '').replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const records = splitRecords(clean, delimiter);
  const width = Math.max(0, ...records.slice(0, 5).map((r) => r.length));
  const headerIndex = Math.max(0, records.findIndex((r) => r.length === width));
  const title = records.slice(0, headerIndex).map((r) => r.join(delimiter).trim()).join('\n') || undefined;
  const columns = (records[headerIndex] ?? []).map((name, i) => name.trim() || `column_${i + 1}`);
  const rows = records.slice(headerIndex + 1)
    .map((record) => Object.fromEntries(columns.map((name, i) => [name, (record[i] ?? '').trim()])));
  return { format: 'csv', title, columns, rows, row_count: rows.length };
}
