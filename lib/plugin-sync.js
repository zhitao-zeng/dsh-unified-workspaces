// Package-only synchronization through the official DSH pluginManager Remote.
// Plans never contain source settings, local paths, account records or secrets.
import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, lstatSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateOrigin } from './config.js';

const PACKAGE = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const ACTIONS = new Set(['inventory', 'plan', 'execute', 'status']);
const record = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const digest = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const safeName = x => typeof x === 'string' && x.length <= 214 && PACKAGE.test(x);
const safeId = x => typeof x === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(x);
class Failure extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
const invalid = () => new Failure('plugin-sync/invalid-request', '插件同步请求无效。');
function excluded(name) {
  if (name === '@zhitao-zeng/dsh-unified-workspaces' || name.startsWith('@local/')) return '统一工作区及本机专用插件由各主机单独维护。';
  if (/remote[-_]?web|remote[-_]?control|tunnel|relay/i.test(name)) return '远程访问及隧道插件由目标主机单独维护，避免改变手机入口。';
  if (/macos|darwin|windows|win32|electron|desktop|ego-browser/i.test(name)) return '插件依赖本机桌面或操作系统，不能直接同步到服务器。';
  if (name.startsWith('@deepseek-ai/')) return '官方运行时组件由各主机的 DSH 安装管理。';
  return '';
}
function inventoryValue(bundles, plugins) {
  if (!Array.isArray(bundles) || !Array.isArray(plugins)) throw new Failure('plugin-sync/unavailable', '官方插件清单暂时不可用。', 503);
  const rows = bundles.filter(b => safeName(b?.name)).map(b => {
    const source = typeof b.source === 'string' ? b.source : '';
    const sourceKind = !source ? 'shipped' : source.startsWith(b.name + '@') && !/[:/\\\s]/.test(source.slice(b.name.length + 1)) ? 'registry' : 'local-or-custom';
    const states = plugins.filter(p => p.moduleName === b.name || p.moduleName?.startsWith(b.name + '/'));
    const reason = excluded(b.name) || (sourceKind !== 'registry' ? '仅支持注册表中的精确版本；本地安装包、链接和自定义地址不跨主机复制。' : '')
      || (b.installed !== true ? '此项由 DSH 安装提供。' : '') || (!VERSION.test(b.version || '') ? '未能确认源插件的精确版本。' : '')
      || (b.error ? '源插件存在兼容或加载问题，请先在源主机修复。' : '');
    return { name: b.name, version: typeof b.version === 'string' && VERSION.test(b.version) ? b.version : null,
      installed: b.installed === true, enabled: b.enabled === true, active: states.some(p => p.enabled === true && p.fiberPhase === 'active'),
      sourceKind, eligible: reason === '', reason };
  });
  return { bundles: rows, activeModules: plugins.filter(p => safeName(p.moduleName) && p.enabled === true && p.fiberPhase === 'active').map(p => p.moduleName).sort(),
    hotReload: plugins.some(p => p.moduleName === '@deepseek-ai/dsh-hmr' && p.enabled === true && p.fiberPhase === 'active') };
}
function inputValue(value, action, hosts) {
  if (!record(value)) throw invalid();
  const allowed = action === 'inventory' ? ['target'] : action === 'plan' ? ['target', 'packages']
    : action === 'execute' ? ['planId', 'requestId', 'confirm'] : ['jobId'];
  if (Object.keys(value).some(k => !allowed.includes(k))) throw invalid();
  if (['inventory', 'plan'].includes(action) && !hosts.has(value.target)) throw invalid();
  if (action === 'plan' && (!Array.isArray(value.packages) || !value.packages.length || value.packages.length > 32
      || !value.packages.every(safeName) || new Set(value.packages).size !== value.packages.length)) throw invalid();
  for (const k of ['planId', 'requestId', 'jobId']) if (allowed.includes(k)
      && (typeof value[k] !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value[k]))) throw invalid();
  if (action === 'execute' && value.confirm !== true) throw invalid();
  return value;
}
function cleanResult(result) {
  const application = ['applied', 'restart-required', 'failed', 'cancelled', 'overridden'].includes(result?.application) ? result.application : 'unknown';
  const errorCode = result?.error?.code || result?.errorCode;
  return { application, changed: result?.changed === true,
    ...(VERSION.test(result?.version || '') ? { version: result.version } : {}),
    ...(typeof result?.restartReason === 'string' && /^[a-z-]{1,64}$/.test(result.restartReason) ? { restartReason: result.restartReason } : {}),
    ...(typeof errorCode === 'string' && /^[a-z0-9/-]{1,100}$/i.test(errorCode) ? { errorCode } : {}),
    // Build scripts retain the official manager's separate approval workflow.
    buildApprovalRequired: result?.buildApprovalRequired === true || Array.isArray(result?.pendingBuilds) && result.pendingBuilds.length > 0 };
}

/** A write-ahead marker holds only operation identity, never credentials/config. */
function filePendingStore(file) {
  if (typeof file !== 'string' || !file) throw Error('Private pending store unavailable');
  let observed;
  function privateStat(stat) {
    if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600) throw Error('Invalid pending store');
  }
  function snapshot() {
    let fd;
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); privateStat(fstatSync(fd));
      if (fstatSync(fd).size > 128 * 1024) throw Error('Pending store too large');
      const raw = readFileSync(fd, 'utf8'), value = JSON.parse(raw);
      if (value?.version !== 1 || !Array.isArray(value.pending)) throw Error('Invalid pending store');
      return { revision: digest(raw), pending: value.pending };
    } catch (error) { if (error.code === 'ENOENT') return { revision: null, pending: [] }; throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return {
    read() { const value = snapshot(); observed = value.revision; return value.pending; },
    write(pending) {
      const temporary = file + '.' + randomUUID() + '.tmp', lock = file + '.lock'; let fd, lockFd, lockIdentity;
      try {
        // No wait/retry or stale-lock stealing: another process or a replaced
        // handler's write must be observed and reviewed before any dispatch.
        lockFd = openSync(lock, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW || 0), 0o600);
        lockIdentity = fstatSync(lockFd);
        if (observed === undefined || snapshot().revision !== observed) throw Error('Pending store revision changed');
        fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        const raw = JSON.stringify({ version: 1, pending }) + '\n';
        writeFileSync(fd, raw); fsyncSync(fd); closeSync(fd); fd = undefined;
        renameSync(temporary, file);
        const directory = openSync(dirname(file), constants.O_RDONLY);
        try { fsyncSync(directory); } finally { closeSync(directory); }
        observed = digest(raw);
      } catch (error) { if (fd !== undefined) closeSync(fd); try { unlinkSync(temporary); } catch {} throw error; }
      finally {
        if (lockFd !== undefined) {
          closeSync(lockFd);
          try { const stat = lstatSync(lock); if (stat.ino === lockIdentity.ino && stat.dev === lockIdentity.dev) unlinkSync(lock); } catch {}
        }
      }
    },
  };
}
function validPending(row) {
  const fields = ['host', 'originHash', 'name', 'version', 'installRequestId', 'jobId', 'requestId', 'startedAt', 'result'];
  const resultFields = ['application', 'changed', 'version', 'restartReason', 'errorCode', 'buildApprovalRequired'];
  return record(row) && Object.keys(row).every(k => fields.includes(k))
    && typeof row.host === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(row.host)
    && typeof row.originHash === 'string' && /^[a-f0-9]{64}$/.test(row.originHash)
    && row.host !== 'mac' && safeName(row.name) && VERSION.test(row.version || '') && safeId(row.installRequestId)
    && safeId(row.jobId) && safeId(row.requestId) && Number.isFinite(row.startedAt)
    && (row.result === undefined || record(row.result) && Object.keys(row.result).every(k => resultFields.includes(k)) && cleanResult(row.result).application !== 'unknown');
}

/** Source is always the local profile; callers can select only configured targets. */
export function createPluginSyncHandler({ authorize, connection, gateway, remotes = [], fetchImpl = fetch,
  now = Date.now, readTimeoutMs = 20_000, installTimeoutMs = 180_000, maxPlans = 64, pendingFile, pendingStore }) {
  const targets = new Map(remotes.map(r => [r.id, { ...r, origin: validateOrigin(r.origin) }]));
  const plans = new Map(), jobs = new Map(), hostJobs = new Map();
  const recoveries = new Map();
  let pending = new Map(), storageReady = true;
  try {
    pendingStore ||= filePendingStore(pendingFile);
    const rows = pendingStore.read();
    if (!Array.isArray(rows) || rows.length > 64 || !rows.every(validPending) || new Set(rows.map(row => row.host)).size !== rows.length) throw Error('Invalid pending markers');
    pending = new Map(rows.map(row => [row.host, row]));
    for (const row of rows) if (targets.has(row.host)) {
      const job = { jobId: row.jobId, requestId: row.requestId, target: row.host, targetLabel: targets.get(row.host).label,
        phase: 'uncertain', current: row.name, results: [], installRequestId: row.installRequestId,
        code: 'plugin-sync/result-uncertain', message: '上次安装尚无最终确认，目标保持锁定。请刷新读取官方结果，勿重复安装。', startedAt: row.startedAt };
      jobs.set(row.jobId, job); hostJobs.set(row.host, row.jobId);
    }
  } catch { storageReady = false; }
  function savePending(next) {
    try { pendingStore.write([...next.values()]); pending = next; }
    catch { storageReady = false; throw new Failure('plugin-sync/persistence-unavailable', '私有安装记录暂时无法保存，未继续安装；请在维护窗口检查。', 503); }
  }
  function setPending(row) { const next = new Map(pending); next.set(row.host, row); savePending(next); }
  function clearPending(host) { const next = new Map(pending); next.delete(host); savePending(next); }
  let disposed = false;
  async function rpc(host, namespace, method, args = {}, timeout = readTimeoutMs) {
    const signal = AbortSignal.timeout(timeout);
    if (host === 'mac') {
      const peer = connection.createPeer({ principal: { kind: 'owner' }, interactions: 'none' });
      try { return await gateway.invoke({ namespace, method, args, peer, signal }); }
      finally { await peer.dispose(); }
    }
    const remote = targets.get(host);
    if (!remote) throw invalid();
    const cookie = await remote.credential();
    const name = namespace + '/' + method, rpcId = 'plugin-sync-' + randomUUID();
    const response = await fetchImpl(remote.origin + '/api/' + name, { method: 'POST', redirect: 'error', signal,
      headers: { cookie, origin: remote.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: name, payload: { args } }) });
    const text = await response.text();
    if (text.length > 4 * 1024 * 1024) throw new Error('Plugin inventory unavailable');
    const envelope = JSON.parse(text);
    if (response.status !== 200 || envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result?.ok !== true) throw new Error('Official plugin operation unavailable');
    return envelope.result.value;
  }
  async function inventory(host) {
    const [bundles, plugins] = await Promise.all([rpc(host, 'pluginManager', 'listBundles'), rpc(host, 'pluginManager', 'listPlugins')]);
    return inventoryValue(bundles, plugins);
  }
  async function pair(target) {
    const [source, destination] = await Promise.all([inventory('mac'), inventory(target)]);
    return { source, destination };
  }
  function planRows(source, destination, names) {
    return names.map(name => {
      const from = source.bundles.find(b => b.name === name), to = destination.bundles.find(b => b.name === name);
      if (!from) throw invalid();
      let action = 'install', reason = from.reason;
      if (!from.eligible) action = 'blocked';
      else if (to?.installed || to?.sourceKind === 'shipped' && to.version) {
        action = to.version === from.version ? 'current' : 'maintenance';
        reason = action === 'current' ? '目标已是此版本，保持目标启用状态和配置。' : '目标已有不同版本；需要单独维护，当前会话期间不卸载或覆盖。';
      } else if (to?.enabled) { action = 'maintenance'; reason = '目标已选中但未安装，先在目标插件页检查配置。'; }
      else if (destination.activeModules.some(module => module === name || module.startsWith(name + '/'))) {
        action = 'maintenance'; reason = '目标已加载此模块，需要在目标插件页单独检查，当前不会覆盖。';
      }
      return { name, sourceVersion: from.version, targetVersion: to?.version || null, sourceEnabled: from.enabled,
        sourceActive: from.active, targetEnabled: to?.enabled === true, afterEnabled: to?.enabled === true,
        action, reason: reason || '安装此精确版本，保持关闭；请在目标的官方插件页单独启用和配置。' };
    });
  }
  function fingerprint(value, rows) {
    return digest({ source: value.source.bundles, target: value.destination.bundles, activeModules: value.destination.activeModules,
      hotReload: value.destination.hotReload, rows });
  }
  function publicPlan(plan) {
    return { planId: plan.id, target: plan.target, targetLabel: targets.get(plan.target).label,
      source: 'mac', rows: plan.rows, hotReload: plan.hotReload, expiresAt: plan.expiresAt,
      installs: plan.rows.filter(r => r.action === 'install').length,
      persistenceReady: storageReady, activeJob: hostJobs.get(plan.target) || null,
      settingsCopied: false, activationChanged: false, restartAllowed: false };
  }
  async function finishInstall(job, marker, result) {
    if (result.application === 'unknown') throw new Failure('plugin-sync/result-uncertain', '官方尚未返回确定的安装结果，目标继续锁定。请刷新核对。', 504);
    job.officialResult = result;
    setPending({ ...marker, result });
    const state = await inventory(marker.host), installed = state.bundles.find(b => b.name === marker.name);
    const verified = installed?.installed === true && installed.version === marker.version && installed.enabled === false;
    const row = { name: marker.name, ...result, verified, enabled: installed?.enabled === true };
    const previous = job.results.findIndex(r => r.name === marker.name);
    if (previous === -1) job.results.push(row); else job.results[previous] = row;
    // Only an explicit official outcome plus a successful final inventory read
    // retires the write-ahead marker. An exact version alone proves no outcome.
    clearPending(marker.host); delete job.officialResult; return row;
  }
  async function recover(job) {
    if (job.phase !== 'uncertain' || !pending.has(job.target)) return;
    if (pending.get(job.target).originHash !== digest(targets.get(job.target).origin)) {
      job.message = '目标连接配置已变化，无法对应上次安装；目标继续锁定，请先在维护窗口核对原主机。'; return;
    }
    if (recoveries.has(job.target)) return recoveries.get(job.target);
    const task = (async () => {
      const marker = pending.get(job.target);
      try {
        const raw = job.officialResult || marker.result || await rpc(job.target, 'pluginManager', 'waitForInstall', { requestId: marker.installRequestId });
        if (raw === null) { job.message = '官方暂未保留此安装的最终结果；清单相同也不足以证明完成。目标继续锁定，请在维护窗口核对。'; return; }
        const result = cleanResult(raw), row = await finishInstall(job, marker, result);
        job.phase = row.verified && ['applied', 'restart-required'].includes(result.application) ? 'complete' : 'stopped';
        job.code = job.phase === 'complete' ? undefined : 'plugin-sync/install-incomplete';
        job.needsMaintenance = result.application === 'restart-required';
        job.message = job.needsMaintenance ? '官方确认安装已保存但需要维护重启；本工具未重启，也未继续原计划后续项。'
          : job.phase === 'complete' ? '官方结果和目标清单已确认；此包保持关闭，原计划后续项未自动继续。' : '官方结果和目标清单已确认，安装未全部通过；原计划后续项未继续。';
        job.current = null; job.finishedAt = now(); hostJobs.delete(job.target);
      } catch { job.message = '安装结果仍待确认，目标继续锁定。可以刷新读取官方结果；不会重试安装或取消任务。'; }
    })().finally(() => recoveries.delete(job.target));
    recoveries.set(job.target, task); return task;
  }
  async function run(job, plan) {
    try {
      const value = await pair(plan.target), freshRows = planRows(value.source, value.destination, plan.names);
      if (fingerprint(value, freshRows) !== plan.fingerprint) throw new Failure('plugin-sync/plan-stale', '两边插件清单已变化，请刷新并重新确认计划。', 409);
      if (!value.destination.hotReload) throw new Failure('plugin-sync/maintenance-required', '目标未启用官方热重载；已保留计划，需要维护窗口后再操作。', 409);
      for (const row of plan.rows.filter(r => r.action === 'install')) {
        if (disposed) throw new Failure('plugin-sync/stopped', '管理模块已关闭，后续插件未安装。', 503);
        const latest = await inventory(plan.target), current = latest.bundles.find(b => b.name === row.name);
        if (!latest.hotReload || current?.installed || current?.enabled || current?.version
            || latest.activeModules.some(module => module === row.name || module.startsWith(row.name + '/'))) {
          throw new Failure('plugin-sync/plan-stale', '目标插件或热重载状态已变化，已停止后续安装。请刷新后重新确认。', 409);
        }
        const sessions = await rpc(plan.target, 'session', 'list', { _request: {} });
        if (!Array.isArray(sessions?.items) || !sessions.items.every(s => record(s) && typeof s.running === 'boolean')) throw new Error('Session status unavailable');
        if (sessions.items.some(s => s.running === true)) throw new Failure('plugin-sync/target-busy', '目标还有运行中的会话，未继续安装。请等空闲后刷新并重新确认。', 409);
        job.phase = 'installing'; job.current = row.name;
        // Never enable a new bundle or grant dependency build-script approval.
        // Once dispatched, an unknown result is never retried or cancelled here.
        const marker = { host: plan.target, originHash: digest(targets.get(plan.target).origin), name: row.name, version: row.sourceVersion,
          installRequestId: 'sync-' + randomUUID(), jobId: job.jobId, requestId: job.requestId, startedAt: job.startedAt };
        setPending(marker); job.installRequestId = marker.installRequestId;
        let result;
        try { result = cleanResult(await rpc(plan.target, 'pluginManager', 'installBundle', {
          spec: row.name + '@' + row.sourceVersion, options: { enabled: false, saveExact: true, requestId: marker.installRequestId },
        }, installTimeoutMs)); }
        catch { throw new Failure('plugin-sync/result-uncertain', '安装结果尚未确认，已停止后续插件。请刷新目标清单核对，勿重复提交。', 504); }
        const completed = await finishInstall(job, marker, result);
        if (!completed.verified || !['applied', 'restart-required'].includes(result.application)) throw new Failure('plugin-sync/install-incomplete', '安装未全部通过，已停止后续插件。请查看结果并在目标官方插件页处理。', 409);
        if (result.application === 'restart-required') { job.needsMaintenance = true; job.message = '安装包已保存但官方要求维护重启；本工具不会重启服务，后续插件未安装。'; break; }
      }
      job.phase = 'complete'; if (!job.needsMaintenance) job.message = '所选安装包已处理；新包保持关闭，启用和设置请在目标官方插件页完成。';
    } catch (error) {
      job.phase = pending.has(plan.target) ? 'uncertain' : 'stopped';
      job.code = pending.has(plan.target) ? 'plugin-sync/result-uncertain' : error instanceof Failure ? error.code : 'plugin-sync/unavailable';
      job.message = pending.has(plan.target) ? '安装结果尚未最终确认，目标保持锁定。请刷新读取官方结果，勿重复提交。'
        : error instanceof Failure ? error.message : '插件服务暂时不可用，已停止；请刷新清单核对后再操作。';
    } finally {
      if (!pending.has(plan.target)) { job.current = null; job.finishedAt = now(); hostJobs.delete(plan.target); }
    }
  }
  async function actionValue(action, input) {
    for (const [id, job] of jobs) if (job.finishedAt && job.finishedAt + 30 * 60_000 < now()) jobs.delete(id);
    for (const [id, plan] of plans) if (plan.expiresAt < now() && (!plan.started || !jobs.has(plan.jobId))) plans.delete(id);
    if (action === 'inventory') {
      const value = await pair(input.target);
      return { source: 'mac', target: input.target, targetLabel: targets.get(input.target).label, ...value,
        persistenceReady: storageReady, activeJob: hostJobs.get(input.target) || null };
    }
    if (action === 'plan') {
      if (plans.size >= maxPlans) throw new Failure('plugin-sync/busy', '待确认计划较多，请稍后重新打开。', 429);
      const value = await pair(input.target), rows = planRows(value.source, value.destination, input.packages);
      const plan = { id: randomUUID(), target: input.target, names: [...input.packages], rows,
        fingerprint: fingerprint(value, rows), hotReload: value.destination.hotReload, expiresAt: now() + 10 * 60_000, started: false };
      plans.set(plan.id, plan); return publicPlan(plan);
    }
    if (action === 'status') {
      const job = jobs.get(input.jobId); if (!job) throw new Failure('plugin-sync/not-found', '此任务已结束或记录已过期，请刷新插件清单。', 404);
      await recover(job);
      return { ...job, results: [...job.results] };
    }
    const plan = plans.get(input.planId);
    if (!plan || plan.expiresAt < now()) throw new Failure('plugin-sync/plan-expired', '计划已过期，请重新生成并确认。', 409);
    if (plan.started) {
      const job = jobs.get(plan.jobId);
      if (job?.requestId !== input.requestId) throw new Failure('plugin-sync/already-submitted', '此计划已提交，请查看已有结果，不要重复执行。', 409);
      return { ...job, results: [...job.results] };
    }
    if (hostJobs.has(plan.target)) throw new Failure('plugin-sync/busy', '目标正在处理另一个同步任务，请查看已有结果。', 409);
    if (!storageReady) throw new Failure('plugin-sync/persistence-unavailable', '私有安装记录暂时不可用，当前只能查看计划；请在维护窗口检查。', 503);
    if (!plan.rows.some(r => r.action === 'install')) throw new Failure('plugin-sync/no-installs', '计划中没有可安装的新包。', 409);
    const job = { jobId: randomUUID(), requestId: input.requestId, target: plan.target, targetLabel: targets.get(plan.target).label,
      phase: 'checking', current: null, results: [], message: '正在核对目标空闲状态和计划。', startedAt: now() };
    plans.set(plan.id, { ...plan, started: true, jobId: job.jobId }); jobs.set(job.jobId, job); hostJobs.set(plan.target, job.jobId);
    // Keep dispatched work independent from the browser's HTTP connection.
    void run(job, plan); return { ...job, results: [] };
  }
  const handler = async (action, req, res) => {
    const send = (status, value) => { if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); };
    try {
      if (disposed) throw new Failure('plugin-sync/unavailable', '插件同步服务已关闭。', 503);
      let allowed = false; try { allowed = await authorize(req); } catch {}
      if (!allowed) { req.resume(); throw new Failure('plugin-sync/unauthorized', '需要本机授权或已配对设备。', 403); }
      if (!ACTIONS.has(action) || req.method !== 'POST') { req.resume(); throw new Failure('plugin-sync/method-not-allowed', '请通过插件管理界面明确提交操作。', 405); }
      if (String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') { req.resume(); throw invalid(); }
      const chunks = []; let length = 0;
      for await (const chunk of req) { length += chunk.length; if (length > 16 * 1024) throw invalid(); chunks.push(chunk); }
      let input; try { input = inputValue(JSON.parse(Buffer.concat(chunks).toString('utf8')), action, targets); } catch { throw invalid(); }
      send(200, { ok: true, value: await actionValue(action, input) });
    } catch (error) {
      const e = error instanceof Failure ? error : new Failure('plugin-sync/unavailable', '插件清单暂时不可用，请稍后刷新。', 503);
      send(e.status, { ok: false, error: { code: e.code, message: e.message } });
    }
  };
  handler.close = () => { disposed = true; /* Never cancel an already dispatched official install. */ };
  return handler;
}
