import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { validateOrigin } from './config.js';

const execute = promisify(execFile);
export function validateCredential(value, origin, now = Date.now()) {
  origin = validateOrigin(origin);
  const authority = new URL(origin).host;
  const expectedName = 'dsh-auth-' + createHash('sha256').update(authority).digest('base64url');
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.origin !== origin
      || value.active !== true || value.cookieName !== expectedName || typeof value.cookieValue !== 'string'
      || value.cookieValue.length > 8192 || !/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.cookieValue)) throw new Error('Remote credential rejected');
  const [, raw, signature] = value.cookieValue.split('.');
  let body;
  try { body = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { throw new Error('Remote credential rejected'); }
  if (Buffer.from(signature, 'base64url').length !== 32 || body?.version !== 1 || body.authority !== authority
      || !Number.isSafeInteger(body.issuedAt) || !Number.isSafeInteger(body.expiresAt)
      || body.issuedAt > now + 30_000 || body.expiresAt <= now + 5000
      || body.expiresAt <= body.issuedAt || body.expiresAt - body.issuedAt > 300_000
      || body.expiresAt > now + 330_000) throw new Error('Remote credential rejected');
  return { cookie: value.cookieName + '=' + value.cookieValue, expiresAt: body.expiresAt };
}
export function createCredentialProvider(host, { executeImpl = execute, now = Date.now } = {}) {
  let cache, pending, disposed = false;
  const credential = async () => {
    if (disposed) throw new Error('Remote credential provider stopped');
    if (cache && cache.until > now()) return cache.cookie;
    if (!pending) pending = (async () => {
      let value;
      try {
        const [executable, ...args] = host.credentialCommand;
        const result = await executeImpl(executable, args, { timeout: 45_000, maxBuffer: 16 * 1024,
          encoding: 'utf8', windowsHide: true, shell: false });
        value = JSON.parse(result.stdout);
      } catch { throw new Error('Remote credential unavailable'); }
      const checked = validateCredential(value, host.origin, now());
      if (disposed) throw new Error('Remote credential provider stopped');
      cache = { ...checked, until: Math.min(now() + 60_000, checked.expiresAt - 5000) };
      return cache.cookie;
    })().finally(() => { pending = undefined; });
    return pending;
  };
  credential.invalidate = () => { cache = undefined; };
  credential.close = () => { disposed = true; cache = undefined; };
  return credential;
}
