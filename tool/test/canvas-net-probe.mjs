#!/usr/bin/env node
// #47 探针的服务端：只回答一件事——Canvas 运行时能不能连上本机端口。
// 与 map.mjs 分开起（8799），这样不往产品服务里加 CORS，也不污染它的行为。
// 每条请求都落 tool/out/canvas-net-probe.log，服务端看见什么与浏览器报什么可以对照。
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PROBE_PORT || 8799);
const here = path.dirname(fileURLToPath(import.meta.url));
const logFile = path.join(here, '..', 'out', 'canvas-net-probe.log');
fs.mkdirSync(path.dirname(logFile), { recursive: true });

function log(line) {
  const row = `${new Date().toISOString()} ${line}`;
  console.log(row);
  fs.appendFileSync(logFile, row + '\n');
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

// CORS 用回显而不是 *：回显能一并测出「带 Origin 的预检/简单请求」到底带的是哪个源，
// 那个值就是 Canvas 运行时的真实 origin——设 ACAO 白名单要靠它。
function cors(req) {
  const origin = req.headers.origin;
  return origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : { 'access-control-allow-origin': '*' };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const origin = req.headers.origin || '(none)';
  const ua = req.headers['user-agent'] || '(none)';

  if (url.pathname === '/ping') {
    log(`GET /ping origin=${origin} ua="${ua.slice(0, 120)}"`);
    const body = JSON.stringify({
      ok: true,
      sawOrigin: req.headers.origin ?? null,
      sawReferer: req.headers.referer ?? null,
      sawCookie: req.headers.cookie ? 'yes' : 'no',
      host: req.headers.host ?? null,
      at: new Date().toISOString(),
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...cors(req),
    });
    res.end(body);
    return;
  }

  if (url.pathname === '/pixel.png') {
    log(`GET /pixel.png origin=${origin}`);
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': PNG_1X1.length });
    res.end(PNG_1X1);
    return;
  }

  if (url.pathname === '/events') {
    log(`GET /events (SSE) origin=${origin}`);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      ...cors(req),
    });
    res.write('event: hello\ndata: {"ok":true,"transport":"sse"}\n\n');
    const tick = setInterval(() => res.write(': tick\n\n'), 15000);
    req.on('close', () => clearInterval(tick));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('probe server: /ping /pixel.png /events /ws\n');
});

server.on('upgrade', (req, socket) => {
  // 交给普通请求处理会拿不到 socket，这里显式转发一次握手结果。
  const key = req.headers['sec-websocket-key'];
  if (!key || !req.url.startsWith('/ws')) {
    socket.destroy();
    return;
  }
  log(`UPGRADE /ws origin=${req.headers.origin || '(none)'}`);
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const payload = Buffer.from('{"ok":true,"transport":"ws"}');
  socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  socket.on('close', () => log('WS 关闭'));
});

server.listen(PORT, '127.0.0.1', () => {
  log(`探针服务已起 http://127.0.0.1:${PORT}/（日志 ${logFile}）`);
});
