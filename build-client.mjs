import fs from 'node:fs';
const ids = JSON.parse(fs.readFileSync(new URL('./remote-client-ids.json', import.meta.url), 'utf8'));
let template = fs.readFileSync(new URL('./client-main.template.js', import.meta.url), 'utf8');
const helpers = fs.readFileSync(new URL('./lib/transport.js', import.meta.url), 'utf8').replaceAll('export ', '');
const persistent = fs.readFileSync(new URL('./persistent-parent.template.js', import.meta.url), 'utf8');
const pluginSync = fs.readFileSync(new URL('./plugin-sync.template.js', import.meta.url), 'utf8');
const picker = fs.readFileSync(new URL('./lib/picker.js', import.meta.url), 'utf8');
const start = picker.indexOf('\t\tvar module =');
const end = picker.lastIndexOf('\n\t}\n});');
if (start < 0 || end < start) throw new Error('Unexpected pinned official picker bundle');
template = template.replace('/* REMOTE_CLIENT_IDS */', () => ids.map(id => JSON.stringify(id)).join(',')).replace('/* PERSISTENT_HELPERS */', () => persistent).replace('/* PLUGIN_SYNC */', () => pluginSync).replace('/* ROUTING_HELPERS */', () => helpers).replace(/^[ \t]*\/\* PICKER_MODULE \*\//m, () => picker.slice(start, end));
fs.writeFileSync(new URL('./lib/client.js', import.meta.url), template);

const boot = fs.readFileSync(new URL('./boot.template.js', import.meta.url), 'utf8').replace('/* ROUTING_HELPERS */', () => helpers).replace('/* HOST_CLIENT_IDS */', () => JSON.stringify([...ids, '@zhitao-zeng/dsh-unified-workspaces', '@linxin666/dsh-remote-web-ui']));
fs.writeFileSync(new URL('./lib/boot.js', import.meta.url), boot);

for (const [source, output] of [['embed-prelude.template.js', 'lib/embed-prelude.js'], ['companion.template.js', 'lib/embed-companion.js']]) fs.writeFileSync(new URL(output, import.meta.url), fs.readFileSync(new URL(source, import.meta.url), 'utf8').replace('/* ROUTING_HELPERS */', () => helpers));
