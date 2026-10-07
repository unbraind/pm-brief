import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionCapability } from "@unbrained/pm-cli/sdk/authoring";
import extension, { buildBrief, CommandError, EXIT_CODE, renderBrief, selectNextItems,
  type BriefFormat, type BriefOptions, type PmItem, type GovernanceSummary,
  type MergeDecisionsSummary } from "../index.ts";

const formats: BriefFormat[] = ["json", "markdown", "prompt", "slack"];
const generatedAt = "2026-10-05T00:00:00Z";

/** Generate real public API input, including the exact issue #135 fixture at length 300. */
function fixture(count = 50, length = 300): PmItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `pm-fixture-${i}`, title: `Synthetic task ${i} ` + "a".repeat(length),
    type: "Task", status: i % 5 === 0 ? "closed" : "open", priority: 2,
    created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    tags: [], description: "Synthetic fixture", dependencies: [],
  }));
}

/** Verify explicit usage failure and return its advertised minimum for a real retry. */
function minimumBudget(error: unknown): number {
  assert.ok(error instanceof CommandError);
  assert.equal(error.exitCode, EXIT_CODE.USAGE);
  assert.match(error.message, /Brief cannot fit: minimum budget \d+ required; run pm brief/);
  const minimum = Number(error.message.match(/minimum budget (\d+)/)![1]);
  assert.ok(minimum > 0);
  return minimum;
}

/** Check the ceiling, settled estimate and useful identity, or verify the minimum-budget retry. */
function checkBudget(items: PmItem[], options: BriefOptions & { format: BriefFormat; tokenBudget: number }): void {
  try {
    const brief = buildBrief(items, options);
    assert.ok(brief.budget.estimatedTokens <= options.tokenBudget, "buildBrief cannot return an overrun");
    const estimate = Math.ceil(renderBrief(brief, options.format).length / 4);
    assert.ok(estimate <= options.tokenBudget, `${options.format}: ${estimate} > ${options.tokenBudget}`);
    assert.equal(brief.budget.estimatedTokens, estimate, "disclosure must include its own digits");
    const ranked = selectNextItems(items, options);
    if (ranked.length) assert.equal(brief.next[0]?.id, ranked[0].id, "retain the highest-ranked actionable ID");
    if (brief.budget.truncated) {
      assert.ok(brief.omissions);
      assert.match(brief.omissions.retrieve, /pm list --all; pm get <id>/);
      assert.ok(Object.values(brief.omissions.sections).every((count) => count > 0));
    }
  } catch (error) {
    // Assertion errors propagate: a silent overrun cannot be mistaken for cannot-fit.
    const minimum = minimumBudget(error);
    assert.ok(minimum > options.tokenBudget);
    const retry = buildBrief(items, { ...options, tokenBudget: minimum });
    assert.ok(Math.ceil(renderBrief(retry, options.format).length / 4) <= minimum);
  }
}

for (const format of formats) {
  for (const tokenBudget of [100, 300, 1000, 4000]) {
    test(`issue #135: ${format} enforces ${tokenBudget} including disclosure`, () => {
      checkBudget(fixture(), { format, tokenBudget, generatedAt, pmVersion: "2026.10.5" });
    });
  }
}

test("generated sweep: every returned rendering fits across counts, field lengths and budgets", () => {
  for (const count of [0, 1, 6, 17, 50]) {
    for (const length of [0, 40, 160, 1000, 6000]) {
      const items = fixture(count, length).map((item, index) => ({ ...item,
        status: index % 4 === 0 ? "closed" : index % 4 === 1 ? "in_progress" : "open",
        priority: index % 5, tags: ["tag".repeat(length)],
        docs: ["docs/" + "x".repeat(length)],
        dependencies: index > 1 ? [{ id: "pm-fixture-1", kind: "blocked_by" }] : [],
      }));
      for (const format of formats) {
        for (const tokenBudget of [1, 100, 300, 500, 1000, 2000, 4000, 10000]) {
          checkBudget(items, { format, tokenBudget, generatedAt, includeClosed: true,
            nextCount: count + 1, focusTypes: ["Task"], pmVersion: "test" });
        }
      }
    }
  }
});

test("long fields shorten with ellipses, retained IDs stay exact, and omitted section counts are honest", () => {
  const items = fixture(50, 6000);
  const full = buildBrief(items, { generatedAt, tokenBudget: 100000 });
  for (const format of formats) {
    const compact = buildBrief(items, { generatedAt, format, tokenBudget: 1000 });
    assert.ok(compact.omissions?.shortenedFields);
    assert.ok(compact.next.some((item) => item.title.endsWith("…")));
    assert.ok(compact.next.every((item) => items.some((source) => source.id === item.id)));
    assert.equal(compact.omissions.sections.next ?? 0, full.next.length - compact.next.length);
    assert.equal(compact.omissions.sections.focus ?? 0, full.focus.length - compact.focus.length);
    assert.equal(compact.omissions.sections.momentum ?? 0, full.momentum.recent.length - compact.momentum.recent.length);
    assert.match(renderBrief(compact, format), /pm list --all/);
  }
});

test("governance and merge receipts compete for budget without losing compromise identities or totals", () => {
  const long = "long context ".repeat(400);
  const governance: GovernanceSummary = {
    duplicateClusters: [{ clusterId: "cluster-1", items: [{ id: "pm-fixture-1", title: long, status: "open", type: "Task" }], maxScore: 1, reason: "exact_title", remediation: "pm get pm-fixture-1" }], duplicateClustersTotal: 20,
    staleInProgress: [], staleInProgressTotal: 0,
    storageFindings: [{ kind: "history_unparseable", detail: long, path: "history/orphan.jsonl", remediation: "pm list --all" }], storageFindingsTotal: 30,
    secretFindings: [{ itemId: "pm-fixture-1", field: "description", rule: "github_token", remediation: "pm get pm-fixture-1" }], secretFindingsTotal: 40,
    threshold: 0.6, staleThresholdHours: 24, generatedAt,
  };
  const mergeDecisions: MergeDecisionsSummary = {
    pendingCount: 50, compromisedItemIds: ["pm-fixture-1"],
    receipts: [{ receiptId: "receipt-1", itemId: "pm-fixture-1", itemPath: "tasks/pm-fixture-1.toon",
      conflictResolution: "preferred_side", preferred: "ours", conflicts: [{ field: "description", discarded: long }] }],
  };
  for (const format of formats) {
    const options = { format, generatedAt, governance, mergeDecisions, tokenBudget: 1000 };
    checkBudget(fixture(), options);
    const brief = buildBrief(fixture(), options);
    assert.deepEqual(brief.mergeDecisions?.compromisedItemIds, ["pm-fixture-1"]);
    assert.equal(brief.mergeDecisions?.pendingCount, 50);
    assert.equal(brief.governance?.secretFindingsTotal, 40);
    assert.equal(brief.omissions!.sections.mergeReceipts ?? 0, 50 - brief.mergeDecisions!.receipts.length);
    assert.equal(brief.omissions!.sections.secretFindings ?? 0, 40 - brief.governance!.secretFindings.length);
    assert.match(brief.omissions!.retrieve, /pm merge report/);
    assert.equal(brief.next.find((item) => item.id === "pm-fixture-1")?.mergeCompromised, true);
  }
});

test("cannot-fit is concise, includes minimum and format-specific recovery, and is not a returned overrun", () => {
  for (const format of formats) {
    assert.throws(() => buildBrief(fixture(), { format, tokenBudget: 1, generatedAt }), (error: unknown) => {
      const minimum = minimumBudget(error);
      assert.ok((error as Error).message.length < 150);
      assert.match((error as Error).message, new RegExp(format === "prompt" ? `pm brief prompt --max-tokens ${minimum}` : `pm brief --format ${format} --max-tokens ${minimum}`));
      return true;
    });
  }
  for (const tokenBudget of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => buildBrief([], { tokenBudget }), /positive safe integer/);
  }
});

test("ordinary default 4000 retains selected context and has no omission receipt", () => {
  const items = fixture(5, 20);
  for (const format of formats) {
    const ordinary = buildBrief(items, { generatedAt, format });
    const unbounded = buildBrief(items, { generatedAt, format, tokenBudget: 100000 });
    assert.equal(ordinary.budget.truncated, false);
    assert.equal(ordinary.omissions, undefined);
    for (const key of ["focus", "next", "blockers", "risks", "momentum", "staleContext", "recommendedPmUpdates"] as const) {
      assert.deepEqual(ordinary[key], unbounded[key]);
    }
  }
});

test("real command wiring budgets stdout and files and refuses to write an overrun", async () => {
  const root = mkdtempSync(join(tmpdir(), "pm-brief-budget-"));
  const cli = resolve("node_modules/@unbrained/pm-cli/dist/cli.js");
  try {
    const init = spawnSync(process.execPath, [cli, "--pm-path", join(root, ".agents/pm"), "init", "--defaults", "--agent-guidance", "skip"], { cwd: root, encoding: "utf8" });
    assert.equal(init.status, 0, init.stderr);
    const create = spawnSync(process.execPath, [cli, "--pm-path", join(root, ".agents/pm"), "create", "Task", "A real budget fixture " + "x".repeat(3000), "--create-mode", "progressive"], { cwd: root, encoding: "utf8", env: { ...process.env, PM_AUTHOR: "codex-sol" } });
    assert.equal(create.status, 0, create.stderr);
    const capabilities = (JSON.parse(readFileSync("manifest.json", "utf8")) as { capabilities: ExtensionCapability[] }).capabilities;
    const activation = await activateExtensionForTest(extension, { name: "pm-brief", capabilities });
    assert.deepEqual(activation.failed, []);
    for (const format of formats) {
      const command = format === "prompt" ? "brief prompt" : "brief";
      const options = { format, "no-governance": true, "max-tokens": 1000 };
      const result = (await runRegisteredCommandForTest(activation.commands, { command, options, pmRoot: join(root, ".agents/pm") })).result as { output: string };
      assert.ok(Math.ceil(result.output.length / 4) <= 1000);
      const output = join(root, `${format}.txt`);
      await runRegisteredCommandForTest(activation.commands, { command, options: { ...options, output }, pmRoot: join(root, ".agents/pm") });
      assert.ok(Math.ceil(readFileSync(output, "utf8").length / 4) <= 1000);
      const refused = join(root, `refused-${format}.txt`);
      await assert.rejects(runRegisteredCommandForTest(activation.commands, { command, options: { ...options, output: refused, "max-tokens": 1 }, pmRoot: join(root, ".agents/pm") }), (error: unknown) => minimumBudget(error) > 1);
      assert.equal(existsSync(refused), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("public renderers recheck changed formats and cumulative omissions after caller edits", () => {
  const items = fixture();
  const brief = buildBrief(items, { generatedAt, tokenBudget: 1000, format: "markdown" });
  const previous = brief.omissions!;
  // Render a changed format and a changed field through the public API; no mocks.
  const changed = { ...brief, next: brief.next.map((item) => ({ ...item, title: item.title.repeat(200) })) };
  const output = renderBrief(changed, "json");
  assert.ok(Math.ceil(output.length / 4) <= 1000);
  const rendered = JSON.parse(output) as typeof brief;
  assert.ok(rendered.omissions!.sections.momentum >= previous.sections.momentum);
  assert.equal(rendered.omissions!.sections.next ?? 0, 5 - rendered.next.length);
  assert.equal(rendered.omissions!.shortenedFields, true);
});

test("focus-only minimal briefs retain an ID and missing focus warnings disclose dropped insights", () => {
  const items: PmItem[] = [{ id: "pm-only", title: "Long focus " + "x".repeat(6000), status: "closed", type: "Task" }];
  for (const format of formats) {
    checkBudget(items, { generatedAt, format, tokenBudget: 1000, includeClosed: true, focusIds: ["pm-only", "pm-missing"] });
    const brief = buildBrief(items, { generatedAt, format, tokenBudget: 1000, includeClosed: true, focusIds: ["pm-only", "pm-missing"] });
    assert.equal(brief.focus[0]?.id, "pm-only");
    assert.equal(brief.next.length, 0);
  }
});


test("escaped and Unicode display fields use character estimates, and rendering leaves input unchanged", () => {
  const items = fixture(12, 0).map((item) => ({ ...item, title: '\"\n😀'.repeat(600) }));
  for (const format of formats) checkBudget(items, { generatedAt, format, tokenBudget: 1000 });
  const brief = buildBrief(items, { generatedAt, tokenBudget: 1000, format: "markdown" });
  const snapshot = JSON.stringify(brief);
  renderBrief(brief, "json");
  assert.equal(JSON.stringify(brief), snapshot);
});
