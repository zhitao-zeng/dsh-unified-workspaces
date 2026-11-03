// Opt-in wire compatibility for an existing 0.4.1 phone page. All traffic
// delegates to the same authenticated fixed-source services as the new UI.
import { createCatalogHandler } from './catalog.js';
import { createManagementHandler } from './manage.js';

function rewrite(req, from, to) {
  const raw = req.url || '/';
  const at = raw.indexOf('?');
  const path = at < 0 ? raw : raw.slice(0, at);
  if (path !== from && !path.startsWith(from + '/')) return false;
  req.url = to + raw.slice(from.length);
  return true;
}
function unavailable(req, res) {
  req.resume();
  res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ ok: false, message: 'Legacy remote route unavailable.' }));
}
export function registerLegacyRoutes(ctx, { remote, authorize, connection, gateway, WebSocketImpl }) {
  const catalog = createCatalogHandler({ authorize, connection, gateway,
    remotes: [{ ...remote, id: 'gpu16' }], WebSocketImpl });
  const management = createManagementHandler({ authorize, connection, gateway,
    remotes: [{ ...remote, id: 'gpu16' }] });
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/api/gpu16-native', handler: (req, res) => {
    if (!rewrite(req, '/api/gpu16-native', remote.routes.native)) return unavailable(req, res);
    return remote.proxy.httpHandler(req, res);
  } }));
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/gpu16-native/remote.mux', handler: (req, socket, head) => {
    if (!rewrite(req, '/gpu16-native/remote.mux', remote.routes.mux)) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return remote.proxy.upgrade(req, socket, head);
  } }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/gpu16-entry/catalog', handler: catalog }));
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/api/gpu16-entry/status', handler: remote.status }));
  for (const action of ['describe', 'mutate', 'update', 'replace', 'revision']) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/gpu16-entry/appearance/' + action, handler: (req, res) => remote.appearance(action, req, res) }));
  for (const action of ['directories', 'workspace-create', 'session-create', 'directory-create']) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/gpu16-entry/manage/' + action, handler: (req, res) => management(action, req, res) }));
  return () => { catalog.close(); management.close(); };
}
