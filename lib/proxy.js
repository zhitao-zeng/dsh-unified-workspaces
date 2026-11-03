import http from 'node:http';
import { pipeline } from 'node:stream';
import WebSocket, { WebSocketServer } from 'ws';

import { validateOrigin } from './config.js';
const LOCAL_CONTROLS = ['/api/pair', '/api/update', '/api/plugin-manager'];
const PASS_HEADERS = new Set(['content-type', 'content-length', 'accept', 'range', 'if-range', 'if-none-match', 'if-modified-since', 'x-dsh-locale']);
const DROP_RESPONSE = new Set(['set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization']);

export function upstreamPath(raw, httpPrefix) {
  const url = new URL(raw, 'http://127.0.0.1');
  if (!url.pathname.startsWith(httpPrefix + '/')) return;
  const suffix = url.pathname.slice(httpPrefix.length);
  const segments = suffix.slice(1).split('/');
  if (segments.some(part => !/^[A-Za-z0-9_$.-]+$/.test(part) || part === '.' || part === '..')) return;
  const path = suffix.startsWith('/_host/') ? suffix.slice('/_host'.length) : '/api' + suffix;
  if (suffix.startsWith('/_host/') && !['/sidebar', '/git', '/pet', '/dsh-prompt-predict'].some(prefix => path === prefix || path.startsWith(prefix + '/'))) return;
  if (LOCAL_CONTROLS.some(prefix => path === prefix || path.startsWith(prefix + '/'))) return;
  const privateKeys = new Set(['device', 'dsh_embed_grant', 'bootstrap', 'control', 'parent']);
  const pieces = url.search ? url.search.slice(1).split('&').filter(piece => {
    try { return !privateKeys.has(decodeURIComponent(piece.split('=', 1)[0].replace(/\+/g, ' '))); }
    catch { return true; }
  }) : [];
  return path + (pieces.length ? '?' + pieces.join('&') : '');
}

function deny(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: false, message: status === 403 ? '需要已配对设备或本机授权。' : '远端 暂不可用，请重试。' }));
}

/** Fixed-origin proxy. Caller supplies authentication and a short-lived, memory-only credential. */
export function createProxy({ origin, httpPrefix, muxPath, authorize, credential, ready, remotePairingStillValid = () => true }) {
  const target = new URL(validateOrigin(origin));
  const match = typeof httpPrefix === 'string' && /^\/api\/dsh-unified\/hosts\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/native$/.exec(httpPrefix);
  if (!match || muxPath !== '/dsh-unified/hosts/' + match[1] + '/remote.mux') throw new Error('Invalid remote proxy routes');
  const sockets = new Set();
  const pending = new Set();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false });
  let disposed = false;

  async function httpHandler(req, res) {
    if (disposed) return deny(res, 503);
    let allowed;
    try { allowed = await authorize(req); } catch { allowed = false; }
    if (!allowed) { req.resume(); return deny(res, 403); }
    const path = upstreamPath(req.url || '/', httpPrefix);
    if (!path || !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || 'GET')) { req.resume(); return deny(res, 404); }
    let cookie;
    try { if (!(await ready())) { req.resume(); return deny(res, 426); } cookie = await credential(); }
    catch { req.resume(); return deny(res, 503); }
    if (res.destroyed || req.destroyed) return;
    const headers = { cookie, origin: target.origin, 'sec-fetch-site': 'same-origin', 'accept-encoding': 'identity' };
    for (const [name, value] of Object.entries(req.headers)) if (PASS_HEADERS.has(name) && value !== undefined) headers[name] = value;
    const upstream = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port || 80, path, method: req.method, headers });
    pending.add(upstream);
    upstream.on('response', source => {
      const out = {};
      for (const [name, value] of Object.entries(source.headers)) if (!DROP_RESPONSE.has(name) && value !== undefined) out[name] = value;
      out['cache-control'] = 'no-store';
      res.writeHead(source.statusCode || 502, out);
      pipeline(source, res, () => {});
    });
    upstream.on('error', () => { if (!res.headersSent) deny(res, 502); else res.destroy(); });
    upstream.on('close', () => pending.delete(upstream));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    // A response/follow/export may be long-lived. Only bound connection establishment.
    const connectTimer = setTimeout(() => upstream.destroy(), 10_000);
    connectTimer.unref();
    upstream.on('socket', socket => {
      if (!socket.connecting) clearTimeout(connectTimer);
      else socket.once('connect', () => clearTimeout(connectTimer));
    });
    upstream.on('close', () => clearTimeout(connectTimer));
    pipeline(req, upstream, () => {});
  }

  async function upgrade(req, socket, head) {
    let upgraded = false;
    const reject = status => { if (!upgraded && !socket.destroyed) { socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); } };
    let allowed;
    try { allowed = !disposed && await authorize(req); } catch { allowed = false; }
    if (!allowed) return reject(403);
    try { if (new URL(req.url, 'http://127.0.0.1').pathname !== muxPath) return reject(404); } catch { return reject(404); }
    let cookie;
    try { if (!(await ready())) return reject(426); cookie = await credential(); }
    catch { return reject(503); }
    if (socket.destroyed) return;
    const upstream = new WebSocket(target.origin.replace(/^http:/, 'ws:') + '/api/remote.mux', { headers: { cookie, origin: target.origin, 'sec-fetch-site': 'same-origin' }, handshakeTimeout: 10_000, maxPayload: 64 * 1024 * 1024, perMessageDeflate: false, followRedirects: false });
    sockets.add(upstream);
    let client;
    let timer;
    let heartbeat;
    const close = () => { clearInterval(timer); clearInterval(heartbeat); upstream.terminate(); client?.terminate(); sockets.delete(upstream); if (client) sockets.delete(client); };
    socket.once('error', close);
    socket.once('close', close);
    upstream.once('error', () => { reject(502); close(); });
    upstream.once('close', () => { reject(502); close(); });
    upstream.once('open', () => {
      if (socket.destroyed || disposed) return close();
      wss.handleUpgrade(req, socket, head, accepted => {
        upgraded = true;
        client = accepted;
        sockets.add(client);
        const relay = (from, to) => from.on('message', (data, isBinary) => {
          if (to.readyState !== WebSocket.OPEN || to.bufferedAmount > 16 * 1024 * 1024) return close();
          to.send(data, { binary: isBinary }, error => { if (error) close(); });
        });
        relay(client, upstream); relay(upstream, client);
        client.once('error', close); client.once('close', close);
        let peerActivity = Date.now();
        client.on('pong', () => { peerActivity = Date.now(); });
        client.on('message', () => { peerActivity = Date.now(); });
        // The upstream WebSocket client answers 远端's ping itself. Check the
        // phone leg independently so an abandoned TCP socket cannot look live.
        heartbeat = setInterval(() => {
          if (client.readyState !== WebSocket.OPEN || (Date.now() - peerActivity > 6_000 && client.bufferedAmount === 0)) return close();
          client.ping(undefined, undefined, error => { if (error) close(); });
        }, 2_000);
        heartbeat.unref();
        // Revocation and policy changes terminate this browser's carrier only.
        timer = setInterval(() => {
          try { if (!remotePairingStillValid(req)) close(); } catch { close(); }
        }, 5_000);
        timer.unref();
      });
    });
  }

  return {
    httpHandler, upgrade,
    close() { disposed = true; for (const request of pending) request.destroy(); for (const socket of sockets) socket.terminate(); wss.close(); },
  };
}
