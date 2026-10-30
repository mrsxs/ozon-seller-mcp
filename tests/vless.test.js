import assert from 'node:assert/strict';
import https from 'node:https';
import test from 'node:test';
import { Agent, fetch as undiciFetch } from 'undici';
import { request } from '../src/http.js';
import { callTool } from '../src/tools.js';
import { VlessConfigError, openTunnel, parseVless, vlessConnector } from '../src/vless.js';
import { CERT, KEY, fakeNode } from './fake-node.js';
import { parse, withEnv } from './helpers.js';

const ID = '11111111-2222-4333-8444-555555555555';
const LINK = `vless://${ID}@203.0.113.7:443?encryption=none&host=node.example.com&path=%2Fws&security=tls&sni=node.example.com&type=ws#%E8%8A%82%E7%82%B9`;

test('parseVless reads a WebSocket node and rejects what it cannot speak', () => {
  const cfg = parseVless(LINK);
  assert.equal(cfg.uuid.toString('hex'), ID.replace(/-/g, ''));
  assert.deepEqual({ address: cfg.address, port: cfg.port, tls: cfg.tls, host: cfg.host, sni: cfg.sni, path: cfg.path, name: cfg.name },
    { address: '203.0.113.7', port: 443, tls: true, host: 'node.example.com', sni: 'node.example.com', path: '/ws', name: '节点' });
  for (const bad of [
    LINK.replace('type=ws', 'type=grpc'),
    LINK.replace('security=tls', 'security=reality'),
    `${LINK.split('#')[0]}&flow=xtls-rprx-vision`,
    LINK.replace(ID, 'not-a-uuid'),
    'vmess://abc',
  ]) {
    assert.throws(() => parseVless(bad), (error) => error instanceof VlessConfigError && !error.message.includes(ID), bad);
  }
});

test('OZON_PROXY wins when set, an empty value means no proxy, and the UUID never shows', async () => {
  const proxy = async () => parse(await callTool('ozon_status', {})).proxy;
  await withEnv({ OZON_PROXY: LINK, HTTPS_PROXY: 'http://127.0.0.1:7890' }, async () => {
    const shown = await proxy();
    assert.equal(shown, 'OZON_PROXY=vless://203.0.113.7:443（ws+tls，host=node.example.com，节点：节点）');
    assert.ok(!shown.includes(ID));
  });
  await withEnv({ OZON_PROXY: '  ' }, async () => assert.equal(await proxy(), null));
  await withEnv({ OZON_PROXY: 'socks5://u:secret@127.0.0.1:1080' }, async () => assert.equal(await proxy(), 'OZON_PROXY=socks5://127.0.0.1:1080'));
  await withEnv({ OZON_PROXY: LINK.replace('type=ws', 'type=tcp') }, async () => {
    await assert.rejects(request('/v1/seller/info', {}), (error) => {
      assert.match(error.message, /代理配置无效（OZON_PROXY=（只支持 WebSocket 节点/);
      assert.ok(!error.message.includes(ID));
      return true;
    });
  });
  await withEnv({ HTTPS_PROXY: LINK }, async () => {
    await assert.rejects(request('/v1/seller/info', {}), /vless 节点请填在 OZON_PROXY/);
  });
});

const readOnce = (stream) => new Promise((resolve, reject) => {
  stream.once('data', (d) => resolve(d.toString()));
  stream.once('error', reject);
});

test('tunnel speaks VLESS over WebSocket and relays both ways', async () => {
  const { server, seen, port } = await fakeNode();
  try {
    const cfg = parseVless(`vless://${ID}@127.0.0.1:${port}?type=ws&security=none&host=node.example.com&path=%2Fws%3Fed%3D2048`);
    const tunnel = openTunnel(cfg, 'api-seller.ozon.ru', 443);
    tunnel.write('hello');
    assert.equal(await readOnce(tunnel), 'HELLO');
    tunnel.write('again');
    assert.equal(await readOnce(tunnel), 'AGAIN');
    assert.deepEqual({ ...seen, servername: undefined }, { upgrades: 1, path: '/ws?ed=2048', host: `node.example.com:${port}`,
      servername: undefined, version: 0, uuid: ID.replace(/-/g, ''), command: 1, port: 443, target: 'api-seller.ozon.ru' });
    tunnel.destroy();
  } finally {
    server.close();
  }
});

test('handshake failures are retried once, then surface as VLESS_WS_FAILED; non-VLESS replies are named', async () => {
  const refused = await fakeNode({ mode: 'reject' });
  const odd = await fakeNode({ mode: 'notvless' });
  try {
    const connect = vlessConnector(parseVless(`vless://${ID}@127.0.0.1:${refused.port}?type=ws&security=none&path=%2Fws`));
    const error = await new Promise((resolve) => connect({ protocol: 'https:', hostname: 'api-seller.ozon.ru', port: 443 }, resolve));
    assert.equal(error.code, 'VLESS_WS_FAILED');
    assert.ok(!error.message.includes(ID));
    assert.equal(refused.seen.upgrades, 2);
    connect.close();

    const tunnel = openTunnel(parseVless(`vless://${ID}@127.0.0.1:${odd.port}?type=ws&security=none`), 'api-seller.ozon.ru', 443);
    tunnel.write('hello');
    await assert.rejects(readOnce(tunnel), (e) => e.code === 'VLESS_BAD_REPLY');
  } finally {
    refused.server.close();
    odd.server.close();
  }
});

test('requests reach the target through a TLS node with host ≠ sni, verified end to end', async () => {
  const target = https.createServer({ cert: CERT, key: KEY }, (req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ path: req.url, key: req.headers['api-key'], body: body.length })));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const node = await fakeNode({ mode: 'relay', relayPort: target.address().port, secure: true });
  const connect = vlessConnector(
    parseVless(`vless://${ID}@127.0.0.1:${node.port}?type=ws&security=tls&host=front.node.test&sni=sni.node.test&path=%2Fws`),
    { tlsOptions: { ca: CERT }, nodeTls: { ca: CERT } },
  );
  const agent = new Agent({ connect });
  try {
    const big = 'x'.repeat(200_000); // spans many WebSocket frames
    for (let i = 0; i < 4; i += 1) {
      const res = await undiciFetch('https://api-seller.ozon.ru/v1/roles', {
        method: 'POST', headers: { 'Api-Key': 'k' }, body: JSON.stringify({ big }), dispatcher: agent,
      });
      assert.deepEqual(await res.json(), { path: '/v1/roles', key: 'k', body: big.length + 10 });
    }
    assert.equal(node.seen.host, `front.node.test:${node.port}`);
    assert.equal(node.seen.servername, 'sni.node.test');
    // Keep-alive reuses tunnels (undici may open a second one while the first is still marked busy).
    assert.ok(node.seen.upgrades <= 2, `upgrades=${node.seen.upgrades}`);
  } finally {
    await agent.close();
    connect.close();
    node.server.close();
    target.close();
  }
});
