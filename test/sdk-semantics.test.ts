import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { PmClient, readSettings, resolveRuntimeStatusRegistry, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";
import extension, { buildBrief, buildDelta, CommandError, detectStaleContext, duplicateRemediationCommand, renderBrief, selectNextItems, summarizeMomentum, summarizeRisks, type PmItem } from "../index.ts";

const root = resolve(import.meta.dirname, "..");

/** Initialize an isolated native tracker outside git and guarantee cleanup before its first write. */
async function tracker(t: TestContext) {
  const workspace = await mkdtemp(join(tmpdir(), "brief-sdk-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const pmRoot = join(workspace, ".agents/pm");
  const client = new PmClient({ cwd: workspace, pmRoot, noExtensions: true, author: "fixture" });
  await client.init("fixture", { defaults: true, agentGuidance: "skip", mergeFence: false });
  await mkdir(join(workspace, "bin"));
  await symlink(process.execPath, join(workspace, "bin/node"));
  return { workspace, pmRoot, client };
}

/** Read a certified native corpus, never a partial projection or SDK mock. */
async function corpus(client: PmClient): Promise<PmItem[]> {
  return (await client.listAllComplete({ includeBody: true })).items;
}

test("F03: reverse blocks and unresolved prerequisites hold executable work in a real non-git tracker", async (t) => {
  const { client, pmRoot } = await tracker(t);
  const a = (await client.create({ type: "Task", title: "Implement after prerequisite" })).item.id;
  const b = (await client.create({ type: "Task", title: "Resolve prerequisite", dep: [`id=${a},kind=blocks`] })).item.id;
  const unknown = (await client.create({ type: "Task", title: "Wait for missing prerequisite", dep: ["id=fixture-missing,kind=blocked_by"], allowUnresolvedDeps: true })).item.id;
  let items = await corpus(client);
  const options = { tokenBudget: 32000, pmRoot, focusIds: [a] };
  const brief = buildBrief(items, options);
  assert.ok(!brief.next.some(item => item.id === a), "reverse blocks must hold A");
  assert.ok(!brief.next.some(item => item.id === unknown), "unknown target must hold work");
  assert.ok(brief.blockers.some(edge => edge.itemId === a && edge.blockedBy === b));
  assert.ok(brief.blockers.some(edge => edge.itemId === unknown && edge.blockedBy === "fixture-missing" && edge.status === undefined));
  assert.ok(brief.focus[0].rankingReasons.some(reason => reason.startsWith("blocked_by_active_dependency:")));
  assert.deepEqual(brief.focus[0].dependencyIds, [b]);
  assert.deepEqual(brief.focus[0].dependentIds, []);
  assert.deepEqual(brief.next.find(item => item.id === b)?.dependentIds, [a]);
  assert.deepEqual(brief.next.find(item => item.id === b)?.dependencyIds, []);
  assert.ok(summarizeRisks(items).some(risk => risk.itemId === a));
  await client.close(b, "Prerequisite complete");
  items = await corpus(client);
  assert.ok(selectNextItems(items).some(item => item.id === a), "closing B releases A");
  assert.ok(!selectNextItems(items).some(item => item.id === unknown));
});

test("F05: runtime terminal and active roles govern every lifecycle view and command boundary", async (t) => {
  const { client, pmRoot, workspace } = await tracker(t);
  await client.schemaAddStatus("accepted", { role: ["terminal_done"] });
  await client.schemaAddStatus("waiting-review", { role: ["active"] });
  const accepted = (await client.create({ type: "Task", title: "Accepted delivery", status: "accepted", closeReason: "Accepted with evidence" })).item.id;
  const waiting = (await client.create({ type: "Task", title: "Awaiting active review", status: "waiting-review" })).item.id;
  const decision = (await client.create({ type: "Decision", title: "Accepted decision", status: "accepted", closeReason: "Decision recorded" })).item.id;
  const statusRegistry = resolveRuntimeStatusRegistry((await readSettings(pmRoot)).schema);
  const items = await corpus(client);
  const options = { statusRegistry, tokenBudget: 32000, staleDays: 0, focusIds: [accepted, waiting] };
  const brief = buildBrief(items, options);
  assert.deepEqual(brief.next.map(item => item.id), [waiting]);
  assert.deepEqual(brief.focus.map(item => item.id), [waiting]);
  assert.ok(!brief.decisionsNeeded.some(item => item.id === decision));
  assert.deepEqual(detectStaleContext(items, options).map(item => item.itemId), [waiting]);
  assert.ok(!summarizeRisks(items, options).some(item => item.itemId === accepted));
  assert.equal(summarizeMomentum(items, options).closedCount, 2);
  assert.equal(duplicateRemediationCommand({ id: accepted, title: "Accepted", status: "accepted", type: "Task" }, { id: waiting, title: "Active", status: "waiting-review", type: "Task" }, statusRegistry), `pm update ${waiting} --dep id=${accepted},kind=related`);
  const delta = buildDelta([{ id: accepted, ts: new Date().toISOString(), op: "update", patch: [{ op: "replace", path: "/metadata/status", value: "accepted" }] }], new Map(items.map(item => [item.id, item])), { since: "fixture", statusRegistry });
  assert.equal(delta.items[0].closed, true);
  const harness = await createExtensionTestHarness(extension, { name: "pm-brief", capabilities: ["commands", "services", "schema"] });
  t.after(() => harness.deactivate());
  const savedPath = process.env.PATH;
  const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
  try {
    process.env.PATH = join(workspace, "bin");
    process.env.GIT_CEILING_DIRECTORIES = dirname(workspace);
    for (const command of ["brief", "brief prompt", "brief next", "brief stale", "brief momentum"]) {
      const result = await harness.runCommand({ command, pmRoot, options: command === "brief" ? { format: "json", noGovernance: true, tokenBudget: "32000" } : command === "brief prompt" ? { noGovernance: true, tokenBudget: "32000" } : { format: "json", days: "7" } });
      const serialized = JSON.stringify(result.result);
      if (command === "brief" || command === "brief prompt" || command === "brief next") {
        // Momentum may name accepted work, but executable next rows must exclude it.
        assert.match(serialized, /Awaiting active review/);
      }
      if (command === "brief next") assert.ok(!serialized.includes(accepted));
    }
    const noGit = spawnSync("git", ["status"], { env: process.env, encoding: "utf8" });
    assert.equal((noGit.error as NodeJS.ErrnoException).code, "ENOENT");
  } finally {
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling;
  }
});

test("F14: multilingual native briefs meet SDK UTF-8 ceilings between legacy and canonical sizes", async (t) => {
  const { client } = await tracker(t);
  await client.create({ type: "Task", title: "漢".repeat(100), description: "Résumé 日本語 😀".repeat(30) });
  const items = await corpus(client);
  for (const format of ["json", "markdown", "prompt", "slack"] as const) {
    const full = buildBrief(items, { format, tokenBudget: 32000 });
    const output = renderBrief(full, format);
    const legacy = Math.ceil(output.length / 4);
    const canonical = estimatePmOutputTokens(Buffer.byteLength(output, "utf8"));
    assert.ok(canonical > legacy);
    const tokenBudget = Math.floor((legacy + canonical) / 2);
    try {
      const brief = buildBrief(items, { format, tokenBudget });
      const emitted = renderBrief(brief, format);
      const measured = estimatePmOutputTokens(Buffer.byteLength(emitted, "utf8"));
      assert.ok(measured <= tokenBudget, `${format}: ${measured} exceeds ${tokenBudget}`);
      assert.equal(brief.budget.estimatedTokens, measured);
      assert.ok(brief.budget.truncated && brief.omissions);
      assert.equal(full.next.length - brief.next.length, brief.omissions.sections.next ?? 0);
    } catch (error) {
      if (!(error instanceof CommandError)) throw error;
      assert.equal(error.exitCode, 2);
      assert.match(error.message, /minimum budget \d+ required/);
    }
    assert.equal(full.budget.estimatedTokens, canonical, "full rendering includes framing and its own accounting digits");
    assert.ok(full.next[0].tokenCostEstimate > Math.ceil(JSON.stringify({ title: items[0].title }).length / 4));
  }
});


test("SDK blocker adaptation preserves external source provenance and unrelated context", () => {
  const items: PmItem[] = [
    { id: "fixture-work", status: "open", dependencies: [{ id: "fixture-local", kind: "blocked_by", source_kind: "external" }, { id: "fixture-related", kind: "related" }] },
    { id: "fixture-local", status: "closed" },
  ];
  const brief = buildBrief(items, { focusIds: ["fixture-work"] });
  assert.equal(brief.next.length, 0);
  assert.deepEqual(brief.focus[0].dependencyIds, ["fixture-local", "fixture-related"]);
  assert.ok(brief.blockers.some(edge => edge.blockedBy === "fixture-local" && edge.status === undefined));
});
