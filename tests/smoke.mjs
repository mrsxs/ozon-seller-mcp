// End-to-end MCP stdio handshake against the real entry point (no Ozon network calls).
// Override the command, e.g. SMOKE_CMD='["npx","-y","--package=./ozon-seller-mcp-2.0.0.tgz","ozon-seller-mcp"]'.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.env.SMOKE_CMD
  ? JSON.parse(process.env.SMOKE_CMD)
  : [process.execPath, path.join(root, 'bin', 'ozon-seller-mcp.js')];

const child = spawn(command, args, {
  env: { ...process.env, OZON_READ_ONLY: 'true', OZON_TOOLSET: 'core', OZON_CLIENT_ID: '', OZON_API_KEY: '' },
  stdio: ['pipe', 'pipe', 'inherit'],
  shell: process.platform === 'win32' && command === 'npx',
});
let finished = false;
child.on('exit', (code) => {
  if (!finished) {
    console.error(`smoke failed: server exited early with code ${code}`);
    process.exit(1);
  }
});

const pending = new Map();
let buffer = '';
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line); // Any non-JSON stdout line breaks MCP and fails here.
    pending.get(message.id)?.(message);
  }
});

let nextId = 1;
function rpc(method, params = {}) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)));
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const timer = setTimeout(() => {
  console.error('smoke test timed out');
  child.kill();
  process.exit(1);
}, 5 * 60 * 1000);

try {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
  assert(init.serverInfo?.name === 'ozon-seller', 'unexpected serverInfo');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const { tools } = await rpc('tools/list');
  const names = new Set(tools.map((t) => t.name));
  for (const name of ['ozon_status', 'ozon_api_call', 'ozon_top_products', 'ozon_sales_overview']) assert(names.has(name), `missing ${name}`);
  assert(tools.length === 25, `expected 25 core read-only tools, got ${tools.length}`);
  const size = Buffer.byteLength(JSON.stringify(tools));
  assert(size < 60 * 1024, `tool list too large: ${size} bytes`);

  const status = JSON.parse((await rpc('tools/call', { name: 'ozon_status', arguments: {} })).content[0].text);
  assert(status.read_only === true && status.official_operations === 482, 'bad ozon_status');
  assert(status.api_key_configured === false, 'api key should be unset');

  const blocked = await rpc('tools/call', { name: 'ozon_api_call', arguments: { endpoint: '/v2/products/stocks', body: { stocks: [] } } });
  assert(blocked.isError === true && blocked.content[0].text.includes('OZON_READ_ONLY'), 'write call must be blocked in read-only mode');

  const invalid = await rpc('tools/call', { name: 'ozon_top_products', arguments: { limit: 500 } });
  assert(invalid.isError === true && invalid.content[0].text.includes('maximum'), 'invalid composite args must be rejected');

  console.log(`smoke ok: ${tools.length} tools, ${Math.round(size / 1024)}KB tool list, server ${init.serverInfo.name} ${init.serverInfo.version}`);
  clearTimeout(timer);
  finished = true;
  child.stdin.end();
  child.on('exit', () => process.exit(0));
} catch (error) {
  console.error('smoke failed:', error.message);
  finished = true;
  child.kill();
  process.exit(1);
}
