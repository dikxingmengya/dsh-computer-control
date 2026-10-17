import { fileURLToPath } from 'node:url';
import os from 'node:os';
// Verifies the /computer-activity command: the flags, both output forms, and that
// it reports the same operations the tool does.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = await import(pathToFileURL(path.join(ROOT, 'index.js')).href);

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${String(detail).slice(0, 600)}` : ''}`);
};

let command;
const tools = new Map();
plugin.apply({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  tools: { register: (d) => { tools.set(d.name, d); return () => {}; } },
  commands: { register: (definition) => { command = definition; return () => {}; } },
  effect: (f) => { f(); return () => {}; },
  inject: () => {},
  get: (key) => (key === 'commands' ? { register: (definition) => { command = definition; return () => {}; } } : undefined),
  systemPrompt: { getSectionOrder: () => 3000, section: () => () => {} },
}, { artifactDir: path.join(os.tmpdir(), 'dsh-cc-command-artifacts'), indicatorLanguage: 'zh', indicatorTheme: 'light', indicatorClaimScreen: false, activityLogToFile: false, dryRun: false });

check('the Host registers /computer-activity', command?.name === 'computer-activity', JSON.stringify({ name: command?.name, id: command?.definitionId, description: command?.description }));

const exec = { callId: 't', rootCallId: 't', name: 't', arguments: {}, agent: { id: 'command-test' }, signal: new AbortController().signal, deferContext: () => {}, concludeTurn: () => {} };
const call = (name, args) => tools.get(name).execute(args, { ...exec, name, arguments: args });
const invoke = (rawInput) => command.handler({ agent: { id: 'command-test' }, rawInput, signal: new AbortController().signal, commandId: 'c1' });

await call('mouse_control', { action: 'move', x: 10, y: 20 });
await call('screen_capture', { target: 'region', region: { x: 0, y: 0, width: 40, height: 30 }, maxDim: 40, attach: false });
try { await call('system_control', { action: 'lock' }); } catch { /* the risk gate is expected to refuse */ }

const json = await invoke('--json --limit 50');
let payload;
try { payload = JSON.parse(json.text); } catch (error) { payload = null; }
check('--json returns the machine-readable form the page parses', json.kind === 'success' && payload !== null, JSON.stringify(payload).slice(0, 400));
check('it carries the same operations the tool lists', (payload?.entries?.length ?? 0) >= 3, `${payload?.entries?.length} entries, total ${payload?.total}`);

const table = await invoke('');
check('without --json it answers with a readable table', table.kind === 'success' && table.text.includes('鼠标') && table.text.includes('截屏'), table.text.split('\n').slice(0, 4).join('\n'));

const byKind = await invoke('--json --kind screen');
const capturePayload = byKind.kind === 'success' ? JSON.parse(byKind.text) : { entries: [] };
check('--kind filters', capturePayload.entries.length > 0 && capturePayload.entries.every((e) => e.kind === 'screen'), capturePayload.entries.map((e) => e.summary).join(', '));

const badFlag = await invoke('--nonsense');
check('a typo fails loudly instead of answering a different question', badFlag.kind === 'error' && /Usage|用法/.test(badFlag.text), badFlag.text.split('\n')[0]);

const badKind = await invoke('--kind nonsense');
check('an unknown kind is rejected', badKind.kind === 'error', badKind.text.split('\n')[0]);

const badLimit = await invoke('--limit abc');
check('a bad limit is rejected', badLimit.kind === 'error', badLimit.text.split('\n')[0]);

const failed = results.filter((r) => !r.ok).length;
console.log(`\n=========== ${results.length - failed} passed, ${failed} failed ===========`);
process.exit(failed === 0 ? 0 : 1);
