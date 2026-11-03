import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { normalizeParentLocale } from '../lib/embed.js';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function fixture(locale = { active: 'zh', languages: ['zh-CN', 'en-US'] }, existingNativeBridge) {
  const calls = [], listeners = new Map(), replies = [], storage = new Map();
  const original = { type: 'server-response', rpcId: 'locale-read', result: { ok: true, value: { namespaces: [
    { ns: 'locale', value: {}, base: {}, user: {}, revision: 0 },
    { ns: 'models', value: { owner: 'remote-models' }, revision: 19 },
    { ns: 'credentials', value: { owner: 'remote-credentials' }, revision: 23 },
  ] } } };
  const boot = { hostId: 'alpha', frameId: 'frame-alpha', sessionId: 'existing-alpha',
    frameOrigin: 'http://127.0.0.1:39880', parentOrigin: 'dsh-app://app', grant: 'private-grant', controlToken: 'private-control',
    ...(locale === undefined ? {} : { locale }) };
  const parent = {}, env = { console, URL, Headers, Request, Response, Promise, Set, Map,
    location: { origin: boot.frameOrigin, href: boot.frameOrigin + '/' },
    __DSH_EMBED_BOOT__: boot, parent,
    fetch: async (url, options) => { calls.push({ url: String(url), options }); return Response.json(original); },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    document: { baseURI: boot.frameOrigin + '/', querySelector: () => null, documentElement: {},
      createElement: () => ({ remove() {} }), head: { appendChild() {} } },
    addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name),
  };
  env.window = env;
  if (existingNativeBridge) Object.defineProperty(env, '__DSH_LOCALE__', { value: existingNativeBridge, configurable: false });
  vm.createContext(env);
  vm.runInContext(read('embed-prelude.template.js').replace('/* ROUTING_HELPERS */', read('lib/transport.js').replaceAll('export ', '')), env);
  const describe = () => env.fetch(boot.frameOrigin + '/api/settings/describe', { method: 'POST', body: JSON.stringify({ method: 'settings/describe' }) }).then(response => response.json());
  return { env, boot, parent, original, calls, listeners, replies, describe };
}

test('parent locale bootstrap accepts bounded language data and rejects executable or unrelated fields', () => {
  assert.deepEqual(normalizeParentLocale({ active: 'zh', languages: ['en-US', 'zh'] }), { active: 'zh', languages: ['zh', 'en-US'] });
  for (const input of [null, 'zh', { active: '</script>', languages: ['zh'] },
    { active: 'zh', languages: [] }, { active: 'zh', languages: Array(17).fill('zh') },
    { active: 'zh', languages: ['z'.repeat(65)] }, { active: 'zh', languages: ['en_US'] },
    { active: 'zh', languages: ['zh'], settings: {} }]) assert.equal(normalizeParentLocale(input), undefined);
});

test('native language bootstrap and live settings projection are read-only and keep remote execution namespaces intact', async () => {
  const f = fixture();
  assert.deepEqual(plain(await f.env.__DSH_LOCALE__.read()), { languages: ['zh', 'zh-CN', 'en-US'], preference: 'zh' });
  assert.equal(Object.isFrozen(f.env.__DSH_LOCALE__), true);
  let snapshot = await f.describe();
  assert.equal(snapshot.result.value.namespaces[0].value.preference, 'zh');
  assert.deepEqual(snapshot.result.value.namespaces.slice(1), f.original.result.value.namespaces.slice(1));
  assert.deepEqual(f.original.result.value.namespaces[0].value, {}, 'the upstream settings document is never mutated');
  const observations = [];
  const stop = f.env.__DSH_LOCALE__.subscribe(value => observations.push(plain(value)));
  f.env.__DSH_UNIFIED_PARENT_LOCALE__.update({ active: 'en', languages: ['en-US'] });
  snapshot = await f.describe();
  assert.equal(snapshot.result.value.namespaces[0].value.preference, 'en');
  assert.equal(observations.length, 1);
  f.env.__DSH_LOCALE__.onChange('fr');
  assert.equal(f.env.__DSH_UNIFIED_PARENT_LOCALE__.read().active, 'en', 'child locale notifications cannot persist or change the parent preference');
  assert.throws(() => f.env.__DSH_UNIFIED_PARENT_LOCALE__.update({ active: 'en', languages: ['en'], command: 'invalid' }));
  assert.equal(f.env.__DSH_UNIFIED_PARENT_LOCALE__.read().active, 'en');
  const detached = f.env.__DSH_UNIFIED_PARENT_LOCALE__.read(); detached.languages[0] = 'fr';
  assert.equal(f.env.__DSH_UNIFIED_PARENT_LOCALE__.read().languages[0], 'en');
  stop();
  assert(f.calls.every(call => call.options.method === 'POST' && JSON.parse(call.options.body).method === 'settings/describe'));
});

test('an existing non-configurable native locale bridge is retained while the read-only display projection still follows the parent', async () => {
  const bridge = Object.freeze({ read: async () => ({ languages: ['en-US'], preference: null }), onChange() {} });
  const f = fixture({ active: 'zh', languages: ['zh-CN'] }, bridge);
  assert.equal(f.env.__DSH_LOCALE__, bridge);
  assert.equal(Object.getOwnPropertyDescriptor(f.env, '__DSH_LOCALE__').configurable, false);
  assert.equal((await f.describe()).result.value.namespaces[0].value.preference, 'zh');
  f.env.__DSH_UNIFIED_PARENT_LOCALE__.update({ active: 'en', languages: ['en-US'] });
  assert.equal((await f.describe()).result.value.namespaces[0].value.preference, 'en');
  assert.deepEqual(f.original.result.value.namespaces[0].value, {});
});

test('authenticated appearance updates use native settings adoption without setLocale or a document reload', async () => {
  const f = fixture(); let plugin, reloads = 0, active = 'zh', clean;
  f.env.__ModuleLoader__ = { load(value) { plugin = value.factory(() => {}); } };
  vm.runInContext(read('companion.template.js'), f.env);
  plugin.apply({ uiWorkspace: { selection: { getSnapshot: () => ({ sessionId: 'existing-alpha' }), subscribe: () => () => {} } },
    locale: { setLocale() { throw Error('durable preference writes are forbidden'); } },
    sessions: {}, layout: { toggleSidebar() {} }, effect: callback => { clean = callback(); },
    configForms: { describe: () => ({ load: async () => { reloads++; active = (await f.describe()).result.value.namespaces[0].value.preference; } }) },
  });
  const port = { start() {}, close() {}, postMessage: value => f.replies.push(plain(value)) };
  f.listeners.get('message')({ source: f.parent, origin: f.boot.parentOrigin,
    data: { type: 'dsh-unified/embed-init', frameId: f.boot.frameId, controlToken: f.boot.controlToken }, ports: [port] });
  for (const [id, language] of [['en-request', 'en'], ['zh-request', 'zh']]) {
    await port.onmessage({ data: { id, type: 'appearance/reload', locale: { active: language, languages: [language] } } });
    assert.equal(active, language); assert.equal(f.replies.find(reply => reply.id === id).ok, true);
  }
  assert.equal(reloads, 2);
  await port.onmessage({ data: { id: 'invalid-request', type: 'appearance/reload', locale: { active: 'en', languages: ['en'], unexpected: true } } });
  assert.equal(f.replies.find(reply => reply.id === 'invalid-request').ok, false);
  assert.equal(active, 'zh'); assert.equal(reloads, 2);
  assert.deepEqual(f.original.result.value.namespaces[0].value, {});
  clean?.();
});
