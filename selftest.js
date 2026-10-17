// Does this plugin work on THIS machine?
//
// A recipient has no way to tell a broken install from a broken machine, and the
// plugin's real dependencies are all outside Node: PowerShell, the C# compiler that
// `Add-Type` invokes, DPI awareness, the overlay's layered windows. This runs the
// smallest set of checks that separates "installed correctly" from "will not work
// here", and it prints what it found rather than only a pass or fail.
//
//   node selftest.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n        ${detail}` : ''}`);
};

console.log(`computer-control self-test on ${process.platform} ${process.arch}, Node ${process.version}\n`);

check('running on Windows', process.platform === 'win32', process.platform === 'win32' ? 'windows' : `this plugin drives the Windows desktop through user32/gdi32 and cannot work on ${process.platform}`);

// The shipped files, before anything is executed.
for (const required of ['index.js', 'client.js', 'cordis.patch.yml', 'native/agent.ps1', 'native/native.cs', 'native/overlay.cs']) {
  const present = await fs.access(path.join(HERE, required)).then(() => true, () => false);
  check(`the package carries ${required}`, present, present ? undefined : 'missing from the installed copy');
}

let bridge;
try {
  const { NativeBridge } = await import('./lib/bridge.js');
  bridge = new NativeBridge({ logger: { info: () => {}, warn: (m) => console.log(`        [helper] ${m}`), error: () => {}, debug: () => {} } });

  const started = Date.now();
  const info = await bridge.call('screen.info', {}, { timeoutMs: 60_000 });
  check('the native helper starts and answers', info !== null && typeof info === 'object',
    `took ${Date.now() - started} ms. This is where PowerShell and the C# compiler are exercised; a failure here names what is missing rather than leaving the plugin silently inert.`);

  check('the desktop is measured in physical pixels', info?.dpiMode === 'per-monitor-v2',
    `dpiMode=${info?.dpiMode} virtual=${info?.virtualScreen?.width}x${info?.virtualScreen?.height} scale=${info?.monitors?.[0]?.scale}`);

  const capture = await bridge.call('screen.capture', { x: 0, y: 0, width: 64, height: 64, hwnd: '', maxDim: 64, scale: 0, format: 'png', quality: 80, out: path.join(HERE, 'selftest-capture.png') }, { timeoutMs: 60_000 });
  check('a capture can be taken and written', capture?.width > 0 && capture?.bytes > 0, `${capture?.width}x${capture?.height}, ${capture?.bytes} bytes`);
  await fs.rm(path.join(HERE, 'selftest-capture.png'), { force: true });

  const overlay = await bridge.call('overlay.start', { claim: false }, { timeoutMs: 20_000 });
  check('the on-screen indicator can be created', overlay?.available === true,
    overlay?.available === true ? `theme=${overlay.theme}` : `unavailable: ${overlay?.reason ?? 'unknown'}. Input and capture still work without it.`);
  if (overlay?.available === true) await bridge.call('overlay.stop', {}, { timeoutMs: 10_000 }).catch(() => {});
} catch (error) {
  check('the native helper starts and answers', false, `${error?.name}: ${error?.message}`);
} finally {
  bridge?.dispose();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed`);
if (failed.length > 0) {
  console.log('\nA failure above is a fact about this machine, not a bug report to guess at:');
  console.log('  * PowerShell: the helper tries DSH_COMPUTER_CONTROL_PWSH, then pwsh, then Windows PowerShell 5.1.');
  console.log('  * The C# compiler ships with .NET Framework and is invoked by Add-Type on first use.');
  console.log('  * Everything else names itself in its own message.');
}
process.exit(failed.length === 0 ? 0 : 1);
