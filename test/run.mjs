// Runs every suite in this directory and reports one line for all of them.
//
// Each suite is its own process on purpose: they install a plugin, some of them start a helper
// and a browser, and one of them must be able to fail without dragging the rest down with it.
// A single process would let one suite's leftover state change another suite's answer, which is
// the kind of failure that takes an afternoon to find.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const suites = fs.readdirSync(here)
  .filter((name) => name.endsWith('-test.mjs'))
  .sort();

const results = [];
for (const name of suites) {
  process.stdout.write(`\n--- ${name} ---\n`);
  const started = Date.now();
  const run = spawnSync(process.execPath, [path.join(here, name)], { stdio: 'inherit', cwd: here });
  results.push({ name, code: run.status ?? 1, ms: Date.now() - started });
}

console.log('\n=========== suites ===========');
for (const { name, code, ms } of results) {
  console.log(`  ${code === 0 ? 'PASS' : 'FAIL'}  ${name.padEnd(22)} ${String(ms).padStart(6)} ms`);
}
const failed = results.filter((entry) => entry.code !== 0);
console.log(`\n  ${results.length - failed.length} of ${results.length} suites passed`);
process.exit(failed.length === 0 ? 0 : 1);
