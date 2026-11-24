/** Exercise real Git checkout conversion and the installed changelog check together. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { devNull, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

/** Canonical generator installed by this package's lockfile. */
const cli = join(dirname(createRequire(import.meta.url).resolve("pm-changelog/package.json")), "dist/cli.js");

/**
 * Fixture environment: isolated Git configuration, and none of Git's repository-location variables
 * (`git rev-parse --local-env-vars`: GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, …), so a caller's
 * repository, for example a hook's index, is never read or written by the fixture.
 */
function fixtureEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Probe with the caller's environment minus every GIT_* variable, keeping the platform's search-path key
  // as is (Windows spells it Path), so git.exe stays discoverable and no caller repository is consulted.
  const probeEnv = Object.fromEntries(Object.entries(base).filter(([name]) => !name.toUpperCase().startsWith("GIT_")));
  const local = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", env: probeEnv })
    .split("\n").filter(Boolean);
  const env: NodeJS.ProcessEnv = { ...base, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
  for (const name of local) delete env[name];
  return env;
}

/** Generate, stage, re-check out and re-check the changelog in a fresh repository with `core.autocrlf=true`. */
function assertCheckoutKeepsGeneratedBytes(base: NodeJS.ProcessEnv): void {
  const root = mkdtempSync(join(tmpdir(), "brief-changelog-eol-"));
  const env = fixtureEnv(base);
  const input = JSON.stringify({ items: [{ id: "fixture-closed", type: "Issue", title: "Historical incident",
    status: "closed", created_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-02T00:00:00Z" }] });
  const args = [cli, "--stdin", "--mode", "replace", "--output", "CHANGELOG.md", "--version", "2026.1.2", "--date", "2026-01-02"];
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root, env });
    execFileSync("git", ["config", "core.autocrlf", "true"], { cwd: root, env });
    writeFileSync(join(root, ".gitattributes"), readFileSync(resolve(import.meta.dirname, "../.gitattributes")));
    const generated = spawnSync(process.execPath, args, { cwd: root, env, input, encoding: "utf8" });
    assert.equal(generated.status, 0, generated.stderr);
    const expected = readFileSync(join(root, "CHANGELOG.md"));
    assert.match(expected.toString(), /### Closed/);
    execFileSync("git", ["add", ".gitattributes", "CHANGELOG.md"], { cwd: root, env, stdio: "pipe" });
    rmSync(join(root, "CHANGELOG.md"));
    execFileSync("git", ["checkout-index", "--force", "--", "CHANGELOG.md"], { cwd: root, env });
    assert.deepEqual(readFileSync(join(root, "CHANGELOG.md")), expected, "checkout must preserve the generator's LF bytes");
    const checked = spawnSync(process.execPath, [...args, "--check"], { cwd: root, env, input, encoding: "utf8" });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("Windows-style checkout retains generated LF changelog bytes and neutral closures", () => {
  assertCheckoutKeepsGeneratedBytes(process.env);
});

test("the fixture never stages into a caller's repository named by inherited Git location variables", () => {
  const caller = mkdtempSync(join(tmpdir(), "brief-changelog-caller-"));
  try {
    const isolated = fixtureEnv(process.env);
    execFileSync("git", ["init", "--quiet"], { cwd: caller, env: isolated });
    writeFileSync(join(caller, "keep.txt"), "caller\n");
    execFileSync("git", ["add", "keep.txt"], { cwd: caller, env: isolated });
    const index = join(caller, ".git", "index");
    const before = readFileSync(index);
    // A hook or wrapper that runs this suite exports its own repository location.
    assertCheckoutKeepsGeneratedBytes({ ...process.env, GIT_DIR: join(caller, ".git"), GIT_WORK_TREE: caller, GIT_INDEX_FILE: index });
    assert.deepEqual(readFileSync(index), before, "the caller's index must be untouched");
  } finally {
    rmSync(caller, { recursive: true, force: true });
  }
});
