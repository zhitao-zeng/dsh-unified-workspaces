#!/usr/bin/env python3
"""Sign a five-minute browser grant from an existing remote DSH Home over SSH.

Normal stdout is a private machine-readable credential response. Use --check
for a status-only health check. Never run this command with shell tracing.
The remote host needs Python 3 and PyYAML already installed.
"""
import argparse
import json
import os
import re
import subprocess
import sys
from urllib.parse import urlsplit


def normalize_origin(raw):
    value = urlsplit(raw)
    if value.scheme != 'http' or value.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('A loopback HTTP origin is required')
    if value.username or value.password or value.path or value.query or value.fragment:
        raise ValueError('Only a loopback HTTP origin is accepted')
    port = value.port or 80
    if not 1 <= port <= 65535:
        raise ValueError('Invalid origin port')
    host = '[::1]' if value.hostname == '::1' else value.hostname
    return 'http://' + host + (':' + str(port) if port != 80 else '')


def remote_program(configuration):
    # All editable data goes through JSON on stdin. The remote shell only sees
    # the fixed command `python3 -`, never interpolated paths or credentials.
    return "CONFIG = " + repr(configuration) + "\n" + r'''
import base64
import hashlib
import hmac
import json
import os
import subprocess
import sys
import time
import urllib.request

def main():
    import yaml
    path = os.path.join(CONFIG['dshHome'], '.credentials.yaml')
    if not os.path.isfile(path) or os.path.getsize(path) > 4 * 1024 * 1024:
        raise RuntimeError('Unavailable')
    with open(path, 'r', encoding='utf-8') as stream:
        records = (yaml.safe_load(stream) or {}).get('records', {})
    matches = [value for key, value in records.items()
               if 'client-connection' in str(key) and 'browser-session' in str(key)]
    if len(matches) != 1:
        raise RuntimeError('Unavailable')
    record = matches[0]
    if record.get('kind') != 'grant' or record.get('payload', {}).get('version') != 1:
        raise RuntimeError('Unavailable')
    encoded = record['payload'].get('secret')
    if not isinstance(encoded, str):
        raise RuntimeError('Unavailable')
    secret = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
    if len(secret) != 32:
        raise RuntimeError('Unavailable')
    service = CONFIG.get('service')
    if service:
        result = subprocess.run(['systemctl', '--user', 'show', '--property=ActiveState,MainPID', '--', service],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=8, text=True)
        rows = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if result.returncode or rows.get('ActiveState') != 'active' or not rows.get('MainPID', '').isdigit() or int(rows['MainPID']) <= 0:
            raise RuntimeError('Unavailable')
    authority = CONFIG['origin'].split('://', 1)[1]
    issued = int(time.time() * 1000)
    b64 = lambda data: base64.urlsafe_b64encode(data).decode('ascii').rstrip('=')
    body = b64(json.dumps({'version': 1, 'authority': authority,
                           'issuedAt': issued, 'expiresAt': issued + 300000}, separators=(',', ':')).encode())
    name = 'dsh-auth-' + b64(hashlib.sha256(authority.encode()).digest())
    value = 'v1.' + body + '.' + b64(hmac.new(secret, body.encode(), hashlib.sha256).digest())
    # A successful authenticated read proves the existing listener and Home
    # agree. This does not create a session, start a Host or invoke a model.
    payload = json.dumps({'type': 'client-request', 'rpcId': 'unified-credential-probe',
                          'method': 'session/list', 'payload': {'args': {'_request': {}}}}).encode()
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request('http://127.0.0.1:' + str(CONFIG['remotePort']) + '/api/session/list',
                                     data=payload, method='POST',
                                     headers={'Host': authority, 'Origin': CONFIG['origin'],
                                              'Cookie': name + '=' + value, 'Content-Type': 'application/json',
                                              'Sec-Fetch-Site': 'same-origin'})
    with opener.open(request, timeout=10) as response:
        raw = response.read(16 * 1024 * 1024 + 1)
        if response.status != 200 or len(raw) > 16 * 1024 * 1024:
            raise RuntimeError('Unavailable')
    envelope = json.loads(raw)
    items = envelope.get('result', {}).get('value', {}).get('items')
    if envelope.get('result', {}).get('ok') is not True or not isinstance(items, list):
        raise RuntimeError('Unavailable')
    print(json.dumps({'origin': CONFIG['origin'], 'active': True, 'cookieName': name, 'cookieValue': value}))

try:
    main()
except Exception:
    print('Existing remote DSH grant or listener unavailable.', file=sys.stderr)
    sys.exit(1)
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ssh-host', required=True, help='An existing SSH config alias')
    parser.add_argument('--dsh-home', required=True, help='Existing absolute DSH Home on the remote host')
    parser.add_argument('--origin', required=True, help='Local loopback HTTP origin of the existing SSH tunnel')
    parser.add_argument('--remote-port', type=int, default=3080, help='Existing remote DSH listener port')
    parser.add_argument('--service', help='Optional existing systemd user service to verify, never start')
    parser.add_argument('--check', action='store_true', help='Print status only, no credential')
    args = parser.parse_args()
    try:
        origin = normalize_origin(args.origin)
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}', args.ssh_host):
            raise ValueError('Invalid SSH alias')
        if not args.dsh_home.startswith('/') or '\x00' in args.dsh_home or len(args.dsh_home) > 8192:
            raise ValueError('Invalid existing DSH Home')
        if not 1 <= args.remote_port <= 65535:
            raise ValueError('Invalid existing DSH port')
        if args.service and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@:-]{0,127}', args.service):
            raise ValueError('Invalid user service name')
        configuration = {'dshHome': args.dsh_home, 'origin': origin,
                         'remotePort': args.remote_port, 'service': args.service}
        result = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '--', args.ssh_host, 'python3 -'],
                                input=remote_program(configuration), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, timeout=35, check=False)
        if result.returncode or len(result.stdout) > 16 * 1024:
            raise RuntimeError('Unavailable')
        value = json.loads(result.stdout)
        if value.get('origin') != origin or value.get('active') is not True:
            raise RuntimeError('Unavailable')
        if args.check:
            print(json.dumps({'ok': True, 'origin': origin, 'active': True}))
        else:
            print(json.dumps(value))
        return 0
    except Exception:
        # SSH errors and provider stdout may contain sensitive data; never echo.
        print('Existing remote DSH credential check failed. Verify SSH access, DSH Home, listener and remote PyYAML.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
