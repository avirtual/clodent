import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNNER = path.join(ROOT, 'scripts', 'run-tests.js');
const FIXTURES = path.join(ROOT, 'test', 'fixtures', 'runner');

function runRunner(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [RUNNER, ...args], { cwd: ROOT, env, encoding: 'utf8' });
  const lines = res.stdout.split('\n').filter((line) => line.trim());
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, lines };
}

function assertTotals(result, totals) {
  assert.equal(result.lines.at(-1), totals);
  assert.ok(result.stdout.endsWith(`${totals}\n`), `stdout ends with TOTALS: ${JSON.stringify(result.stdout)}`);
  assert.ok(!result.stderr.includes('TOTALS:'), 'TOTALS absent from stderr');
}

describe('scripts/run-tests.js', () => {
  it('prints zero totals and exits 0 when no test files are found', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'empty')]);
    assertTotals(result, 'TOTALS: 0 pass, 0 fail, 0 tests');
    assert.equal(result.code, 0);
  });

  it('counts leaf tests only, not describe blocks', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'green')]);
    assertTotals(result, 'TOTALS: 4 pass, 0 fail, 4 tests');
    assert.equal(result.code, 0);
  });

  it('reports failures, excludes skips from totals and exits 1', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'mixed')]);
    assertTotals(result, 'TOTALS: 1 pass, 1 fail, 2 tests');
    assert.equal(result.code, 1);
    assert.ok(
      result.lines.some((line) => /^FAIL .*mixed\.test\.js: fails on purpose — Expected values/.test(line)),
      result.stdout,
    );
    assert.ok(result.lines.includes('SKIPPED: 1'), result.stdout);
  });

  it('counts a file that throws at import as exactly one failure', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'broken')]);
    assertTotals(result, 'TOTALS: 1 pass, 1 fail, 2 tests');
    assert.equal(result.code, 1);
    assert.ok(
      result.lines.some((line) => /^FAIL .*throws\.test\.js: .* — Error: fixture throws at import$/.test(line)),
      result.stdout,
    );
  });

  it('counts a failing suite with no failing test beneath it as one failure', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'suite-fail')]);
    assertTotals(result, 'TOTALS: 1 pass, 2 fail, 3 tests');
    assert.equal(result.code, 1);
    assert.ok(result.lines.some((line) => /^FAIL .*after-hook\.test\.js: .* — after hook breaks$/.test(line)), result.stdout);
    assert.ok(result.lines.some((line) => /^FAIL .*describe-throws\.test\.js: .* — table fails to load$/.test(line)), result.stdout);
  });

  it('counts subtests, not their parent test', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'subtests')]);
    assertTotals(result, 'TOTALS: 3 pass, 1 fail, 4 tests');
    assert.equal(result.code, 1);
    const fails = result.lines.filter((line) => line.startsWith('FAIL '));
    assert.equal(fails.length, 1, result.stdout);
    assert.match(fails[0], /: child fails — Expected values/);
  });

  it('does not count a test file that registers no tests', () => {
    const result = runRunner(['--dir', path.join(FIXTURES, 'no-tests')]);
    assertTotals(result, 'TOTALS: 0 pass, 0 fail, 0 tests');
    assert.equal(result.code, 0);
  });

  it('runs only the files named as arguments and ignores --reporter=', () => {
    const file = path.join(FIXTURES, 'green', 'top.test.js');
    const result = runRunner(['--reporter=dot', file]);
    assertTotals(result, 'TOTALS: 1 pass, 0 fail, 1 tests');
    assert.equal(result.code, 0);
  });
});
