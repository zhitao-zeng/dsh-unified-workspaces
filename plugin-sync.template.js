// Injected as a factory-level function by build-client.mjs.
function createPluginSyncPanel({ React, h, requestFetch, requestAccess }) {
  const border = '1px solid var(--dsw-alias-border-l2,#cdd1d7)';
  const button = { border, borderRadius: 7, padding: '6px 10px', background: 'transparent', color: 'inherit', cursor: 'pointer' };
  async function request(action, input, signal) {
    const access = requestAccess();
    const response = await requestFetch(access.prefix + '/api/dsh-unified/plugin-sync/' + action, {
      method: 'POST', credentials: 'same-origin', headers: { ...access.headers, 'content-type': 'application/json' },
      body: JSON.stringify(input), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25_000)]) : AbortSignal.timeout(25_000),
    });
    let data; try { data = await response.json(); } catch {}
    if (!response.ok || data?.ok !== true) throw new Error(data?.error?.message || '插件同步服务暂时不可用，请刷新清单核对。');
    return data.value;
  }
  return function PluginSyncPanel({ hosts = [], onOpenTarget }) {
    const remotes = hosts.filter(host => host.id !== 'mac');
    const [target, setTarget] = React.useState(remotes[0]?.id || '');
    const [data, setData] = React.useState(null), [selected, setSelected] = React.useState([]);
    const [plan, setPlan] = React.useState(null), [job, setJob] = React.useState(null);
    const [busy, setBusy] = React.useState(false), [notice, setNotice] = React.useState(''), [statusUnknown, setStatusUnknown] = React.useState(false);
    const mounted = React.useRef(true), generation = React.useRef(0);
    const working = !statusUnknown && job && ['checking', 'installing'].includes(job.phase);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
    React.useEffect(() => {
      if (!remotes.some(host => host.id === target)) setTarget(remotes[0]?.id || '');
    }, [target, remotes.map(host => host.id).join(',')]);
    async function refresh() {
      if (!target) return;
      const current = ++generation.current; setBusy(true); setNotice(''); setPlan(null);
      try {
        const value = await request('inventory', { target });
        if (!mounted.current || generation.current !== current) return;
        setData(value); setSelected(old => old.filter(name => value.source.bundles.some(row => row.name === name && row.eligible)));
        if (value.activeJob) {
          const next = await request('status', { jobId: value.activeJob });
          if (!mounted.current || generation.current !== current) return;
          setStatusUnknown(false); setJob(next);
        } else if (statusUnknown) { setJob(null); setStatusUnknown(false); }
      } catch (error) { if (mounted.current && generation.current === current) { setData(null); setNotice(error.message); } }
      finally { if (mounted.current && generation.current === current) setBusy(false); }
    }
    React.useEffect(() => { setSelected([]); setData(null); setPlan(null); setJob(null); setStatusUnknown(false); void refresh(); }, [target]);
    React.useEffect(() => {
      if (!working) return;
      let closed = false, timer; const abort = new AbortController();
      async function poll() {
        try {
          const value = await request('status', { jobId: job.jobId }, abort.signal);
          if (closed) return; setJob(value);
          if (['checking', 'installing'].includes(value.phase)) timer = setTimeout(poll, 1500);
        } catch (error) { if (!closed) { setStatusUnknown(true); setNotice('状态读取中断。安装不会自动重试；请刷新清单核对。' + error.message); } }
      }
      timer = setTimeout(poll, 1000);
      return () => { closed = true; clearTimeout(timer); abort.abort(); };
    }, [job?.jobId, working]);
    async function preview() {
      const current = generation.current; setBusy(true); setNotice(''); setJob(null); setStatusUnknown(false);
      try { const value = await request('plan', { target, packages: selected }); if (mounted.current && generation.current === current) setPlan(value); }
      catch (error) { if (mounted.current) setNotice(error.message); }
      finally { if (mounted.current) setBusy(false); }
    }
    async function execute() {
      if (!plan) return;
      if (!globalThis.crypto?.randomUUID) { setNotice('浏览器缺少安全请求标识能力，请通过 HTTPS 或本机 App 打开。'); return; }
      setBusy(true); setNotice('');
      try {
        const value = await request('execute', { planId: plan.planId, requestId: crypto.randomUUID(), confirm: true });
        if (mounted.current) { setStatusUnknown(false); setJob(value); setPlan(null); }
      } catch (error) { if (mounted.current) { setNotice(error.message + ' 请刷新目标清单核对后再生成计划。'); setPlan(null); } }
      finally { if (mounted.current) setBusy(false); }
    }
    if (!remotes.length) return null;
    const label = remotes.find(host => host.id === target)?.label || target;
    const sourceRows = (data?.source.bundles || []).filter(row => row.installed);
    const cell = { textAlign: 'left', padding: '7px 6px', borderBottom: border, verticalAlign: 'top', fontSize: 12 };
    const state = row => !row ? '未安装 · 关闭' : (row.installed ? row.version || '已安装' : 'DSH 内置') + ' · ' + (row.enabled ? '已启用' : '关闭');
    return h('details', { style: { border, borderRadius: 12, padding: 14, margin: '10px 0 18px', flexShrink: 0 }, 'data-plugin-sync-panel': true },
      h('summary', { style: { cursor: 'pointer', fontWeight: 600 } }, '插件同步：Mac → 远端'),
      h('p', { style: { fontSize: 12, lineHeight: 1.7 } }, '选择 Mac 上的插件，先核对精确版本计划，再明确安装到远端。新安装包保持关闭；目标已有插件的启用状态和设置保持原值。'),
      h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' } },
        h('label', null, '目标主机 ', h('select', { value: target, disabled: busy || working, onChange: e => setTarget(e.target.value), style: { ...button, padding: 5 } },
          remotes.map(host => h('option', { key: host.id, value: host.id }, host.label || host.id)))),
        h('button', { type: 'button', style: button, disabled: busy || working, onClick: refresh }, busy ? '读取中…' : '刷新清单'),
        onOpenTarget && h('button', { type: 'button', style: button, onClick: () => onOpenTarget(target) }, '打开目标主机插件管理')),
      data && !data.destination.hotReload && h('p', { role: 'status', style: { fontSize: 12 } }, '目标未启用官方热重载，当前仅生成计划，安装需要维护窗口。'),
      data?.persistenceReady === false && h('p', { role: 'alert', style: { fontSize: 12 } }, '私有安装记录暂时不可用，当前只能查看计划；不会提交安装。'),
      h('div', { style: { overflowX: 'auto', marginTop: 10 } }, h('table', { style: { borderCollapse: 'collapse', width: '100%', minWidth: 450 } },
        h('thead', null, h('tr', null, ['选择', 'Mac 插件 / 版本', '目标安装 / 启用状态', '同步说明'].map(t => h('th', { key: t, style: cell }, t)))),
        h('tbody', null, sourceRows.map(row => {
          const to = data.destination.bundles.find(x => x.name === row.name);
          return h('tr', { key: row.name },
            h('td', { style: cell }, h('input', { type: 'checkbox', 'aria-label': '选择同步 ' + row.name,
              disabled: !row.eligible || busy || working, checked: selected.includes(row.name), onChange: e => {
                setPlan(null); setSelected(old => e.target.checked ? [...old, row.name] : old.filter(name => name !== row.name));
              } })),
            h('td', { style: cell }, h('div', { style: { overflowWrap: 'anywhere' } }, row.name), h('div', null, row.version, ' · ', row.enabled ? '已启用' : '关闭', row.active ? ' · 运行中' : '')),
            h('td', { style: cell }, state(to)),
            h('td', { style: cell }, row.reason || (to?.version === row.version ? '版本已相同，将保持目标状态。' : to?.installed ? '已有不同版本，需要独立维护。' : '可安装精确版本；安装后保持关闭。')));
        })))),
      h('p', { style: { fontSize: 12, opacity: 0.75, lineHeight: 1.6 } }, '同步仅处理插件包，不复制 API Key、账号、本机路径或源插件设置。不会重启服务、取消会话或自动批准依赖构建脚本。启用与配置请点击上方「打开目标主机插件管理」单独完成。'),
      h('button', { type: 'button', style: button, disabled: !selected.length || busy || working || !data, onClick: preview }, '查看 ' + selected.length + ' 项同步计划'),
      plan && h('section', { style: { marginTop: 14, padding: 12, border, borderRadius: 8 }, 'aria-label': '待确认的插件同步计划' },
        h('strong', null, '确认目标：', plan.targetLabel || label),
        h('ul', { style: { paddingLeft: 20, fontSize: 12, lineHeight: 1.8 } }, plan.rows.map(row => h('li', { key: row.name },
          row.name, '：', row.targetVersion || '未安装', ' → ', row.sourceVersion,
          '；启用：', row.targetEnabled ? '开启 → 开启' : '关闭 → 关闭', '；', row.reason))),
        plan.activeJob && h('p', { role: 'status', style: { fontSize: 12 } }, '此目标有进行中或待确认的安装，已锁定。请先刷新读取已有任务结果。'),
        h('button', { type: 'button', style: button, disabled: !plan.installs || !plan.hotReload || plan.persistenceReady === false || !!plan.activeJob || busy || working, onClick: execute },
          '确认将 ' + plan.installs + ' 个安装包同步到 ' + (plan.targetLabel || label) + '（保持关闭）')),
      job && h('section', { role: 'status', style: { fontSize: 12, lineHeight: 1.8, marginTop: 12 } },
        h('strong', null, statusUnknown ? '同步状态待核对' : job.phase === 'uncertain' ? '安装待确认，目标已锁定' : working ? '正在处理 ' + (job.current || job.targetLabel || label) : job.phase === 'complete' ? '同步处理完成' : '同步已停止'),
        h('div', null, job.message),
        job.results.map((row, i) => h('div', { key: row.name + i }, row.name, '：', row.verified ? '精确版本已安装，关闭' : '需要核对',
          ' · ', row.application, row.restartReason ? '（等待维护，本工具未重启）' : '', row.buildApprovalRequired ? ' · 依赖脚本需在官方插件页单独批准' : '', row.errorCode ? ' · ' + row.errorCode : ''))),
      notice && h('p', { role: 'alert', style: { fontSize: 12, lineHeight: 1.7 } }, notice));
  };
}
