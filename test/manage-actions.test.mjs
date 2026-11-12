import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { createManagementHandler } from '../lib/manage.js';

// Group 5 opens four mutations the Host already exposes: pin, unpin, session
// rename and workspace rename. This file pins the wire contract (action name ->
// namespace/method/args) and the strict input/result validation around it.
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return 'http://127.0.0.1:' + server.address().port; };
const closeServer = async server => { server.closeAllConnections?.(); if (server.listening) await new Promise(resolve => server.close(resolve)); };
const signedFixture = (origin, issuedAt = Date.now(), ttl = 300_000) => {
  const authority = new URL(origin).host;
  return { origin, active: true,
    cookieName: 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url'),
    cookieValue: 'v1.' + Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + ttl })).toString('base64url')
      + '.' + Buffer.alloc(32, 4).toString('base64url') };
};
const workspaceRow = host => ({ workspaceId: 'ws-' + host, title: 'WS ' + host, path: '/srv/' + host,
  sessionIds: ['session-a'], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });

async function fixture(respond) {
  const seen = [];
  const remote = http.createServer(async (req, res) => {
    if (req.headers.cookie !== 'cookie-test') { req.resume(); res.writeHead(403).end(); return; }
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ url: req.url, method: message.method, args: message.payload?.args });
    const value = respond(message);
    if (value === undefined) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value } }));
  });
  const origin = await listen(remote);
  const credential = signedFixture(origin);
  const handler = createManagementHandler({
    authorize: async req => req.headers.authorization === 'Bearer owner',
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    gateway: { async invoke() { throw new Error('local Host must not be called by this fixture'); } },
    remotes: [{ id: 'alpha', label: 'Alpha', origin, credential: async () => 'cookie-test' }],
  });
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (!path.startsWith('/api/dsh-unified/manage/')) { req.resume(); res.writeHead(404).end(); return; }
    handler(path.split('/').at(-1), req, res);
  });
  const parent = await listen(server);
  const post = (action, body) => fetch(parent + '/api/dsh-unified/manage/' + action, {
    method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const close = async () => { handler.close(); await closeServer(server); await closeServer(remote); };
  return { post, seen, close };
}

const requestId = 'fixture-request-0001';

test('pin and unpin reach workspace/pinSession and workspace/unpinSession', async () => {
  // The wire method carries its namespace, e.g. "workspace/pinSession".
  const f = await fixture(message => message.method === 'workspace/pinSession' || message.method === 'workspace/unpinSession'
    ? { pinnedSessionIds: ['session-a'] } : undefined);
  try {
    const pinned = await f.post('session-pin', { host: 'alpha', sessionId: 'session-a', requestId });
    assert.equal(pinned.status, 200);
    assert.deepEqual((await pinned.json()).value.pinnedSessionIds, ['session-a']);
    const unpinned = await f.post('session-unpin', { host: 'alpha', sessionId: 'session-a', requestId: 'fixture-request-0002' });
    assert.equal(unpinned.status, 200);
    assert.deepEqual(f.seen.map(row => row.method), ['workspace/pinSession', 'workspace/unpinSession']);
    assert.deepEqual(f.seen[0].args, { request: { sessionId: 'session-a' } });
    assert.equal(f.seen[0].url, '/api/workspace/pinSession');
  } finally { await f.close(); }
});

test('renames reach session/rename and workspace/rename with a trimmed title', async () => {
  const f = await fixture(message => message.method === 'session/rename' || message.method === 'workspace/rename'
    ? (message.payload.args.request.workspaceId ? { workspace: workspaceRow('alpha') } : { title: '新标题', seq: 7 })
    : undefined);
  try {
    const session = await f.post('session-rename', { host: 'alpha', sessionId: 'session-a', title: '  新标题  ', requestId });
    assert.equal(session.status, 200);
    assert.deepEqual((await session.json()).value, { title: '新标题', seq: 7 });
    const workspace = await f.post('workspace-rename', { host: 'alpha', workspaceId: 'ws-alpha', title: ' 改名 ', requestId: 'fixture-request-0002' });
    assert.equal(workspace.status, 200);
    assert.equal((await workspace.json()).value.workspace.title, 'WS alpha');
    assert.deepEqual(f.seen[0].args, { request: { sessionId: 'session-a', title: '新标题' } });
    assert.deepEqual(f.seen[1].args, { request: { workspaceId: 'ws-alpha', title: '改名' } });
    assert.deepEqual(f.seen.map(row => row.url), ['/api/session/rename', '/api/workspace/rename']);
  } finally { await f.close(); }
});

test('strict inputs reject extra fields, blank titles, oversize titles and bad identities', async () => {
  const f = await fixture(() => ({ pinnedSessionIds: [] }));
  try {
    const bad = [
      ['session-pin', { host: 'alpha', sessionId: 'session-a', requestId, extra: 1 }],
      ['session-pin', { host: 'alpha', sessionId: '', requestId }],
      ['session-pin', { host: 'alpha', sessionId: 7, requestId }],
      ['session-pin', { host: 'alpha', sessionId: 'session-a' }],
      ['session-rename', { host: 'alpha', sessionId: 'session-a', title: '   ', requestId }],
      ['session-rename', { host: 'alpha', sessionId: 'session-a', title: 'x'.repeat(201), requestId }],
      ['session-rename', { host: 'alpha', sessionId: 'session-a', title: 'ok', requestId, workspaceId: 'ws' }],
      ['workspace-rename', { host: 'alpha', workspaceId: 'ws-alpha', title: '', requestId }],
      ['workspace-rename', { host: 'alpha', workspaceId: '', title: 'ok', requestId }],
      ['session-unpin', { host: 'unknown', sessionId: 'session-a', requestId }],
    ];
    for (const [action, body] of bad) {
      const response = await f.post(action, body);
      assert.equal(response.status, 400, action + ' ' + JSON.stringify(body).slice(0, 60));
      assert.equal((await response.json()).ok, false);
    }
    assert.equal(f.seen.length, 0, 'no invalid request reaches the Host');
  } finally { await f.close(); }
});

test('malformed Host results are rejected instead of trusted', async () => {
  const cases = [
    ['session-pin', 'workspace/pinSession', { pinnedSessionIds: 'session-a' }],
    ['session-pin', 'workspace/pinSession', {}],
    ['session-unpin', 'workspace/unpinSession', { pinnedSessionIds: [7] }],
    ['session-rename', 'session/rename', { title: 'ok', seq: '7' }],
    ['session-rename', 'session/rename', { title: 7, seq: 7 }],
    ['workspace-rename', 'workspace/rename', { workspace: { workspaceId: 'ws-alpha' } }],
  ];
  for (const [action, wireMethod, value] of cases) {
    const f = await fixture(message => message.method === wireMethod ? value : undefined);
    try {
      const body = action === 'workspace-rename'
        ? { host: 'alpha', workspaceId: 'ws-alpha', title: 'ok', requestId }
        : action === 'session-rename'
          ? { host: 'alpha', sessionId: 'session-a', title: 'ok', requestId }
          : { host: 'alpha', sessionId: 'session-a', requestId };
      const response = await f.post(action, body);
      // A write whose result cannot be validated is reported as uncertain (504),
      // never as success: the caller must re-read the catalog before retrying.
      assert.equal(response.status, 504, action + ' accepted a malformed result');
      assert.equal((await response.json()).error.code, 'management/result-uncertain');
    } finally { await f.close(); }
  }
});

test('Host error codes map to the catalog-facing messages', async () => {
  const errors = {
    'workspace/pinSession': { code: 'session/not-found', message: 'gone' },
    'workspace/unpinSession': { code: 'gateway/bad-request', message: 'bad' },
  };
  const remote = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString());
    const error = errors[message.method] || { code: 'gateway/internal', message: 'boom' };
    res.writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ type: 'server-response', rpcId: message.rpcId, result: { ok: false, error } }));
  });
  const origin = await listen(remote);
  const handler = createManagementHandler({
    authorize: async req => req.headers.authorization === 'Bearer owner',
    connection: { createPeer: () => ({ dispose: async () => {} }) },
    gateway: { async invoke() { throw new Error('unexpected local call'); } },
    remotes: [{ id: 'alpha', label: 'Alpha', origin, credential: async () => signedFixture(origin) }],
  });
  const server = http.createServer((req, res) => handler(new URL(req.url, 'http://127.0.0.1').pathname.split('/').at(-1), req, res));
  const parent = await listen(server);
  try {
    const post = (action, body) => fetch(parent + '/api/dsh-unified/manage/' + action, {
      method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const notFound = await post('session-pin', { host: 'alpha', sessionId: 'session-a', requestId });
    assert.equal(notFound.status, 404);
    assert.match((await notFound.json()).error.message, /找不到这个会话/);
    const bad = await post('session-unpin', { host: 'alpha', sessionId: 'session-a', requestId: 'fixture-request-0002' });
    assert.equal(bad.status, 400);
  } finally { handler.close(); await closeServer(server); await closeServer(remote); }
});
