window.__ModuleLoader__.load({
  id: '@zhitao-zeng/dsh-unified-workspaces',
  factory(require) {
    /* ROUTING_HELPERS */
    /* PERSISTENT_HELPERS */
    /* PLUGIN_SYNC */
    function pickerModule(require) {
      /* PICKER_MODULE */
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
          async function createAndOpen(host, workspace) {
            if (disposed || writeBusy || host.status !== 'ready') return;
            const previous = uncertainCreates.get(creationKey({ host: host.id, workspaceId: workspace.workspaceId }));
            if (previous) {
              emit({ ...snapshot, dialog: previous, managerNotice: '上一次创建结果仍待核对，未发送新的创建请求。' });
              showManager(); return;
            }
            if (uncertainCreates.size >= 128) {
              emit({ ...snapshot, managerNotice: '待核对的创建请求较多，请先核对已有会话列表。' }); showManager(); return;
            }
            let requestId;
            try { requestId = newRequestId(); }
            catch (error) { emit({ ...snapshot, managerNotice: error.message }); showManager(); return; }
            const dialog = { kind: 'session', host: host.id, label: host.label,
              path: workspace.path, workspaceId: workspace.workspaceId,
              workspaceTitle: workspace.title || workspace.path || '', requestId };
            await createFromDialog(undefined, dialog);
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
          async function createFromDialog(event, submittedDialog) {
            event?.preventDefault?.();
            const dialog = submittedDialog || snapshot.dialog;
            if (disposed || !dialog || writeBusy || dialog.browsing || dialog.uncertain) return;
            if (dialog.kind === 'workspace' && !absoluteWorkspacePath(dialog.path)) {
              editDialog({ error: '请输入目标主机上的绝对目录路径。' }); return;
            }
            writeBusy = true;
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
                    emit({ ...snapshot, managerNotice: '会话已创建；' + (error instanceof Error ? error.message : '暂时无法打开。') + ' 可点击下方「打开刚创建的会话」继续，请勿重复创建。' });
                    showManager();
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
                emit({ ...snapshot, managerNotice: '会话已创建，但未能加入工作区。已保留该会话，可在「其他会话」中查看。' });
                void refreshAfterWrite();
                showManager();
              } else if (!disposed) {
                const uncertain = error?.code === 'management/result-uncertain';
                const failedDialog = { ...dialog, error: error instanceof Error ? error.message : '创建未完成，请刷新列表确认结果。', uncertain };
                if (uncertain && dialog.kind === 'session') {
                  uncertainCreates.set(creationKey(dialog), failedDialog); saveUncertainCreates();
                } else if (dialog.kind === 'session') {
                  uncertainCreates.delete(creationKey(dialog)); saveUncertainCreates();
                }
                emit({ ...snapshot, dialog: failedDialog });
                showManager();
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
          async function open(hostId, sessionId, workspaceId, allowBlank = false) {
            const cached = snapshot.hosts.find(row => row.id === hostId);
            const acknowledgement = confirmedCreated.get(hostId)?.get(sessionId);
            const acknowledged = acknowledgement && acknowledgement.until > Date.now()
              && roots(cached, true).some(item => item.sessionId === sessionId);
            const knownCurrent = acknowledged || (hostId === selected && Date.now() - catalogReadAt < 10_000 || persistentMode && hostId !== 'mac')
              && snapshot.phase === 'ready' && cached?.status === 'ready'
              && roots(cached, allowBlank).some(item => item.sessionId === sessionId);
            const latest = knownCurrent ? snapshot.hosts : await refresh();
            const host = latest?.find(row => row.id === hostId);
            if (!host || !acknowledged && host.status !== 'ready' || !roots(host, allowBlank).some(item => item.sessionId === sessionId)) throw new Error('该会话暂时无法打开，请刷新列表后重试。');
            if (hostId === selected) {
              if (allowBlank) await ui.uiWorkspace.sessions?.refresh?.();
              await ui.uiWorkspace.openSession(sessionId);
              if (persistentMode) snapshot = { ...snapshot, activeTarget: 'mac' };
              currentSessionId = sessionId;
              saveCurrentSelection();
              ui.layout.selectPanel(null);
              if (persistentMode) document.querySelector('[contenteditable="true"],textarea')?.focus?.();
              snapshot = { ...snapshot };
              for (const listener of listeners) listener();
              return;
            }
            saveCurrentSelection();
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
          const rowStyle = { border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit', textAlign: 'left', width: '100%', minWidth: 0, borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6, boxSizing: 'border-box' };
          function UnifiedTree({ wide = true, expandSidebar, main = false }) {
            const catalog = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
            const [closed, setClosed] = React.useState({});
            const [busy, setBusy] = React.useState(false);
            const [notice, setNotice] = React.useState('');
            const toggle = id => setClosed(value => ({ ...value, [id]: !value[id] }));
            async function reveal(host, item, workspaceId) {
              if (busy) return;
              setBusy(true); setNotice('');
              try { await open(host.id, item.sessionId, workspaceId, item.blank === true); }
              catch (error) { setNotice(error instanceof Error ? error.message : '打开未完成，请重试。'); }
              finally { setBusy(false); }
            }
            if (!wide) return h('button', { type: 'button', style: { ...rowStyle, justifyContent: 'center', padding: 10 }, title: '全部工作区', 'aria-label': '展开全部工作区', onClick: () => expandSidebar?.() }, '▤');
            const sessionRow = (host, group, item) => {
              const active = host.id === (persistentMode ? catalog.activeTarget : selected) && item.sessionId === (persistentMode && host.id !== 'mac' ? catalog.remotes[host.id]?.sessionId : currentSessionId);
              return h('button', {
                type: 'button', key: host.id + ':' + item.sessionId, role: 'treeitem',
                'data-row-key': 'session:' + item.sessionId, 'data-host-id': host.id,
                'data-workspace-id': group.workspaceId,
                'aria-current': active ? 'page' : undefined,
                disabled: busy || catalog.operationBusy || host.status !== 'ready', title: titleOf(item),
                onClick: () => reveal(host, item, group.workspaceId),
                style: { ...rowStyle, padding: '7px 8px 7px 29px', fontSize: 12, opacity: busy ? 0.65 : 1, background: active ? 'var(--dsw-alias-interactive-bg-active,rgba(128,128,128,.13))' : 'transparent' },
              }, h('span', { 'aria-hidden': true, style: { opacity: 0.5 } }, '◦'), h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, titleOf(item)), main ? h('span', { style: { marginLeft: 'auto', fontSize: 11, opacity: 0.55, flexShrink: 0 } }, '打开') : null, item.running === true ? h('span', { title: '运行中', 'aria-label': '运行中', style: { color: '#2b9b68', marginLeft: main ? 3 : 'auto', flexShrink: 0, fontSize: 10 } }, '●') : null);
            };
            if (!main) {
              const hosts = catalog.hosts;
              const mac = hosts.find(host => host.id === 'mac');
              const remotes = hosts.filter(host => host.id !== 'mac');
              const workspaceRows = hosts.flatMap(host => groups(host).filter(group => group.workspaceId !== '__other__').map(group => {
                const key = host.id + ':' + group.workspaceId;
                const expanded = sidebarExpanded.has(key);
                const label = group.title || group.path?.split('/').filter(Boolean).pop() || '工作区';
                return h('div', { key, role: 'group', 'aria-label': label, 'data-flat-workspace-row': true, 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, style: { marginBottom: 3 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', minHeight: 32, gap: 2 } },
                    h('button', { type: 'button', 'data-action': 'toggle-workspace', 'aria-label': (expanded ? '收起工作区：' : '展开工作区：') + label, 'aria-expanded': expanded, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, width: 23, flex: '0 0 23px', padding: '6px 3px', justifyContent: 'center' } }, expanded ? '⌄' : '›'),
                    h('button', { type: 'button', 'data-action': 'open-workspace', disabled: busy || catalog.operationBusy || host.status !== 'ready', title: group.path || label, onClick: () => setWorkspaceExpanded(host.id, group.workspaceId, !expanded), style: { ...rowStyle, flex: 1, padding: '6px 2px', overflow: 'hidden', fontSize: 12, fontWeight: 550 } },
                      h('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, '▱'), h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, label)),
                    host.id !== 'mac' && h('span', { 'data-remote-workspace-badge': true, style: { fontSize: 9, whiteSpace: 'nowrap', opacity: 0.6, flexShrink: 0 } }, host.label + ' · 远程'),
                    h('button', { type: 'button', 'data-action': 'new-session', 'data-host-id': host.id, 'data-workspace-id': group.workspaceId, 'aria-label': '在 ' + host.label + ' 的 ' + label + ' 新建并打开会话', disabled: busy || catalog.operationBusy || host.status !== 'ready', onClick: () => createAndOpen(host, group), style: { ...rowStyle, width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 3px' } }, '+ 会话')),
                  expanded && (group.members.length ? group.members.map(item => sessionRow(host, group, item)) : h('p', { style: { margin: '3px 4px 7px 27px', fontSize: 11, opacity: 0.55 } }, '暂无会话，点击「+ 会话」创建')));
              }));
              const addButton = (host, label, empty = false) => h('button', { key: host.id + ':' + label, type: 'button', 'data-action': 'new-workspace', 'data-host-id': host.id, 'data-empty-remote-action': empty || undefined, disabled: catalog.operationBusy || host.status !== 'ready', onClick: () => openCreation('workspace', host), style: { ...rowStyle, padding: '8px 5px', fontSize: 11, opacity: host.status === 'ready' ? 0.75 : 0.5 } }, label);
              return h('section', { 'aria-label': '全部工作区', 'data-dsh-unified-workspaces': true, 'data-unified-location': 'sidebar', 'data-sidebar-layout': 'workspace-list', style: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, overflow: 'auto', padding: '0 10px 10px', boxSizing: 'border-box', color: 'inherit' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px' } }, h('strong', { style: { fontSize: 12, opacity: 0.7 } }, '工作区'),
                  h('button', { type: 'button', 'aria-label': '打开远端工作台', onClick: showManager, style: { ...rowStyle, width: 'auto', fontSize: 11, marginLeft: 'auto', padding: '2px 4px', opacity: 0.65 } }, '管理'),
                  h('button', { type: 'button', 'aria-label': '刷新全部工作区', onClick: () => refresh(), style: { ...rowStyle, width: 'auto', padding: '2px 4px' } }, '↻')),
                catalog.phase === 'loading' && h('p', { style: { fontSize: 12, padding: 4, opacity: 0.7 } }, '正在读取工作区…'),
                catalog.error && h('p', { role: 'status', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, catalog.error),
                notice && h('p', { role: 'alert', style: { fontSize: 12, padding: 4, color: '#bc6b15' } }, notice),
                h('div', { role: 'tree', 'aria-label': '本机与远程工作区', 'aria-busy': busy }, workspaceRows),
                remotes.filter(remote => remote.workspaces.length === 0).map(remote => addButton(remote, '+ 添加 ' + remote.label + ' 工作区', true)),
                remotes.filter(remote => remote.status === 'offline').map(remote => h('p', { key: remote.id, style: { fontSize: 11, padding: '0 5px', opacity: 0.6 } }, remote.label + ' 暂时离线')),
                h('div', { style: { marginTop: 8, borderTop: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', paddingTop: 4 } }, mac && addButton(mac, '+ 本机工作区'), remotes.map(remote => addButton(remote, '+ ' + remote.label + ' 工作区'))));
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
              h('div', { style: { minHeight: 260, flex: '1 0 260px' } }, h(UnifiedTree, { main: true })));
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
            // Keep all previously connected source pages in this stable list.
            const sources = Object.entries(catalog.remotes).filter(([hostId, remote]) => remote.embed || catalog.activeTarget === hostId);
            return sources.map(([hostId, remote]) => {
              const visible = catalog.activeTarget === hostId && info.activePanelId === null;
              const label = catalog.hosts.find(host => host.id === hostId)?.label || hostId;
              return h('section', { key: hostId, 'data-persistent-remote-overlay': true, 'data-host-id': hostId, 'aria-label': label + ' 远程会话', 'aria-hidden': !visible, style: { position: 'absolute', ...bounds, display: visible ? 'block' : 'none', background: 'var(--dsw-alias-bg-base)', overflow: 'hidden', pointerEvents: visible ? 'auto' : 'none' } },
                visible && parentCollapsed && h('button', { type: 'button', 'data-action': 'expand-parent-workspaces', 'aria-label': '展开工作区列表', onClick: () => ui.layout.toggleSidebar(), style: { position: 'absolute', top: 10, left: 10, zIndex: 2, border: '1px solid var(--dsw-alias-border-l2,#cdd1d7)', borderRadius: 7, padding: '7px 10px', background: 'var(--dsw-alias-bg-base)', color: 'inherit', cursor: 'pointer', fontSize: 12 } }, '展开工作区列表'),
                remote.embed && h('iframe', { key: remote.embed.frameId, ref: element => persistentBridges.get(hostId)?.attach(element), 'data-persistent-remote-frame': true, 'data-host-id': hostId, title: label + ' 远程工作区', src: remote.embed.frameUrl, sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads', style: { width: '100%', height: '100%', border: 0, display: 'block' } }),
                (!remote.ready || remote.notice) && h('div', { role: 'status', style: { position: 'absolute', top: 12, left: 12, right: 12, borderRadius: 8, padding: 12, background: 'var(--dsw-alias-bg-base)', color: 'inherit', fontSize: 12 } }, remote.notice || '正在打开 ' + label + ' 工作区…'));
            });
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
          const Icon = () => h('span', { 'aria-hidden': true, style: { fontSize: 16 } }, '▤');
          const Footer = () => h('button', { type: 'button', title: '管理本机与远端的工作区和会话', 'aria-label': '远端工作台', onClick: showManager, style: { background: 'transparent', color: 'inherit', border: 0, padding: '5px 7px', fontSize: 12, cursor: 'pointer' } }, '远端工作台');
          ui.slots.inject('main', () => ui.slots.register({ name: 'main', key: panel }, WorkspacesPage));
          ui.slots.inject('sidebar.workspaces', () => {
            enableUnified();
            return () => { disposeUnified?.(); disposeUnified = undefined; };
          });
          ui.slots.inject('sidebar.panellist', () => ui.slots.register({ name: 'sidebar.panellist', id: panel, label: '远端工作台', order: 3 }, Icon));
          ui.slots.inject('sidebar.footer.action', () => ui.slots.register({ name: 'sidebar.footer.action', id: panel }, Footer));
        });
      },
    };
  },
});
