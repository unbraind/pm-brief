/** Execute the Windows documentation gate with each native command failing in turn. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';

test('Windows documentation validation preserves every native command failure', () => {
  const workflow = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  const step = workflow.jobs['audit-windows'].steps.find((step: { name: string }) => step.name === 'Check documentation and tracker changes');
  assert.equal(step.shell, 'bash');
  const root = mkdtempSync(join(tmpdir(), 'brief-docs-gate-'));
  try {
    const log = join(root, 'calls');
    const commands = step.run.trim().split('\n').filter((line: string) => !line.startsWith('set '));
    for (let failure = 1; failure <= commands.length; failure++) {
      writeFileSync(log, '');
      const stub = `count=0
node() { check; }
npm() { check; }
check() { count=$((count+1)); echo "$count" >> "$CALL_LOG"; if [ "$count" -eq "$FAIL_AT" ]; then return 17; fi; }
`;
      const result = spawnSync('bash', ['-c', stub + step.run], { encoding: 'utf8', env: { ...process.env, CALL_LOG: log, FAIL_AT: String(failure) } });
      assert.equal(result.status, 17, result.stderr);
      assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, failure);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
