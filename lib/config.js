import { readFileSync, openSync, fstatSync, closeSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const RESERVED = new Set(['mac', '__proto__', 'constructor', 'prototype']);
export function validHostId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value) && !RESERVED.has(value);
}
export function validateOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid remote origin'); }
  if (typeof value !== 'string' || url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[0-9]{1,5})?$/.test(value)
      || Number(url.port || 80) < 1 || Number(url.port || 80) > 65535) {
    throw new Error('Remote origin must be an explicit loopback HTTP port');
  }
  return url.origin;
}
export function routesForHost(id) {
  if (!validHostId(id)) throw new Error('Invalid remote host id');
  const prefix = '/api/dsh-unified/hosts/' + id;
  return Object.freeze({ native: prefix + '/native', appearance: prefix + '/appearance',
    embed: prefix + '/embed', status: prefix + '/status', mux: '/dsh-unified/hosts/' + id + '/remote.mux' });
}
export function parseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== 1
      || Object.keys(value).some(key => !['version', 'hosts', 'legacyHostId'].includes(key))
      || !Array.isArray(value.hosts) || value.hosts.length > 32) throw new Error('Invalid unified workspace configuration');
  const ids = new Set();
  const hosts = value.hosts.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row)
        || Object.keys(row).some(key => !['id', 'label', 'origin', 'credentialCommand', 'remoteTree'].includes(key))
        || !validHostId(row.id) || ids.has(row.id) || typeof row.label !== 'string'
        || !row.label.trim() || row.label.length > 128 || /[\u0000-\u001f]/.test(row.label)
        || !Array.isArray(row.credentialCommand) || row.credentialCommand.length < 1 || row.credentialCommand.length > 64
        || !row.credentialCommand.every(arg => typeof arg === 'string' && arg.length <= 8192 && !arg.includes('\0'))
        || !isAbsolute(row.credentialCommand[0])
        || row.remoteTree !== undefined && typeof row.remoteTree !== 'boolean') throw new Error('Invalid remote host configuration');
    ids.add(row.id);
    return Object.freeze({ id: row.id, label: row.label, origin: validateOrigin(row.origin),
      credentialCommand: Object.freeze([...row.credentialCommand]), remoteTree: row.remoteTree === true });
  });
  if (value.legacyHostId !== undefined && (!validHostId(value.legacyHostId) || !ids.has(value.legacyHostId))) {
    throw new Error('Legacy host must identify one configured remote');
  }
  return Object.freeze({ version: 1, hosts: Object.freeze(hosts), ...(value.legacyHostId === undefined ? {} : { legacyHostId: value.legacyHostId }) });
}
export function loadConfig({ env = process.env, home = homedir(), readFile = readFileSync,
  openFile = openSync, fileStat = fstatSync, closeFile = closeSync } = {}) {
  const path = env.DSH_UNIFIED_CONFIG || join(home, '.config/dsh-unified-workspaces/hosts.json');
  if (!isAbsolute(path)) throw new Error('Unified workspace configuration path must be absolute');
  let descriptor;
  try { descriptor = openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error?.code === 'ENOENT') return parseConfig({ version: 1, hosts: [] }); throw new Error('Unified workspace configuration unavailable'); }
  try {
    const info = fileStat(descriptor);
    if (!info.isFile() || info.size > 256 * 1024
        || typeof process.getuid === 'function' && info.uid !== process.getuid()
        || (info.mode & 0o022) !== 0) throw new Error('Unified workspace configuration must be an owner-controlled regular file');
    try { return parseConfig(JSON.parse(readFile(descriptor, 'utf8'))); }
    catch { throw new Error('Unified workspace configuration is invalid'); }
  } finally { closeFile(descriptor); }
}
