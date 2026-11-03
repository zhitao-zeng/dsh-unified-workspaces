import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, renameSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { parseConfig, loadConfig, validateOrigin, routesForHost } from '../lib/config.js';
import { validateCredential, createCredentialProvider } from '../lib/credential.js';
import { createCatalogHandler } from '../lib/catalog.js';
import { createManagementHandler } from '../lib/manage.js';
import { createProxy } from '../lib/proxy.js';
import { createEmbedService } from '../lib/embed.js';

const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const closeServer = async server => { server.closeAllConnections?.(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
const record = value => ({ type: 'server-response', rpcId: value.rpcId, result: { ok: true, value: value.value } });
const item = host => ({ sessionId: 'shared-session', blank: false, agentAvailable: false, fixtureHost: host });
const workspace = host => ({ workspaceId: 'shared-workspace', title: host, path: '/srv/' + host,
  sessionIds: ['shared-session'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const baseline = host => ({ items: [workspace(host)], archivedSessionIds: [], pinnedSessionIds: [] });
const theme = host => ({ writable: true, hasDocument: true, namespaces: [
  { ns: 'ui-theme', revision: 1, value: { theme: host } }, { ns: 'locale', revision: 2, value: { language: host } },
  { ns: 'providers', revision: 3, value: { owner: host } },
] });
function signedFixture(origin, issuedAt = Date.now(), ttl = 300_000) {
  const authority = new URL(origin).host;
  return { origin, active: true,
    cookieName: 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'),
    cookieValue: 'v1.' + Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + ttl })).toString('base64url')
      + '.' + Buffer.alloc(32, 4).toString('base64url') };
}

test('configuration accepts N explicit loopback sources, rejects command/identity/origin ambiguity', () => {
  const row = id => ({ id, label: id, origin: 'http://127.0.0.1:43081', credentialCommand: ['/usr/bin/python3', '/example/helper.py'] });
  assert.deepEqual(parseConfig({ version: 1, hosts: [] }).hosts, []);
  assert.deepEqual(parseConfig({ version: 1, hosts: [row('alpha'), row('beta')] }).hosts.map(x => x.id), ['alpha', 'beta']);
  for (const id of ['mac', '__proto__', 'constructor', 'prototype', '../host', 'bad/id', '']) assert.throws(() => parseConfig({ version: 1, hosts: [row(id)] }));
  assert.throws(() => parseConfig({ version: 1, hosts: [row('alpha'), row('alpha')] }));
  assert.throws(() => parseConfig({ version: 1, hosts: [{ ...row('alpha'), credentialCommand: ['python3'] }] }));
  for (const origin of ['https://127.0.0.1:4000', 'http://example.test:4000', 'http://user@127.0.0.1:4000', 'http://127.0.0.1:4000/path', 'http://127.0.0.1:4000?q=1', 'http://127.0.0.1:4000#x']) assert.throws(() => validateOrigin(origin));
  assert.equal(validateOrigin('http://[::1]:43081'), 'http://[::1]:43081');
  assert.equal(validateOrigin('http://localhost:80'), 'http://localhost');
  assert.deepEqual(loadConfig({ env: {}, home: '/example', openFile() { throw Object.assign(new Error(), { code: 'ENOENT' }); } }).hosts, []);
});

test('configuration reads one owner-controlled file descriptor and rejects symlinks or writable files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-unified-config-fixture-'));
  const path = join(directory, 'hosts.json');
  const value = id => JSON.stringify({ version: 1, hosts: [{ id, label: id, origin: 'http://127.0.0.1:43081', credentialCommand: ['/fixture/helper'] }] });
  try {
    writeFileSync(path, value('alpha'), { mode: 0o600 });
    const env = { DSH_UNIFIED_CONFIG: path };
    assert.equal(loadConfig({ env }).hosts[0].id, 'alpha');
    chmodSync(path, 0o666); assert.throws(() => loadConfig({ env })); chmodSync(path, 0o600);
    symlinkSync(path, join(directory, 'link.json'));
    assert.throws(() => loadConfig({ env: { DSH_UNIFIED_CONFIG: join(directory, 'link.json') } }));
    assert.equal(loadConfig({ env, openFile(file, flags) {
      const fd = openSync(file, flags);
      renameSync(file, file + '.opened'); writeFileSync(file, value('replacement'), { mode: 0o600 });
      return fd;
    } }).hosts[0].id, 'alpha');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('credential caches are per source and bounded by authority and five-minute expiry', async () => {
  const a = { origin: 'http://127.0.0.1:43081', credentialCommand: ['/fixture/a'] };
  const b = { origin: 'http://127.0.0.1:43082', credentialCommand: ['/fixture/b'] };
  let calls = 0;
  const executeImpl = async executable => { calls++; return { stdout: JSON.stringify(signedFixture(executable.endsWith('/a') ? a.origin : b.origin)) }; };
  const ca = createCredentialProvider(a, { executeImpl }), cb = createCredentialProvider(b, { executeImpl });
  assert.notEqual(await ca(), await cb());
  await Promise.all([ca(), ca(), cb()]); assert.equal(calls, 2);
  assert.throws(() => validateCredential(signedFixture(a.origin), b.origin));
  assert.throws(() => validateCredential(signedFixture(a.origin, Date.now(), 600_000), a.origin));
  assert.throws(() => validateCredential(signedFixture(a.origin, Date.now() - 400_000), a.origin));
  ca.close(); cb.close(); await assert.rejects(ca());
});

test('two remote Hosts with colliding IDs retain independent catalogs, writes, proxies, grants and frames', async () => {
  const resources = [], sockets = new Set();
  const calls = new Map(); let localPeers = 0;
  const connection = { createPeer() { localPeers++; return { async dispose() { localPeers--; } }; } };
  const gateway = {
    async invoke({ namespace, method }) {
      if (namespace === 'session' && method === 'list') return { items: [item('mac')] };
      if (namespace === 'settings' && method === 'describe') return theme('mac');
      throw new Error('Unexpected local method');
    },
    stream() { return { async *[Symbol.asyncIterator]() { yield { type: 'baseline', value: baseline('mac') }; } }; },
  };
  const authorize = async req => req.headers.authorization === 'Bearer parent-owner';
  let parent;
  try {
    const remotes = [];
    for (const id of ['alpha', 'beta']) {
      const seen = []; calls.set(id, seen);
      const server = http.createServer(async (req, res) => {
        seen.push({ url: req.url, headers: req.headers });
        if (req.headers.cookie !== 'cookie-' + id) { req.resume(); res.writeHead(403).end(); return; }
        if (req.url === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><script>window.__DSH_BOOT__={rev:"test",entries:[],batches:[]};</script></head><body></body></html>');
        if (req.url.startsWith('/plugins/')) return res.writeHead(200, { 'content-type': 'text/javascript' }).end('// mock modules');
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        let message; try { message = JSON.parse(Buffer.concat(chunks).toString()); } catch { res.writeHead(400).end(); return; }
        let value;
        if (message.method === 'session/list') value = { items: [item(id)] };
        else if (message.method === 'settings/describe') value = theme(id);
        else if (message.method === 'workspace/create') value = { workspace: workspace(id), created: true };
        else { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(record({ rpcId: message.rpcId, value })));
      });
      const origin = await listen(server); resources.push(server);
      assert.notEqual(new URL(origin).port, '3080');
      const wss = new WebSocketServer({ noServer: true }); resources.push(wss);
      server.on('upgrade', (req, socket, head) => {
        seen.push({ url: req.url, headers: req.headers });
        if (req.headers.cookie !== 'cookie-' + id) return socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        wss.handleUpgrade(req, socket, head, client => {
          sockets.add(client); client.on('close', () => sockets.delete(client));
          client.on('message', (data, binary) => {
            if (binary) return client.send(data, { binary: true });
            const frame = JSON.parse(data.toString());
            if (frame.type === 'open') client.send(JSON.stringify({ type: 'item', streamId: frame.streamId,
              value: frame.endpoint === 'workspace/follow' ? { type: 'baseline', value: baseline(id) } : { source: id, sessionId: 'shared-session' } }));
          });
        });
      });
      remotes.push({ id, label: 'Worker ' + id, origin, credential: async () => 'cookie-' + id });
    }
    const catalog = createCatalogHandler({ authorize, connection, gateway, remotes, WebSocketImpl: WebSocket });
    const management = createManagementHandler({ authorize, connection, gateway, remotes });
    const services = new Map(remotes.map(host => {
      const routes = routesForHost(host.id);
      return [host.id, { routes, proxy: createProxy({ origin: host.origin, httpPrefix: routes.native, muxPath: routes.mux,
        authorize, credential: host.credential, ready: async () => true }),
      embed: createEmbedService({ hostId: host.id, origin: host.origin, authorizeOwner: authorize, credential: host.credential,
        connection, gateway, WebSocketImpl: WebSocket, WebSocketServerImpl: WebSocketServer,
        loadClient: () => ({ prelude: '// mock prelude', companion: '// mock companion' }) }) }];
    }));
    parent = http.createServer((req, res) => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      if (path === '/api/dsh-unified/catalog') return catalog(req, res);
      if (path.startsWith('/api/dsh-unified/manage/')) return management(path.split('/').at(-1), req, res);
      for (const service of services.values()) {
        if (path.startsWith(service.routes.native + '/')) return service.proxy.httpHandler(req, res);
        if (path.startsWith(service.routes.embed + '/')) return service.embed.parent(path.split('/').at(-1), req, res);
      }
      req.resume(); res.writeHead(404).end();
    });
    parent.on('upgrade', (req, socket, head) => {
      for (const service of services.values()) if (new URL(req.url, 'http://127.0.0.1').pathname === service.routes.mux) return service.proxy.upgrade(req, socket, head);
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    });
    const parentOrigin = await listen(parent);
    const headers = { authorization: 'Bearer parent-owner', origin: parentOrigin, 'content-type': 'application/json' };
    const request = (path, body, extra = {}) => fetch(parentOrigin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const catalogResponse = await (await request('/api/dsh-unified/catalog')).json();
    assert.deepEqual(catalogResponse.hosts.map(x => x.id), ['mac', 'alpha', 'beta']);
    assert.deepEqual(catalogResponse.hosts.map(x => x.items[0].sessionId), ['shared-session', 'shared-session', 'shared-session']);
    assert.deepEqual(catalogResponse.hosts.map(x => x.items[0].fixtureHost), ['mac', 'alpha', 'beta']);
    assert(!JSON.stringify(catalogResponse).includes('cookie-alpha'));
    assert(!JSON.stringify(catalogResponse).includes(remotes[0].origin));
    assert.equal(localPeers, 0);
    for (const host of remotes) {
      const result = await (await request('/api/dsh-unified/manage/workspace-create', { host: host.id, path: '/srv/' + host.id, requestId: 'same-fixture-request-001' })).json();
      assert.equal(result.value.workspace.title, host.id);
      const again = await request('/api/dsh-unified/manage/workspace-create', { host: host.id, path: '/srv/' + host.id, requestId: 'same-fixture-request-001' });
      assert.equal(again.status, 200);
      assert.equal(calls.get(host.id).filter(x => x.url === '/api/workspace/create').length, 1);
      const native = await (await request(services.get(host.id).routes.native + '/session/list?x=%2f+%20&device=parent-pair', { type: 'client-request', rpcId: 'proxy', method: 'session/list', payload: { args: {} } }, { cookie: 'parent-cookie', 'x-dsh-remote-device': 'parent-device' })).json();
      assert.equal(native.result.value.items[0].fixtureHost, host.id);
      const upstream = calls.get(host.id).at(-1);
      assert.equal(upstream.url, '/api/session/list?x=%2f+%20');
      assert.equal(upstream.headers.cookie, 'cookie-' + host.id);
      assert.equal(upstream.headers.authorization, undefined);
      assert.equal(upstream.headers['x-dsh-remote-device'], undefined);
      assert.equal(upstream.headers.origin, host.origin);
    }
    assert.equal((await request('/api/dsh-unified/manage/directories', { host: 'unknown' })).status, 400);
    assert.equal((await request('/api/dsh-unified/manage/directories', { host: 'alpha', origin: 'http://example.test' })).status, 400);
    for (const [index, path] of ['C:\\fixture', '\\\\server\\share\\fixture'].entries()) {
      assert.equal((await request('/api/dsh-unified/manage/workspace-create', { host: 'alpha', path,
        requestId: 'windows-fixture-path-' + index })).status, 200);
    }
    assert.equal((await request('/api/dsh-unified/manage/workspace-create', { host: 'alpha', path: 'C:relative',
      requestId: 'invalid-relative-fixture' })).status, 400);
    assert.equal((await request('/api/dsh-unified/hosts/unknown/native/session/list')).status, 404);
    const carriers = [];
    for (const host of remotes) {
      const socket = new WebSocket(parentOrigin.replace('http:', 'ws:') + services.get(host.id).routes.mux + '?device=parent-device', { headers });
      carriers.push(socket); await once(socket, 'open');
      const received = once(socket, 'message');
      socket.send(JSON.stringify({ type: 'open', streamId: 'same-stream', endpoint: 'session/follow', payload: { args: { request: { sessionId: 'shared-session' } } } }));
      assert.equal(JSON.parse((await received)[0].toString()).value.source, host.id);
    }
    carriers[0].close();
    const stillLive = once(carriers[1], 'message'); carriers[1].send(Buffer.from([1, 2, 3]), { binary: true });
    assert.deepEqual((await stillLive)[0], Buffer.from([1, 2, 3])); carriers[1].close();
    const frames = [];
    for (const host of remotes) {
      const service = services.get(host.id);
      const response = await request(service.routes.embed + '/bootstrap', { sessionId: 'shared-session', parentOrigin }, { 'x-dsh-embed-parent': parentOrigin });
      assert.equal(response.status, 200);
      const value = (await response.json()).value;
      assert.equal(value.hostId, host.id);
      const documentResponse = await fetch(value.frameUrl);
      assert.equal(documentResponse.status, 200); assert.equal(documentResponse.headers.get('set-cookie'), null);
      const html = await documentResponse.text();
      const metadata = JSON.parse(/Object\.freeze\((\{[^\n]+?\})\)\}\);const e=/.exec(html)[1]);
      frames.push({ ...value, grant: metadata.grant });
      assert.equal(metadata.hostId, host.id);
      assert.equal((await fetch(value.frameUrl)).status, 403);
    }
    assert.notEqual(frames[0].frameOrigin, frames[1].frameOrigin);
    const api = '/api/session/list';
    const body = JSON.stringify({ type: 'client-request', rpcId: 'frame', method: 'session/list', payload: { args: {} } });
    const data = await (await fetch(frames[0].frameOrigin + api, { method: 'POST', body, headers: { 'x-dsh-embed-grant': frames[0].grant } })).json();
    assert.equal(data.result.value.items[0].fixtureHost, 'alpha');
    assert.equal((await fetch(frames[1].frameOrigin + api, { method: 'POST', body, headers: { 'x-dsh-embed-grant': frames[0].grant } })).status, 403);
    assert.equal((await fetch(frames[0].frameOrigin + api, { method: 'POST', body, headers: { cookie: 'dsh_embed_any=' + frames[0].grant } })).status, 403);
    const appearance = '/api/dsh-unified/hosts/beta/appearance/describe';
    assert.equal((await fetch(frames[1].frameOrigin + appearance, { method: 'POST', body, headers: { 'x-dsh-embed-grant': frames[0].grant } })).status, 403);
    const combined = await (await fetch(frames[1].frameOrigin + appearance, { method: 'POST', headers: { 'x-dsh-embed-grant': frames[1].grant, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'appearance', method: 'settings/describe', payload: { args: {} } }) })).json();
    assert.equal(combined.result.value.namespaces.find(x => x.ns === 'providers').value.owner, 'beta');
    assert.equal(combined.result.value.namespaces.find(x => x.ns === 'ui-theme').value.theme, 'mac');
    const combo = '/plugins/??@fixture/core/client.js,fixture/ui.js&rev=raw%2f+%20&dsh_embed_grant=' + frames[0].grant;
    assert.equal((await fetch(frames[0].frameOrigin + combo)).status, 200);
    assert.equal(calls.get('alpha').at(-1).url, '/plugins/??@fixture/core/client.js,fixture/ui.js&rev=raw%2f+%20');
    assert.equal((await request(services.get('beta').routes.embed + '/close', { frameId: frames[0].frameId, controlToken: frames[0].controlToken, parentOrigin }, { 'x-dsh-embed-parent': parentOrigin })).status, 403);
    assert.equal((await request(services.get('alpha').routes.embed + '/close', { frameId: frames[0].frameId, controlToken: frames[0].controlToken, parentOrigin }, { 'x-dsh-embed-parent': parentOrigin })).status, 200);
    assert.equal((await fetch(frames[1].frameOrigin + api, { method: 'POST', body, headers: { 'x-dsh-embed-grant': frames[1].grant } })).status, 200);
    for (const service of services.values()) { service.embed.close(); service.proxy.close(); }
    catalog.close(); management.close();
  } finally {
    for (const socket of sockets) socket.terminate();
    if (parent) await closeServer(parent);
    for (const resource of resources.reverse()) {
      if (resource instanceof WebSocketServer) resource.close(); else await closeServer(resource);
    }
  }
});

test('IPv6 loopback HTTP proxy strips URL brackets for the socket and retains authority', async t => {
  const remote = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, 'ipv6-fixture-cookie');
    assert.equal(req.headers.host, new URL(origin).host);
    assert.equal(req.headers.origin, origin);
    res.end('ipv6-loopback-ok');
  });
  let origin, parent, proxy;
  try {
    try {
      remote.listen(0, '::1'); await once(remote, 'listening');
    } catch (error) {
      if (['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) { t.skip('IPv6 loopback is unavailable on this runner'); return; }
      throw error;
    }
    origin = 'http://[::1]:' + remote.address().port;
    const routes = routesForHost('ipv6');
    proxy = createProxy({ origin, httpPrefix: routes.native, muxPath: routes.mux,
      authorize: async () => true, credential: async () => 'ipv6-fixture-cookie', ready: async () => true });
    parent = http.createServer(proxy.httpHandler);
    const url = await listen(parent);
    assert.equal(await (await fetch(url + routes.native + '/session/list')).text(), 'ipv6-loopback-ok');
  } finally {
    proxy?.close(); if (parent) await closeServer(parent); await closeServer(remote);
  }
});
