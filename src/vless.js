// VLESS over WebSocket (optionally TLS) tunnel, so a seller can reach Ozon through a node set in OZON_PROXY.
// The Ozon TLS session runs end to end inside the tunnel: the node relays bytes and never sees the API key.
import dns from 'node:dns';
import { Duplex } from 'node:stream';
import tls from 'node:tls';
import { Agent, WebSocket, buildConnector } from 'undici';

const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const CONNECT_TIMEOUT = 30_000; // node handshake (with one retry) plus the Ozon TLS handshake
const WS_CONNECT_TIMEOUT = 12_000; // CDN entry IPs from China are often slow to complete TLS
const HIGH_WATER = 1 << 20;

export class VlessConfigError extends Error {
  name = 'VlessConfigError';
}

function tunnelError(code, message) {
  return Object.assign(new Error(message), { code });
}

function decode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export const isVlessLink = (raw) => /^\s*vless:/i.test(String(raw));

// Messages never echo the UUID: it is the node's password.
export function parseVless(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new VlessConfigError('vless 链接无法解析');
  }
  if (url.protocol !== 'vless:') throw new VlessConfigError('不是 vless:// 链接');
  const id = decode(url.username);
  if (!UUID.test(id)) throw new VlessConfigError('vless 链接里的用户 ID（UUID）格式不对');
  const q = url.searchParams;
  const type = (q.get('type') || 'tcp').toLowerCase();
  if (type !== 'ws') throw new VlessConfigError(`只支持 WebSocket 节点（type=ws），当前是 type=${type}`);
  const security = (q.get('security') || 'none').toLowerCase();
  if (security !== 'tls' && security !== 'none') {
    throw new VlessConfigError(`只支持 security=tls 或 none，当前是 security=${security}`);
  }
  if ((q.get('encryption') || 'none') !== 'none') throw new VlessConfigError('只支持 encryption=none');
  if (q.get('flow')) throw new VlessConfigError('不支持 flow（XTLS）参数，请换用 WebSocket 节点');
  const address = url.hostname.replace(/^\[|\]$/g, '');
  if (!address) throw new VlessConfigError('vless 链接缺少服务器地址');
  const useTls = security === 'tls';
  const port = Number(url.port || (useTls ? 443 : 80));
  const host = q.get('host') || q.get('sni') || address;
  const path = q.get('path') || '/';
  return {
    uuid: Buffer.from(id.replace(/-/g, ''), 'hex'),
    address, port, tls: useTls, host,
    sni: q.get('sni') || host,
    path: path.startsWith('/') ? path : `/${path}`,
    name: decode(url.hash.slice(1)),
  };
}

export function describeVless(cfg) {
  const name = cfg.name ? `，节点：${cfg.name.slice(0, 40)}` : '';
  return `vless://${cfg.address}:${cfg.port}（ws${cfg.tls ? '+tls' : ''}，host=${cfg.host}${name}）`;
}

// Request header: version 0, UUID, no addons, command 1 (TCP), port, address type 2 (domain), domain.
export function vlessHeader(uuid, target, port) {
  const name = Buffer.from(target);
  if (name.length > 255) throw new Error('目标域名过长');
  return Buffer.concat([Buffer.from([0]), uuid, Buffer.from([0, 1, port >> 8, port & 255, 2, name.length]), name]);
}

// WebSocket transport to the node: TCP to the link's address (often a preferred CDN IP),
// Host header from `host`, TLS SNI from `sni`. undici derives SNI from the URL host, so it is forced here.
export function nodeAgent(cfg, nodeTls = {}) {
  const base = buildConnector({ ...nodeTls, timeout: WS_CONNECT_TIMEOUT, lookup: (_name, options, cb) => dns.lookup(cfg.address, options, cb) });
  return new Agent({ connect: (opts, cb) => base({ ...opts, servername: cfg.tls ? cfg.sni : opts.servername }, cb) });
}

const bracket = (h) => (h.includes(':') ? `[${h}]` : h);

// A byte stream to target:port relayed by the node.
export function openTunnel(cfg, target, port, agent = nodeAgent(cfg)) {
  const url = `${cfg.tls ? 'wss' : 'ws'}://${bracket(cfg.host)}:${cfg.port}${cfg.path}`;
  const ws = new WebSocket(url, { dispatcher: agent });
  ws.binaryType = 'arraybuffer';
  let opened = false;
  let header = vlessHeader(cfg.uuid, target, port);
  let reply = Buffer.alloc(0);
  const queued = [];

  // Keep the producer (TLS, undici) paced by the WebSocket send buffer.
  const send = (data, callback) => {
    ws.send(data);
    const drain = () => {
      if (tunnel.destroyed || ws.bufferedAmount < HIGH_WATER) callback();
      else setTimeout(drain, 20);
    };
    drain();
  };

  const tunnel = new Duplex({
    write(chunk, _encoding, callback) {
      const data = header ? Buffer.concat([header, chunk]) : chunk;
      header = null;
      if (opened) send(data, callback);
      else queued.push([data, callback]);
    },
    read() {},
    final(callback) {
      callback();
    },
    destroy(error, callback) {
      for (const [, cb] of queued.splice(0)) cb(error ?? tunnelError('VLESS_CLOSED', 'VLESS 隧道已关闭'));
      if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
      callback(error);
    },
  });

  const failed = (reason) => (opened
    ? tunnelError('VLESS_CLOSED', `VLESS 节点中断了连接${reason ? `：${reason}` : ''}`)
    : tunnelError('VLESS_WS_FAILED', `连不上 VLESS 节点 ${cfg.address}:${cfg.port}（WebSocket 握手失败${reason ? `：${reason}` : ''}）`));

  ws.addEventListener('open', () => {
    opened = true;
    for (const [data, callback] of queued.splice(0)) send(data, callback);
  });
  ws.addEventListener('message', (event) => {
    let data = Buffer.from(event.data);
    if (reply) {
      // Response header: version 0, addons length, addons. It may arrive split across frames.
      reply = Buffer.concat([reply, data]);
      if (reply[0] !== 0) {
        tunnel.destroy(tunnelError('VLESS_BAD_REPLY', '节点回应的不是 VLESS 协议，检查 OZON_PROXY 里的 path 和 host'));
        return;
      }
      if (reply.length < 2 || reply.length < 2 + reply[1]) return;
      data = reply.subarray(2 + reply[1]);
      reply = null;
    }
    if (data.length) tunnel.push(data);
  });
  ws.addEventListener('error', (event) => tunnel.destroy(failed(event.error?.message || event.message || '')));
  ws.addEventListener('close', () => {
    if (!opened) tunnel.destroy(failed(''));
    else tunnel.push(null);
  });
  return tunnel;
}

// undici custom connector: TLS to the real host inside the tunnel, so certificates are still verified end to end.
// `close()` releases the node connections when the dispatcher is replaced.
// tlsOptions / nodeTls exist for tests (a private CA); production uses the system trust store defaults.
export function vlessConnector(cfg, { timeout = CONNECT_TIMEOUT, tlsOptions = {}, nodeTls = {} } = {}) {
  const agent = nodeAgent(cfg, nodeTls);
  const sessions = new Map();
  const connect = (opts, callback) => {
    const https = opts.protocol === 'https:';
    const port = Number(opts.port) || (https ? 443 : 80);
    const servername = opts.servername || opts.hostname;
    let settled = false;
    let socket;
    let attempt = 0;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        socket?.destroy();
        callback(error);
      } else {
        callback(null, socket);
      }
    };
    const timer = setTimeout(() => finish(tunnelError('VLESS_CONNECT_TIMEOUT',
      `经 VLESS 节点 ${cfg.address}:${cfg.port} 建立连接超过 ${Math.round(timeout / 1000)} 秒`)), timeout);

    const start = () => {
      attempt += 1;
      let tunnel;
      try {
        tunnel = openTunnel(cfg, opts.hostname, port, agent);
      } catch (error) {
        finish(error);
        return;
      }
      const current = https
        ? tls.connect({ socket: tunnel, servername, ALPNProtocols: ['http/1.1'], session: sessions.get(servername), ...tlsOptions })
        : tunnel;
      socket = current;
      const fail = (error) => {
        if (settled || socket !== current) return;
        // Nothing reaches Ozon before the WebSocket opens, so one retry is safe even for writes.
        if (error.code === 'VLESS_WS_FAILED' && attempt < 2) {
          if (current !== tunnel) current.destroy();
          start();
          return;
        }
        finish(error);
      };
      tunnel.on('error', (error) => {
        if (settled && current !== tunnel) current.destroy(error);
        else fail(error);
      });
      // The TLS layer re-reports a tunnel failure as a generic reset; let the tunnel's own error win.
      if (current !== tunnel) current.on('error', (error) => setImmediate(fail, error));
      if (https) {
        current.on('session', (session) => sessions.set(servername, session));
        current.once('secureConnect', () => {
          if (socket === current) finish(null);
        });
      } else {
        // Plain targets only need the WebSocket open; the request bytes wait in the queue until then.
        finish(null);
      }
    };
    start();
  };
  connect.close = () => agent.close().catch(() => {});
  return connect;
}
