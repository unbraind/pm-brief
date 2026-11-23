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

test("Windows-style checkout retains generated LF changelog bytes and neutral closures", () => {
  const root = mkdtempSync(join(tmpdir(), "brief-changelog-eol-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1" };
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
});
