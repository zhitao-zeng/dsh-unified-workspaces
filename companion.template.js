window.__ModuleLoader__.load({
  id: '@zhitao-zeng/dsh-unified-embed-companion',
  factory(require) {
    return {
      inject: ['uiWorkspace', 'sessions', 'layout', 'configForms'],
      apply(ctx) {
        const boot = globalThis.__DSH_EMBED_BOOT__;
        if (!boot || typeof boot.controlToken !== 'string' || typeof boot.frameId !== 'string' || typeof boot.parentOrigin !== 'string' || boot.parentOrigin === 'null') throw new Error('远程工作区消息授权无效。');
        let port;
        let disposed = false;
        let requestInFlight = false;
        const selected = () => ctx.uiWorkspace.selection?.getSnapshot?.()?.sessionId;
        const send = value => { if (!disposed) { try { port?.postMessage(value); } catch {} } };
        const validSession = id => typeof id === 'string' && id.length > 0 && id.length <= 512;
        function knownSession(id) {
          const list = ctx.sessions?.list?.getSnapshot?.();
          return !!(list && list.phase === 'ready' && (Object.prototype.hasOwnProperty.call(list.byId || {}, id) || Array.isArray(list.ids) && list.ids.includes(id) || Array.isArray(list.items) && list.items.some(item => item.sessionId === id)));
        }
        async function command(message) {
          if (!message || typeof message.id !== 'string' || message.id.length > 128 || !['session/open', 'status', 'appearance/reload', 'plugin-manager/open'].includes(message.type)) return;
          if (requestInFlight && message.type === 'session/open') { send({ id: message.id, ok: false, error: '远程工作区正在打开会话，请稍后重试。' }); return; }
          try {
            if (message.type === 'session/open') {
              if (!validSession(message.sessionId)) throw new Error('会话标识无效。');
              requestInFlight = true;
              if (!knownSession(message.sessionId)) await ctx.sessions?.refresh?.();
              if (disposed) return;
              if (!knownSession(message.sessionId)) throw new Error('远端中没有找到此会话，请刷新列表后重试。');
              ctx.layout.selectPanel(null);
              await ctx.uiWorkspace.openSession(message.sessionId);
              document.querySelector('[contenteditable="true"],textarea')?.focus?.();
            } else if (message.type === 'plugin-manager/open') {
              ctx.layout.selectPanel('plugins');
            } else if (message.type === 'appearance/reload') {
              if (message.locale !== undefined) {
                const bridge = globalThis.__DSH_UNIFIED_PARENT_LOCALE__;
                if (!bridge || typeof bridge.update !== 'function') throw new Error('远程工作区语言桥接尚未就绪。');
                bridge.update(message.locale);
              }
              await ctx.configForms?.describe?.().load();
              // Update styles without navigating or replacing this Client Context.
              if (typeof message.css === 'string' && message.css.length <= 32000) {
                let style = document.getElementById('dsh-parent-appearance');
                if (!style) { style = document.createElement('style'); style.id = 'dsh-parent-appearance'; document.head.appendChild(style); }
                style.textContent = message.css;
              }
            }
            send({ id: message.id, ok: true, value: { sessionId: selected(), frameId: boot.frameId } });
          } catch (error) { send({ id: message.id, ok: false, error: error instanceof Error ? error.message : '远程操作未完成。' }); }
          finally { if (message.type === 'session/open') requestInFlight = false; }
        }
        function onInit(event) {
          const value = event.data;
          if (disposed || event.source !== window.parent || event.origin !== boot.parentOrigin || !value || value.type !== 'dsh-unified/embed-init' || value.frameId !== boot.frameId || value.controlToken !== boot.controlToken || event.ports?.length !== 1) return;
          try { port?.close(); } catch {}
          port = event.ports[0];
          port.onmessage = event => command(event.data);
          port.start?.();
          send({ type: 'ready', frameId: boot.frameId, sessionId: selected() });
        }
        ctx.effect(() => {
          // Keep the parent navigation as the sole workspace sidebar. The native
          // child center still owns all of its session controllers and dialogs.
          let sidebarHandled = false;
          const markShell = () => {
            const shell = document.querySelector('[data-shell-overlay]')?.parentElement;
            if (shell) {
              shell.setAttribute('data-dsh-embed-shell', '');
              if (!sidebarHandled) {
                sidebarHandled = true;
                const collapsed = shell.getAttribute('data-sidebar-collapsed');
                if (collapsed === null || collapsed === 'false') ctx.layout.toggleSidebar();
              }
            }
          };
          const embedStyle = document.createElement('style');
          embedStyle.textContent = '[data-dsh-embed-shell]>:first-child{display:none!important}[data-dsh-embed-shell]>:nth-child(2){grid-column:1/3!important;grid-row:1!important}[data-dsh-embed-shell]>[data-rightbar-col]{grid-column:3!important;grid-row:1!important}';
          document.head.appendChild(embedStyle); markShell();
          const observer = globalThis.MutationObserver ? new MutationObserver(markShell) : undefined;
          observer?.observe(document.documentElement, { childList: true, subtree: true });
          window.addEventListener('message', onInit);
          const stop = ctx.uiWorkspace.selection?.subscribe?.(() => send({ type: 'state', frameId: boot.frameId, sessionId: selected() }));
          return () => { disposed = true; observer?.disconnect(); embedStyle.remove(); window.removeEventListener('message', onInit); stop?.(); try { port?.close(); } catch {} port = undefined; };
        }, '远端 persistent embedded workspace bridge');
      },
    };
  },
});
