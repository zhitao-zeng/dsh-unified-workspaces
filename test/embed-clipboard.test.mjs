import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
// Cross-origin remote frames need an explicit clipboard-write delegation.
// Permissions Policy defaults `clipboard-write` to `self`, so without the
// attribute navigator.clipboard.writeText throws NotAllowedError inside the
// frame and the remote UI's copy button silently does nothing. DSH's own
// writeClipboard helper has no execCommand fallback when writeText exists but
// throws, so the grant has to live on the iframe.
const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const FRAME = /'data-persistent-remote-frame': true[\s\S]{0,600}?\}\s*\)/;

function frameElement(source) {
  const match = FRAME.exec(source);
  assert.ok(match, 'the remote frame element must exist');
  return match[0];
}

test('the remote frame delegates clipboard-write so its copy buttons work', () => {
  for (const file of ['client-main.template.js', 'lib/client.js']) {
    const element = frameElement(read(file));
    assert.match(element, /allow: 'clipboard-write'/, file + ' must grant clipboard-write to the frame');
  }
});

test('the remote frame does not delegate clipboard-read', () => {
  for (const file of ['client-main.template.js', 'lib/client.js']) {
    const element = frameElement(read(file));
    assert.ok(!element.includes('clipboard-read'), file + ' must not let the frame read the clipboard');
  }
});

test('the remote frame keeps its sandbox restrictions', () => {
  for (const file of ['client-main.template.js', 'lib/client.js']) {
    const element = frameElement(read(file));
    assert.match(element, /sandbox: 'allow-scripts allow-same-origin allow-forms allow-downloads'/, file + ' must keep the documented sandbox tokens');
    assert.ok(!/allow-popups|allow-top-navigation|allow-modals/.test(element), file + ' must not widen the sandbox');
  }
});
