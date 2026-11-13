window.__ModuleLoader__.load({
  id: '@zhitao-zeng/dsh-unified-workspaces',
  factory(require) {
    /* ROUTING_HELPERS */
    /* PERSISTENT_HELPERS */
    /* PLUGIN_SYNC */
    function pickerModule(require) {
      /* PICKER_MODULE */
    }
    // ── 第二棵 Client 树（B2）─────────────────────────────────────────────
    // 在同一文档里启动一棵独立的 DSH 客户端树，通过插件后台代理连到指定远端。
    // 依赖：cordis 的 Context（页面已提供）、dsh-client-modules 的
    // createClientModuleSystem；官方没有暴露 Loader 插件类，这里用本地 shim 补齐
    // （7 个方法：ctx / internal / create / entries / resolve / ensureId / await）。
    //
    // 风险：shim、facade 形状、boot 图裁剪都是本项目自行承担的适配，
    // DSH 升级后必须按 ASSESS-productization.md 第七节的清单回归。
    function createRemoteTree(require) {
      const SEEDS = [
        ['react', 'react'], ['react/jsx-runtime', 'react/jsx-runtime'], ['react-dom', 'react-dom'],
        ['react-dom/client', 'react-dom/client'], ['zod', 'zod'], ['@tanstack/react-virtual', '@tanstack/react-virtual'],
        ['@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-store'],
        ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-slots'],
        ['@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-primitives'],
        ['@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-client-ui-dockkit'],
      ];
      return async function bootSecondTree(options) {
        const opts = options || {};
        const container = opts.container || null;
        const hostId = typeof opts.hostId === 'string' && opts.hostId ? opts.hostId : null;
        const initialSessionId = typeof opts.sessionId === 'string' && opts.sessionId ? opts.sessionId : null;
        const trace = [];
        const handle = { ok: false, mount: null };
        const lifetime = new AbortController();
        const sockets = new Set();
        let ctx = null;
        let mount = null;
        let unmount = null;
        let disposed = false;
        let disposePromise = null;
        let startup = true;
        handle.dispose = () => {
          if (disposePromise) return disposePromise;
          disposed = true; handle.ok = false;
          lifetime.abort();
          disposePromise = (async () => {
            const failures = [];
            const clean = async action => { try { await action(); } catch (error) { failures.push(error); } };
            try {
              // React cleanup needs its Session services to remain available.
              // Remove the view first, then release Cordis dependencies/transport.
              await clean(() => unmount?.());
              let inspect = null;
              try { inspect = ctx?.get?.('cordisInspect') || null; } catch {}
              // The root Context owns all manually loaded plugins. Unload their
              // dependants first while the manually installed connection remains
              // available for final provider-manifest updates.
              const entries = [...(ctx?.loader?.entries?.() || [])].reverse();
              for (const entry of entries) {
                await clean(() => entry.fiber?.dispose?.());
                await Promise.resolve();
                await clean(() => inspect?.syncChain);
              }
              await clean(() => ctx?.fiber?.dispose?.());
              if (failures.length) throw new AggregateError(failures, '远端界面清理未全部完成');
            }
            finally {
              for (const socket of sockets) { try { socket.close(1000, 'Remote view released'); } catch {} }
              sockets.clear(); mount?.remove();
              handle.mount = null; handle.uiWorkspace = null;
              opts.signal?.removeEventListener('abort', onAbort);
            }
          })();
          return disposePromise;
        };
        const onAbort = () => { void handle.dispose().catch(() => {}); };
        opts.signal?.addEventListener('abort', onAbort, { once: true });
        const checkAlive = () => {
          opts.signal?.throwIfAborted();
          lifetime.signal.throwIfAborted();
        };
        const step = (label, extra) => trace.push({ at: trace.length, label, ...(extra ? { extra } : {}) });
        try {
          checkAlive();
          if (hostId !== null) {
            if (!initialSessionId) throw new Error('远端界面需要明确的已有会话');
            // Verify the requested identity before the native navigation service
            // can restore a default. A stale row must never create a new blank.
            const response = await fetch('/api/dsh-unified/hosts/' + hostId + '/native/session/list', {
              method: 'POST', credentials: 'same-origin', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: 'client-request', rpcId: 'remote-tree-initial-' + hostId,
                method: 'session/list', payload: { args: { _request: {} } } }),
            });
            const envelope = await response.json();
            if (!response.ok || envelope?.result?.ok !== true || !envelope.result.value?.items?.some(item => item.sessionId === initialSessionId)) {
              throw new Error('目标远端会话已不可用，请刷新列表后重试');
            }
          }
          checkAlive();
          const cordis = require('@deepseek-ai/cordis');
          const face = require('@deepseek-ai/dsh-client-modules');
          const { Context, Service } = cordis;
          if (typeof Context !== 'function' || typeof Service !== 'function') throw new Error('cordis exports missing Context/Service');
          step('cordis');
          const staticModules = { '@deepseek-ai/cordis': cordis };
          const missing = [];
          for (const [key, spec] of SEEDS) {
            try { staticModules[key] = require(spec); } catch (error) { missing.push(spec + ' :: ' + String(error && error.message || error).slice(0, 120)); }
          }
          if (missing.length) throw new Error('Missing second-tree modules: ' + missing.join(', '));
          if (hostId !== null) {
            const storeFace = staticModules['@deepseek-ai/dsh-client-store'];
            staticModules['@deepseek-ai/dsh-client-store'] = {
              ...storeFace,
              createSnapshotStore(initial, options) {
                if (options?.persist?.name !== 'dsh.sessions.current') return storeFace.createSnapshotStore(initial, options);
                const store = storeFace.createSnapshotStore(initial, { ...options,
                  persist: { ...options.persist, name: 'dsh.unified.' + hostId + '.sessions.current' } });
                // This runs while UiWorkspaceService initializes its fields,
                // before watchNavigation can restore a blank or the Mac's ID.
                store.set({ sessionId: initialSessionId });
                return store;
              },
            };
          }
          step('seeds');
          const facade = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration); }, create() { throw new Error('client-modules: second-tree facade create() is unused'); } };
          // 影子 window：只截获 __ModuleLoader__，其余转发给真实 window。
          // 注意必须用"以真实 window 为 this"的包装，否则 addEventListener 这类
          // 原生方法会抛 Illegal invocation（实测踩到）。
          const realGlobal = globalThis;
          const overlay = new Map();
          const NEEDS_THIS = ['addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout',
            'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
            'fetch', 'matchMedia', 'getComputedStyle', 'postMessage', 'dispatchEvent'];
          // A remote tree is a Web client. Electron preload bridges belong to
          // the Mac tree: exposing them starts a second desktop onboarding flow
          // and can send remote account actions through the local desktop.
          const desktopBridges = new Set(['dshDesktop', 'dshDesktopBoot', 'dshOnboarding', 'dshPlatform']);
          // Use a separate target: contextBridge properties on the real Window
          // can be non-configurable, so a Proxy of that Window cannot hide them.
          const shadowWindow = new Proxy(Object.create(null), {
            get(_target, prop) {
              if (desktopBridges.has(prop)) return undefined;
              if (['window', 'self', 'globalThis'].includes(prop)) return shadowWindow;
              if (prop === '__ModuleLoader__') return facade;
              if (overlay.has(prop)) return overlay.get(prop);
              const value = Reflect.get(realGlobal, prop);
              if (typeof value === 'function' && NEEDS_THIS.includes(prop)) {
                return function (...args) { return value.apply(realGlobal, args); };
              }
              return value;
            },
            set(target, prop, value) {
              if (prop === '__ModuleLoader__') return true;
              overlay.set(prop, value);
              return true;
            },
            has(_target, prop) { return !desktopBridges.has(prop) && (prop === '__ModuleLoader__' || overlay.has(prop) || prop in realGlobal); },
          });
          const loadBundle = async url => {
            const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: lifetime.signal });
            if (!response.ok) throw new Error('bundle ' + url + ' -> HTTP ' + response.status);
            let source = await response.text();
            // The pinned shortcuts module detects Electron from the shared DOM
            // platform marker. This tree owns Web keyboard handling; it must not
            // register another controller with the Mac preload keyboard bridge.
            if (hostId !== null && String(url).includes('dsh-client-shortcuts/client.js')) {
              const desktopProbe = 'const desktop = document.documentElement.dataset.platform;';
              if (source.split(desktopProbe).length !== 2) throw new Error('当前 DSH 快捷键模块需要重新验证远端适配');
              source = source.replace(desktopProbe, 'const desktop = undefined;');
            }
            const run = new Function('window', 'self', 'globalThis', 'document', source + '\n//# sourceURL=' + url);
            try { run(shadowWindow, shadowWindow, shadowWindow, document); }
            catch (error) {
              const first = String(source).split('\n')[0].slice(0, 80);
              throw new Error('bundle eval failed (' + first + '…): ' + String(error && error.message || error));
            }
          };
          // 指定 hostId 时：换掉连接层（不加载页面自带的那个），用代理前缀手装一个。
          const baseBoot = globalThis.__DSH_BOOT__;
          // Use the same native remote composition as the compatibility view.
          // Desktop-only and experimental addons can require APIs absent on the
          // remote host, so copying the complete Mac graph can abort startup.
          // Each tree owns a fixed graph until it is reopened. Its parent keeps
          // HMR; a second HMR client could reintroduce the unfiltered Mac graph.
          const remoteIds = [/* REMOTE_CLIENT_IDS */].filter(id =>
            id.startsWith('@deepseek-ai/') && ![
              '@deepseek-ai/dsh-client-connection', '@deepseek-ai/dsh-client-hmr',
            ].includes(id));
          const boot = hostId === null ? baseBoot : filterClientGraph(baseBoot, remoteIds);
          const modules = face.createClientModuleSystem(facade, { id: '@deepseek-ai/dsh-client-modules', exports: face },
            { boot, staticModules, loadBundle });
          step('moduleSystem', { entries: modules.manifest.plugins.length });
          // 调试用：第二棵树的模块清单（正式版删除）。
          try { if (globalThis.__DSH_UNIFIED_TREE_MANIFEST_DEBUG__ === true) realGlobal.__DSH_UNIFIED_TREE_MANIFEST__ = modules.manifest.plugins.map(entry => entry.id); } catch {}
          if (facade.pendingQueue.length !== modules.manifest.plugins.length) step('pendingQueue', { got: facade.pendingQueue.length });
          ctx = new Context();
          class LoaderShim extends Service {
            constructor(scope) { super(scope, 'loader'); this.byId = new Map(); }
            ensureId(options) { const id = String(options.name); if (this.byId.has(id)) throw new Error('duplicate entry ' + id); return id; }
            resolve(id) { return this.byId.get(id); }
            remove(entry) { if (entry && entry.options) this.byId.delete(entry.options.name); }
            entries() { return this.byId.values(); }
            async await() { await Promise.all([...this.byId.values()].map(entry => entry.fiber)); }
            async create(options) {
              const id = this.ensureId(options);
              const exports = await modules.import(id, ctx.baseUrl, {});
              const fiber = ctx.plugin(exports);
              const entry = { options: { ...options, name: id }, fiber };
              this.byId.set(id, entry);
              await fiber;
              return entry;
            }
          }
          await ctx.plugin(LoaderShim);
          checkAlive();
          step('loaderShim');
          if (!ctx.loader) throw new Error('loader service was not provided');
          ctx.loader.internal = modules;
          if (hostId !== null) {
            const connectionFace = require('@deepseek-ai/dsh-client-connection');
            if (typeof connectionFace.installConnection !== 'function') throw new Error('connection face has no installConnection');
            const prefix = '/api/dsh-unified/hosts/' + hostId + '/native/';
            const muxPath = '/dsh-unified/hosts/' + hostId + '/remote.mux';
            const transport = {
              fetch(path, init) {
                const rest = String(path).replace(/^\/?api\//, '');
                // Provider unregisters publish one final manifest during
                // teardown. This narrow cleanup RPC precedes connection close.
                if (!(disposed && rest === 'dynamicCordisRunner/syncInspectManifest')) checkAlive();
                if (startup && ['session/create', 'workspace/initializeDefault'].includes(rest.replace(/^\//, '').split('?')[0])) {
                  throw new Error('打开已有远端会话时不创建默认会话或工作区');
                }
                return globalThis.fetch(prefix + rest, { ...(init || {}), credentials: 'same-origin' });
              },
              createWebSocket(url) {
                checkAlive();
                const target = String(url).replace('/api/remote.mux', muxPath);
                const socket = new WebSocket(target);
                sockets.add(socket);
                socket.addEventListener('close', () => sockets.delete(socket), { once: true });
                return socket;
              },
              streamBaseUrl: new URL('/', globalThis.__DSH_TRANSPORT__?.streamBaseUrl || globalThis.location.href || globalThis.location.origin + '/').href,
              ownsHost: false,
            };
            connectionFace.installConnection(ctx, { transport, location: globalThis.location });
            step('remoteConnection', { hostId, prefix });
          }
          await modules.entries.start(ctx.loader, modules.manifest);
          checkAlive();
          step('entriesStart', { activated: [...ctx.loader.entries()].filter(e => e.fiber).length });
          await ctx.loader.await();
          checkAlive();
          const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined).map(entry => entry.options.name);
          step('loaded');
          if (failed.length) throw new Error('Second-tree entries failed: ' + failed.join(', '));
          mount = document.createElement('div');
          mount.setAttribute('data-proto-second-tree', '');
          // 挂到调用方容器时铺满容器；独立调试模式才用右下角小窗。
          mount.style.cssText = container
            ? 'position:absolute;inset:0;overflow:hidden;background:var(--dsw-alias-bg-base)'
            : 'position:fixed;right:8px;bottom:8px;width:520px;height:420px;z-index:2147483000;border:2px solid #f59e0b;background:#fff;overflow:hidden';
          (container || document.body).appendChild(mount);
          // 第二棵树的服务要从它自己的 Context 里取：根 ctx 上没有 uiWorkspace。
          let uiWorkspace = null;
          await ctx.inject(['uiRenderer', 'uiWorkspace', 'layout'], scope => {
            uiWorkspace = scope.uiWorkspace;
            scope.effect(() => {
              const stop = scope.uiRenderer.mount(mount);
              let stopped = false;
              unmount = () => { if (!stopped) { stopped = true; return stop?.(); } };
              return unmount;
            }, 'remote tree renderer');
            // 侧栏只保留一份（本插件的合并侧栏）。先把第二棵树的侧栏收成图标条
            // （纯内存状态，不落盘），再用 CSS 把那一条藏掉，见 RemoteTreePane。
            try { scope.layout.toggleSidebar(); } catch {}
          });
          checkAlive();
          if (!uiWorkspace) throw new Error('second tree uiWorkspace 未就绪（客户端模块清单缺依赖）');
          step('mounted', { uiWorkspace: Boolean(uiWorkspace) });
          handle.mount = mount;
          let home = null; let state = null; let sessionCount = null;
          try { home = ctx.remote?.$host?.home ?? null; } catch (error) { home = 'ERR ' + String(error && error.message || error); }
          try { state = ctx.connection?.state?.getSnapshot?.() ?? null; } catch {}
          try {
            const list = await ctx.connection.rpc.call('/api', 'session/list', { args: { _request: {} } }, undefined);
            sessionCount = Array.isArray(list?.value?.items) ? list.value.items.length : null;
          } catch (error) { sessionCount = 'ERR ' + String(error && error.message || error).slice(0, 120); }
          // 只读句柄：仅隔离验证用，正式运行不挂全局。
          if (globalThis.__DSH_UNIFIED_REMOTE_TREE_HANDLE_DEBUG__ === true) {
            globalThis.__DSH_UNIFIED_REMOTE_TREE_HANDLE__ = { ctx, modules, hostId, mount, dispose: handle.dispose };
          }
          handle.ok = true; handle.trace = trace; handle.hostId = hostId; handle.home = home;
          handle.state = state; handle.sessionCount = sessionCount;
          // 切会话入口：第二棵树自己的 uiWorkspace，和原生界面点会话走同一条路。
          handle.uiWorkspace = uiWorkspace;
          handle.openSession = sessionId => { checkAlive(); if (!uiWorkspace) throw new Error('second tree uiWorkspace 未就绪'); uiWorkspace.openSession(sessionId); };
          handle.selection = () => { try { return uiWorkspace?.selection?.getSnapshot?.() ?? null; } catch { return null; } };
          handle.activate = () => { checkAlive(); startup = false; };
          handle.mounted = Boolean(mount.firstChild);
          return handle;
        } catch (error) {
          try { await handle.dispose(); } catch {}
          return Object.assign(handle, { ok: false, stage: 'threw', error: String(error && error.stack || error).slice(0, 1200), trace });
        }
      };
    }
    // ── 远端会话视图管理器（每台机器最多一棵树）──────────────────────────
    // 规则：同机切换会话复用；切到别的机器或回到本机时释放；草稿按"机器+会话"
    // 暂存，重新创建后回填。释放不停止远端任务（停止必须由用户显式触发）。
    function createRemoteTreeManager(require, options = {}) {
      const bootTree = options.bootTree || createRemoteTree(require);
      // 计数器只为隔离验证服务：只有显式打开 __DSH_UNIFIED_TREE_DEBUG_ON__ 才挂到全局。
      const debug = { boots: 0, releases: [], opens: [], errors: [], calls: [] };
      if (globalThis.__DSH_UNIFIED_TREE_DEBUG_ON__ === true) globalThis.__DSH_UNIFIED_TREE_DEBUG__ = debug;
      const trees = new Map();    // hostId -> { handle, ready: Promise }
      const releasing = new Map();
      const waitUntil = async (check, timeout, signal) => {
        const started = Date.now();
        for (;;) {
          if (signal?.aborted) return false;
          try { if (check()) return true; } catch {}
          if (Date.now() - started >= timeout) return false;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      };
      async function ensure(hostId, container, sessionId) {
        if (!hostId || !container) return null;
        if (releasing.has(hostId)) await releasing.get(hostId);
        const existing = trees.get(hostId);
        if (existing) { if (existing.handle && existing.handle.mount && !container.contains(existing.handle.mount)) container.appendChild(existing.handle.mount); return existing.ready; }
        const record = { handle: null, control: new AbortController(), released: false };
        debug.boots++;
        record.ready = bootTree({ hostId, container, sessionId, signal: record.control.signal }).then(async handle => {
          record.handle = handle;
          if (record.released) await handle?.dispose?.();
          if (!handle?.ok && trees.get(hostId) === record) trees.delete(hostId);
          return handle;
        }).catch(error => { if (trees.get(hostId) === record) trees.delete(hostId); debug.errors.push(String(error && error.message || error)); throw error; });
        trees.set(hostId, record);
        const handle = await record.ready;
        return handle;
      }
      async function open(hostId, sessionId) {
        const entry = trees.get(hostId); if (!entry) return false;
        entry.sessionId = sessionId; debug.opens.push(hostId + ':' + String(sessionId).slice(0, 8));
        const handle = entry.handle || await entry.ready; if (!handle || !handle.ok || entry.released) return false;
        // 刚启动的第二棵树会话列表是异步拉取的；列表没到之前 retain 会报
        // "unknown session"。先等它自己的列表认得这个会话，再切主视图。
        const listed = await waitUntil(() => {
          const list = handle.uiWorkspace?.sessions?.list?.getSnapshot?.();
          return Boolean(list && list.phase === 'ready' && list.byId && list.byId[sessionId]);
        }, 15000, entry.control.signal);
        if (entry.released || entry.control.signal.aborted) return false;
        if (!listed) { debug.errors.push('not-listed:' + String(sessionId).slice(0, 8)); return false; }
        let lastError = null;
        let explicitlyOpened = false;
        const opened = await waitUntil(() => {
          // A seeded selection is a navigation hint, not a retained main view.
          // Blank sessions in particular still need an explicit native open.
          if (explicitlyOpened && handle.selection()?.sessionId === sessionId) return true;
          try { handle.openSession(sessionId); explicitlyOpened = true; } catch (error) { lastError = error; }
          return false;
        }, 12000, entry.control.signal);
        if (entry.released || entry.control.signal.aborted) return false;
        if (!opened) { debug.errors.push('open:' + String(lastError && lastError.message || 'timeout').slice(0, 160)); return false; }
        if (entry.released || trees.get(hostId) !== entry) return false;
        handle.activate?.();
        // 草稿不再自己存：DSH 原生就按会话持久化输入框内容，树重建后它自己会回填。
        // 之前自己再存一份会在输入框里叠出两份文本（实测 "DRAFT-KEEP-42DRAFT-KEEP-42"）。
        return true;
      }
      async function release(hostId) {
        if (releasing.has(hostId)) return releasing.get(hostId);
        const entry = trees.get(hostId); if (!entry) return;
        // 释放不停远端任务；输入框草稿由 DSH 自己按会话持久化。
        trees.delete(hostId); debug.releases.push(hostId);
        entry.released = true; entry.control.abort();
        const pending = (async () => {
          const handle = entry.handle || await entry.ready.catch(() => null);
          await handle?.dispose?.();
        })();
        releasing.set(hostId, pending);
        try { await pending; }
        catch (error) { debug.errors.push('dispose:' + String(error && error.message || error)); throw error; }
        finally { if (releasing.get(hostId) === pending) releasing.delete(hostId); }
      }
      async function releaseAllExcept(hostId) {
        for (const id of [...trees.keys()]) if (id !== hostId) await release(id);
      }
      function ready(hostId) { const entry = trees.get(hostId); return Boolean(entry && entry.handle && entry.handle.ok); }
      return { ensure, open, release, releaseAllExcept, ready, trees, debug };
    }
    return {
      inject: ['connection'],
      apply(ctx) {
        const persistentMode = globalThis.__DSH_UNIFIED_PERSISTENT_LOCAL__ === true;
        let selected = 'mac';
        try { const saved = sessionStorage.getItem(HOST_KEY); if (validHostId(saved)) selected = saved; } catch {}
        if (persistentMode) selected = 'mac';
        const gpu = selected !== 'mac';
        if (gpu && globalThis.__DSH_UNIFIED_REMOTE_BOOT__?.beforeClientContext !== true) {
          throw new Error('远端的原生连接未在工作区启动前就绪，已停止加载。');
        }
        ctx.inject(['slots', 'layout', 'uiWorkspace', 'locale'], ui => {
          const React = require('react');
          const h = React.createElement;
          // 第二棵树按"每台机器的配置"启用：hosts.json 里该主机写了 remoteTree:true。
          // 隔离测试可以用 __DSH_UNIFIED_REMOTE_TREE__ + __DSH_UNIFIED_REMOTE_TREE_HOSTS__ 强开。
          const remoteTrees = createRemoteTreeManager(require);
          const testTreeHosts = new Set(Array.isArray(globalThis.__DSH_UNIFIED_REMOTE_TREE_HOSTS__)
            ? globalThis.__DSH_UNIFIED_REMOTE_TREE_HOSTS__ : []);
          const treeHostIdsNow = () => {
            const ids = new Set(testTreeHosts);
            for (const host of snapshot.hosts || []) if (host && host.remoteTree === true) ids.add(host.id);
            return ids;
          };
          // 版本闸门：只有"本机与远端 release（version+commit）一致"才启用第二棵树。
          // 版本未知（拿不到远端 release）→ 一律回退 iframe；隔离测试可用 FORCE 跳过。
          const localRelease = () => { try { return globalThis.__DSH_BOOT__?.release || null; } catch { return null; } };
          const sameRelease = (a, b) => Boolean(a && b && a.version && b.version && a.version === b.version && String(a.commit || '') === String(b.commit || ''));
          const treeForHost = hostId => {
            if (!remoteTrees || !treeHostIdsNow().has(hostId)) return false;
            if (globalThis.__DSH_UNIFIED_REMOTE_TREE_FORCE__ === true) return true;
            const host = (snapshot.hosts || []).find(entry => entry.id === hostId);
            return sameRelease(localRelease(), host && host.release ? host.release : null);
          };
          const panel = 'dsh-unified-host';
          const selectionKey = 'dsh-unified-selection-by-host';
          const pendingKey = 'dsh-unified-pending-selection';
          const createdKey = 'dsh-unified-created-sessions';
          const sidebarExpansionKey = 'dsh-unified-sidebar-open-workspaces';
          if (gpu) ui.plugin(pickerModule(require));
          const requestFetch = window.fetch.bind(window);
          const PluginSyncPanel = createPluginSyncPanel({ React, h, requestFetch, requestAccess });
          const listeners = new Set();
          const persistentBridges = new Map();
          let snapshot = { phase: 'loading', hosts: [], error: '', dialog: null, managerNotice: '', recentCreated: null, operationBusy: false, activeTarget: 'mac', remotes: Object.create(null) };
          let created = Object.create(null);
          const confirmedCreated = new Map();
          const uncertainCreates = new Map();
          const uncertainKey = 'dsh-unified-uncertain-session-creates';
          const creationKey = dialog => dialog.host + ':' + dialog.workspaceId;
          try {
            const saved = JSON.parse(sessionStorage.getItem(uncertainKey) || '[]');
            if (Array.isArray(saved)) for (const dialog of saved.slice(-128)) {
              if (dialog?.kind === 'session' && validHostId(dialog.host)
                  && typeof dialog.workspaceId === 'string' && dialog.workspaceId.length > 0 && dialog.workspaceId.length <= 512
                  && typeof dialog.requestId === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(dialog.requestId)
                  && typeof dialog.path === 'string' && typeof dialog.label === 'string') uncertainCreates.set(creationKey(dialog), { ...dialog, uncertain: true });
            }
          } catch {}
          function saveUncertainCreates() {
            try { sessionStorage.setItem(uncertainKey, JSON.stringify([...uncertainCreates.values()])); return true; } catch { return false; }
          }
          try {
            const saved = JSON.parse(sessionStorage.getItem(createdKey) || '{}');
            for (const host of Object.keys(saved)) {
              if (!validHostId(host)) continue;
              created[host] = Object.create(null);
              for (const [id, value] of Object.entries(saved[host] || {}).slice(-128)) if (value === true && id && id.length <= 512) created[host][id] = true;
            }
          } catch {}
          function bridgeFor(hostId) {
            if (!validHostId(hostId, false) || !snapshot.hosts.some(host => host.id === hostId)) throw new Error('未配置此远端主机。');
            let bridge = persistentBridges.get(hostId);
            if (!bridge) {
              bridge = createPersistentEmbed({ hostId, fetch: requestFetch, getLocale: currentLocale, changed: value => {
                if (disposed) return;
                const old = snapshot.remotes[hostId] || {};
                const next = { ...old, ...('metadata' in value ? { embed: value.metadata || null } : {}), ...('ready' in value ? { ready: value.ready === true } : {}), ...(typeof value.sessionId === 'string' ? { sessionId: value.sessionId } : {}), ...('notice' in value ? { notice: value.notice || '' } : {}) };
                emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: next } });
              } });
              persistentBridges.set(hostId, bridge);
            }
            return bridge;
          }
          let writeBusy = false;
          let browseGeneration = 0;
          const managementRequests = new Set();
          let sidebarExpanded = new Set();
          try {
            const values = JSON.parse(sessionStorage.getItem(sidebarExpansionKey) || '[]');
            if (Array.isArray(values)) sidebarExpanded = new Set(values.filter(value => typeof value === 'string' && value.length <= 1024 && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}:/.test(value)).slice(-128));
          } catch {}
          let currentSessionId;
          let catalogReadAt = 0;
          let disposed = false;
          let inFlight;
          let requestAbort;
          let disposeUnified;
          function enableUnified() {
            if (!disposeUnified) disposeUnified = ui.slots.register({ name: 'sidebar.workspaces', priority: -100 }, UnifiedTree);
          }
          function manageCurrent() {
            disposeUnified?.();
            disposeUnified = undefined;
            ui.layout.selectPanel(null);
          }
          function emit(next) {
            snapshot = next;
            saveCurrentSelection();
            for (const listener of listeners) listener();
          }
          function saveCurrentSelection() {
            const value = ui.uiWorkspace.selection?.getSnapshot?.();
            const ownHost = snapshot.hosts.find(host => host.id === selected);
            if (!value || typeof value.sessionId !== 'string' || !ownHost?.items.some(item => item.sessionId === value.sessionId)) return;
            currentSessionId = value.sessionId;
            try {
              const raw = sessionStorage.getItem(selectionKey);
              let byHost = raw ? JSON.parse(raw) : {};
              if (!byHost || typeof byHost !== 'object' || Array.isArray(byHost)) byHost = {};
              sessionStorage.setItem(selectionKey, JSON.stringify({ ...byHost, [selected]: value }));
            } catch {}
          }
          function requestAccess() {
            let device;
            try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
            const phone = typeof device === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(device);
            return { prefix: phone ? '/remote' : '', headers: phone ? { 'x-dsh-remote-device': device } : {} };
          }
          function newRequestId() {
            if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
            if (globalThis.crypto?.getRandomValues) return [...globalThis.crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join('');
            throw new Error('无法准备创建请求，请刷新页面后重试。');
          }
          async function management(action, input) {
            if (disposed) throw new Error('工作台已关闭，请重新打开后重试。');
            const access = requestAccess();
            const control = new AbortController();
            managementRequests.add(control);
            const timeout = setTimeout(() => control.abort(), 45_000);
            try {
              const response = await requestFetch(access.prefix + '/api/dsh-unified/manage/' + action, {
                method: 'POST', credentials: 'same-origin', cache: 'no-store',
                headers: { ...access.headers, 'content-type': 'application/json' },
                body: JSON.stringify(input), signal: control.signal,
              });
              const data = await response.json();
              if (response.ok && data?.ok === true) return data.value;
              const error = new Error(data?.error?.message || '操作未完成，请刷新列表确认结果。');
              error.code = data?.error?.code || 'management/unavailable';
              error.details = data?.error?.details;
              throw error;
            } catch (error) {
              if (error?.code) throw error;
              const failure = new Error(action === 'directories' ? '目录暂时无法读取，可以直接输入绝对路径。' : '创建结果尚未确认，请先刷新列表查看。');
              failure.code = action === 'directories' ? 'management/read-unavailable' : 'management/result-uncertain';
              throw failure;
            } finally { clearTimeout(timeout); managementRequests.delete(control); }
          }
          function markCreated(host, sessionId) {
            if (!validHostId(host) || typeof sessionId !== 'string' || !sessionId || sessionId.length > 512) return;
            if (!Object.hasOwn(created, host)) created[host] = Object.create(null);
            created[host][sessionId] = true;
            created[host] = Object.fromEntries(Object.entries(created[host]).slice(-128));
            try { sessionStorage.setItem(createdKey, JSON.stringify(created)); } catch {}
          }
          function publishCreatedSession(dialog, sessionId) {
            uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
            markCreated(dialog.host, sessionId);
            if (!confirmedCreated.has(dialog.host)) confirmedCreated.set(dialog.host, new Map());
            const row = { sessionId, blank: true, running: false, agentAvailable: false,
              cwd: dialog.path, updatedAt: Date.now() };
            const workspace = typeof dialog.workspaceId === 'string' ? {
              workspaceId: dialog.workspaceId, path: dialog.path,
              title: dialog.workspaceTitle || dialog.path, sessionIds: [sessionId],
            } : undefined;
            confirmedCreated.get(dialog.host).set(sessionId, { row, workspace, until: Date.now() + 60_000 });
            if (confirmedCreated.get(dialog.host).size > 128) confirmedCreated.get(dialog.host).delete(confirmedCreated.get(dialog.host).keys().next().value);
            // A successful source-specific create acknowledgement is enough to
            // show/open this identity. Catalog reconciliation runs separately.
            const hosts = reconcileCreated(snapshot.hosts, false).map(host => host.id === dialog.host ? { ...host, status: 'ready' } : host);
            if (typeof dialog.workspaceId === 'string') setWorkspaceExpanded(dialog.host, dialog.workspaceId, true, false);
            emit({ ...snapshot, hosts, dialog: null,
              recentCreated: { host: dialog.host, sessionId, workspaceId: dialog.workspaceId },
              managerNotice: '已在 ' + dialog.label + ' 创建会话，正在打开…' });
          }
          function reconcileCreated(hosts, sourceRead = true) {
            return hosts.map(host => {
              const pending = confirmedCreated.get(host.id);
              if (!pending?.size) return host;
              let items = host.items, workspaces = host.workspaces;
              for (const [id, value] of pending) {
                if (value.until <= Date.now() || sourceRead && host.status === 'ready' && host.items.some(item => item.sessionId === id)) {
                  pending.delete(id); continue;
                }
                if (!items.some(item => item.sessionId === id)) items = [...items, value.row];
                if (value.workspace) {
                  const own = workspaces.find(workspace => workspace.workspaceId === value.workspace.workspaceId);
                  if (!own) workspaces = [...workspaces, value.workspace];
                  else if (!own.sessionIds.includes(id)) workspaces = workspaces.map(workspace => workspace !== own ? workspace : { ...workspace, sessionIds: [...workspace.sessionIds, id] });
                }
              }
              return items === host.items && workspaces === host.workspaces ? host : { ...host, items, workspaces };
            });
          }
          function setWorkspaceExpanded(host, workspaceId, expanded, notify = true) {
            const key = host + ':' + workspaceId;
            if (expanded) sidebarExpanded.add(key); else sidebarExpanded.delete(key);
            sidebarExpanded = new Set([...sidebarExpanded].slice(-128));
            try { sessionStorage.setItem(sidebarExpansionKey, JSON.stringify([...sidebarExpanded])); } catch {}
            if (notify) emit({ ...snapshot });
          }
          function showManager() {
            enableUnified();
            const collapsed = document.querySelector?.('[data-sidebar-collapsed]')?.getAttribute('data-sidebar-collapsed');
            if (typeof window.innerWidth === 'number' && window.innerWidth <= 700 && collapsed === 'false') ui.layout.toggleSidebar?.();
            ui.layout.selectPanel(panel);
          }
          function openCreation(kind, host, workspace) {
            if (writeBusy || host.status !== 'ready') return;
            let requestId;
            try { requestId = newRequestId(); } catch (error) { emit({ ...snapshot, managerNotice: error.message }); showManager(); return; }
            browseGeneration++;
            emit({ ...snapshot, managerNotice: '', dialog: { kind, host: host.id, label: host.label,
              path: kind === 'workspace' ? '' : workspace.path, workspaceId: workspace?.workspaceId,
              workspaceTitle: workspace?.title || workspace?.path || '', requestId,
              directory: null, browsing: false, showHidden: false, error: '', uncertain: false } });
            showManager();
          }
          async function createAndOpen(host, workspace, onNotice) {
            if (disposed || writeBusy || host.status !== 'ready') {
              try { fetch('http://127.0.0.1:8099/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ kind: 'create-skip', host: host && host.id, disposed, writeBusy, status: host && host.status, active: snapshot.activeTarget, t: new Date().toISOString() }) }); } catch {}
              return;
            }
            const notify = notifier(onNotice);
            const previous = uncertainCreates.get(creationKey({ host: host.id, workspaceId: workspace.workspaceId }));
            if (previous) {
              if (typeof onNotice === 'function') { onNotice('上一次创建结果仍待核对，未发送新的创建请求。'); return; }
              emit({ ...snapshot, dialog: previous, managerNotice: '上一次创建结果仍待核对，未发送新的创建请求。' });
              showManager(); return;
            }
            if (uncertainCreates.size >= 128) { notify('待核对的创建请求较多，请先核对已有会话列表。'); return; }
            let requestId;
            try { requestId = newRequestId(); }
            catch (error) { notify(error.message); return; }
            const dialog = { kind: 'session', host: host.id, label: host.label,
              path: workspace.path, workspaceId: workspace.workspaceId,
              workspaceTitle: workspace.title || workspace.path || '', requestId };
            await createFromDialog(undefined, dialog, onNotice);
          }
          function editDialog(patch) {
            if (!snapshot.dialog || writeBusy) return;
            emit({ ...snapshot, dialog: { ...snapshot.dialog, ...patch } });
          }
          function closeCreation() {
            if (writeBusy) return;
            browseGeneration++;
            emit({ ...snapshot, dialog: null });
          }
          async function browseDirectory(path) {
            const dialog = snapshot.dialog;
            if (!dialog || dialog.kind !== 'workspace' || dialog.browsing || writeBusy) return;
            const generation = ++browseGeneration;
            editDialog({ browsing: true, error: '' });
            try {
              const value = await management('directories', { host: dialog.host, ...(path ? { path } : {}) });
              if (disposed || generation !== browseGeneration || !snapshot.dialog) return;
              if (!value || typeof value.path !== 'string' || !Array.isArray(value.entries) || !Array.isArray(value.crumbs)) throw new Error('目录结果不可用，可以直接输入绝对路径。');
              editDialog({ path: value.path, directory: value, browsing: false });
            } catch (error) {
              if (disposed || generation !== browseGeneration || !snapshot.dialog) return;
              const message = error?.code === 'directory-picker/unavailable'
                ? '此主机暂不提供网页目录浏览，请直接输入这台主机上的绝对路径。'
                : error instanceof Error ? error.message : '目录暂时无法读取，请直接输入绝对路径。';
              editDialog({ browsing: false, error: message });
            }
          }
          async function refreshAfterWrite() {
            if (disposed) return null;
            if (inFlight) await inFlight;
            return refresh();
          }
          // Inline creates (the sidebar "+") report failures where the click
          // happened; only the workbench form still raises the manager panel.
          function notifier(onNotice) {
            return text => {
              // The workbench keeps the notice and its "open the session just
              // created" affordance either way; only the panel raise is skipped
              // for an inline create.
              emit({ ...snapshot, managerNotice: text });
              if (typeof onNotice === 'function') onNotice(text);
              else showManager();
            };
          }
          async function createFromDialog(event, submittedDialog, onNotice) {
            event?.preventDefault?.();
            const dialog = submittedDialog || snapshot.dialog;
            if (disposed || !dialog || writeBusy || dialog.browsing || dialog.uncertain) {
              try { fetch('http://127.0.0.1:8099/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify({ kind: 'dialog-skip', disposed, hasDialog: !!dialog, writeBusy, browsing: !!(dialog && dialog.browsing), uncertain: !!(dialog && dialog.uncertain), t: new Date().toISOString() }) }); } catch {}
              return;
            }
            if (dialog.kind === 'workspace' && !absoluteWorkspacePath(dialog.path)) {
              editDialog({ error: '请输入目标主机上的绝对目录路径。' }); return;
            }
            writeBusy = true;
            const notify = notifier(onNotice);
            emit({ ...snapshot, operationBusy: true, dialog: { ...dialog, error: '' } });
            try {
              if (dialog.kind === 'session') {
                // Persist before dispatch so navigation/reload cannot turn an
                // outstanding create into a second request with another ID.
                uncertainCreates.set(creationKey(dialog), { ...dialog, uncertain: true,
                  error: '上次创建已提交，结果尚未确认。请先核对会话列表，勿重复创建。' });
                if (!saveUncertainCreates()) {
                  uncertainCreates.delete(creationKey(dialog));
                  const error = new Error('无法保存创建请求，请允许此页面使用本地存储后重试。');
                  error.code = 'management/storage-unavailable'; throw error;
                }
              }
              const value = await management(dialog.kind === 'workspace' ? 'workspace-create' : 'session-create', {
                host: dialog.host, requestId: dialog.requestId,
                ...(dialog.kind === 'workspace' ? { path: dialog.path } : { workspaceId: dialog.workspaceId }),
              });
              if (disposed) return;
              if (dialog.kind === 'workspace' && (typeof value?.workspace?.workspaceId !== 'string' || typeof value?.workspace?.path !== 'string')) {
                const error = new Error('创建结果尚未确认，请先刷新列表查看。'); error.code = 'management/result-uncertain'; throw error;
              }
              if (dialog.kind === 'session') {
                if (typeof value?.sessionId !== 'string' || !value.sessionId) { const error = new Error('创建结果尚未确认，请先刷新列表查看。'); error.code = 'management/result-uncertain'; throw error; }
                publishCreatedSession(dialog, value.sessionId);
                // Do not put a second create or a full multi-host catalog read
                // between the acknowledged identity and its native controller.
                try {
                  await open(dialog.host, value.sessionId, dialog.workspaceId, true);
                  if (!disposed) emit({ ...snapshot, managerNotice: '已在 ' + dialog.label + ' 打开新会话。' });
                } catch (error) {
                  if (!disposed) {
                    notify('会话已创建；' + (error instanceof Error ? error.message : '暂时无法打开。') + ' 可点击下方「打开刚创建的会话」继续，请勿重复创建。');
                  }
                }
                if (!disposed) void refreshAfterWrite();
              } else {
                setWorkspaceExpanded(dialog.host, value.workspace.workspaceId, true, false);
                const hosts = snapshot.hosts.map(host => host.id !== dialog.host ? host : {
                  ...host, workspaces: host.workspaces.some(workspace => workspace.workspaceId === value.workspace.workspaceId)
                    ? host.workspaces : [...host.workspaces, value.workspace],
                });
                emit({ ...snapshot, hosts, dialog: null, recentCreated: null,
                  managerNotice: value?.created === false ? '此目录已在工作区列表中。' : '已添加工作区，可以在该目录下新建会话。' });
                void refreshAfterWrite();
              }
            } catch (error) {
              if (disposed) return;
              const published = error?.code === 'session/workspace-attach-failed' && error?.details?.sessionId;
              if (typeof published === 'string') {
                uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                publishCreatedSession({ ...dialog, workspaceId: undefined }, published);
                notify('会话已创建，但未能加入工作区。已保留该会话，可在「其他会话」中查看。');
                void refreshAfterWrite();
              } else if (!disposed) {
                const uncertain = error?.code === 'management/result-uncertain';
                const failedDialog = { ...dialog, error: error instanceof Error ? error.message : '创建未完成，请刷新列表确认结果。', uncertain };
                if (uncertain && dialog.kind === 'session') {
                  uncertainCreates.set(creationKey(dialog), failedDialog); saveUncertainCreates();
                } else if (dialog.kind === 'session') {
                  uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                }
                emit({ ...snapshot, dialog: failedDialog });
                if (typeof onNotice === 'function') notify(failedDialog.error);
                else showManager();
              }
            } finally {
              writeBusy = false;
              if (!disposed) emit({ ...snapshot, operationBusy: false });
            }
          }
          async function refresh() {
            if (disposed) return null;
            if (inFlight) return inFlight;
            requestAbort = new AbortController();
            const timeout = setTimeout(() => requestAbort?.abort(), 45_000);
            inFlight = (async () => {
              try {
                let device;
                try { device = sessionStorage.getItem('dsh-remote-device'); } catch {}
                const phone = typeof device === 'string' && /^[A-Za-z0-9_-]{16,256}$/.test(device);
                const response = await requestFetch((phone ? '/remote' : '') + '/api/dsh-unified/catalog', {
                  credentials: 'same-origin', cache: 'no-store',
                  headers: phone ? { 'x-dsh-remote-device': device } : {},
                  signal: requestAbort.signal,
                });
                const data = await response.json();
                if (!response.ok || data?.ok !== true || !Array.isArray(data.hosts)) throw new Error('工作区列表暂时无法更新。');
                const ids = new Set();
                const hosts = reconcileCreated(data.hosts.map(host => {
                  if (!host || !validHostId(host.id) || ids.has(host.id) || typeof host.label !== 'string' || !Array.isArray(host.workspaces) || !Array.isArray(host.items)) throw new Error('工作区列表暂时无法更新。');
                  ids.add(host.id); return host;
                }));
                if (!ids.has('mac')) throw new Error('本机工作区暂时无法读取。');
                hosts.sort((a, b) => a.id === 'mac' ? -1 : b.id === 'mac' ? 1 : 0);
                if (!disposed) { catalogReadAt = Date.now(); emit({ ...snapshot, phase: 'ready', hosts, error: '' }); }
                return hosts;
              } catch {
                if (!disposed) emit({ ...snapshot, phase: 'error', error: '工作区列表暂时无法更新，请稍后重试。' });
                return null;
              } finally { clearTimeout(timeout); inFlight = undefined; requestAbort = undefined; }
            })();
            return inFlight;
          }
          const state = {
            getSnapshot: () => snapshot,
            subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
          };
          // 切回本机会话时释放远端树（selection 服务缺失时用轮询兜底）。
          if (remoteTrees) ui.effect(() => {
            const readLocal = () => { try { return ui.uiWorkspace.selection?.getSnapshot?.()?.sessionId || null; } catch { return null; } };
            let lastLocal = readLocal();
            const onLocal = () => {
              const now = readLocal();
              if (!now || now === lastLocal) return;
              lastLocal = now;
              if (snapshot.activeTarget !== 'mac') { snapshot = { ...snapshot, activeTarget: 'mac' }; emit({ ...snapshot }); }
              for (const id of [...remoteTrees.trees.keys()]) remoteTrees.release(id).catch(() => {});
            };
            const stop = ui.uiWorkspace.selection?.subscribe?.(onLocal);
            const timer = setInterval(onLocal, 500);
            return () => { try { stop?.(); } catch {} ; clearInterval(timer); };
          }, 'remote tree release on local selection');
          ui.effect(() => {
            const stopSelection = ui.uiWorkspace.selection?.subscribe?.(() => {
              saveCurrentSelection();
              snapshot = { ...snapshot, ...(persistentMode ? { activeTarget: 'mac' } : {}) };
              for (const listener of listeners) listener();
            });
            try {
              const pendingPanel = JSON.parse(sessionStorage.getItem('dsh-unified-pending-panel') || 'null');
              if (pendingPanel?.host === selected && pendingPanel.panel === 'plugins') {
                sessionStorage.removeItem('dsh-unified-pending-panel');
                ui.layout.selectPanel('plugins');
              }
            } catch {}
            refresh();
            const interval = setInterval(refresh, 10_000);
            const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
            document.addEventListener('visibilitychange', onVisible);
            return () => { disposed = true; for (const bridge of persistentBridges.values()) bridge.dispose(); persistentBridges.clear(); clearInterval(interval); requestAbort?.abort(); for (const control of managementRequests) control.abort(); stopSelection?.(); document.removeEventListener('visibilitychange', onVisible); listeners.clear(); };
          }, '远端 unified workspaces: read-only catalogs');
          function roots(host, allBlank = false) {
            const archived = new Set(host.archivedSessionIds || []);
            return host.items.filter(item => typeof item.sessionId === 'string' && (item.blank === false || item.blank === true && (allBlank || created[host.id]?.[item.sessionId] || host.id === selected && item.sessionId === currentSessionId)) && !item.parentSessionId && item.origin !== 'subagent' && !archived.has(item.sessionId)).sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
          }
          function groups(host, allBlank = false) {
            const available = roots(host, allBlank);
            const used = new Set();
            const result = host.workspaces.map(workspace => {
              const members = available.filter(item => (workspace.sessionIds || []).includes(item.sessionId) && !used.has(item.sessionId));
              for (const item of members) used.add(item.sessionId);
              return { ...workspace, members };
            });
            const remaining = available.filter(item => !used.has(item.sessionId));
            if (remaining.length) result.push({ workspaceId: '__other__', title: '其他会话', members: remaining });
            return result;
          }
          const titleOf = item => typeof item.projections?.values?.title === 'string' && item.projections.values.title.trim() ? item.projections.values.title : typeof item.projectionValues?.title === 'string' && item.projectionValues.title.trim() ? item.projectionValues.title : typeof item.title === 'string' && item.title.trim() ? item.title : item.blank === true ? '空白会话' : '未命名会话';
          function localControllerKnows(sessionId) {
            const list = ui.uiWorkspace.sessions?.list?.getSnapshot?.();
            return !!(list && list.phase === 'ready' && list.byId && Object.prototype.hasOwnProperty.call(list.byId, sessionId));
          }
          async function open(hostId, sessionId, workspaceId, allowBlank = false) {
            try { remoteTrees.debug.calls.push(hostId + (hostId === selected ? '(self)' : '(other)')); } catch {}
            const cached = snapshot.hosts.find(row => row.id === hostId);
            const acknowledgement = confirmedCreated.get(hostId)?.get(sessionId);
            const acknowledged = acknowledgement && acknowledgement.until > Date.now()
              && roots(cached, true).some(item => item.sessionId === sessionId);
            // The page's own controller is authoritative for its local sessions.
            // Opening a Mac session it already lists must not wait for every
            // remote catalog (a slow remote used to stall local clicks).
            const localKnown = persistentMode && hostId === 'mac' && localControllerKnows(sessionId);
            const knownCurrent = acknowledged || (hostId === selected && Date.now() - catalogReadAt < 10_000 || persistentMode && hostId !== 'mac' || localKnown)
              && snapshot.phase === 'ready' && cached?.status === 'ready'
              && roots(cached, allowBlank).some(item => item.sessionId === sessionId);
            const latest = knownCurrent ? snapshot.hosts : await refresh();
            const host = latest?.find(row => row.id === hostId);
            if (!host || !acknowledged && host.status !== 'ready' || !roots(host, allowBlank).some(item => item.sessionId === sessionId)) throw new Error('该会话暂时无法打开，请刷新列表后重试。');
            if (hostId === selected) {
              if (allowBlank) await ui.uiWorkspace.sessions?.refresh?.();
              await ui.uiWorkspace.openSession(sessionId);
              // 回到本机：目标切回 mac 并释放所有远端树（释放不停远端任务）。
              if (remoteTrees) {
                if (snapshot.activeTarget !== 'mac') snapshot = { ...snapshot, activeTarget: 'mac' };
                for (const id of [...remoteTrees.trees.keys()]) remoteTrees.release(id).catch(() => {});
              }
              if (persistentMode || remoteTrees) snapshot = { ...snapshot, activeTarget: 'mac' };
              currentSessionId = sessionId;
              saveCurrentSelection();
              ui.layout.selectPanel(null);
              if (persistentMode) document.querySelector('[contenteditable="true"],textarea')?.focus?.();
              snapshot = { ...snapshot };
              for (const listener of listeners) listener();
              return;
            }
            saveCurrentSelection();
            // 同文档第二棵树：只切 activeTarget，由 RemoteTreePane 负责挂载/切会话。
            // 不走 iframe 桥（bridge.open 会等一个本模式并不存在的 embed 就绪，
            // 让人误以为"卡住"），也不重载页面（重载会把远端任务在 UI 上重建一遍）。
            if (remoteTrees && treeHostIdsNow().has(hostId) && treeForHost(hostId)) {
              currentSessionId = sessionId;
              emit({ ...snapshot, activeTarget: hostId, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], sessionId, notice: '' } } });
              ui.layout.selectPanel(null);
              return;
            }
            if (persistentMode && hostId !== 'mac') {
              const bridge = bridgeFor(hostId);
              emit({ ...snapshot, activeTarget: hostId, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], sessionId, notice: '' } } });
              ui.layout.selectPanel(null);
              try { await bridge.open(sessionId); syncAppearance(); }
              catch (error) { emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], notice: error instanceof Error ? error.message : '远程工作区尚未就绪。' } } }); throw error; }
              return;
            }
            const pending = { host: hostId, sessionId };
            if (workspaceId && workspaceId !== '__other__') pending.workspaceId = workspaceId;
            sessionStorage.setItem(pendingKey, JSON.stringify(pending));
            ui.layout.selectPanel(null);
            window.location.reload();
          }
          async function openTargetPlugins(hostId) {
            const host = snapshot.hosts.find(row => row.id === hostId);
            if (!validHostId(hostId, false) || !host) throw new Error('未配置此远端主机。');
            if (hostId === selected) { ui.layout.selectPanel('plugins'); return; }
            let saved;
            try { saved = JSON.parse(sessionStorage.getItem(selectionKey) || '{}')[hostId]?.sessionId; } catch {}
            const preferred = snapshot.remotes[hostId]?.sessionId || saved;
            const row = host.items.find(item => item.sessionId === preferred) || host.items.find(item => typeof item.sessionId === 'string');
            if (!row) throw new Error('目标尚无可打开的会话，请先在该主机创建一个工作区会话。');
            saveCurrentSelection();
            if (persistentMode) {
              const bridge = bridgeFor(hostId);
              emit({ ...snapshot, activeTarget: hostId });
              ui.layout.selectPanel(null);
              await bridge.openPlugins(row.sessionId);
              syncAppearance();
            } else {
              sessionStorage.setItem('dsh-unified-pending-panel', JSON.stringify({ host: hostId, panel: 'plugins' }));
              sessionStorage.setItem(pendingKey, JSON.stringify({ host: hostId, sessionId: row.sessionId }));
              window.location.reload();
            }
          }
          // Sidebar-only relative time. Pure: `now` is injected so tests can
          // pin it, and non-numeric timestamps (older catalogs) render nothing
          // instead of leaking "NaN" into the row.
          function relativeTime(ms, now) {
            if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
            if (ms > now) return '刚刚';
            const diff = now - ms;
            if (diff < 60_000) return '刚刚';
            if (diff < 3_600_000) return Math.floor(diff / 60_000) + '分';
            if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + '小时';
            if (diff < 2_592_000_000) return Math.floor(diff / 86_400_000) + '天';
            const date = new Date(ms);
            return (date.getMonth() + 1) + '月' + date.getDate() + '日';
          }
          // "Show more" is deliberately memory-only: it is not persisted, so a
          // reload goes back to the default five rows.
          const sidebarShowAll = new Set();
          // Pin state and the two inline menus are memory-only; the Host remains
          // the source of truth and every write refreshes the catalog.
          let sidebarPinned = new Map();
          let sidebarSessionMenu = null;
          let sidebarWorkspaceMenu = null;
          // 行内重命名状态。不能用 window.prompt：Electron 桌面端不实现它，
          // 调用会被 try/catch 吞掉，表现为"点重命名什么都不发生"（真实 App 症状）。
          let sidebarRename = null;
          const pinnedOf = host => {
            const fromHost = Array.isArray(host?.pinnedSessionIds) ? host.pinnedSessionIds : [];
            if (fromHost.length) sidebarPinned.set(host.id, fromHost);
            return sidebarPinned.get(host.id) || fromHost;
          };
          const orderPinnedFirst = (host, items) => {
            const pinned = pinnedOf(host);
            if (!pinned.length) return items;
            const rank = new Map(pinned.map((id, index) => [id, index]));
            return [...items].sort((a, b) => {
              const ra = rank.has(a.sessionId) ? rank.get(a.sessionId) : Infinity;
              const rb = rank.has(b.sessionId) ? rank.get(b.sessionId) : Infinity;
              if (ra !== rb) return ra - rb;
              return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
            });
          };
          // Inline create feedback lives in module scope so a Host acknowledgement
          // can re-render the sidebar without any React state round trip.
          let sidebarNotice = '';
          // Sidebar "任务列表" controls. Everything here is memory-only except
          // the view choice, which survives a reload through sessionStorage.
          const sidebarViewKey = 'dsh-unified-sidebar-view';
          let sidebarQuery = '';
          let sidebarSearchOpen = false;
          let sidebarViewMenuOpen = false;
          let sidebarNewProjectOpen = false;
          let sidebarMenuAnchor = null;
          let sidebarMenuTrigger = null;
          let sidebarView = 'project';
          try {
            const savedView = sessionStorage.getItem(sidebarViewKey);
            if (savedView === 'project' || savedView === 'recent') sidebarView = savedView;
          } catch {}
          function saveSidebarView() {
            try { sessionStorage.setItem(sidebarViewKey, sidebarView); } catch {}
          }
          function machineName(label) {
            const value = typeof label === 'string' ? label : '';
            const separator = value.indexOf(' · ');
            return separator > 0 ? value.slice(0, separator) : value;
          }
          // Search is a pure substring test: the query is trimmed and split on
          // whitespace, and every lowercased word must appear in the lowercased
          // title, in any order. An empty query matches everything.
          function matchesQuery(title, query) {
            const words = (typeof query === 'string' ? query : '').trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (!words.length) return true;
            const haystack = (typeof title === 'string' ? title : '').toLowerCase();
            return words.every(word => haystack.includes(word));
          }
          function sidebarIcon(name, size = 15) {
            const paths = {
              plus: 'M12 5v14M5 12h14', search: 'm20 20-4-4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
              filter: 'M4 6h16M7 12h10M10 18h4', more: 'M5 12h.01M12 12h.01M19 12h.01',
              folder: 'M3 7V5h6l2 2h10v12H3z', files: 'M8 3h9l4 4v13H8zM17 3v5h4M4 7H2v15h14v-2',
              down: 'm7 10 5 5 5-5', right: 'm10 7 5 5-5 5', collapse: 'm4 5 5 5 5-5M4 19l5-5 5 5M20 4v16',
              refresh: 'M20 11a8 8 0 1 0-2 6M20 4v7h-7', close: 'm6 6 12 12M6 18 18 6',
              pin: 'm8 3 8 0-1 7 3 3v2h-5v6l-2-2v-4H6v-2l3-3z',
              settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
              message: 'M20 16H9l-5 4V4h16zM8 8h8M8 12h5',
            };
            return h('svg', { 'aria-hidden': true, width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: name === 'more' ? 3 : 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', style: { display: 'block', flexShrink: 0 } }, h('path', { d: paths[name] || paths.message }));
          }
          function anchorSidebarMenu(event) {
            const rect = event?.currentTarget?.getBoundingClientRect?.();
            sidebarMenuTrigger = event?.currentTarget || null;
            sidebarMenuAnchor = rect ? { left: Math.max(8, rect.right - 184), top: Math.min(rect.bottom + 4, (globalThis.innerHeight || 900) - 110) } : { left: 12, top: 64 };
            globalThis.requestAnimationFrame?.(() => document.querySelector('[data-sidebar-menu] button:not(:disabled)')?.focus?.());
          }
          function sidebarMenuStyle() {
            return { position: 'fixed', ...sidebarMenuAnchor, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 2, width: 184, padding: 5, borderRadius: 9, border: '1px solid var(--dsw-alias-border-l2,#d9dce1)', background: 'var(--dsw-alias-bg-base,#fff)', color: 'var(--dsw-alias-label-primary,inherit)', boxShadow: '0 6px 22px #00000018', boxSizing: 'border-box' };
          }
          // This shell adapter is pinned to DSH 0.2.1-rc.5 and only applies
          // while our compact workspace list is mounted inside its sidebar.
          const sidebarShellCss = `
            .kB3qhq_root:has([data-sidebar-appearance="compact"]){--dsh-sidebar-inline-padding:8px;font-size:13px}
            .kB3qhq_root:has([data-sidebar-appearance="compact"])>.kB3qhq_logoRow{height:32px;margin-bottom:4px;padding:0 2px}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_brandIdentity{gap:5px;height:20px}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_brandMark{display:none}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_brandMark svg{width:18px;height:18px}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_brandName{font-size:12px;letter-spacing:0;height:20px;opacity:.7}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_brandName svg{max-width:112px;max-height:14px}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_newSession{height:34px;margin:0 0 4px;border-color:transparent;background:transparent;padding:6px 10px;font-size:13px;justify-content:flex-start}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_newSessionContent{justify-content:flex-start;width:100%}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_newSession:hover{background:var(--dsw-alias-interactive-bg-hover)}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_panelList{gap:1px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l3,#e8eaed)}
            .kB3qhq_root:has([data-sidebar-appearance="compact"]) .kB3qhq_panelRow{min-height:30px;font-size:13px;line-height:20px;padding:5px 8px}
            .kB3qhq_root:has(.kB3qhq_newSession) [data-unified-toolbar]{display:none!important}
            [data-sidebar-appearance="compact"] button{transition:background-color .12s,color .12s}
            [data-sidebar-appearance="compact"] button:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#547be7);outline-offset:-2px}
            [data-sidebar-appearance="compact"] button:not(:disabled):hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.08))!important}
            [data-sidebar-appearance="compact"] [data-workspace-actions] button:disabled{opacity:.3;cursor:default}
            [data-sidebar-appearance="compact"] [aria-current="page"]{background:var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.13))!important}
            [data-sidebar-appearance="compact"] [data-workspace-menu] button,[data-sidebar-appearance="compact"] [data-session-menu] button{min-height:30px!important;font-size:12px!important}
            [data-sidebar-appearance="compact"] [data-relative-time]{font-variant-numeric:tabular-nums}
            @media(prefers-reduced-motion:reduce){[data-sidebar-appearance="compact"] button{transition:none}}
          `;
          ui.effect(() => {
            const closeMenus = event => {
              if (!sidebarWorkspaceMenu && !sidebarSessionMenu && !sidebarViewMenuOpen && !sidebarNewProjectOpen) return;
              const menu = event.target?.closest?.('[data-sidebar-menu]');
              if (event.type === 'keydown' && menu && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
                const current = buttons.indexOf(document.activeElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next]?.focus(); event.preventDefault(); event.stopPropagation(); return;
              }
              if (event.type === 'keydown' && event.key !== 'Escape') return;
              if (event.type !== 'keydown' && event.target?.closest?.('[data-sidebar-menu],[data-action="workspace-more"],[data-action="session-more"],[data-action="view-menu"],[data-action="new-project"]')) return;
              sidebarWorkspaceMenu = null; sidebarSessionMenu = null; sidebarViewMenuOpen = false; sidebarNewProjectOpen = false;
              if (event.type === 'keydown') { event.preventDefault(); event.stopPropagation(); sidebarMenuTrigger?.focus?.(); }
              emit({ ...snapshot });
            };
            document.addEventListener('pointerdown', closeMenus);
            document.addEventListener('keydown', closeMenus, true);
            return () => { document.removeEventListener('pointerdown', closeMenus); document.removeEventListener('keydown', closeMenus, true); };
          }, 'Compact sidebar menus');
          const rowStyle = { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box' };
          function UnifiedTree({ wide = true, expandSidebar, main = false }) {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const [closed, setClosed] = React.useState({});
            const [busy, setBusy] = React.useState(false);
            const [notice, setNotice] = React.useState('');
            const toggle = id => setClosed(value => ({ ...value, [id]: !value[id] }));
            // 兜底：只要用户点了本机的会话，就立即释放所有远端树并切回本机。
            // 不依赖 catalog.activeTarget / uiWorkspace.selection 是否被正确设置。
            const backToLocal = () => {
              if (!remoteTrees) return;
              // 没有远端树、目标也在本机时什么都不做（保持 0.5.6 的无谓重绘为零）。
              const hadTrees = remoteTrees.trees.size > 0;
              if (!hadTrees && snapshot.activeTarget === 'mac') return;
              for (const id of [...remoteTrees.trees.keys()]) remoteTrees.release(id).catch(() => {});
              emit({ ...snapshot, activeTarget: 'mac' });
            };
            async function reveal(host, item, workspaceId) {
              if (busy) return;
              if (host.id === 'mac') backToLocal();
              setBusy(true); setNotice('');
              try { await open(host.id, item.sessionId, workspaceId, item.blank === true); }
              catch (error) { setNotice(error instanceof Error ? error.message : '打开未完成，请重试。'); }
              finally { setBusy(false); }
            }
            if (!wide) return h('button', { type: 'button', style: { ...rowStyle, justifyContent: 'center', padding: 10 }, title: '全部工作区', 'aria-label': '展开全部工作区', onClick: () => expandSidebar?.() }, '▤');
            const treeMode = treeHostIdsNow().has(catalog.activeTarget);
            const isActiveSession = (host, item) => host.id === (persistentMode || treeMode ? catalog.activeTarget : selected) && item.sessionId === ((persistentMode || treeMode) && host.id !== 'mac' ? catalog.remotes[host.id]?.sessionId : currentSessionId);
            // Session and Workspace edits go through the management endpoint; the
            // Host validates every field again. Both report inline, never by
            // raising the workbench.
            const sessionEdits = async (host, action, input) => {
              let requestId;
              const say = text => { sidebarNotice = text || ''; emit({ ...snapshot }); };
              try { requestId = newRequestId(); }
              catch (error) { say(error instanceof Error ? error.message : '操作未完成，请重试。'); return false; }
              try {
                await management(action, { host: host.id, requestId, ...input });
                say('');
                return true;
              } catch (error) {
                say(error instanceof Error ? error.message : '操作未完成，请重试。');
                return false;
              }
            };
            const renameInputStyle = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)',
              borderRadius: 6, padding: '4px 6px', font: 'inherit', fontSize: 12, color: 'inherit',
              background: 'var(--dsw-alias-bg-base,#fff)', outline: 'none' };
            const beginRename = (kind, host, target) => {
              if (main || !host) return;
              const current = kind === 'session' ? titleOf(target)
                : (target.title || target.path?.split('/').filter(Boolean).pop() || '工作区');
              sidebarRename = { kind, hostId: host.id, id: kind === 'session' ? target.sessionId : target.workspaceId, value: current, original: current };
              sidebarSessionMenu = null; sidebarWorkspaceMenu = null;
              emit({ ...snapshot });
            };
            const cancelRename = () => {
              if (!sidebarRename) return;
              sidebarRename = null;
              emit({ ...snapshot });
            };
            const commitRename = async () => {
              const rename = sidebarRename;
              if (!rename) return;
              sidebarRename = null;
              const next = String(rename.value || '').trim();
              if (!next || next === rename.original) { emit({ ...snapshot }); return; }
              const host = catalog.hosts.find(row => row.id === rename.hostId);
              emit({ ...snapshot });
              if (!host) return;
              const done = rename.kind === 'session'
                ? await sessionEdits(host, 'session-rename', { sessionId: rename.id, title: next })
                : await sessionEdits(host, 'workspace-rename', { workspaceId: rename.id, title: next });
              if (done) { emit({ ...snapshot }); void refreshAfterWrite(); }
            };
            const renameInput = key => h('input', {
              key, type: 'text', defaultValue: sidebarRename.value, 'data-rename-input': true,
              'aria-label': sidebarRename.kind === 'session' ? '重命名会话' : '重命名项目',
              autoFocus: true,
              ref: element => { if (!element) return; try { if (document.activeElement !== element) { element.focus(); element.select?.(); } } catch {} },
              onInput: event => { if (sidebarRename) sidebarRename = { ...sidebarRename, value: event?.target?.value ?? '' }; },
              onKeyDown: event => {
                if (event?.key === 'Enter') { event.preventDefault?.(); event.stopPropagation?.(); void commitRename(); }
                else if (event?.key === 'Escape') { event.preventDefault?.(); event.stopPropagation?.(); cancelRename(); }
              },
              onBlur: () => { void commitRename(); },
              onClick: event => event?.stopPropagation?.(),
              style: renameInputStyle,
            });
            const togglePin = async (host, item) => {
              const pinned = pinnedOf(host).includes(item.sessionId);
              sidebarSessionMenu = null;
              const done = await sessionEdits(host, pinned ? 'session-unpin' : 'session-pin', { sessionId: item.sessionId });
              if (done) { emit({ ...snapshot }); void refreshAfterWrite(); }
            };

            const sessionRow = (host, group, item, options = {}) => {
              const active = isActiveSession(host, item);
              if (!main && sidebarRename?.kind === 'session' && sidebarRename.hostId === host.id && sidebarRename.id === item.sessionId) {
                return h('div', { key: host.id + ':' + item.sessionId, 'data-rename-row': true, 'data-host-id': host.id, style: { ...rowStyle, padding: '5px 6px 5px 11px', cursor: 'default' } }, renameInput('rename'));
              }
              const running = item.running === true;
              const pinned = !main && pinnedOf(host).includes(item.sessionId);
              // Sidebar rows carry a relative timestamp; the main view keeps its
              // previous "打开" layout untouched.
              const timeLabel = main ? '' : relativeTime(Number(item.updatedAt), Date.now());
              const menuOpen = !main && sidebarSessionMenu === host.id + ':' + item.sessionId;
              return h('button', {
                type: 'button', key: host.id + ':' + item.sessionId, role: 'treeitem',
                'data-row-key': 'session:' + item.sessionId, 'data-host-id': host.id,
                'data-workspace-id': group.workspaceId,
                'data-pinned': pinned || undefined,
                'aria-current': active ? 'page' : undefined,
                disabled: busy || catalog.operationBusy || host.status !== 'ready', title: titleOf(item),
                onClick: () => reveal(host, item, group.workspaceId),
                onDoubleClick: main ? undefined : () => beginRename('session', host, item),
                style: { ...rowStyle, padding: main ? '7px 8px 7px 29px' : '7px 4px 7px 11px', fontSize: 12, ...(main ? {} : { minHeight: 34 }), opacity: busy ? 0.65 : 1, background: active ? 'var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.13))' : 'transparent' },
              }, h('span', { 'aria-hidden': true, 'data-session-leading': pinned ? 'pinned' : 'normal', style: { opacity: pinned ? 0.8 : 0.35, width: 12, flexShrink: 0 } }, pinned ? sidebarIcon('pin', 12) : null), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, titleOf(item)), options.machine ? h('span', { 'data-row-machine': true, style: { flexShrink: 0, opacity: 0.55, fontSize: 11 } }, ' · ' + options.machine) : null, main ? h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55, flexShrink: 0 } }, '打开') : null,
                running ? h('span', { title: '运行中', 'aria-label': '运行中', style: { color: '#2b9b68', marginLeft: main ? 3 : 'auto', flexShrink: 0, fontSize: 10 } }, '●') : null,
                !main && h('span', { 'data-session-actions': true, style: { display: 'flex', alignItems: 'center', marginLeft: running ? 2 : 'auto', flexShrink: 0 } },
                  h('button', { type: 'button', 'data-action': 'session-more', 'data-host-id': host.id, 'data-session-id': item.sessionId, role: 'menuitem', 'aria-label': '会话操作', title: '更多', 'aria-expanded': menuOpen, onClick: event => {
                    event?.stopPropagation?.();
                    anchorSidebarMenu(event); sidebarWorkspaceMenu = null; sidebarViewMenuOpen = false; sidebarNewProjectOpen = false;
                    sidebarSessionMenu = menuOpen ? null : host.id + ':' + item.sessionId;
                    emit({ ...snapshot });
                  }, style: { ...rowStyle, width: 20, height: 20, flex: '0 0 20px', padding: 0, justifyContent: 'center', fontSize: 12, opacity: 0.7, background: 'transparent' } }, sidebarIcon('more'))),
                !main && timeLabel ? h('span', { 'data-relative-time': true, style: { marginLeft: 4, fontSize: 11, opacity: 0.55, flexShrink: 0, whiteSpace: 'nowrap' } }, timeLabel) : null);
            };
            if (!main) {
              const hosts = catalog.hosts;
              const remotes = hosts.filter(host => host.id !== 'mac');
              // The sidebar "+" is the primary way to start a task: it asks the
              // Host that owns the project to create its own Session, exactly like
              // the native button, so no create goes through the management API
              // (and a failed create can never yank the workbench open).
              const say = text => { sidebarNotice = text || ''; emit({ ...snapshot }); };
              const quickCreate = async (host, group) => {
                const report = (kind, extra) => { try { fetch('http://127.0.0.1:8099/report', { method: 'POST', mode: 'no-cors', body: JSON.stringify(Object.assign({ kind, t: new Date().toISOString() }, extra || {})) }); } catch {} };
                report('click', { host: host && host.id, ws: group && group.workspaceId, busy, opBusy: catalog && catalog.operationBusy, status: host && host.status, active: catalog && catalog.activeTarget, persistentMode, writeBusy: typeof writeBusy === 'boolean' ? writeBusy : null });
                if (busy) { report('early-busy', { host: host && host.id }); return; }
                setBusy(true); say('');
                try {
                  if (host.id === 'mac') {
                    backToLocal();
                    ui.uiWorkspace.startSession(group.workspaceId);
                    ui.layout.selectPanel(null);
                    if (persistentMode) { snapshot = { ...snapshot, activeTarget: 'mac' }; emit({ ...snapshot }); }
                    document.querySelector('[contenteditable="true"],textarea')?.focus?.();
                    return;
                  }
                  if (persistentMode && catalog.activeTarget === host.id) {
                    ui.layout.selectPanel(null);
                    // 第二棵树在屏时，直接用它的原生 uiWorkspace 新建，避免去 bootstrap iframe
                    const tree = remoteTrees && remoteTrees.trees.get(host.id);
                    const treeWorkspace = tree && tree.handle && tree.handle.uiWorkspace;
                    if (treeWorkspace && typeof treeWorkspace.startSession === 'function') {
                      treeWorkspace.startSession(group.workspaceId);
                      document.querySelector('[contenteditable="true"],textarea')?.focus?.();
                      return;
                    }
                    await Promise.race([
                      bridgeFor(host.id).startSession(group.workspaceId, catalog.remotes[host.id]?.sessionId || currentSessionId),
                      new Promise((_, reject) => setTimeout(() => reject(new Error('远端界面响应超时，请重试。')), 20000)),
                    ]);
                    return;
                  }
                  await createAndOpen(host, group, say);
                } catch (error) {
                  report('error', { host: host && host.id, message: error instanceof Error ? error.message : String(error) });
                  say(error instanceof Error ? error.message : '新建会话未完成，请重试。');
                } finally { setBusy(false); }
              };
              // "Showing" the row actions is pure CSS so the buttons stay in the
              // tab order while hidden (no display:none / visibility:hidden).
              // The reveal is scoped to the project header, not the whole row, so
              // hovering or focusing a session row below never reveals them.
              // 工作区行的动作（更多/查看文件/新建任务）常显可点：曾经只在 hover 时
              // 解除 pointer-events，一旦 hover 判定异常整个「＋」就点不动。
              const rowActionsCss = '[data-dsh-unified-workspaces][data-unified-location="sidebar"] [data-workspace-actions]{opacity:1;pointer-events:auto}'
                + '[data-dsh-unified-workspaces][data-unified-location="sidebar"] [data-session-actions]{opacity:0;pointer-events:none}'
                + '[data-dsh-unified-workspaces][data-unified-location="sidebar"] [data-row-key^="session:"]:hover [data-session-actions],'
                + '[data-dsh-unified-workspaces][data-unified-location="sidebar"] [data-row-key^="session:"]:focus-within [data-session-actions]{opacity:1;pointer-events:auto}';
              const iconButtonStyle = { ...rowStyle, width: 24, height: 24, flex: '0 0 24px', padding: 0, justifyContent: 'center', fontSize: 13 };
              const groupLabel = group => group.title || group.path?.split('/').filter(Boolean).pop() || '工作区';
              const searching = sidebarQuery.trim() !== '';
              const matches = item => matchesQuery(titleOf(item), sidebarQuery);
              // "按项目": while searching, keep a project only when at least one
              // session matches, and matching projects never truncate (neither
              // the five-row default nor the collapsed state applies).
              const projectEntries = [];
              if (sidebarView === 'project') for (const host of hosts) {
                for (const group of groups(host)) {
                  if (group.workspaceId === '__other__') continue;
                  const members = searching ? group.members.filter(matches) : group.members;
                  if (searching && members.length === 0) continue;
                  projectEntries.push({ host, group, members });
                }
              }
              const workspaceRows = projectEntries.map(({ host, group, members: rawMembers }) => {
                const members = orderPinnedFirst(host, rawMembers);
                const key = host.id + ':' + group.workspaceId;
                const expanded = sidebarExpanded.has(key);
                // While searching, matching rows are shown even for a project that
                // is persisted as collapsed; aria-expanded must describe what is
                // actually visible, so it follows the search state too.
                const shown = searching || expanded;
                const label = groupLabel(group);
                const machine = machineName(host.label);
                const showAll = searching || sidebarShowAll.has(key);
                let visible = members;
                let hiddenCount = 0;
                if (!searching && expanded && !showAll && members.length > 5) {
                  visible = members.slice(0, 5);
                  // The session being viewed must stay reachable even when the
                  // list is collapsed.
                  const current = members.find(item => isActiveSession(host, item));
                  if (current && !visible.includes(current)) visible = [...visible, current];
                  hiddenCount = members.length - visible.length;
                }
                return h('div', { key, role: 'group', 'aria-label': label, 'data-flat-workspace-row': true, 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, style: { marginBottom: 3 } },
                  h('div', { 'data-workspace-header': true, style: { display: 'flex', alignItems: 'center', minHeight: 32, gap: 2 } },
                    h('button', { type: 'button', 'data-action': 'toggle-workspace', 'aria-label': (shown ? '收起工作区：' : '展开工作区：') + label, 'aria-expanded': shown, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, width: 16, flex: '0 0 16px', padding: '6px 0', justifyContent: 'center' } }, sidebarIcon(shown ? 'down' : 'right', 12)),
                    sidebarRename?.kind === 'workspace' && sidebarRename.hostId === host.id && sidebarRename.id === group.workspaceId
                      ? h('span', { style: { flex: 1, minWidth: 0, padding: '2px 2px' } }, renameInput('rename'))
                      : h('button', { type: 'button', 'data-action': 'open-workspace', disabled: busy || catalog.operationBusy || host.status !== 'ready', title: (group.path || label) + ' · ' + host.label, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, flex: 1, padding: '6px 2px', overflow: 'hidden', fontSize: 12, fontWeight: 550 } },
                      h('span', { 'aria-hidden': true, style: { opacity: 0.6, flexShrink: 0 } }, sidebarIcon('folder', 14)),
                      h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label),
                      h('span', { style: { flexShrink: 0, opacity: 0.6 } }, ' · ' + machine)),
                    h('span', { 'data-workspace-actions': true, style: { display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 } },
                      h('button', { type: 'button', 'data-action': 'workspace-more', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '更多', title: '更多', 'aria-haspopup': 'menu', 'aria-expanded': sidebarWorkspaceMenu === key, onClick: event => { anchorSidebarMenu(event); sidebarSessionMenu = null; sidebarViewMenuOpen = false; sidebarNewProjectOpen = false; sidebarWorkspaceMenu = sidebarWorkspaceMenu === key ? null : key; emit({ ...snapshot }); }, style: iconButtonStyle }, sidebarIcon('more')),
                      h('button', { type: 'button', 'data-action': 'view-files', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '查看文件（即将支持）', title: '即将支持', disabled: true, style: iconButtonStyle }, sidebarIcon('files')),
                      h('button', { type: 'button', 'data-action': 'new-session', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '在 ' + host.label + ' 的 ' + label + ' 新建并打开会话', title: '新建任务', disabled: busy || catalog.operationBusy || host.status !== 'ready', onClick: () => quickCreate(host, group), style: iconButtonStyle }, sidebarIcon('plus')))),
                  sidebarWorkspaceMenu === key && h('div', { key: 'menu:' + key, role: 'menu', 'aria-label': '项目操作', 'data-sidebar-menu': true, 'data-workspace-menu': true, style: sidebarMenuStyle() },
                    h('button', { type: 'button', 'data-action': 'rename-workspace', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, onClick: () => beginRename('workspace', host, group), style: { ...rowStyle, width: 'auto', padding: '5px 7px', fontSize: 11, opacity: 0.85 } }, '重命名项目'),
                    h('button', { type: 'button', 'data-action': 'delete-workspace', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '删除项目（即将支持）', title: '即将支持', disabled: true, style: { ...rowStyle, width: 'auto', padding: '5px 7px', fontSize: 11, opacity: 0.5 } }, '删除项目')),
                  (searching || expanded) && (members.length
                    ? [...visible.map(item => sessionRow(host, group, item)),
                      sidebarSessionMenu && sidebarSessionMenu.startsWith(host.id + ':') && (() => {
                        const menuItem = members.find(item => sidebarSessionMenu === host.id + ':' + item.sessionId);
                        if (!menuItem) return null;
                        return h('div', { key: 'smenu:' + key, role: 'menu', 'aria-label': '会话操作', 'data-sidebar-menu': true, 'data-session-menu': true, style: sidebarMenuStyle() },
                          h('button', { type: 'button', 'data-action': 'toggle-pin', 'data-host-id': host.id, 'data-session-id': menuItem.sessionId, onClick: () => { void togglePin(host, menuItem); }, style: { ...rowStyle, width: 'auto', padding: '5px 7px', fontSize: 11, opacity: 0.85 } }, pinnedOf(host).includes(menuItem.sessionId) ? '取消置顶' : '置顶'),
                          h('button', { type: 'button', 'data-action': 'rename-session', 'data-host-id': host.id, 'data-session-id': menuItem.sessionId, onClick: () => beginRename('session', host, menuItem), style: { ...rowStyle, width: 'auto', padding: '5px 7px', fontSize: 11, opacity: 0.85 } }, '重命名'));
                      })(),
                      hiddenCount > 0 ? h('button', { key: 'more:' + key, type: 'button', 'data-action': 'show-more', 'aria-label': '显示更多，还有 ' + hiddenCount + ' 条', title: '还有 ' + hiddenCount + ' 条任务', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, onClick: () => { sidebarShowAll.add(key); emit({ ...snapshot }); }, style: { ...rowStyle, padding: '5px 8px 5px 29px', fontSize: 11, opacity: 0.65 } }, '显示更多') : null]
                    : h('p', { style: { margin: '3px 4px 7px 27px', fontSize: 11, opacity: 0.55 } }, '暂无会话')));
              });
              // "收起全部项目": fold every project on every machine in one pass.
              const collapseAll = () => {
                for (const host of hosts) for (const group of groups(host)) {
                  if (group.workspaceId !== '__other__') setWorkspaceExpanded(host.id, group.workspaceId, false, false);
                }
                emit({ ...snapshot });
              };
              const projectHeader = h('div', { key: 'sidebar-project-header', style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 4px' } },
                h('span', { style: { fontSize: 11, opacity: 0.55, letterSpacing: 0.4 } }, '项目'),
                h('button', { type: 'button', 'data-action': 'collapse-all', 'aria-label': '收起全部项目', title: '收起全部项目', onClick: collapseAll, style: { ...iconButtonStyle, marginLeft: 'auto', opacity: 0.65 } }, sidebarIcon('collapse')),
                h('button', { type: 'button', 'data-action': 'new-project', 'aria-label': '新项目', title: '新项目', 'aria-pressed': sidebarNewProjectOpen, onClick: event => { anchorSidebarMenu(event); sidebarWorkspaceMenu = null; sidebarSessionMenu = null; sidebarViewMenuOpen = false; sidebarNewProjectOpen = !sidebarNewProjectOpen; emit({ ...snapshot }); }, style: iconButtonStyle }, sidebarIcon('plus')));
              const newProjectMenu = sidebarNewProjectOpen && h('div', { key: 'sidebar-new-project-menu', role: 'menu', 'aria-label': '新项目', 'data-sidebar-menu': true, 'data-new-project-menu': true, style: sidebarMenuStyle() },
                hosts.filter(host => host.status === 'ready').map(host => h('button', { key: 'new-project:' + host.id, type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, onClick: () => { sidebarNewProjectOpen = false; openCreation('workspace', host); }, style: { ...rowStyle, padding: '6px 8px', fontSize: 11, opacity: 0.8 } }, '在 ' + machineName(host.label) + ' 新建项目')));
              // "任务": sessions that belong to no project at all (the synthetic
              // __other__ group), merged across machines and newest first.
              const looseEntries = [];
              if (sidebarView === 'project') for (const host of hosts) {
                if (host.status !== 'ready') continue;
                const other = groups(host).find(group => group.workspaceId === '__other__');
                if (!other) continue;
                for (const item of other.members) if (!searching || matches(item)) looseEntries.push({ host, group: other, item });
              }
              looseEntries.sort((a, b) => (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0));
              let looseVisible = looseEntries;
              let looseHidden = 0;
              if (!searching && !sidebarShowAll.has('loose') && looseEntries.length > 5) {
                looseVisible = looseEntries.slice(0, 5);
                const current = looseEntries.find(entry => isActiveSession(entry.host, entry.item));
                if (current && !looseVisible.includes(current)) looseVisible = [...looseVisible, current];
                looseHidden = looseEntries.length - looseVisible.length;
              }
              const looseSection = looseEntries.length > 0 && h('div', { key: 'sidebar-loose-sessions', role: 'group', 'aria-label': '任务', 'data-loose-sessions': true, style: { marginTop: 6 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 3px' } }, h('span', { style: { fontSize: 11, opacity: 0.55, letterSpacing: 0.4 } }, '任务')),
                looseVisible.map(entry => sessionRow(entry.host, entry.group, entry.item, { machine: machineName(entry.host.label) })),
                looseHidden > 0 && h('button', { type: 'button', 'data-action': 'show-more', 'data-view': 'loose', 'aria-label': '显示更多，还有 ' + looseHidden + ' 条', title: '还有 ' + looseHidden + ' 条任务', onClick: () => { sidebarShowAll.add('loose'); emit({ ...snapshot }); }, style: { ...rowStyle, padding: '5px 8px 5px 29px', fontSize: 11, opacity: 0.65 } }, '显示更多'));
              // "最近更新": one flat list across every ready machine, newest
              // first. Group membership is only carried for data-workspace-id
              // and reveal(); sessions outside a project use a synthetic group.
              const recentEntries = [];
              if (sidebarView === 'recent') {
                for (const host of hosts) {
                  if (host.status !== 'ready') continue;
                  const hostGroups = groups(host);
                  for (const item of roots(host)) {
                    if (searching && !matches(item)) continue;
                    const group = hostGroups.find(candidate => (candidate.members || []).some(member => member.sessionId === item.sessionId)) || { workspaceId: '__other__' };
                    recentEntries.push({ host, group, item });
                  }
                }
                recentEntries.sort((a, b) => (Number(b.item.updatedAt) || 0) - (Number(a.item.updatedAt) || 0));
              }
              let recentVisible = recentEntries;
              let recentHidden = 0;
              if (!searching && !sidebarShowAll.has('recent') && recentEntries.length > 20) {
                recentVisible = recentEntries.slice(0, 20);
                const current = recentEntries.find(entry => isActiveSession(entry.host, entry.item));
                if (current && !recentVisible.includes(current)) recentVisible = [...recentVisible, current];
                recentHidden = recentEntries.length - recentVisible.length;
              }
              const searchEmpty = h('p', { key: 'sidebar-search-empty', 'data-search-empty': true, style: { margin: '6px 5px', fontSize: 11, opacity: 0.6 } }, '没有匹配的任务');
              const sidebarTree = rows => h('div', { key: 'sidebar-project-tree', role: 'tree', 'aria-label': '本机与远程工作区', 'aria-busy': busy }, rows);
              const listBody = sidebarView === 'recent'
                ? recentVisible.length > 0
                  ? h('div', { role: 'tree', 'data-recent-list': true, 'aria-label': '最近更新的任务', 'aria-busy': busy },
                    recentVisible.map(entry => sessionRow(entry.host, entry.group, entry.item, { machine: machineName(entry.host.label) })),
                    recentHidden > 0 && h('button', { type: 'button', 'data-action': 'show-more', 'data-view': 'recent', 'aria-label': '显示更多，还有 ' + recentHidden + ' 条', title: '还有 ' + recentHidden + ' 条任务', onClick: () => { sidebarShowAll.add('recent'); emit({ ...snapshot }); }, style: { ...rowStyle, padding: '5px 8px 5px 29px', fontSize: 11, opacity: 0.65 } }, '显示更多'))
                  : searching ? searchEmpty : h('p', { style: { margin: '6px 5px', fontSize: 11, opacity: 0.6 } }, '暂无任务')
                : [projectHeader, newProjectMenu,
                  searching
                    ? projectEntries.length > 0 && sidebarTree(workspaceRows)
                    : sidebarTree(workspaceRows),
                  looseSection,
                  searching && projectEntries.length === 0 && looseEntries.length === 0 && searchEmpty];
              const addButton = (host, label, empty = false) => h('button', { key: host.id + ':' + label, type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, 'data-empty-remote-action': empty || undefined, disabled: catalog.operationBusy || host.status !== 'ready', onClick: () => openCreation('workspace', host), style: { ...rowStyle, padding: '8px 5px', fontSize: 11, opacity: host.status === 'ready' ? 0.75 : 0.5 } }, label);
              return h('section', { 'aria-label': '全部工作区', 'data-dsh-unified-workspaces': true, 'data-unified-location': 'sidebar', 'data-sidebar-layout': 'workspace-list', 'data-sidebar-appearance': 'compact', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: '0 4px 10px', boxSizing: 'border-box', color: 'inherit' } },
                h('style', null, rowActionsCss),
                h('style', { 'data-sidebar-shell-style': true }, sidebarShellCss),
                h('div', { 'data-unified-toolbar': true, style: { display: 'flex', alignItems: 'center', gap: 4, padding: '10px 4px 6px' } },
                  h('button', { type: 'button', 'data-action': 'new-task', title: '新建任务', onClick: () => ui.uiWorkspace.startSession(), style: { ...rowStyle, width: 'auto', height: 36, padding: '0 12px', fontSize: 13, fontWeight: 550, borderRadius: 8 } }, sidebarIcon('message'), '新建任务'),
                  h('button', { type: 'button', title: '打开远端工作台', 'aria-label': '打开远端工作台', onClick: showManager, style: { ...iconButtonStyle, marginLeft: 'auto', opacity: 0.65 } }, sidebarIcon('settings'))),
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '2px 4px 8px' } },
                  h('span', { style: { fontSize: 11, opacity: 0.55, letterSpacing: 0.4 } }, '任务列表'),
                  h('button', { type: 'button', title: '刷新全部工作区', 'aria-label': '刷新全部工作区', onClick: () => refresh(), style: { ...iconButtonStyle, marginLeft: 'auto', opacity: 0.55 } }, sidebarIcon('refresh', 14)),
                  h('button', { type: 'button', 'data-action': 'search', 'aria-label': '搜索任务', 'aria-pressed': sidebarSearchOpen, title: '搜索任务', onClick: () => { const opening = !sidebarSearchOpen; sidebarSearchOpen = opening; if (!opening) sidebarQuery = ''; emit({ ...snapshot }); }, style: { ...iconButtonStyle, opacity: 0.65 } }, sidebarIcon('search')),
                  h('button', { type: 'button', 'data-action': 'view-menu', 'aria-label': '切换视图', 'aria-pressed': sidebarViewMenuOpen, title: '切换视图', onClick: event => { anchorSidebarMenu(event); sidebarWorkspaceMenu = null; sidebarSessionMenu = null; sidebarNewProjectOpen = false; sidebarViewMenuOpen = !sidebarViewMenuOpen; emit({ ...snapshot }); }, style: iconButtonStyle }, sidebarIcon('filter'))),
                sidebarSearchOpen && h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px 8px' } },
                  h('input', { type: 'text', 'data-search-input': true, 'aria-label': '搜索任务', placeholder: '搜索任务', value: sidebarQuery, onChange: event => { sidebarQuery = event.target.value; emit({ ...snapshot }); }, style: { flex: 1, minWidth: 0, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 6, background: 'transparent', color: 'inherit', padding: '4px 6px', fontSize: 11, font: 'inherit' } }),
                  h('button', { type: 'button', 'data-action': 'search-clear', 'aria-label': '清空搜索', title: '清空搜索', onClick: () => { sidebarQuery = ''; sidebarSearchOpen = false; emit({ ...snapshot }); }, style: iconButtonStyle }, sidebarIcon('close'))),
                sidebarViewMenuOpen && h('div', { role: 'menu', 'aria-label': '选择视图', 'data-sidebar-menu': true, style: sidebarMenuStyle() },
                  [['project', '按项目'], ['recent', '最近更新']].map(([value, label]) => h('button', { key: 'view:' + value, type: 'button', 'data-action': 'view-option', 'data-view': value, 'aria-pressed': sidebarView === value, onClick: () => { sidebarView = value; saveSidebarView(); sidebarViewMenuOpen = false; emit({ ...snapshot }); }, style: { ...rowStyle, padding: '5px 7px', fontSize: 11, opacity: sidebarView === value ? 1 : 0.7 } }, label))),
                catalog.phase === 'loading' && h('p', { style: { fontSize: 12, padding: 4, opacity: 0.7 } }, '正在读取工作区…'),
                catalog.error && h('p', { role: 'status', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, catalog.error),
                (notice || sidebarNotice) && h('p', { role: 'alert', 'data-sidebar-notice': true, style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, notice || sidebarNotice),
                listBody,
                remotes.filter(remote => remote.workspaces.length === 0).map(remote => addButton(remote, '+ 添加 ' + remote.label + ' 工作区', true)),
                remotes.filter(remote => remote.status === 'offline').map(remote => h('p', { key: remote.id, style: { fontSize: 11, padding: '0 5px', opacity: 0.6 } }, remote.label + ' 暂时离线')));
            }
            return h('section', { 'aria-label': '全部工作区', 'data-dsh-unified-workspaces': true, 'data-unified-location': main ? 'main' : 'sidebar', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: main ? '0 8px 16px' : '0 10px 10px', boxSizing: 'border-box', color: 'inherit' } },
              h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '10px 4px', flex: '0 0 auto' } },
                h('strong', { style: { fontSize: 12, opacity: 0.7 } }, '全部工作区'),
                h('button', { type: 'button', title: '管理当前主机的工作区', 'aria-label': '管理当前工作区', onClick: manageCurrent, style: { ...rowStyle, width: 'auto', marginLeft: 'auto', padding: '2px 5px', fontSize: 11, opacity: 0.7 } }, '管理当前主机'),
                h('button', { type: 'button', 'aria-label': '刷新全部工作区', onClick: () => refresh(), style: { ...rowStyle, width: 'auto', padding: '2px 5px' } }, '↻')),
              catalog.phase === 'loading' && h('p', { style: { fontSize: 12, padding: 4, opacity: 0.7 } }, '正在读取工作区…'),
              catalog.error && h('p', { role: 'status', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, catalog.error),
              notice && h('p', { role: 'alert', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, notice),
              h('div', { role: 'tree', 'aria-label': '本机与远端工作区', 'aria-busy': busy }, catalog.hosts.map(host => {
                const hostGroups = groups(host, main);
                const hostClosed = closed['host:' + host.id];
                return h('div', { key: host.id, role: 'group', 'aria-label': host.label, 'data-workspace-host': host.id, style: { marginBottom: 12 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } }, h('button', { type: 'button', style: { ...rowStyle, fontSize: 13, fontWeight: 650, padding: '8px 4px', flex: 1 }, onClick: () => toggle('host:' + host.id), 'aria-expanded': !hostClosed },
                    h('span', { 'aria-hidden': true }, hostClosed ? '›' : '⌄'), host.label,
                    host.id === selected ? h('span', { style: { fontSize: 10, fontWeight: 400, opacity: 0.55 } }, '当前') : null,
                    h('span', { style: { fontSize: 10, fontWeight: 400, opacity: 0.55, marginLeft: 'auto' } }, host.status === 'ready' ? String(roots(host, main).length) : '暂时离线')),
                    h('button', { type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, 'aria-label': '在 ' + host.label + ' 新建工作区', disabled: catalog.operationBusy || host.status !== 'ready', onClick: () => openCreation('workspace', host), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 4px' } }, '+ 工作区')),
                  !hostClosed && (host.status !== 'ready' ? h('p', { style: { fontSize: 12, padding: '0 14px', opacity: 0.65 } }, '连接恢复后可继续打开原会话。') : hostGroups.length === 0 ? h('p', { style: { fontSize: 12, padding: '0 14px', opacity: 0.65 } }, '暂无工作区') : hostGroups.map(group => {
                    const groupKey = host.id + ':' + group.workspaceId;
                    const groupClosed = closed[groupKey];
                    const label = group.title || group.path?.split('/').filter(Boolean).pop() || '工作区';
                    return h('div', { key: groupKey, role: 'group', 'aria-label': label, 'data-workspace-id': group.workspaceId },
                      h('div', { style: { display: 'flex', alignItems: 'center' } },
                        h('button', { type: 'button', 'aria-label': (groupClosed ? '展开工作区：' : '收起工作区：') + label, 'aria-expanded': !groupClosed, onClick: () => toggle(groupKey), style: { ...rowStyle, padding: '6px 2px 6px 12px', width: 29, flex: '0 0 29px' } }, groupClosed ? '›' : '⌄'),
                        h('button', { type: 'button', disabled: busy, onClick: () => {
                          toggle(groupKey);
                        }, title: group.path || label, style: { ...rowStyle, padding: '6px 4px', fontSize: 12, fontWeight: 550, overflow: 'hidden' } }, h('span', { style: { whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' } }, label)),
                        group.workspaceId !== '__other__' && h('button', { type: 'button', 'data-action': 'new-session', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '在 ' + host.label + ' 的 ' + label + ' 新建并打开会话', disabled: busy || catalog.operationBusy || host.status !== 'ready', onClick: () => createAndOpen(host, group), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 4px' } }, '+ 会话')),
                      !groupClosed && (group.members.length ? group.members.map(item => sessionRow(host, group, item)) : h('p', { style: { margin: '3px 4px 6px 29px', fontSize: 11, opacity: 0.55 } }, '暂无已有会话')));
                  })));
              })));
          }
          function CreationForm({ catalog }) {
            const dialog = catalog.dialog;
            if (!dialog) return null;
            const workspace = dialog.kind === 'workspace';
            const disabled = catalog.operationBusy || dialog.browsing;
            const fieldStyle = { width: '100%', boxSizing: 'border-box', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 7, background: 'transparent', color: 'inherit', padding: '9px 10px', font: 'inherit', fontSize: 13 };
            const buttonStyle = { ...rowStyle, width: 'auto', padding: '8px 11px', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', fontSize: 12 };
            return h('form', { 'aria-label': workspace ? '新建工作区表单' : '新建会话表单', onSubmit: createFromDialog, style: { border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 12, padding: 16, margin: '0 0 16px', flexShrink: 0 } },
              h('h3', { style: { margin: '0 0 8px', fontSize: 15 } }, (workspace ? '新建工作区 · ' : '新建会话 · ') + dialog.label),
              workspace ? h('div', null,
                h('label', { style: { display: 'block', fontSize: 12, marginBottom: 6 } }, '目标主机上的目录'),
                h('div', { style: { display: 'flex', gap: 8 } },
                  h('input', { 'aria-label': '工作区目录', value: dialog.path, disabled, placeholder: '/目标主机/项目目录', onChange: event => { browseGeneration++; editDialog({ path: event.target.value, directory: null, error: '', uncertain: false, requestId: newRequestId() }); }, style: { ...fieldStyle, minWidth: 0, flex: 1 } }),
                  h('button', { type: 'button', disabled, onClick: () => browseDirectory(dialog.path || undefined), style: buttonStyle }, dialog.browsing ? '读取中…' : '浏览目录')),
                h('p', { style: { fontSize: 11, opacity: 0.65, margin: '7px 0' } }, '选择已有目录，或直接输入绝对路径。工作区名称会根据目录生成。'),
                dialog.directory && h('section', { 'aria-label': '目标主机目录浏览器', style: { borderTop: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', marginTop: 10, paddingTop: 8 } },
                  h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 } }, dialog.directory.crumbs.map((crumb, index) => h('button', { key: crumb.path, type: 'button', disabled, onClick: () => browseDirectory(crumb.path), style: { ...rowStyle, width: 'auto', padding: '3px 5px', fontSize: 11 } }, index ? crumb.name : '/'))),
                  h('label', { style: { display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, opacity: 0.7, marginBottom: 6 } }, h('input', { type: 'checkbox', checked: dialog.showHidden, disabled, onChange: event => editDialog({ showHidden: event.target.checked }) }), '显示隐藏目录'),
                  h('div', { style: { maxHeight: 180, overflow: 'auto' } }, dialog.directory.entries.filter(entry => dialog.showHidden || !entry.hidden).map(entry => h('button', { key: entry.path, type: 'button', disabled, title: entry.path, onClick: () => browseDirectory(entry.path), style: { ...rowStyle, padding: '5px 4px', fontSize: 12 } }, '▸ ', entry.name))),
                  dialog.directory.truncated && h('p', { style: { fontSize: 11, opacity: 0.65 } }, '此层目录较多，仅显示一部分；可直接输入完整路径。')))
                : h('div', null, h('p', { style: { fontSize: 13, margin: '4px 0' } }, dialog.workspaceTitle), h('p', { style: { fontSize: 11, opacity: 0.65, wordBreak: 'break-all' } }, dialog.path), h('p', { style: { fontSize: 12, opacity: 0.7 } }, '使用这台主机已有的默认配置创建并打开空白会话。')),
              dialog.error && h('p', { role: 'alert', style: { fontSize: 12, color: '#bc6b15', margin: '10px 0' } }, dialog.error),
              h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 } },
                h('button', { type: 'submit', disabled: disabled || dialog.uncertain, style: buttonStyle }, catalog.operationBusy ? '正在新建…' : workspace ? '新建工作区' : '新建会话'),
                dialog.uncertain && h('button', { type: 'button', disabled: catalog.operationBusy, onClick: () => refreshAfterWrite(), style: buttonStyle }, '刷新列表查看结果'),
                dialog.uncertain && dialog.kind === 'session' && h('button', { type: 'button', disabled: catalog.operationBusy, onClick: () => {
                  uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                  emit({ ...snapshot, dialog: null, managerNotice: '已解除这次创建的保留状态。若已找到会话，请直接打开；再次点「＋会话」会创建另一个。' });
                }, style: buttonStyle }, '已核对列表，允许再次新建'),
                h('button', { type: 'button', disabled: catalog.operationBusy, onClick: closeCreation, style: buttonStyle }, '取消')));
          }
          function WorkspacesPage() {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const recent = catalog.recentCreated;
            const recentHost = recent && catalog.hosts.find(host => host.id === recent.host);
            return h('section', { 'data-remote-workbench': true, style: { padding: 20, maxWidth: 980, margin: '0 auto', width: '100%', height: '100%', minHeight: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'auto' } },
              h('h2', { style: { fontSize: 20, margin: '0 0 8px' } }, '远端工作台'),
              h('p', { style: { opacity: 0.7, fontSize: 13, margin: '0 0 12px' } }, '集中管理本机和已配置远端的目录、工作区与会话。'),
              h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,280px),1fr))', gap: 12, marginBottom: 16, flexShrink: 0 } }, catalog.hosts.map(host => h('section', { key: host.id, 'data-manager-host': host.id, style: { border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 12, padding: 14 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } }, h('strong', { style: { fontSize: 14 } }, host.label), h('span', { style: { marginLeft: 'auto', fontSize: 11, color: host.status === 'ready' ? '#2b9b68' : '#bc6b15' } }, host.status === 'ready' ? '可访问' : '暂时离线')),
                h('p', { style: { fontSize: 11, opacity: 0.65, margin: '6px 0' } }, host.id !== 'mac' ? '此主机使用已有的 SSH 连接与 DSH 服务' : '本机上的 DSH'),
                h('p', { style: { fontSize: 12, opacity: 0.7 } }, host.workspaces.length + ' 个工作区 · ' + roots(host, true).length + ' 个会话'),
                h('button', { type: 'button', disabled: catalog.operationBusy || host.status !== 'ready', 'data-action': 'new-workspace', 'data-host-id': host.id, onClick: () => openCreation('workspace', host), style: { ...rowStyle, width: 'auto', border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', padding: '7px 10px', fontSize: 12 } }, '+ 新建工作区')))),
              catalog.hosts.length === 1 && h('p', { 'data-host-setup-help': true, style: { fontSize: 12, opacity: 0.7 } }, '尚未配置远端。请在私有 hosts.json 中添加 SSH 隧道地址和短期凭据命令，再重新加载插件。'),
              h(PluginSyncPanel, { hosts: catalog.hosts, onOpenTarget: async hostId => {
                try { await openTargetPlugins(hostId); }
                catch (error) { emit({ ...snapshot, managerNotice: error instanceof Error ? error.message : '目标插件页暂时无法打开。' }); showManager(); }
              } }),
              h(CreationForm, { catalog }),
              catalog.managerNotice && h('div', { role: 'status', style: { fontSize: 12, padding: '8px 4px 12px', flexShrink: 0 } }, catalog.managerNotice,
                recent && recentHost && h('button', { type: 'button', onClick: async () => { try { await open(recent.host, recent.sessionId, recent.workspaceId, true); } catch (error) { emit({ ...snapshot, managerNotice: error.message }); } }, style: { ...rowStyle, width: 'auto', marginTop: 7, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', padding: '6px 10px' } }, '打开刚创建的会话')),
              // The workbench no longer repeats the sidebar tree: one list, in
              // the sidebar, is the only place to see or open a Session.
              );
          }
          function syncAppearance() {
            if (!persistentMode || !globalThis.getComputedStyle) return;
            const values = getComputedStyle(document.body || document.documentElement);
            const declarations = [];
            for (let index = 0; index < values.length; index++) { const name = values[index]; if (name.startsWith('--dsw-') || name.startsWith('--ds-')) declarations.push(name + ':' + values.getPropertyValue(name)); }
            const locale = currentLocale();
            for (const [hostId, bridge] of persistentBridges) if (snapshot.remotes[hostId]?.ready) bridge.appearance('body,body[data-ds-dark-theme]{' + declarations.join(';') + '}', locale);
          }
          function currentLocale() {
            const active = ui.locale?.getSnapshot?.()?.active;
            const language = value => typeof value === 'string' && value.length <= 64 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,7}$/.test(value);
            if (!language(active)) return undefined;
            const browser = Array.isArray(globalThis.navigator?.languages) ? globalThis.navigator.languages : [];
            return { active, languages: [...new Set([active, ...browser.filter(language)])].slice(0, 16) };
          }
          // 远端会话视图：把第二棵树挂进一个容器；同机切会话只 openSession，
          // 换机器时由父级 releaseAllExcept 释放，草稿按"机器+会话"存取。
          function RemoteTreePane({ hostId, sessionId, visible }) {
            const host = React.useRef(null);
            const [status, setStatus] = React.useState('idle');
            React.useEffect(() => {
              if (!remoteTrees || !host.current) return undefined;
              let cancelled = false;
              setStatus('booting');
              remoteTrees.ensure(hostId, host.current, sessionId)
                .then(handle => { if (cancelled) return; setStatus(handle && handle.ok ? 'ready' : 'failed'); })
                .catch(() => { if (!cancelled) setStatus('failed'); });
              return () => { cancelled = true; };
            }, [hostId, sessionId]);
            React.useEffect(() => {
              if (!remoteTrees || !sessionId || status !== 'ready') return;
              remoteTrees.open(hostId, sessionId).catch(() => {});
            }, [hostId, sessionId, status]);
            // 视图不再可见（切回本机或切到别的机器）→ 存草稿并释放这棵树。
            // 用可见性驱动，不依赖"点击走了哪条分支"。
            const wasVisible = React.useRef(visible);
            React.useEffect(() => {
              const previous = wasVisible.current; wasVisible.current = visible;
              if (!remoteTrees || visible || !previous) return;
              remoteTrees.release(hostId).catch(() => {});
            }, [visible, hostId, sessionId]);
            return h('div', { 'data-remote-tree-host': hostId, 'data-remote-tree-status': status, style: { position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-base)', display: visible ? 'block' : 'none' } },
              // 侧栏只保留一份（合并侧栏）。第二棵树自带的那条侧栏在这里藏掉，
              // 远端视图只显示对话；选择机器/会话仍走合并侧栏。
              // 类名带构建哈希，用 CSS Modules 的稳定后缀匹配。
              h('style', { key: 'tree-hidden-sidebar' },
                '[data-proto-second-tree] [class*="_sidebarCol"]{width:0!important;min-width:0!important;max-width:0!important;overflow:hidden!important;visibility:hidden!important;pointer-events:none!important}'
                + '[data-proto-second-tree]>div>div{grid-template-columns:0 minmax(0,1fr) 0!important}'),
              h('div', { ref: host, style: { position: 'absolute', inset: 0, overflow: 'hidden' } }),
              status !== 'ready' && h('div', { role: 'status', style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, opacity: 0.75, pointerEvents: 'none' } }, status === 'failed' ? '远端界面未就绪，请刷新列表后重试' : '正在打开远端界面…'));
          }
          function PersistentOverlay() {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const info = React.useSyncExternalStore(ui.layout.panelInfo.subscribe, ui.layout.panelInfo.getSnapshot, ui.layout.panelInfo.getSnapshot);
            const [bounds, setBounds] = React.useState({ left: 280, top: 0, right: 0, bottom: 0 });
            const [parentCollapsed, setParentCollapsed] = React.useState(false);
            React.useEffect(() => {
              const shell = document.querySelector('[data-shell-overlay]')?.parentElement;
              const center = shell?.children?.[1];
              function measure() { if (!shell || !center) return; const parent = shell.getBoundingClientRect(), main = center.getBoundingClientRect(); setBounds({ left: main.left - parent.left, top: main.top - parent.top, right: 0, bottom: parent.bottom - main.bottom }); const collapsed = shell.getAttribute('data-sidebar-collapsed'); setParentCollapsed(collapsed !== null && collapsed !== 'false'); }
              measure();
              const observer = globalThis.ResizeObserver ? new ResizeObserver(measure) : undefined;
              if (shell) observer?.observe(shell); if (center) observer?.observe(center);
              window.addEventListener('resize', measure);
              return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
            }, []);
            React.useEffect(() => { if (info.activePanelId === null && catalog.remotes[catalog.activeTarget]?.ready) persistentBridges.get(catalog.activeTarget)?.focus(); }, [catalog.activeTarget, info.activePanelId, catalog.remotes]);
            // 每台机器最多一棵树：目标切换后释放其它机器。释放不停远端任务。
            React.useEffect(() => {
              if (!remoteTrees) return undefined;
              remoteTrees.releaseAllExcept(treeHostIdsNow().has(catalog.activeTarget) ? catalog.activeTarget : null).catch(() => {});
              return undefined;
            }, [catalog.activeTarget]);
            React.useEffect(() => () => { if (remoteTrees) { for (const id of [...remoteTrees.trees.keys()]) remoteTrees.release(id).catch(() => {}); } }, []);
            // Keep all previously connected source pages in this stable list.
            const sources = Object.entries(catalog.remotes).filter(([hostId, remote]) => remote.embed || catalog.activeTarget === hostId);
            return sources.map(([hostId, remote]) => {
              const visible = catalog.activeTarget === hostId && info.activePanelId === null;
              const label = catalog.hosts.find(host => host.id === hostId)?.label || hostId;
              const useTree = treeForHost(hostId);
              return h('section', { key: hostId, 'data-persistent-remote-overlay': true, 'data-host-id': hostId, 'aria-label': label + ' 远程会话', 'aria-hidden': !visible, style: { position: 'absolute', ...bounds, display: visible ? 'block' : 'none', background: 'var(--dsw-alias-bg-base)', overflow: 'hidden', pointerEvents: visible ? 'auto' : 'none' } },
                visible && parentCollapsed && h('button', { type: 'button', 'data-action': 'expand-parent-workspaces', 'aria-label': '展开工作区列表', onClick: () => ui.layout.toggleSidebar(), style: { position: 'absolute', top: 10, left: 10, zIndex: 2, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 7, padding: '7px 10px', background: 'var(--dsw-alias-bg-base)', color: 'inherit', cursor: 'pointer', fontSize: 12 } }, '展开工作区列表'),
                // Only clipboard-write is delegated: the remote UI's copy buttons need
                // it, and granting read as well would let the cross-origin frame read
                // whatever you copied elsewhere.
                // 已有验证过的第二棵树时用它渲染，否则继续用 iframe（默认路径）。
                useTree && h(RemoteTreePane, { key: 'tree-' + hostId, hostId, sessionId: catalog.remotes[hostId]?.sessionId || null, visible }),
                !useTree && remote.embed && h('iframe', { key: remote.embed.frameId, ref: element => persistentBridges.get(hostId)?.attach(element), 'data-persistent-remote-frame': true, 'data-host-id': hostId, title: label + ' 远程工作区', src: remote.embed.frameUrl, allow: 'clipboard-write', sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads', style: { width: '100%', height: '100%', border: 0, display: 'block' } }),
                // 第二棵树自己会报"正在打开"，只有 iframe 路径需要这层等待提示。
                !useTree && (!remote.ready || remote.notice) && h('div', { role: 'status', style: { position: 'absolute', top: 12, left: 12, right: 12, borderRadius: 8, padding: 12, background: 'var(--dsw-alias-bg-base)', color: 'inherit', fontSize: 12 } }, remote.notice || '正在打开 ' + label + ' 工作区…'));
            });
          }
          async function startRemoteSession(hostId) {
            const sessionId = snapshot.remotes[hostId]?.sessionId;
            const bridge = bridgeFor(hostId);
            ui.layout.selectPanel(null);
            emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], notice: '' } } });
            try { await bridge.startSession(undefined, sessionId); }
            catch (error) {
              // Never fall back to the local Host: the user asked for a new
              // session on the source that is on screen.
              if (!disposed) emit({ ...snapshot, remotes: { ...snapshot.remotes, [hostId]: { ...snapshot.remotes[hostId], notice: '未能在远端新建会话：' + (error instanceof Error ? error.message : '远程工作区尚未就绪。') } } });
            }
          }
          if (persistentMode && typeof ui.uiWorkspace.startSession === 'function') {
            // The native sidebar button, titlebar button and keyboard command all
            // call this one service method. A global "new session" (no explicit
            // workspace) follows the source that is on screen, like ZCode.
            ui.effect(() => {
              const service = ui.uiWorkspace;
              const native = service.startSession;
              const own = Object.prototype.hasOwnProperty.call(service, 'startSession');
              const routed = function(workspaceId, options) {
                const target = snapshot.activeTarget;
                // Only while that source is actually on screen (no panel such as
                // automation or settings covers it): a panel's own "new" button
                // still means this page's Host.
                const onScreen = ui.layout.panelInfo?.getSnapshot?.()?.activePanelId == null;
                if (!disposed && workspaceId === undefined && options === undefined && target !== 'mac' && onScreen
                    && validHostId(target, false) && snapshot.remotes[target]?.embed) {
                  void startRemoteSession(target);
                  return;
                }
                return native.call(this, workspaceId, options);
              };
              service.startSession = routed;
              return () => {
                if (service.startSession !== routed) return;
                if (own) service.startSession = native; else delete service.startSession;
              };
            }, 'Global new session follows the visible source');
          }
          if (persistentMode) {
            ui.slots.inject('shell.overlay', () => ui.slots.register({ name: 'shell.overlay', id: 'dsh-unified-persistent-frame' }, PersistentOverlay));
            ui.effect(() => {
              const stopLocale = ui.locale?.subscribe?.(syncAppearance);
              const observer = globalThis.MutationObserver ? new MutationObserver(syncAppearance) : undefined;
              observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-theme'] });
              if (document.body) observer?.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-ds-dark-theme', 'data-theme'] });
              return () => { stopLocale?.(); observer?.disconnect(); };
            }, 'Remote appearance follows local settings');
          }
          const Icon = () => h('span', { 'aria-hidden': true, 'data-unified-panel-icon': true }, sidebarIcon('folder', 16));
          ui.slots.inject('main', () => ui.slots.register({ name: 'main', key: panel }, WorkspacesPage));
          ui.slots.inject('sidebar.workspaces', () => {
            enableUnified();
            return () => { disposeUnified?.(); disposeUnified = undefined; };
          });
          ui.slots.inject('sidebar.panellist', () => ui.slots.register({ name: 'sidebar.panellist', id: panel, label: '远端工作台', order: 3 }, Icon));
        });
        // B2 原型探针：只读地记录"起第二棵树"所需部件在插件空间里可否拿到。
        // DSH 的 token 重定向会清掉 query，所以这里无条件跑一次，纯读。
        // 第二棵树的入口默认不暴露：只有显式开启实验开关时才挂到 window 上，
        // 供隔离环境验证用。产品化后改为由内部调用，不再经过全局对象。
        if (globalThis.__DSH_UNIFIED_REMOTE_TREE__ === true) {
          try { globalThis.__DSH_UNIFIED_BOOT_REMOTE_TREE__ = createRemoteTree(require); }
          catch (error) { globalThis.__DSH_UNIFIED_REMOTE_TREE_ERROR__ = String(error && error.message || error); }
        }
      },
    };
  },
});
