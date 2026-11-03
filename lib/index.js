import { readFileSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';
import { createProxy } from './proxy.js';
import { createCatalogHandler } from './catalog.js';
import { createAppearanceHandler } from './appearance.js';
import { createManagementHandler } from './manage.js';
import { createEmbedService } from './embed.js';
import { createCredentialProvider } from './credential.js';
import { loadConfig, routesForHost } from './config.js';

export const name = 'dsh-unified-workspaces';
export const inject = ['connection', 'webServer', 'clientModules', 'typertGateway'];
const BOOT = readFileSync(new URL('./boot.js', import.meta.url), 'utf8');
function json(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(body));
}

export function apply(ctx) {
  // Config is owner-controlled and loaded once. No HTTP request can select an
  // upstream, SSH destination, executable or credential command.
  const config = loadConfig();
  ctx.effect(() => ctx.on('webserver/index-inject', rows => rows.push({ kind: 'script', placement: 'head', text: BOOT })), 'unified workspaces: before client bootstrap');
  const ownedRequests = new WeakSet();
  let disposed = false;
  function paired(req) {
    const pairing = ctx.get('remoteWebUiPairing');
    if (!pairing || typeof pairing.isPairedDevice !== 'function') return false;
    if (req.headers.origin !== undefined) {
      let url;
      try { url = new URL(req.headers.origin); } catch { return false; }
      if (url.host !== req.headers.host || !['https:', 'http:'].includes(url.protocol)) return false;
    }
    if (req.headers['sec-fetch-site'] === 'cross-site') return false;
    if (pairing.isPairedDevice(req)) return true;
    let device;
    try { device = new URL(req.url, 'http://127.0.0.1').searchParams.get('device'); } catch { return false; }
    if (!device || !/^[A-Za-z0-9_-]{16,256}$/.test(device)) return false;
    return pairing.isPairedDevice({ headers: { ...req.headers, cookie: 'dsh_pair=' + device } });
  }
  async function owner(req) {
    try { return (await ctx.connection.admit(req)).peer?.principal?.kind === 'owner'; } catch { return false; }
  }
  async function authorize(req) {
    if (disposed) return false;
    if (await owner(req)) { ownedRequests.add(req); return true; }
    return paired(req);
  }
  const remotes = config.hosts.map(host => {
    const credential = createCredentialProvider(host);
    const routes = routesForHost(host.id);
    let readiness;
    async function ready() {
      if (disposed) return false;
      if (readiness && readiness.until > Date.now()) return readiness.ok;
      const rpcId = 'unified-preflight-' + host.id;
      const response = await fetch(host.origin + '/api/session/list', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { cookie: await credential(), origin: host.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/list', payload: { args: { _request: {} } } }),
      });
      if (!response.ok) { credential.invalidate(); throw new Error('Remote unavailable'); }
      const value = await response.json();
      const items = value?.result?.value?.items;
      const ok = value?.type === 'server-response' && value.rpcId === rpcId && value?.result?.ok === true
        && Array.isArray(items) && items.every(item => typeof item?.sessionId === 'string' && typeof item.agentAvailable === 'boolean');
      readiness = { ok, until: Date.now() + 10_000 };
      return ok;
    }
    const proxy = createProxy({ origin: host.origin, httpPrefix: routes.native, muxPath: routes.mux,
      credential, ready, authorize, remotePairingStillValid: req => ownedRequests.has(req) || paired(req) });
    const appearance = createAppearanceHandler({ origin: host.origin, authorize, connection: ctx.connection,
      gateway: ctx.typertGateway, credential });
    const embed = createEmbedService({ hostId: host.id, origin: host.origin, credential,
      connection: ctx.connection, gateway: ctx.typertGateway, authorizeOwner: owner,
      WebSocketImpl: WebSocket, WebSocketServerImpl: WebSocketServer,
      loadClient: () => ({ prelude: readFileSync(new URL('./embed-prelude.js', import.meta.url), 'utf8'),
        companion: readFileSync(new URL('./embed-companion.js', import.meta.url), 'utf8') }) });
    for (const action of ['bootstrap', 'refresh', 'close']) ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: routes.embed + '/' + action, handler: (req, res) => embed.parent(action, req, res) }));
    for (const action of ['describe', 'mutate', 'update', 'replace', 'revision']) ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: routes.appearance + '/' + action, handler: (req, res) => appearance(action, req, res) }));
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routes.native, handler: proxy.httpHandler }));
    ctx.effect(() => ctx.webServer.registerUpgrade({ path: routes.mux, handler: proxy.upgrade }));
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: routes.status, handler: async (req, res) => {
      let allowed = false;
      try { allowed = await authorize(req); } catch {}
      req.resume();
      if (!allowed) return json(res, 403, { ok: false, message: '需要本机授权或已配对设备。' });
      if (req.method !== 'GET') return json(res, 405, { ok: false, message: '状态只支持读取。' });
      try { const ok = await ready(); return json(res, ok ? 200 : 426,
        { ok, id: host.id, label: host.label, nativeProtocolReady: ok }); }
      catch { return json(res, 503, { ok: false, id: host.id, label: host.label, nativeProtocolReady: false }); }
    } }));
    return { id: host.id, label: host.label, origin: host.origin, credential, appearance, embed, proxy };
  });
  const catalog = createCatalogHandler({ authorize, connection: ctx.connection, gateway: ctx.typertGateway,
    remotes, WebSocketImpl: WebSocket });
  const management = createManagementHandler({ authorize, connection: ctx.connection, gateway: ctx.typertGateway, remotes });
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/dsh-unified/catalog', handler: catalog }));
  for (const action of ['directories', 'workspace-create', 'session-create', 'directory-create']) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/dsh-unified/manage/' + action, handler: (req, res) => management(action, req, res) }));
  ctx.effect(() => ctx.on('settings/document-updated', ns => {
    for (const remote of remotes) { remote.appearance.noteUpdate(ns); remote.embed.noteAppearanceUpdate(ns); }
  }));
  ctx.effect(() => () => {
    disposed = true; management.close(); catalog.close();
    for (const remote of remotes) { remote.embed.close(); remote.appearance.close(); remote.proxy.close(); remote.credential.close(); }
  });
}
