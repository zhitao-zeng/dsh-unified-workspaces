import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('SSH signer uses an existing grant, exact local authority and status-only checks without remote mutation', () => {
  const helper = fileURLToPath(new URL('../scripts/ssh-browser-cookie.py', import.meta.url));
  const program = String.raw`
import base64, contextlib, hashlib, hmac, http.server, importlib.util, io, json, os, sys, tempfile, threading, types
from unittest.mock import patch
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('helper',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
assert m.normalize_origin('http://[::1]:43081')=='http://[::1]:43081'
assert m.normalize_origin('http://localhost:80')=='http://localhost'
for raw in ['https://127.0.0.1:43081','http://example.test:43081','http://user@127.0.0.1:43081','http://127.0.0.1:43081/path','http://127.0.0.1:43081?q=1']:
    try:m.normalize_origin(raw)
    except ValueError:pass
    else:raise AssertionError('Unsafe origin accepted')
secret=bytes(range(32));b64=lambda value:base64.urlsafe_b64encode(value).decode().rstrip('=')
origin='http://127.0.0.1:43081';authority='127.0.0.1:43081';seen=[]
class MockDsh(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def do_POST(self):
        assert self.path=='/api/session/list'
        assert self.headers['Host']==authority and self.headers['Origin']==origin
        name,cookie=self.headers['Cookie'].split('=',1)
        assert name=='dsh-auth-'+b64(hashlib.sha256(authority.encode()).digest())
        version,body,signature=cookie.split('.')
        assert version=='v1' and hmac.compare_digest(signature,b64(hmac.new(secret,body.encode(),hashlib.sha256).digest()))
        payload=json.loads(base64.urlsafe_b64decode(body+'='*(-len(body)%4)))
        assert payload['authority']==authority and payload['expiresAt']-payload['issuedAt']==300000
        request=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert request['method']=='session/list';seen.append(request['method'])
        response=json.dumps({'type':'server-response','rpcId':request['rpcId'],'result':{'ok':True,'value':{'items':[]}}}).encode()
        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(response)
server=http.server.HTTPServer(('127.0.0.1',0),MockDsh)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
    with tempfile.TemporaryDirectory(prefix='dsh-unified-signer-fixture-') as home:
        path=os.path.join(home,'.credentials.yaml');open(path,'w').write('synthetic fixture')
        before=open(path,'rb').read()
        credentials={'records':{'@example/client-connection/browser-session':{'kind':'grant','payload':{'version':1,'secret':b64(secret)}}}}
        yaml=types.SimpleNamespace(safe_load=lambda stream:credentials)
        configuration={'dshHome':home,'origin':origin,'remotePort':server.server_port,'service':None}
        output=io.StringIO()
        with patch.dict(sys.modules,{'yaml':yaml}),contextlib.redirect_stdout(output):
            exec(compile(m.remote_program(configuration),'<synthetic-remote-helper>','exec'),{})
        result=json.loads(output.getvalue());assert result['active'] is True and result['origin']==origin
        assert seen==['session/list'] and open(path,'rb').read()==before
        argv=['helper','--ssh-host','worker-a','--dsh-home',home,'--origin',origin,'--remote-port',str(server.server_port),'--check']
        def fake_ssh(args,**kwargs):
            assert args[:3]==['ssh','-o','BatchMode=yes']
            assert 'StrictHostKeyChecking=yes' in args and args[-2:]==['worker-a','python3 -']
            assert kwargs.get('check') is False and 'shell' not in kwargs
            assert kwargs['input'].startswith('CONFIG = ')
            return types.SimpleNamespace(returncode=0,stdout=json.dumps(result))
        output=io.StringIO()
        with patch.object(sys,'argv',argv),patch.object(m.subprocess,'run',fake_ssh),contextlib.redirect_stdout(output):
            assert m.main()==0
        status=json.loads(output.getvalue());assert status=={'ok':True,'origin':origin,'active':True}
        assert 'cookie' not in output.getvalue() and result['cookieValue'] not in output.getvalue()
        yaml.safe_load=lambda stream:{'records':{}}
        stdout,stderr=io.StringIO(),io.StringIO()
        with patch.dict(sys.modules,{'yaml':yaml}),contextlib.redirect_stdout(stdout),contextlib.redirect_stderr(stderr):
            try:exec(compile(m.remote_program(configuration),'<missing-existing-grant>','exec'),{})
            except SystemExit as error:assert error.code==1
            else:raise AssertionError('Missing existing grant accepted')
        assert stdout.getvalue()=='' and open(path,'rb').read()==before
finally:
    server.shutdown();server.server_close();thread.join(timeout=2)
print('Offline signer HMAC, authority, no-create and status-only checks passed.')
`;
  const output = execFileSync('python3', ['-c', program, helper], { encoding: 'utf8', timeout: 15_000 });
  assert.match(output, /checks passed/);
});
