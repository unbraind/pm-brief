import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { devNull, homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { PmClient } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; version: string; devDependencies: Record<string, string> };
const workspace = mkdtempSync(join(tmpdir(), `${pkg.name}-read-output-`));
const env = { ...process.env, HOME: join(workspace, "home"), GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: "1", PM_AUTHOR: "contract-test", NODE_COMPILE_CACHE: join(workspace, "compile-cache"), npm_config_offline: "true", npm_config_cache: process.env.npm_config_cache ?? join(homedir(), ".npm") };
const ids: string[] = [];
let cli = "";

/** Run a real process without a shell, retaining failure diagnostics. */
function run(bin: string, args: string[], cwd = workspace) {
  return spawnSync(bin, args, { cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
}

/** Require a successful subprocess, with stdout available for fixture creation. */
function success(bin: string, args: string[], cwd = workspace): string {
  const result = run(bin, args, cwd);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return result.stdout;
}

/** Invoke the package's installed host against its real tracker. */
function pm(args: string[], expected: number | number[] = 0): Record<string, unknown> {
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "--json", ...args]);
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(result.status ?? -1), `${args.join(" ")}: ${result.stderr || result.stdout || result.error}`);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

/** Resolve a declared nested collection in the host's response. */
function rows(result: Record<string, unknown>, path: string): unknown[] {
  const value = path.split(".").reduce<unknown>((current, key) => (current as Record<string, unknown>)?.[key], result);
  assert.ok(Array.isArray(value), `${path} must remain a row collection`);
  return value;
}

before(async () => {
  mkdirSync(env.HOME);
  success("npm", ["pack", "--ignore-scripts", "--pack-destination", workspace], root);
  // npm 10 can emit prepare output despite --ignore-scripts; discover the actual archive.
  const archives = readdirSync(workspace).filter((name) => name.endsWith(".tgz"));
  assert.equal(archives.length, 1, "pack must produce exactly one distribution archive");
  const tarball = join(workspace, archives[0]!);
  writeFileSync(join(workspace, "package.json"), JSON.stringify({ name: "read-output-consumer", private: true, type: "module" }));
  // Resolve the package's actual executable instead of assuming its layout.
  const host = JSON.parse(readFileSync(join(root, "node_modules/@unbrained/pm-cli/package.json"), "utf8")) as { bin: { pm: string } };
  cli = join(root, "node_modules/@unbrained/pm-cli", host.bin.pm);
  pm(["init", "--defaults", "--agent-guidance", "skip", "--prefix", "fixture"]);
  // Install the actual archive into the documented project extension directory.
  // Reuse the exact installed dependency graph; package-manager acceptance is a separate gate.
  const extensionRoot = join(workspace, ".agents/pm/extensions", pkg.name);
  mkdirSync(extensionRoot, { recursive: true });
  success("tar", ["-xzf", tarball, "--strip-components=1", "-C", extensionRoot]);
  symlinkSync(join(root, "node_modules"), join(extensionRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const client = new PmClient({ pmRoot: join(workspace, ".agents/pm"), author: "contract-test", noExtensions: true });
  for (let index = 0; index < 12; index++) {
    const result = await client.create({ type: "Task", title: `Synthetic output contract row ${index} with stable context for cursor recovery across all host projection budget pages and repeatable closed-item evidence for throughput and cycle-time summaries`, description: "A repeatable fixture with enough content to exercise host budget compaction.", status: index < 5 ? "closed" : "open", closeReason: "Synthetic completed fixture", createMode: "progressive" });
    ids.push(result.item.id);
  }
  success("git", ["init", "-b", "main"]);
  success("git", ["add", ".agents/pm", ":!.agents/pm/extensions"]);
  success("git", ["-c", "user.name=FixtureBot", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic tracker base"]);
  for (const id of ids) pm(["comment", id, "Synthetic branch change"]);
  success("git", ["add", ".agents/pm", ":!.agents/pm/extensions"]);
  success("git", ["-c", "user.name=FixtureBot", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Synthetic tracker head"]);
  success("git", ["branch", "fixture-base", "HEAD~1"]);
});
after(() => rmSync(workspace, { recursive: true, force: true }));

const scenarios = [
  { name: "brief", args: () => ["brief", "--no-governance", "--max-tokens", "100000"], selector: "next", excluded: "workspace", paths: ["next"] },
  { name: "brief prompt", args: () => ["brief", "prompt", "--no-governance", "--max-tokens", "100000"], selector: "next", excluded: "workspace", paths: ["next"] },
  { name: "brief next", args: () => ["brief", "next", "--count", "100"], selector: "next.id", excluded: "title", projectionPath: "next", paths: ["next"] },
  { name: "brief stale", args: () => ["brief", "stale", "--days", "0"], selector: "stale.itemId", excluded: "title", projectionPath: "stale", paths: ["stale"] },
  { name: "brief momentum", args: () => ["brief", "momentum"], selector: "momentum.recent.id", excluded: "title", projectionPath: "momentum.recent", paths: ["momentum.recent"] },
  { name: "brief since", args: () => ["brief", "since", "2000-01-01", "--max-tokens", "100000"], selector: "items.id", excluded: "title", projectionPath: "items", paths: ["items"] },
  { name: "brief diverge", args: () => ["brief", "diverge", "--base", "fixture-base", "--head", "HEAD", "--include-clean", "--max-tokens", "100000"], selector: "items.id", excluded: "kind", projectionPath: "items", paths: ["items"] },
  { name: "brief duplicates", args: () => ["brief", "duplicates", "--threshold", "0.1", "--limit", "100"], selector: "pairs", excluded: "generatedAt", paths: ["pairs"] },
  { name: "brief governance", args: () => ["brief", "governance", "--threshold", "0.1"], selector: "duplicateClusters", excluded: "generatedAt", paths: ["duplicateClusters"] },
];

for (const scenario of scenarios) {
  test(`${scenario.name}: packaged host projection, omission, and exact row recovery`, () => {
    const args = scenario.args();
    const full = pm([...args, "--output-budget", "unbounded", "--output-limit", "unbounded", "--output-row-contract"]);
    const receipt = full.read_output as { command: string };
    assert.equal(receipt.command, `extension:${scenario.name}`);
    const projected = pm([...args, "--output-budget", "unbounded", "--output-include", scenario.selector]);
    assert.ok(projected.read_output, "projection must carry a receipt");
    const subject = scenario.projectionPath ? rows(projected, scenario.projectionPath)[0] as Record<string, unknown> : projected;
    assert.equal(subject[scenario.excluded], undefined, "unselected data must be omitted");
    const omitted = pm([...args, "--output-budget", "1"], 2);
    assert.ok(omitted.output_budget_exceeded, "infeasible budget must produce the shared omission branch");
    for (const path of scenario.paths) {
      const identity = path === "stale" ? "itemId" : path === "duplicateClusters" ? "clusterId" : "id";
      const expected = rows(full, path).map((row) => ({ [identity]: (row as Record<string, unknown>)[identity] }));
      if (expected.length < 3) continue;
      const controls = ["--output-include", path, "--output-limit", "unbounded"];
      let page: Record<string, unknown> | undefined;
      let budget = 0;
      const unlimited = pm([...args, ...controls, "--output-budget", "unbounded"]);
      const estimate = (unlimited.read_output as { estimated_tokens: number }).estimated_tokens;
      // Start just below the measured envelope to catch narrow feasible compaction windows.
      const candidates = [estimate - 1, ...[0.95, 0.8, 0.6, 0.4].map((ratio) => Math.floor(estimate * ratio))];
      for (const candidate of candidates) {
        const raw = run(process.execPath, [cli, "--pm-path", ".agents/pm", "--json", ...args, ...controls, "--output-budget", String(candidate)]);
        assert.ok(raw.status === 0 || raw.status === 2, raw.stderr || raw.stdout);
        const result = JSON.parse(raw.stdout) as Record<string, unknown>;
        const truncation = result.output_budget_truncation as { continuations?: Array<{ path: string }> } | undefined;
        if (raw.status === 0 && truncation?.continuations?.some((entry) => entry.path === path)) { page = result; budget = candidate; break; }
      }
      if (!page) {
        // Empty/singleton or short collections need no continuation.
        assert.ok(expected.length < 3, `${path} fixture must exercise budget continuation`);
        continue;
      }
      const bounded = page.read_output as { estimated_tokens: number; within_budget: boolean };
      assert.equal(bounded.within_budget, true);
      assert.ok(bounded.estimated_tokens <= budget, "receipt must fit the requested budget");
      const actual: unknown[] = [];
      const cursors = new Set<string>();
      for (let index = 0; index <= expected.length; index++) {
        actual.push(...rows(page, path).map((row) => ({ [identity]: (row as Record<string, unknown>)[identity] })));
        const truncation = page.output_budget_truncation as { continuations?: Array<{ path: string; cursor: string }> } | undefined;
        const next = truncation?.continuations?.find((entry) => entry.path === path);
        if (!next) break;
        assert.ok(!cursors.has(next.cursor), "continuation must advance");
        cursors.add(next.cursor);
        page = pm([...args, ...controls, "--output-budget", String(budget), "--output-cursor", next.cursor], [0, 2]);
        // Later rows can be larger than the first page; retry an explicit omission with more capacity.
        for (let retry = 0; page.output_budget_exceeded && retry < 4; retry++) {
          budget *= 2;
          page = pm([...args, ...controls, "--output-budget", String(budget), "--output-cursor", next.cursor], [0, 2]);
        }
        assert.equal(page.output_budget_exceeded, undefined, "continuation must fit after bounded recovery");
        const receipt = page.read_output as { estimated_tokens: number; within_budget: boolean };
        assert.equal(receipt.within_budget, true);
        assert.ok(receipt.estimated_tokens <= budget, "each continuation receipt must fit its budget");
      }
      assert.deepEqual(actual, expected, `${path}: every row must return once, unchanged and in order`);
    }
  });
}

test("ordinary document files preserve summary output without row-contract validation", () => {
  for (const args of [scenarios[0]!.args(), scenarios[1]!.args(), scenarios[5]!.args(), scenarios[6]!.args(), scenarios[7]!.args(), scenarios[8]!.args()]) {
    const path = join(workspace, "ordinary-output.md");
    const result = pm([...args, "--output", path]);
    assert.equal(result.ok, true);
    assert.equal(result.output, path);
    assert.equal(result.pmBriefFileSummary, undefined);
    assert.ok(existsSync(path));
  }
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "brief", "--no-governance", "--output", join(workspace, "ordinary-toon.md")]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ok: true/);
});

test("writer controls are refused before mutation or document file output", () => {
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "create", "Task", "Must not exist", "--output-budget", "1000"]);
  assert.equal(result.status, 2);
  assert.match(result.stderr + result.stdout, /read|output/i);
  const path = join(workspace, "must-not-exist.md");
  const file = run(process.execPath, [cli, "--pm-path", ".agents/pm", "brief", "--no-governance", "--output", path, "--output-budget", "1000"]);
  assert.equal(file.status, 2);
  assert.equal(existsSync(path), false);
});

test("ordinary brief rendering remains a document", () => {
  const result = run(process.execPath, [cli, "--pm-path", ".agents/pm", "brief", "--no-governance"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# pm brief/);
  assert.doesNotMatch(result.stdout, /pmBriefRendered/);
});

/** Verify per-call SDK controls through the real harness over the same tracker. */
test("SDK options and CLI globals select structured results before host shaping", async () => {
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  try {
    for (const command of ["brief", "brief prompt", "brief next", "brief stale", "brief momentum", "brief since", "brief duplicates", "brief governance"]) {
      for (const transport of ["options", "global"] as const) {
        const result = await harness.runCommand({ command, args: command === "brief since" ? ["2000-01-01"] : [], pmRoot: join(workspace, ".agents/pm"),
          options: { noGovernance: true, maxTokens: "100000", ...(transport === "options" ? { outputBudget: "unbounded" } : {}) },
          global: transport === "global" ? { outputBudget: "unbounded" } : {},
        });
        assert.equal(result.handled, true, result.errorMessage ?? "handler must succeed");
        assert.equal((result.result as Record<string, unknown>).pmBriefRendered, undefined);
      }
    }
    const ordinary = await harness.runCommand({ command: "brief", pmRoot: join(workspace, ".agents/pm"), options: { output: join(workspace, "sdk-file.md"), noGovernance: true } });
    assert.equal(ordinary.handled, true);
    for (const format of ["json", "toon"]) {
      const rendered = await harness.runServiceOverride({ service: "output_format", command: "brief", payload: { result: ordinary.result, format } });
      assert.equal(rendered.handled, true);
      assert.equal(typeof rendered.result, "string");
      if (format === "json") assert.equal(JSON.parse(rendered.result as string).ok, true);
      else assert.match(rendered.result as string, /^ok: true/);
    }
    await assert.rejects(harness.runCommand({ command: "brief", pmRoot: join(workspace, ".agents/pm"), options: { output: "refused.md", outputBudget: "1000" } }), /cannot be combined/);
  } finally { await harness.deactivate(); }
});
