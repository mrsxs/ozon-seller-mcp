// Test-only VLESS-over-WebSocket node and a self-signed certificate (tests/fixtures) for api-seller.ozon.ru and sni.node.test.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

export const CERT = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url));
export const KEY = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url));

function frame(payload) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([0x82, len])
    : len < 65536 ? Buffer.from([0x82, 126, len >> 8, len & 255])
      : Buffer.concat([Buffer.from([0x82, 127]), Buffer.from(new BigUint64Array([BigInt(len)]).buffer).reverse()]);
  return Buffer.concat([head, payload]);
}

// Minimal VLESS-over-WebSocket node. mode: 'upper' echoes upper-cased, 'relay' forwards to relayPort,
// 'reject' refuses the upgrade, 'notvless' answers with a non-VLESS first byte.
export function fakeNode({ mode = 'upper', relayPort, secure = false } = {}) {
  const seen = { upgrades: 0 };
  const onRequest = (_req, res) => res.writeHead(404).end();
  const server = secure ? https.createServer({ cert: CERT, key: KEY }, onRequest) : http.createServer(onRequest);
  server.on('upgrade', (req, socket) => {
    seen.upgrades += 1;
    seen.path = req.url;
    seen.host = req.headers.host;
    seen.servername = socket.servername;
    if (mode === 'reject') {
      socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = (payload) => socket.write(frame(payload));
    let upstream;
    let buffered = Buffer.alloc(0);
    let first = true;
    socket.on('error', () => {});
    socket.on('close', () => upstream?.destroy());
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      for (;;) {
        if (buffered.length < 2) return;
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffered.length < 4) return;
          length = buffered.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (buffered.length < 10) return;
          length = Number(buffered.readBigUInt64BE(2));
          offset = 10;
        }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const data = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length).map((b, i) => b ^ mask[i % 4]));
        buffered = buffered.subarray(offset + 4 + length);
        if (opcode === 8) {
          socket.end();
          return;
        }
        let payload = data;
        if (first) {
          first = false;
          Object.assign(seen, { version: data[0], uuid: data.subarray(1, 17).toString('hex'), command: data[18],
            port: data.readUInt16BE(19), target: data.subarray(23, 23 + data[22]).toString() });
          payload = data.subarray(23 + data[22]);
          if (mode === 'notvless') {
            send(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'));
            continue;
          }
          send(Buffer.from([0])); // response header split across frames
          if (mode === 'relay') {
            send(Buffer.from([0]));
            upstream = net.connect(relayPort, '127.0.0.1');
            upstream.on('data', (d) => send(d));
            upstream.on('error', () => socket.destroy());
            upstream.on('end', () => socket.end());
            upstream.write(payload);
            continue;
          }
          send(Buffer.concat([Buffer.from([0]), Buffer.from(payload.toString().toUpperCase())]));
        } else if (mode === 'relay') {
          upstream.write(payload);
        } else {
          send(Buffer.from(payload.toString().toUpperCase()));
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, port: server.address().port })));
}

