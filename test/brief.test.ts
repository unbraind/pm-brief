import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionActivationResult, ExtensionCapability, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import extension, {
  buildBrief,
  buildDelta,
  buildDivergence,
  changedFieldPaths,
  classifyItemDivergence,
  detectStaleContext,
  evaluateFence,
  checkAttrMerge,
  fenceProbePaths,
  eventKey,
  explainNextItems,
  extractRelationships,
  normalizeCheckpoint,
  parseHistoryJsonl,
  countMalformedLines,
  scanHistoryJsonl,
  pmRootRelFromCtx,
  mergeBase,
  readBlob,
  listChangedPaths,
  parsePmItemsOutput,
  readRecentActivity,
  renderAgentPrompt,
  renderMarkdownBrief,
  renderMarkdownDelta,
  renderMarkdownDivergence,
  renderSlackBrief,
  renderSlackDelta,
  renderSlackDivergence,
  renderTextDelta,
  renderTextDivergence,
  selectNextItems,
  summarizeMomentum,
  summarizeRisks,
  buildDuplicateSweep,
  collapseDuplicatePairs,
  duplicateRemediationCommand,
  parseDuplicateThreshold,
  parseSinceTimestamp,
  renderMarkdownDuplicates,
  renderTextDuplicates,
  selectDuplicateCandidates,
  collectGovernanceSignals,
  governanceIsEmpty,
  renderTextGovernance,
  renderMarkdownGovernance,
  type DeltaActivityEntry,
  type DivergeEvent,
  type PmItem,
  type DuplicatePair,
  type DuplicatePairItem,
  type DuplicateSweepSummary,
  type SimilarItemMatch,
  type GovernanceSummary,
  type GovernanceDuplicateCluster,
} from "../dist/index.js";

/**
 * Capabilities the on-disk `manifest.json` declares.
 *
 * Read from the manifest rather than hard-coded so the tests activate under the
 * exact capability grant the published package ships with: a surface registered
 * without a matching manifest capability fails activation here the same way it
 * would in the CLI, instead of passing against a permissive stub.
 */
const MANIFEST_CAPABILITIES: readonly ExtensionCapability[] = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"),
  ) as { capabilities: ExtensionCapability[] }
).capabilities;

/** Latest project-local pm CLI used by real-workspace integration tests. */
const INSTALLED_PM_BIN = fileURLToPath(
  new URL(process.platform === "win32" ? "../node_modules/.bin/pm.cmd" : "../node_modules/.bin/pm", import.meta.url),
);

/** Shape of the `brief diverge` command result asserted by the wiring test. */
interface DivergeCommandResult {
  ok?: boolean;
  format?: string;
  output?: string;
  verdict?: string;
  pmBriefRendered?: boolean;
}

let cachedActivation: Promise<ExtensionActivationResult> | undefined;

/**
 * Activate pm-brief through pm's real extension loader, once per test process.
 *
 * Replaces the previous hand-built `api` doubles: those could not satisfy the
 * real `ExtensionApi` contract without casting, and silently skipped the
 * capability governance the host applies. Activation is deterministic and has no
 * side effects, so the result is memoized and shared across tests.
 */
function activateBrief(): Promise<ExtensionActivationResult> {
  cachedActivation ??= (async () => {
    const activation = await activateExtensionForTest(extension, {
      name: "pm-brief",
      capabilities: MANIFEST_CAPABILITIES,
    });
    assert.deepEqual(activation.failed, [], "extension activation must not fail");
    return activation;
  })();
  return cachedActivation;
}

/** Command paths registered by the extension, in registration order. */
async function registeredCommandPaths(): Promise<string[]> {
  return (await activateBrief()).registrations.commands.map((entry) => entry.command);
}

/** Flag definitions registered against one command path. */
async function registeredFlags(command: string): Promise<readonly FlagDefinition[]> {
  const entry = (await activateBrief()).registrations.flags.find(
    (candidate) => candidate.target_command === command,
  );
  assert.ok(entry, `flags should be registered for "${command}"`);
  return entry.flags;
}

/** Long-form flag names registered against one command path. */
async function registeredFlagLongs(command: string): Promise<(string | undefined)[]> {
  return (await registeredFlags(command)).map((flag) => flag.long);
}

const items: PmItem[] = [
  {
    id: "pm-a",
    title: "Ship release notes",
    type: "Task",
    status: "in_progress",
    priority: 1,
    assignee: "codex",
    tags: ["release"],
    updated_at: "2026-06-05T00:00:00Z",
    dependencies: [{ id: "pm-b", kind: "blocked_by" }],
    docs: ["docs/release.md"],
  },
  {
    id: "pm-b",
    title: "Approve changelog",
    type: "Decision",
    status: "open",
    priority: 0,
    updated_at: "2026-05-20T00:00:00Z",
  },
  {
    id: "pm-c",
    title: "Refactor old importer",
    type: "Feature",
    status: "open",
    priority: 3,
    updated_at: "2026-05-01T00:00:00Z",
    deadline: "2026-05-15T00:00:00Z",
  },
  {
    id: "pm-d",
    title: "Already done",
    type: "Task",
    status: "closed",
    priority: 0,
    updated_at: "2026-06-01T00:00:00Z",
  },
];

test("extension registers brief commands", async () => {
  assert.deepEqual(await registeredCommandPaths(), ["brief", "brief prompt", "brief next", "brief stale", "brief momentum", "brief since", "brief diverge", "brief duplicates", "brief governance"]);
  const nextFlags = await registeredFlagLongs("brief next");
  assert.ok(nextFlags.includes("--explain"));
  assert.ok(nextFlags.includes("--confidence"));
});

test("brief next command exposes explain flag", async () => {
  assert.ok((await registeredCommandPaths()).includes("brief next"), "brief next command should be registered");
  assert.ok((await registeredFlagLongs("brief next")).includes("--explain"));
});

test("extractRelationships normalizes dependency fields", () => {
  assert.deepEqual(extractRelationships(items[0]!), [{ from: "pm-a", to: "pm-b", kind: "blocked_by" }]);
});

test("extractRelationships dedups blocked_by edges denormalized into dependencies + blocked_by", () => {
  // pm's `update --blocked-by <id>` writes the edge into BOTH item.dependencies
  // (a blocked_by-kind object) AND item.blocked_by (a string), so a naive parse
  // emits the same edge twice. The result must be a single deduped edge.
  const item = {
    id: "pm-x",
    title: "Doubled blocker",
    type: "Task",
    status: "open",
    dependencies: [{ id: "pm-y", kind: "blocked_by" }],
    blocked_by: "pm-y",
  } as (typeof items)[number];
  assert.deepEqual(extractRelationships(item), [{ from: "pm-x", to: "pm-y", kind: "blocked_by" }]);
});

test("parsePmItemsOutput reports malformed CLI output as a command error", () => {
  assert.throws(
    () => parsePmItemsOutput("not-json"),
    (error: unknown) => error instanceof Error && error.name === "CommandError" && error.message.startsWith("Unable to parse pm item JSON:"),
  );
});

test("selectNextItems ranks unblocked priority before blocked work", () => {
  const next = selectNextItems(items, { generatedAt: "2026-06-06T00:00:00Z", nextCount: 3 });
  assert.deepEqual(next.map((item) => item.id), ["pm-b", "pm-c", "pm-a"]);
  assert.equal(next[2]?.whyNow, "blocked: resolve prerequisite before implementation");
});

test("selectNextItems honors the canonical pm next order over the local scorer", () => {
  // `pm next` supplies the authoritative ranking so `brief next` agrees with it.
  // Here the canonical order deliberately contradicts the local score ordering
  // (which would be pm-b, pm-c, pm-a) to prove delegation wins.
  const next = selectNextItems(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    nextCount: 3,
    nextOrder: ["pm-c", "pm-a", "pm-b"],
  });
  assert.deepEqual(next.map((item) => item.id), ["pm-c", "pm-a", "pm-b"]);
});

test("selectNextItems keeps candidates absent from pm next order after ranked ones", () => {
  // A partial canonical order (only pm-c) must place pm-c first; the rest keep
  // the deterministic local tiebreak so no candidate is dropped.
  const next = selectNextItems(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    nextCount: 5,
    nextOrder: ["pm-c"],
  });
  // pm-c is canonically ranked first; pm-a and pm-b are both unranked and must
  // fall back to the deterministic local tiebreak (pm-b before the blocked pm-a),
  // never NaN-driven insertion order.
  assert.deepEqual(next.map((item) => item.id), ["pm-c", "pm-b", "pm-a"]);
});

test("explicit dependency-order overrides the canonical pm next order", () => {
  // `--dependency-order` is a deliberate override of the default ranking, so a
  // supplied nextOrder must not win: prerequisite-first sorting is preserved and
  // the blocked pm-a is never surfaced ahead of its prerequisites.
  const next = selectNextItems(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    nextCount: 3,
    dependencyOrder: true,
    nextOrder: ["pm-a", "pm-b", "pm-c"],
  });
  assert.equal(next[0]?.id !== "pm-a", true, "blocked pm-a must not lead under dependency-order");
  // Matches the dedicated dependency-order behavior (prerequisites before dependents).
  assert.equal(next.at(-1)?.id, "pm-a");
});

test("selectNextItems includes evidence-weighted ranking details", () => {
  const next = selectNextItems([
    ...items,
    {
      id: "pm-e",
      title: "Finish release gate",
      type: "Task",
      status: "open",
      priority: 1,
      updated_at: "2026-06-04T00:00:00Z",
      release: "2026.6.12",
      deadline: "2026-06-10T00:00:00Z",
      files: [{ path: "package.json" }, { path: "CHANGELOG.md" }],
    },
  ], { generatedAt: "2026-06-06T00:00:00Z", nextCount: 5 });
  const releaseGate = next.find((item) => item.id === "pm-e");
  assert.ok(releaseGate);
  assert.ok(releaseGate.rankingScore > 0);
  assert.ok(releaseGate.confidence >= 70);
  assert.ok(releaseGate.rankingReasons.includes("unblocked"));
  assert.ok(releaseGate.rankingReasons.includes("release:2026.6.12"));
  assert.ok(releaseGate.rankingReasons.includes("linked_evidence:2"));

  const duplicateEvidence = selectNextItems([{
    id: "pm-link",
    title: "Avoid duplicate evidence",
    type: "Task",
    status: "open",
    priority: 1,
    docs: ["docs/context.md"],
    files: [{ path: "docs/context.md" }],
  }], { generatedAt: "2026-06-06T00:00:00Z", nextCount: 1 });
  assert.ok(duplicateEvidence[0]?.rankingReasons.includes("linked_evidence:1"));
});

test("selectNextItems supports dependency-first ordering for prerequisite planning", () => {
  const dependencyItems: PmItem[] = [
    {
      id: "pm-a",
      title: "Implement parser",
      type: "Task",
      status: "open",
      priority: 2,
      updated_at: "2026-06-05T00:00:00Z",
      deps: ["pm-b"],
    },
    {
      id: "pm-b",
      title: "Define schema",
      type: "Task",
      status: "open",
      priority: 2,
      updated_at: "2026-06-04T00:00:00Z",
    },
    {
      id: "pm-c",
      title: "Add parser tests",
      type: "Task",
      status: "open",
      priority: 2,
      updated_at: "2026-06-03T00:00:00Z",
      deps: ["pm-a"],
    },
  ];
  const next = selectNextItems(dependencyItems, {
    generatedAt: "2026-06-06T00:00:00Z",
    dependencyOrder: true,
    nextCount: 3,
  });
  assert.deepEqual(next.map((item) => item.id), ["pm-b", "pm-a", "pm-c"]);
});

test("selectNextItems does not penalize work blocked only by closed items", () => {
  const next = selectNextItems([
    {
      id: "pm-y",
      title: "Continue implementation",
      type: "Task",
      status: "open",
      priority: 1,
      updated_at: "2026-06-05T00:00:00Z",
      blocked_by: [{ id: "pm-z", kind: "blocked_by" }],
    },
    {
      id: "pm-z",
      title: "Closed prerequisite",
      type: "Task",
      status: "closed",
      priority: 1,
      updated_at: "2026-06-01T00:00:00Z",
    },
  ], { generatedAt: "2026-06-06T00:00:00Z", nextCount: 1 });
  assert.equal(next[0]?.id, "pm-y");
  assert.equal(next[0]?.whyNow, "priority 1");
  assert.ok(next[0]?.rankingReasons.includes("unblocked"));
  assert.ok(!next[0]?.rankingReasons.some((reason) => reason.startsWith("blocked_by_active_dependency")));
});

test("selectNextItems keeps overdue deadlines more urgent than due-today deadlines", () => {
  const next = selectNextItems([
    {
      id: "pm-overdue",
      title: "Overdue release gate",
      type: "Task",
      status: "open",
      priority: 1,
      updated_at: "2026-06-05T00:00:00Z",
      deadline: "2026-06-05T00:00:00Z",
    },
    {
      id: "pm-today",
      title: "Due today release gate",
      type: "Task",
      status: "open",
      priority: 1,
      updated_at: "2026-06-05T00:00:00Z",
      deadline: "2026-06-06T23:00:00Z",
    },
  ], { generatedAt: "2026-06-06T12:00:00Z", nextCount: 2 });
  assert.deepEqual(next.map((item) => item.id), ["pm-overdue", "pm-today"]);
  assert.ok((next[0]?.rankingScore ?? 0) > (next[1]?.rankingScore ?? 0));
  assert.ok(next[0]?.rankingReasons.some((reason) => reason.startsWith("deadline_overdue:")));
});

test("explainNextItems provides score breakdown and dependency signals", () => {
  const explained = explainNextItems(items, { generatedAt: "2026-06-06T00:00:00Z", nextCount: 3 });
  assert.deepEqual(explained.map((entry) => entry.item.id), ["pm-b", "pm-c", "pm-a"]);
  assert.equal(explained[0]?.activeDependents, 1);
  assert.equal(explained[2]?.score.blocked, -80);
  assert.ok((explained[2]?.score.total ?? 0) < (explained[1]?.score.total ?? 0));
  for (const entry of explained) {
    const { total, ...components } = entry.score;
    const componentTotal = Object.values(components).reduce((sum, value) => sum + value, 0);
    assert.equal(total, Math.round(componentTotal));
  }
});

test("explainNextItems deduplicates repeated relationship signals", () => {
  const explained = explainNextItems([
    {
      id: "pm-work",
      title: "Implement duplicate relationship handling",
      type: "Task",
      status: "open",
      priority: 1,
      deps: ["pm-dep", "pm-dep"],
    },
    {
      id: "pm-dep",
      title: "Single prerequisite",
      type: "Task",
      status: "open",
      priority: 2,
    },
  ], { generatedAt: "2026-06-06T00:00:00Z", nextCount: 2 });
  const work = explained.find((entry) => entry.item.id === "pm-work");
  assert.ok(work);
  assert.equal(work.activeDependencies, 1);
  assert.deepEqual(work.item.dependencyIds, ["pm-dep"]);
  assert.deepEqual(work.item.requiredContext, ["dependency:pm-dep"]);
  assert.equal(work.score.dependencies, -20);
});

test("detectStaleContext reports stale open work only", () => {
  const stale = detectStaleContext(items, { generatedAt: "2026-06-06T00:00:00Z", staleDays: 7 });
  assert.deepEqual(stale.map((item) => item.itemId), ["pm-c", "pm-b"]);
});

test("summarizeRisks includes blockers, overdue deadlines and stale context", () => {
  const risks = summarizeRisks(items, { generatedAt: "2026-06-06T00:00:00Z", staleDays: 7 });
  assert.ok(risks.some((risk) => risk.itemId === "pm-a" && risk.reason === "blocked by visible dependency"));
  assert.ok(risks.some((risk) => risk.itemId === "pm-c" && risk.reason.includes("deadline passed")));
  assert.ok(risks.some((risk) => risk.itemId === "pm-b" && risk.reason.includes("stale context")));
});

test("buildBrief creates deterministic agent brief with suggestions", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    tokenBudget: 4000,
    pmRoot: ".agents/pm",
    pmVersion: "2026.6.6",
  });
  assert.equal(brief.workspace.itemCount, 4);
  assert.deepEqual(brief.focus.map((item) => item.id), ["pm-a"]);
  assert.deepEqual(brief.blockers, [{ itemId: "pm-a", blockedBy: "pm-b", kind: "blocked_by", title: "Approve changelog", status: "open" }]);
  assert.ok(brief.decisionsNeeded.some((item) => item.id === "pm-b"));
  assert.ok(brief.recommendedPmUpdates.some((update) => update.command.startsWith("pm append pm-c")));
  assert.equal(brief.budget.truncated, false);
});

test("buildBrief adds insights for missing focus and empty filtered results", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-missing", "pm-d"],
    assignee: "nobody",
  });
  const messages = brief.insights?.map((insight) => insight.message) ?? [];
  assert.ok(messages.some((message) => message.includes("requested focus id(s) were not found")));
  assert.ok(messages.some((message) => message.includes("closed focus item(s) were omitted")));
  assert.ok(messages.some((message) => message.includes("no open work matched filters")));
  const suggestions = brief.insights?.flatMap((insight) => insight.suggestion ? [insight.suggestion] : []) ?? [];
  assert.ok(suggestions.includes("pm get pm-missing"));
  assert.ok(suggestions.includes("pm brief --format markdown"));
});

test("buildBrief does not emit executable guidance for an unsafe focus id", () => {
  const brief = buildBrief(items, { focusIds: ["pm-missing;echo-pwned"] });
  const missingFocus = brief.insights?.find((insight) => insight.message.includes("requested focus id(s) were not found"));
  assert.ok(missingFocus);
  assert.equal(missingFocus.suggestion, undefined);
});

test("buildBrief compacts when token budget is small", () => {
  const brief = buildBrief(items, { generatedAt: "2026-06-06T00:00:00Z", tokenBudget: 50 });
  assert.equal(brief.budget.truncated, true);
  assert.ok(brief.next.length <= 3);
});

test("detectStaleContext allows a zero-day threshold for immediate freshness checks", () => {
  const stale = detectStaleContext(items, { generatedAt: "2026-06-06T00:00:00Z", staleDays: 0 });
  assert.deepEqual(stale.map((item) => item.itemId), ["pm-c", "pm-b", "pm-a"]);
});

test("renderMarkdownBrief emits stable agent sections", () => {
  const markdown = renderMarkdownBrief(buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    pmVersion: "2026.6.6",
  }));
  assert.match(markdown, /^# pm brief/);
  assert.match(markdown, /## Next Work/);
  assert.match(markdown, /score \d+; confidence \d+/);
  assert.match(markdown, /pm-a blocked_by pm-b Approve changelog \(open\)/);
  assert.match(markdown, /Recommended PM Updates/);
});

test("renderMarkdownBrief includes brief insights section when available", () => {
  const markdown = renderMarkdownBrief(buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-missing"],
  }));
  assert.match(markdown, /## Brief Insights/);
  assert.match(markdown, /requested focus id\(s\) were not found/);
  assert.match(markdown, /suggestion: `pm get pm-missing`/);
});

test("renderAgentPrompt emits copy-pasteable next-turn instructions", () => {
  const prompt = renderAgentPrompt(buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    pmVersion: "2026.6.12",
    tokenBudget: 2500,
  }));
  assert.match(prompt, /^You are continuing work in a pm-managed project\./);
  assert.match(prompt, /Next work:/);
  assert.match(prompt, /pm-b: Approve changelog/);
  assert.match(prompt, /score=\d+; confidence=\d+/);
  assert.match(prompt, /Suggested pm commands:/);
  assert.match(prompt, /pm append pm-c/);
  assert.match(prompt, /Record meaningful decisions, tests, and blockers in pm before handing off\./);

  const deduped = renderAgentPrompt(buildBrief([
    {
      id: "pm-context",
      title: "Condense duplicate context",
      type: "Task",
      status: "open",
      priority: 1,
      docs: ["docs/context.md"],
      files: [{ path: "docs/context.md" }],
    },
  ], {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-context"],
  }));
  assert.equal(deduped.match(/docs\/context\.md/g)?.length, 1);
});

test("extension registers --include-history, --history-limit, and --format slack flags", async () => {
  const flags = await registeredFlagLongs("brief");
  assert.ok(flags.includes("--include-history"));
  assert.ok(flags.includes("--history-limit"));
  const formatFlag = (await registeredFlags("brief")).find((flag) => flag.long === "--format");
  assert.match(formatFlag?.description ?? "", /slack/);
});

test("buildBrief omits recentActivity when includeHistory is not set", () => {
  const brief = buildBrief(items, { generatedAt: "2026-06-06T00:00:00Z", focusIds: ["pm-a"] });
  assert.equal(brief.recentActivity, undefined);
});

test("buildBrief includes recent activity when includeHistory is set", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    includeHistory: true,
    historyLimit: 5,
    pmRoot: ".agents/pm",
  });
  assert.ok(Array.isArray(brief.recentActivity));
  for (const entry of brief.recentActivity ?? []) {
    assert.ok(typeof entry.timestamp === "string" && entry.timestamp.length > 0);
    assert.ok(typeof entry.operation === "string" && entry.operation.length > 0);
  }
});

test("readRecentActivity returns an array without throwing", () => {
  const activity = readRecentActivity(".agents/pm", 3);
  assert.ok(Array.isArray(activity));
  for (const entry of activity) {
    assert.ok(typeof entry.timestamp === "string");
    assert.ok(typeof entry.operation === "string");
  }
});

test("buildBrief highlights focus types alongside focus ids", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusTypes: ["decision"],
  });
  assert.ok(brief.focus.some((item) => item.id === "pm-b"));
  assert.ok(brief.focus.some((item) => item.type === "Decision"));
});

test("type focus silently excludes closed matches without claiming explicit focus ids were omitted", () => {
  const brief = buildBrief([
    ...items,
    { id: "pm-closed-decision", title: "Archived decision", type: "Decision", status: "closed", priority: 2 },
  ], {
    generatedAt: "2026-06-06T00:00:00Z",
    focusTypes: ["decision"],
  });
  assert.ok(!brief.focus.some((item) => item.id === "pm-closed-decision"));
  assert.ok(!(brief.insights ?? []).some((insight) => insight.message.includes("pm-closed-decision")));
});

test("buildBrief focus types combine with explicit focus ids", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    focusTypes: ["decision"],
  });
  assert.deepEqual(brief.focus.map((item) => item.id), ["pm-a", "pm-b"]);
});

test("renderSlackBrief emits Slack-formatted bold headers and bullet items", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    includeHistory: true,
    pmRoot: ".agents/pm",
    pmVersion: "2026.6.13",
  });
  brief.recentActivity = [{ timestamp: "2026-06-05T12:00:00Z", operation: "comment", itemId: "pm-a" }];
  const slack = renderSlackBrief(brief);
  assert.match(slack, /^\*pm brief\*/);
  assert.match(slack, /\*Next Work\*/);
  assert.match(slack, /\*Focus\*/);
  assert.match(slack, /\*Blockers\*/);
  assert.match(slack, /\*Risks\*/);
  assert.match(slack, /\*Stale Context\*/);
  assert.match(slack, /• `pm-b` Approve changelog/);
  assert.match(slack, /`pm-a` blocked_by `pm-b` Approve changelog/);
  assert.doesNotMatch(slack, /`pm-b` pm-b Approve changelog/);
  assert.match(slack, /\*Recent Activity\*/);
  assert.ok(!slack.includes("# pm brief"));
  assert.ok(!slack.includes("## "));
});

test("renderSlackBrief omits Recent Activity section when history is not included", () => {
  const slack = renderSlackBrief(buildBrief(items, { generatedAt: "2026-06-06T00:00:00Z", focusIds: ["pm-a"] }));
  assert.ok(!slack.includes("*Recent Activity*"));
});

test("renderMarkdownBrief includes Recent Activity section when history is present", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    includeHistory: true,
    pmRoot: ".agents/pm",
  });
  brief.recentActivity = [{ timestamp: "2026-06-05T12:00:00Z", operation: "comment", itemId: "pm-a" }];
  const markdown = renderMarkdownBrief(brief);
  assert.match(markdown, /## Recent Activity/);
});

test("renderAgentPrompt includes recent activity when history is present", () => {
  const brief = buildBrief(items, {
    generatedAt: "2026-06-06T00:00:00Z",
    focusIds: ["pm-a"],
    includeHistory: true,
    pmRoot: ".agents/pm",
  });
  brief.recentActivity = [{ timestamp: "2026-06-05T12:00:00Z", operation: "comment", itemId: "pm-a" }];
  const prompt = renderAgentPrompt(brief);
  assert.match(prompt, /Recent activity:/);
});

const momentumItems: PmItem[] = [
  { id: "pm-m1", title: "Fast task", type: "Task", status: "closed", created_at: "2026-06-06T00:00:00Z", closed_at: "2026-06-09T00:00:00Z" },
  { id: "pm-m2", title: "Slow issue", type: "Issue", status: "done", created_at: "2026-06-01T00:00:00Z", closed_at: "2026-06-08T00:00:00Z" },
  { id: "pm-m3", title: "Stale close (no closed_at)", type: "Task", status: "closed", updated_at: "2026-06-09T00:00:00Z" },
  { id: "pm-m4", title: "Old close outside window", type: "Task", status: "closed", created_at: "2026-04-01T00:00:00Z", closed_at: "2026-05-01T00:00:00Z" },
  { id: "pm-m5", title: "Still open", type: "Task", status: "open", created_at: "2026-06-05T00:00:00Z" },
];

test("summarizeMomentum counts closes within the window with cycle-time stats", () => {
  const momentum = summarizeMomentum(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 });
  assert.equal(momentum.windowDays, 7);
  assert.equal(momentum.closedCount, 3);
  assert.deepEqual({ ...momentum.byType }, { Task: 2, Issue: 1 });
  assert.equal(momentum.throughputPerDay, 0.43);
  assert.ok(momentum.cycleTime);
  assert.equal(momentum.cycleTime?.sampleSize, 2);
  assert.equal(momentum.cycleTime?.medianDays, 5);
  assert.equal(momentum.cycleTime?.p90Days, 7);
  assert.deepEqual(momentum.recent.map((entry) => entry.id), ["pm-m1", "pm-m3", "pm-m2"]);
  assert.equal(momentum.recent.find((entry) => entry.id === "pm-m1")?.cycleDays, 3);
  assert.equal(momentum.recent.find((entry) => entry.id === "pm-m3")?.cycleDays, undefined);
});

test("summarizeMomentum excludes closes older than the window and open items", () => {
  const momentum = summarizeMomentum(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 });
  assert.ok(!momentum.recent.some((entry) => entry.id === "pm-m4"));
  assert.ok(!momentum.recent.some((entry) => entry.id === "pm-m5"));
  const wide = summarizeMomentum(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 90 });
  assert.equal(wide.closedCount, 4);
});

test("summarizeMomentum excludes closed items lacking a real close timestamp", () => {
  // A closed item with only created_at has no closed_at/updated_at signal, so
  // it must not be placed in the window nor inject a spurious 0-day cycle time.
  const noCloseSignal: PmItem[] = [
    { id: "pm-only-created", title: "Imported, no close stamp", type: "Task", status: "closed", created_at: "2026-06-09T00:00:00Z" },
    { id: "pm-real", title: "Properly closed", type: "Task", status: "closed", created_at: "2026-06-06T00:00:00Z", closed_at: "2026-06-08T00:00:00Z" },
  ];
  const momentum = summarizeMomentum(noCloseSignal, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 });
  assert.equal(momentum.closedCount, 1);
  assert.deepEqual(momentum.recent.map((entry) => entry.id), ["pm-real"]);
  assert.equal(momentum.cycleTime?.sampleSize, 1);
  assert.equal(momentum.cycleTime?.medianDays, 2);
});

test("summarizeMomentum tallies reserved-name item types without prototype collisions", () => {
  const reservedTypeItems: PmItem[] = [
    { id: "pm-r1", title: "Weird type A", type: "toString", status: "closed", created_at: "2026-06-08T00:00:00Z", closed_at: "2026-06-09T00:00:00Z" },
    { id: "pm-r2", title: "Weird type B", type: "toString", status: "closed", created_at: "2026-06-07T00:00:00Z", closed_at: "2026-06-09T00:00:00Z" },
    { id: "pm-r3", title: "Normal", type: "Task", status: "closed", created_at: "2026-06-06T00:00:00Z", closed_at: "2026-06-08T00:00:00Z" },
  ];
  const momentum = summarizeMomentum(reservedTypeItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 });
  assert.equal(momentum.byType["toString"], 2);
  assert.equal(momentum.byType["Task"], 1);
  assert.equal(momentum.closedCount, 3);
  // JSON output (used by --format json) must serialize the null-proto map cleanly.
  assert.deepEqual(JSON.parse(JSON.stringify(momentum.byType)), { toString: 2, Task: 1 });
});

test("summarizeMomentum clamps a negative window to zero", () => {
  const momentum = summarizeMomentum(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: -5 });
  assert.equal(momentum.windowDays, 0);
  assert.equal(momentum.throughputPerDay, 0);
});

test("summarizeMomentum reports an empty window cleanly", () => {
  const momentum = summarizeMomentum(momentumItems, { generatedAt: "2027-01-01T00:00:00Z", completedDays: 7 });
  assert.equal(momentum.closedCount, 0);
  assert.deepEqual({ ...momentum.byType }, {});
  assert.equal(momentum.cycleTime, undefined);
  assert.deepEqual(momentum.recent, []);
});

test("buildBrief always includes a momentum summary", () => {
  const brief = buildBrief(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 });
  assert.equal(brief.momentum.closedCount, 3);
});

test("renderMarkdownBrief includes a Momentum section with velocity metrics", () => {
  const markdown = renderMarkdownBrief(buildBrief(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 }));
  assert.match(markdown, /## Momentum/);
  assert.match(markdown, /Closed 3 item\(s\) in the last 7 day\(s\)/);
  assert.match(markdown, /Cycle time: median 5d, p90 7d \(n=2\)/);
});

test("renderMarkdownBrief renders an empty Momentum section when nothing closed recently", () => {
  const markdown = renderMarkdownBrief(buildBrief(momentumItems, { generatedAt: "2027-01-01T00:00:00Z", completedDays: 7 }));
  assert.match(markdown, /## Momentum\n\n_No items closed in the last 7 day\(s\)\._/);
});

test("renderSlackBrief includes a Momentum section", () => {
  const slack = renderSlackBrief(buildBrief(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 }));
  assert.match(slack, /\*Momentum\*/);
  assert.match(slack, /Closed 3 item\(s\)/);
});

test("renderAgentPrompt surfaces momentum when items closed recently", () => {
  const prompt = renderAgentPrompt(buildBrief(momentumItems, { generatedAt: "2026-06-10T00:00:00Z", completedDays: 7 }));
  assert.match(prompt, /Recent momentum:/);
  assert.match(prompt, /Closed 3 item\(s\) in the last 7 day\(s\); throughput 0.43\/day, median cycle 5d/);
});

test("brief command registers a --completed-days flag and brief momentum exposes --days", async () => {
  assert.ok((await registeredFlagLongs("brief")).includes("--completed-days"));
  assert.ok((await registeredCommandPaths()).includes("brief momentum"), "brief momentum command should be registered");
  const momentumFlags = await registeredFlagLongs("brief momentum");
  assert.ok(momentumFlags.includes("--days"));
  assert.ok(momentumFlags.includes("--format"));
});

// ---------------------------------------------------------------------------
// brief since / buildDelta
// ---------------------------------------------------------------------------

function actEntry(
  id: string,
  op: string,
  ts: string,
  patch: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }> = [],
  author = "pi-agent",
): DeltaActivityEntry {
  return { ts, author, op, id, patch };
}

function itemsById(items: PmItem[]): Map<string, PmItem> {
  return new Map(items.map((item) => [item.id, item]));
}

describe("brief since / buildDelta", () => {
  test("classifies created, closed, status-transition, reprioritized, and note", () => {
    const entries: DeltaActivityEntry[] = [
      // pm-new: created
      actEntry("pm-new", "create", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/title", value: "New item" },
        { op: "add", path: "/metadata/type", value: "Feature" },
        { op: "add", path: "/metadata/status", value: "open" },
        { op: "add", path: "/metadata/priority", value: 2 },
      ]),
      // pm-closed: closed via close op + close_reason
      actEntry("pm-closed", "close", "2026-07-21T01:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "closed" },
        { op: "add", path: "/metadata/close_reason", value: "completed" },
      ]),
      // pm-status: open -> in_progress (started)
      actEntry("pm-status", "update", "2026-07-20T01:45:00Z", [
        { op: "replace", path: "/metadata/status", value: "open" },
      ]),
      actEntry("pm-status", "update", "2026-07-20T02:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "in_progress" },
      ]),
      // pm-prio: priority 3 -> 1
      actEntry("pm-prio", "update", "2026-07-20T02:30:00Z", [
        { op: "replace", path: "/metadata/priority", value: 3 },
      ]),
      actEntry("pm-prio", "update", "2026-07-20T03:00:00Z", [
        { op: "replace", path: "/metadata/priority", value: 1 },
      ]),
      // pm-note: note added
      actEntry("pm-note", "note_add", "2026-07-20T04:00:00Z", [
        { op: "add", path: "/metadata/notes/1", value: { text: "hi" } },
      ]),
    ];
    const items: PmItem[] = [
      { id: "pm-new", title: "New item", type: "Feature", status: "open", priority: 2 },
      { id: "pm-closed", title: "Done thing", type: "Task", status: "closed", priority: 3 },
      { id: "pm-status", title: "In flight", type: "Task", status: "in_progress", priority: 2 },
      { id: "pm-prio", title: "Reordered", type: "Chore", status: "open", priority: 1 },
      { id: "pm-note", title: "Noted", type: "Task", status: "open", priority: 4 },
    ];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20", workspace: ".agents/pm", pmVersion: "test" });
    const byId = new Map(summary.items.map((c) => [c.id, c]));
    assert.equal(byId.get("pm-new")?.created, true);
    assert.equal(byId.get("pm-closed")?.closed, true);
    assert.equal(byId.get("pm-closed")?.closeReason, "completed");
    assert.equal(byId.get("pm-status")?.statusTransition?.from, "open");
    assert.equal(byId.get("pm-status")?.statusTransition?.to, "in_progress");
    assert.equal(byId.get("pm-status")?.statusLabel, "started");
    assert.equal(byId.get("pm-prio")?.priorityChange?.from, "3");
    assert.equal(byId.get("pm-prio")?.priorityChange?.to, 1);
    assert.equal(byId.get("pm-note")?.notesAdded, 1);
    assert.equal(summary.totals.created, 1);
    assert.equal(summary.totals.closed, 1);
    assert.equal(summary.totals.statusChanged, 1);
    assert.equal(summary.totals.reprioritized, 1);
    assert.equal(summary.totals.notes, 1);
    assert.equal(summary.totals.itemsChanged, 5);
    assert.equal(summary.totals.events, 7);
  });

  test("derives newly-blocked and unblocked status labels", () => {
    const entries: DeltaActivityEntry[] = [
      // pm-block: open -> blocked (newly blocked)
      actEntry("pm-block", "update", "2026-07-20T01:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "blocked" },
      ]),
      // pm-unblock: blocked -> open (unblocked)
      actEntry("pm-unblock", "update", "2026-07-20T01:30:00Z", [
        { op: "replace", path: "/metadata/status", value: "blocked" },
      ]),
      actEntry("pm-unblock", "update", "2026-07-20T02:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "open" },
      ]),
    ];
    const items: PmItem[] = [
      { id: "pm-block", title: "B", type: "Task", status: "blocked", priority: 2 },
      { id: "pm-unblock", title: "U", type: "Task", status: "open", priority: 2 },
    ];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20" });
    const byId = new Map(summary.items.map((c) => [c.id, c]));
    assert.equal(byId.get("pm-block")?.statusLabel, "newly blocked");
    assert.equal(byId.get("pm-unblock")?.statusLabel, "unblocked");
  });

  test("counts dependency add/remove from /metadata/deps patch paths", () => {
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-deps", "update", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/deps/0", value: { id: "pm-x", kind: "depends_on" } },
        { op: "add", path: "/metadata/deps/1", value: { id: "pm-y", kind: "depends_on" } },
        { op: "remove", path: "/metadata/deps/0" },
        { op: "add", path: "/relationships/0", value: { id: "pm-z" } },
      ]),
    ];
    const items: PmItem[] = [{ id: "pm-deps", title: "D", type: "Task", status: "open", priority: 2 }];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20" });
    const change = summary.items[0];
    assert.equal(change.depsAdded, 3);
    assert.equal(change.depsRemoved, 1);
    assert.equal(summary.totals.depsAdded, 3);
    assert.equal(summary.totals.depsRemoved, 1);
  });

  test("deterministic ordering: created before status-changed before other; priority tie-break", () => {
    // pm-other: only a note (rank 4, priority 5)
    // pm-status: status change (rank 3, priority 3)
    // pm-created: created (rank 0, priority 1)
    // pm-created2: created (rank 0, priority 2)
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-created", "create", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/title", value: "C1" },
        { op: "add", path: "/metadata/status", value: "open" },
      ]),
      actEntry("pm-created2", "create", "2026-07-20T02:00:00Z", [
        { op: "add", path: "/metadata/title", value: "C2" },
        { op: "add", path: "/metadata/status", value: "open" },
      ]),
      actEntry("pm-status", "update", "2026-07-20T03:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "in_progress" },
      ]),
      actEntry("pm-other", "note_add", "2026-07-20T04:00:00Z", [
        { op: "add", path: "/metadata/notes/0", value: {} },
      ]),
    ];
    const items: PmItem[] = [
      { id: "pm-created", title: "C1", type: "Task", status: "open", priority: 1 },
      { id: "pm-created2", title: "C2", type: "Task", status: "open", priority: 2 },
      { id: "pm-status", title: "S", type: "Task", status: "in_progress", priority: 3 },
      { id: "pm-other", title: "O", type: "Task", status: "open", priority: 5 },
    ];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20" });
    assert.deepEqual(
      summary.items.map((c) => c.id),
      ["pm-created", "pm-created2", "pm-status", "pm-other"],
    );
  });

  test("empty window produces zero totals, empty items, and a 'No changes' render", () => {
    const summary = buildDelta([], new Map(), { since: "2026-07-01" });
    assert.equal(summary.totals.itemsChanged, 0);
    assert.equal(summary.totals.events, 0);
    assert.equal(summary.items.length, 0);
    const md = renderMarkdownDelta(summary);
    assert.match(md, /No changes since 2026-07-01/);
    const text = renderTextDelta(summary);
    assert.match(text, /No changes since 2026-07-01/);
  });

  test("JSON summary shape is stable and markdown renderer contains expected section headers", () => {
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-new", "create", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/title", value: "New" },
        { op: "add", path: "/metadata/status", value: "open" },
      ]),
      actEntry("pm-closed", "close", "2026-07-20T02:00:00Z", [
        { op: "replace", path: "/metadata/status", value: "closed" },
        { op: "add", path: "/metadata/close_reason", value: "completed" },
      ]),
      actEntry("pm-note", "note_add", "2026-07-20T03:00:00Z", [
        { op: "add", path: "/metadata/notes/0", value: {} },
      ]),
    ];
    const items: PmItem[] = [
      { id: "pm-new", title: "New", type: "Feature", status: "open", priority: 1 },
      { id: "pm-closed", title: "Done", type: "Task", status: "closed", priority: 2 },
      { id: "pm-note", title: "Noted", type: "Task", status: "open", priority: 3 },
    ];
    const summary = buildDelta(entries, itemsById(items), {
      since: "2026-07-20",
      until: "2026-07-22",
      author: "alice",
      workspace: ".agents/pm",
      pmVersion: "test",
      generatedAt: "2026-07-22T00:00:00Z",
    });
    assert.equal(summary.since, "2026-07-20");
    assert.equal(summary.until, "2026-07-22");
    assert.equal(summary.author, "alice");
    assert.equal(summary.workspace, ".agents/pm");
    assert.equal(summary.pmVersion, "test");
    assert.equal(summary.generatedAt, "2026-07-22T00:00:00Z");
    assert.equal(summary.totals.created, 1);
    assert.equal(summary.totals.closed, 1);
    assert.equal(summary.totals.notes, 1);
    const md = renderMarkdownDelta(summary);
    assert.match(md, /# Delta since 2026-07-20 until 2026-07-22 by alice/);
    assert.match(md, /## Summary/);
    assert.match(md, /## Created/);
    assert.match(md, /## Closed/);
    assert.match(md, /## Discussion/);
    assert.match(md, /## Refresh/);
    const slack = renderSlackDelta(summary);
    assert.match(slack, /\*Delta since 2026-07-20 until 2026-07-22 by alice\*/);
    assert.match(slack, /\*Created\*/);
  });

  test("normalizeCheckpoint signs bare relative windows and passes timestamps through", () => {
    assert.equal(normalizeCheckpoint("7d"), "-7d");
    assert.equal(normalizeCheckpoint("24h"), "-24h");
    assert.equal(normalizeCheckpoint("2w"), "-2w");
    assert.equal(normalizeCheckpoint("30m"), "-30m");
    assert.equal(normalizeCheckpoint("  7d  "), "-7d");
    // already-signed, ISO timestamps, and plain dates are untouched
    assert.equal(normalizeCheckpoint("-7d"), "-7d");
    assert.equal(normalizeCheckpoint("2026-07-20"), "2026-07-20");
    assert.equal(normalizeCheckpoint("2026-07-20T00:00:00Z"), "2026-07-20T00:00:00Z");
  });

  test("creation baseline is not counted as retitle/reprioritize/reassign/status change", () => {
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-fresh", "create", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/title", value: "Fresh" },
        { op: "add", path: "/metadata/status", value: "open" },
        { op: "add", path: "/metadata/priority", value: 1 },
        { op: "add", path: "/metadata/assignee", value: "bob" },
      ]),
    ];
    const items: PmItem[] = [{ id: "pm-fresh", title: "Fresh", type: "Feature", status: "open", priority: 1 }];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20" });
    const change = summary.items[0];
    assert.equal(change.created, true);
    assert.equal(change.retitled, false);
    assert.equal(change.priorityChange, undefined);
    assert.equal(change.reassigned, undefined);
    assert.equal(change.statusTransition, undefined);
    assert.equal(summary.totals.retitled, 0);
    assert.equal(summary.totals.reprioritized, 0);
    assert.equal(summary.totals.reassigned, 0);
    assert.equal(summary.totals.statusChanged, 0);
    // post-creation edits ARE still real changes
    const withEdit: DeltaActivityEntry[] = [
      ...entries,
      actEntry("pm-fresh", "update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }]),
    ];
    const editedChange = buildDelta(withEdit, itemsById(items), { since: "2026-07-20" }).items[0];
    assert.equal(editedChange.created, true);
    assert.equal(editedChange.statusLabel, "started");
  });

  test("each changed item appears in exactly one markdown section (no duplication)", () => {
    // pm-multi is created AND has a note AND a dependency change: it must render once.
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-multi", "create", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/title", value: "Multi" }]),
      actEntry("pm-multi", "note_add", "2026-07-20T02:00:00Z", [{ op: "add", path: "/metadata/notes/1", value: { text: "n" } }]),
      actEntry("pm-multi", "update", "2026-07-20T03:00:00Z", [{ op: "add", path: "/metadata/deps/0", value: { id: "pm-x" } }]),
    ];
    const items: PmItem[] = [{ id: "pm-multi", title: "Multi", type: "Task", status: "open", priority: 2 }];
    const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20" });
    const md = renderMarkdownDelta(summary);
    assert.equal((md.match(/pm-multi/g) ?? []).length, 1);
    // its single line still surfaces every change
    assert.match(md, /pm-multi:.*created.*\+1 dep.*note/);
    // primary section is Created (highest rank)
    assert.match(md, /## Created\n\n- pm-multi/);
    // the Refresh block is a proper fenced code block, not an inline ```cmd```
    assert.match(md, /## Refresh\n\n```\npm brief since [^\n]+\n```/);
  });

  test("counts real /metadata/dependencies adds and ignores the close side-effect removal", () => {
    const entries: DeltaActivityEntry[] = [
      // real pm emits dependency edits at /metadata/dependencies (not /metadata/deps)
      actEntry("pm-dep", "update", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/dependencies", value: [{ id: "pm-x", kind: "depends_on" }] }]),
      // closing tears down edges: `remove /metadata/dependencies` is a side-effect, not a user removal
      actEntry("pm-dep", "close", "2026-07-20T02:00:00Z", [
        { op: "remove", path: "/metadata/dependencies" },
        { op: "replace", path: "/metadata/status", value: "closed" },
      ]),
    ];
    const items: PmItem[] = [{ id: "pm-dep", title: "Dep", type: "Task", status: "closed", priority: 2 }];
    const change = buildDelta(entries, itemsById(items), { since: "2026-07-20" }).items[0];
    assert.equal(change.depsAdded, 1);
    assert.equal(change.depsRemoved, 0, "close-side-effect removal must not count as a dependency removal");
  });

  test("buildDelta clamps maxItems to at least 1 (exported-API guard)", () => {
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-1", "create", "2026-07-20T01:00:00Z"),
      actEntry("pm-2", "create", "2026-07-20T02:00:00Z"),
      actEntry("pm-3", "create", "2026-07-20T03:00:00Z"),
    ];
    const items: PmItem[] = [
      { id: "pm-1", title: "1", type: "Task", status: "open", priority: 2 },
      { id: "pm-2", title: "2", type: "Task", status: "open", priority: 2 },
      { id: "pm-3", title: "3", type: "Task", status: "open", priority: 2 },
    ];
    // the top-ranked item under a valid budget of 1
    const topId = buildDelta(entries, itemsById(items), { since: "2026-07-20", maxItems: 1 }).items[0].id;
    // maxItems 0 / negative must not slice from the end or drop everything
    for (const bad of [0, -2]) {
      const summary = buildDelta(entries, itemsById(items), { since: "2026-07-20", maxItems: bad });
      assert.ok(summary.items.length >= 1, `maxItems=${bad} kept at least one item`);
      assert.equal(summary.items[0].id, topId, `maxItems=${bad} kept the top-ranked item, not a tail slice`);
    }
  });

  test("buildDelta tolerates a patch element without a string path", () => {
    const entries: DeltaActivityEntry[] = [
      actEntry("pm-bad", "update", "2026-07-20T01:00:00Z", [
        { op: "add" } as unknown as { op: "add"; path: string },
        { op: "replace", path: "/metadata/status", value: "in_progress" },
      ]),
    ];
    const items: PmItem[] = [{ id: "pm-bad", title: "B", type: "Task", status: "in_progress", priority: 2 }];
    assert.doesNotThrow(() => {
      const change = buildDelta(entries, itemsById(items), { since: "2026-07-20" }).items[0];
      assert.equal(change.statusTransition?.to, "in_progress");
    });
  });
});

// ---------------------------------------------------------------------------
// brief diverge / buildDivergence
// ---------------------------------------------------------------------------

function divEvent(
  op: string,
  ts: string,
  patch: Array<{ op: string; path: string; value?: unknown }> = [],
  opts: { author?: string; afterHash?: string } = {},
): DivergeEvent {
  return {
    ts,
    author: opts.author ?? "pi-agent",
    op,
    patch,
    after_hash: opts.afterHash,
  };
}

describe("brief diverge / buildDivergence", () => {
  test("parseHistoryJsonl tolerates blank and malformed lines", () => {
    const text = [
      '{"ts":"2026-07-20T01:00:00Z","author":"a","op":"create","patch":[],"after_hash":"h1"}',
      "",
      "   ",
      "not-json",
      '{"ts":"2026-07-20T02:00:00Z","author":"b","op":"update","patch":[{"op":"replace","path":"/metadata/status","value":"open"}],"after_hash":"h2"}',
      '{"op":"update"}', // missing ts — should be skipped
    ].join("\n");
    const events = parseHistoryJsonl(text);
    assert.equal(events.length, 2);
    assert.equal(events[0]?.op, "create");
    assert.equal(events[1]?.op, "update");
  });

  test("parseHistoryJsonl returns empty for undefined/empty input", () => {
    assert.deepEqual(parseHistoryJsonl(undefined), []);
    assert.deepEqual(parseHistoryJsonl(""), []);
  });

  test("changedFieldPaths normalizes trailing numeric array segments", () => {
    const events: DivergeEvent[] = [
      divEvent("update", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/tags/3", value: "foo" },
        { op: "add", path: "/metadata/tags/7", value: "bar" },
        { op: "replace", path: "/metadata/status", value: "open" },
        { op: "add", path: "/metadata/notes/1", value: {} },
      ]),
    ];
    const fields = [...changedFieldPaths(events)].sort();
    // /metadata/tags/3 and /metadata/tags/7 both normalize to /metadata/tags
    assert.ok(fields.includes("/metadata/tags"));
    assert.ok(fields.includes("/metadata/status"));
    assert.ok(fields.includes("/metadata/notes"));
    // no raw numeric paths
    assert.ok(!fields.includes("/metadata/tags/3"));
    assert.ok(!fields.includes("/metadata/tags/7"));
    assert.ok(!fields.includes("/metadata/notes/1"));
  });

  test("eventKey uses after_hash when available, else ts|author|op", () => {
    assert.equal(eventKey(divEvent("create", "2026-07-20T01:00:00Z", [], { afterHash: "abc123" })), "abc123");
    assert.equal(eventKey(divEvent("update", "2026-07-20T01:00:00Z", [], { author: "bob" })), "2026-07-20T01:00:00Z|bob|update");
  });

  test("classifyItemDivergence: head-only when only head has new events", () => {
    const result = classifyItemDivergence({
      id: "pm-1",
      ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
      base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
      head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
    });
    assert.equal(result.kind, "head-only");
    assert.equal(result.severity, "low");
    assert.equal(result.head.eventCount, 1);
    assert.equal(result.base.eventCount, 0);
  });

  test("classifyItemDivergence: base-only when only base has new events", () => {
    const result = classifyItemDivergence({
      id: "pm-1",
      ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
      base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/title", value: "New" }], { afterHash: "b1" })], itemPresent: true },
      head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
    });
    assert.equal(result.kind, "base-only");
  });

  test("classifyItemDivergence: unchanged when neither side has new events", () => {
    const ancestorEvent = divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" });
    const result = classifyItemDivergence({
      id: "pm-1",
      ancestor: { events: [ancestorEvent], itemPresent: true },
      base: { events: [ancestorEvent], itemPresent: true },
      head: { events: [ancestorEvent], itemPresent: true },
    });
    assert.equal(result.kind, "unchanged");
  });

  test("classifyItemDivergence: duplicate-id when item absent at ancestor but present on both sides", () => {
    const result = classifyItemDivergence({
      id: "pm-dup",
      ancestor: { events: [], itemPresent: false },
      base: { events: [divEvent("create", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/title", value: "Base" }], { afterHash: "b1" })], itemPresent: true },
      head: { events: [divEvent("create", "2026-07-20T02:00:00Z", [{ op: "add", path: "/metadata/title", value: "Head" }], { afterHash: "h1" })], itemPresent: true },
    });
    assert.equal(result.kind, "duplicate-id");
    assert.equal(result.severity, "high");
  });

  test("classifyItemDivergence: delete-vs-edit when .toon absent on exactly one side", () => {
    const ancestorEvent = divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" });
    const result = classifyItemDivergence({
      id: "pm-del",
      ancestor: { events: [ancestorEvent], itemPresent: true },
      base: { events: [ancestorEvent, divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "closed" }], { afterHash: "b1" })], itemPresent: false },
      head: { events: [ancestorEvent, divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
    });
    assert.equal(result.kind, "delete-vs-edit");
    assert.equal(result.severity, "high");
  });

  test("classifyItemDivergence: field-collision when both sides touch the same non-benign field", () => {
    const ancestorEvent = divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" });
    const result = classifyItemDivergence({
      id: "pm-coll",
      ancestor: { events: [ancestorEvent], itemPresent: true },
      base: { events: [ancestorEvent, divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "closed" }], { afterHash: "b1" })], itemPresent: true },
      head: { events: [ancestorEvent, divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
    });
    assert.equal(result.kind, "field-collision");
    assert.equal(result.severity, "medium");
    assert.deepEqual(result.collidingFields, ["/metadata/status"]);
  });

  test("classifyItemDivergence: union-safe when both sides touch disjoint fields", () => {
    const ancestorEvent = divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" });
    const result = classifyItemDivergence({
      id: "pm-uni",
      ancestor: { events: [ancestorEvent], itemPresent: true },
      base: { events: [ancestorEvent, divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "b1" })], itemPresent: true },
      head: { events: [ancestorEvent, divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "bob" }], { afterHash: "h1" })], itemPresent: true },
    });
    assert.equal(result.kind, "union-safe");
    assert.equal(result.severity, "low");
    assert.deepEqual(result.collidingFields, []);
  });

  test("BENIGN_FIELDS alone never yields field-collision", () => {
    const ancestorEvent = divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" });
    const result = classifyItemDivergence({
      id: "pm-benign",
      ancestor: { events: [ancestorEvent], itemPresent: true },
      base: { events: [ancestorEvent, divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/updated_at", value: "2026-07-20T01:00:00Z" }], { afterHash: "b1" })], itemPresent: true },
      head: { events: [ancestorEvent, divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/updated_at", value: "2026-07-20T02:00:00Z" }], { afterHash: "h1" })], itemPresent: true },
    });
    // both sides only touched /metadata/updated_at (benign) — disjoint non-benign fields → union-safe
    assert.equal(result.kind, "union-safe");
    assert.deepEqual(result.collidingFields, []);
  });

  test("buildDivergence verdict precedence: review-required beats union-safe", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-uni",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "bob" }], { afterHash: "h1" })], itemPresent: true },
      }),
      classifyItemDivergence({
        id: "pm-coll",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "closed" }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    assert.equal(summary.verdict, "review-required");
    // field-collision (rank 2) before union-safe (rank 3)
    assert.equal(summary.items[0]?.kind, "field-collision");
    assert.equal(summary.items[1]?.kind, "union-safe");
  });

  test("buildDivergence verdict: union-safe when all both-sided items are union-safe", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-uni",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "bob" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    assert.equal(summary.verdict, "union-safe");
  });

  test("buildDivergence verdict: clean when no both-sided items", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-h",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    assert.equal(summary.verdict, "clean");
    // head-only is not rendered without --include-clean
    assert.equal(summary.items.length, 0);
  });

  test("buildDivergence deterministic ordering: duplicate-id before delete-vs-edit before field-collision before union-safe, tie-break by id", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-z",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "x" }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "h1" })], itemPresent: true },
      }),
      classifyItemDivergence({
        id: "pm-a",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "x" }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    // both are union-safe; tie-break by id ascending → pm-a before pm-z
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    assert.deepEqual(summary.items.map((i) => i.id), ["pm-a", "pm-z"]);
  });

  test("buildDivergence --include-clean surfaces one-sided items", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-h",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
      }),
      classifyItemDivergence({
        id: "pm-b",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/title", value: "New" }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
      includeClean: true,
    });
    // head-only (rank 4) before base-only (rank 5)
    assert.deepEqual(summary.items.map((i) => i.kind), ["head-only", "base-only"]);
  });

  test("buildDivergence: unrelated histories (ancestorSha === undefined) treats every changed item as one-sided", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-h",
        ancestor: { events: [], itemPresent: false },
        base: { events: [], itemPresent: false },
        head: { events: [divEvent("create", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/title", value: "H" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: undefined,
      workspace: ".agents/pm", pmVersion: "test", fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
      includeClean: true,
    });
    assert.equal(summary.ancestorSha, undefined);
    assert.equal(summary.verdict, "clean");
    assert.equal(summary.items[0]?.kind, "head-only");
  });

  test("buildDivergence: unrelatedHistories is an explicit boolean that survives JSON round-trip", () => {
    const item = classifyItemDivergence({
      id: "pm-h",
      ancestor: { events: [], itemPresent: false },
      base: { events: [], itemPresent: false },
      head: { events: [divEvent("create", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/title", value: "H" }], { afterHash: "h1" })], itemPresent: true },
    });
    const common = {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2",
      workspace: ".agents/pm", pmVersion: "test",
      fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    };

    const unrelated = buildDivergence([item], { ...common, ancestorSha: undefined });
    assert.equal(unrelated.unrelatedHistories, true);
    // JSON.stringify drops `undefined`, so `ancestorSha` disappears from the wire
    // format — the boolean is the only signal a JSON consumer can rely on.
    const wire = JSON.parse(JSON.stringify(unrelated));
    assert.equal("ancestorSha" in wire, false);
    assert.equal(wire.unrelatedHistories, true);

    const related = buildDivergence([item], { ...common, ancestorSha: "s0" });
    assert.equal(related.unrelatedHistories, false);
    assert.equal(JSON.parse(JSON.stringify(related)).unrelatedHistories, false);
  });

  test("buildDivergence recommends --allow-unrelated-histories only when there is no merge base", () => {
    const item = classifyItemDivergence({
      id: "pm-h",
      ancestor: { events: [], itemPresent: false },
      base: { events: [], itemPresent: false },
      head: { events: [divEvent("create", "2026-07-20T01:00:00Z", [{ op: "add", path: "/metadata/title", value: "H" }], { afterHash: "h1" })], itemPresent: true },
    });
    const common = {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2",
      workspace: ".agents/pm", pmVersion: "test",
      fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    };

    // git refuses a no-merge-base merge outright, so the bare form would be a
    // command that cannot succeed.
    const unrelated = buildDivergence([item], { ...common, ancestorSha: undefined });
    assert.ok(unrelated.recommendedCommands.includes("git merge --allow-unrelated-histories main"));
    assert.equal(unrelated.recommendedCommands.includes("git merge main"), false);

    const related = buildDivergence([item], { ...common, ancestorSha: "s0" });
    assert.ok(related.recommendedCommands.includes("git merge main"));
    assert.equal(related.recommendedCommands.some((c) => c.includes("--allow-unrelated-histories")), false);
  });

  const DRIVERS = {
    itemToonDriver: "pm merge driver item %O %A %B",
    historyDriver: "pm merge driver history %O %A %B",
  };

  test("evaluateFence: ok when git resolves both merge attributes and both drivers exist", () => {
    const fence = evaluateFence({ itemToonAttr: "pm-item-toon", historyAttr: "pm-history", ...DRIVERS });
    assert.equal(fence.ok, true);
    assert.equal(fence.attributesInstalled, true);
    assert.equal(fence.driversConfigured, true);
    assert.deepEqual(fence.missing, []);
  });

  test("evaluateFence: not ok when git resolves no merge attribute for the pm paths", () => {
    const fence = evaluateFence({ itemToonAttr: undefined, historyAttr: undefined, ...DRIVERS });
    assert.equal(fence.ok, false);
    assert.equal(fence.attributesInstalled, false);
  });

  test("evaluateFence: not ok when only one of the two attributes resolves", () => {
    assert.equal(evaluateFence({ itemToonAttr: "pm-item-toon", historyAttr: undefined, ...DRIVERS }).attributesInstalled, false);
    assert.equal(evaluateFence({ itemToonAttr: undefined, historyAttr: "pm-history", ...DRIVERS }).attributesInstalled, false);
  });

  test("evaluateFence: a foreign merge driver on the pm paths is not the pm fence", () => {
    // Another tool claiming these paths must not read as the pm fence being installed.
    const fence = evaluateFence({ itemToonAttr: "union", historyAttr: "union", ...DRIVERS });
    assert.equal(fence.attributesInstalled, false);
    assert.equal(fence.ok, false);
  });

  test("evaluateFence: not ok when drivers not configured", () => {
    const fence = evaluateFence({
      itemToonAttr: "pm-item-toon",
      historyAttr: "pm-history",
      itemToonDriver: undefined,
      historyDriver: undefined,
    });
    assert.equal(fence.ok, false);
    assert.equal(fence.driversConfigured, false);
  });

  test("fenceProbePaths prefers a real observed item path over the conventional fallback", () => {
    assert.deepEqual(fenceProbePaths(".agents/pm"), {
      historyPath: ".agents/pm/history/pm-fence-probe.jsonl",
      itemPath: ".agents/pm/tasks/pm-fence-probe.toon",
    });
    assert.deepEqual(fenceProbePaths(".agents/pm", ".agents/pm/features/pm-x.toon"), {
      historyPath: ".agents/pm/history/pm-fence-probe.jsonl",
      itemPath: ".agents/pm/features/pm-x.toon",
    });
  });

  test("checkAttrMerge resolves what git would actually apply, including a nested attributes file", () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-brief-attr-"));
    try {
      spawnSync("git", ["init", "-q", "-b", "main", "."], { cwd: dir, stdio: "pipe", encoding: "utf-8" });
      mkdirSync(join(dir, ".agents", "pm", "history"), { recursive: true });
      // Attributes live in a SUBDIRECTORY, not at the repo root — the case that
      // repo-root .gitattributes parsing cannot see.
      writeFileSync(
        join(dir, ".agents", "pm", ".gitattributes"),
        'history/*.jsonl merge=pm-history\ntasks/*.toon merge=pm-item-toon\n',
      );

      const resolved = checkAttrMerge(dir, [
        ".agents/pm/history/pm-fence-probe.jsonl",
        ".agents/pm/tasks/pm-fence-probe.toon",
        ".agents/pm/unfenced/other.txt",
      ]);
      assert.equal(resolved.get(".agents/pm/history/pm-fence-probe.jsonl"), "pm-history");
      assert.equal(resolved.get(".agents/pm/tasks/pm-fence-probe.toon"), "pm-item-toon");
      // "unspecified" carries no driver name and must be dropped, not stored.
      assert.equal(resolved.has(".agents/pm/unfenced/other.txt"), false);

      const fence = evaluateFence({
        historyAttr: resolved.get(".agents/pm/history/pm-fence-probe.jsonl"),
        itemToonAttr: resolved.get(".agents/pm/tasks/pm-fence-probe.toon"),
        ...DRIVERS,
      });
      assert.equal(fence.attributesInstalled, true, "a nested .gitattributes still fences the workspace");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("renderMarkdownDivergence emits verdict heading and empty case", () => {
    const summary = buildDivergence([], {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", generatedAt: "2026-07-24T00:00:00Z",
      fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    const md = renderMarkdownDivergence(summary);
    assert.match(md, /No pm item divergence between main and feat\/x/);
  });

  test("renderMarkdownDivergence emits fence warning when not ok", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-uni",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/priority", value: 1 }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/assignee", value: "bob" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", generatedAt: "2026-07-24T00:00:00Z",
      fence: { attributesInstalled: false, driversConfigured: true, ok: false, missing: [".gitattributes entries"] },
    });
    const md = renderMarkdownDivergence(summary);
    assert.match(md, /Merge Driver Fence Not Installed/);
    assert.match(md, /pm merge install/);
  });

  test("renderTextDivergence and renderSlackDivergence produce expected output", () => {
    const items = [
      classifyItemDivergence({
        id: "pm-coll",
        ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" })], itemPresent: true },
        base: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T01:00:00Z", [{ op: "replace", path: "/metadata/status", value: "closed" }], { afterHash: "b1" })], itemPresent: true },
        head: { events: [divEvent("create", "2026-07-19T00:00:00Z", [{ op: "add", path: "/metadata/status", value: "open" }], { afterHash: "a0" }), divEvent("update", "2026-07-20T02:00:00Z", [{ op: "replace", path: "/metadata/status", value: "in_progress" }], { afterHash: "h1" })], itemPresent: true },
      }),
    ];
    const summary = buildDivergence(items, {
      base: "main", head: "feat/x", baseSha: "s1", headSha: "s2", ancestorSha: "s0",
      workspace: ".agents/pm", pmVersion: "test", generatedAt: "2026-07-24T00:00:00Z",
      fence: { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] },
    });
    const text = renderTextDivergence(summary);
    assert.match(text, /Divergence: main <- feat\/x/);
    assert.match(text, /verdict: review-required/);
    assert.match(text, /pm-coll/);
    const slack = renderSlackDivergence(summary);
    assert.match(slack, /\*Divergence/);
    assert.match(slack, /Field Collision/);
  });
});

// ---------------------------------------------------------------------------
// brief diverge end-to-end integration test (real git repo + real pm CLI)
// ---------------------------------------------------------------------------

describe("brief diverge end-to-end", () => {
  test("integration: real git repo with divergent branches", async (t) => {
    const pmBin = process.env.PM_BIN ?? INSTALLED_PM_BIN;

    // skip if pm is not on PATH — reported as a real skip, not a silent pass, so a
    // missing pm shows up as an E2E coverage gap instead of a green no-assertion test
    let pmAvailable = false;
    try {
      const r = spawnSync(pmBin, ["--version"], { stdio: "pipe", encoding: "utf-8" });
      pmAvailable = r.status === 0;
    } catch {
      pmAvailable = false;
    }
    if (!pmAvailable) {
      t.skip("pm not on PATH");
      return;
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "pm-diverge-test-"));
    try {
      const git = (args: string[]) => { const r = spawnSync("git", args, { cwd: tmpDir, stdio: "pipe", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`); return r.stdout.trim(); };
      const pm = (args: string[]) => { const r = spawnSync(pmBin, args, { cwd: tmpDir, stdio: "pipe", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 }); if (r.status !== 0) throw new Error(`pm ${args.join(" ")} failed: ${r.stderr}`); return r.stdout.trim(); };

      // init repo
      git(["init"]);
      git(["config", "user.email", "test@test.com"]);
      git(["config", "user.name", "Test"]);
      const pmPath = join(tmpDir, ".agents", "pm");

      // init pm tracker
      pm(["init", "--pm-path", pmPath]);

      // create 3 items — this is the ancestor
      pm(["--pm-path", pmPath, "create", "Task", "--title", "Item 1", "--author", "agent-a", "--json"]);
      pm(["--pm-path", pmPath, "create", "Task", "--title", "Item 2", "--author", "agent-a", "--json"]);
      pm(["--pm-path", pmPath, "create", "Task", "--title", "Item 3", "--author", "agent-a", "--json"]);
      git(["add", "-A"]);
      git(["commit", "-m", "ancestor: 3 items"]);
      const ancestorSha = git(["rev-parse", "HEAD"]);

      // get item ids
      const listOutput = pm(["--pm-path", pmPath, "list-all", "--json"]);
      const parsed = JSON.parse(listOutput) as { items?: Array<{ id: string; title: string }> };
      const itemList = parsed.items ?? (parsed as unknown as Array<{ id: string; title: string }>);
      const item1 = itemList.find((i) => i.title === "Item 1")?.id;
      const item2 = itemList.find((i) => i.title === "Item 2")?.id;
      const item3 = itemList.find((i) => i.title === "Item 3")?.id;
      assert.ok(item1 && item2 && item3, "all 3 items created");

      // Branch A: change item1 status, item2 priority
      git(["checkout", "-b", "branch-a"]);
      pm(["--pm-path", pmPath, "update", item1!, "--status", "in_progress", "--author", "agent-a"]);
      pm(["--pm-path", pmPath, "update", item2!, "--priority", "1", "--author", "agent-a"]);
      git(["add", "-A"]);
      git(["commit", "-m", "branch-a: item1 status, item2 priority"]);

      // Branch B (from ancestor): change item1 status to different value (field-collision),
      // item3 title (one-sided), item2 assignee (union-safe with A's priority edit)
      git(["checkout", ancestorSha]);
      git(["checkout", "-b", "branch-b"]);
      pm(["--pm-path", pmPath, "update", item1!, "--status", "blocked", "--author", "agent-b"]);
      pm(["--pm-path", pmPath, "update", item3!, "--title", "Item 3 Renamed", "--author", "agent-b"]);
      pm(["--pm-path", pmPath, "update", item2!, "--assignee", "agent-b", "--author", "agent-b"]);
      git(["add", "-A"]);
      git(["commit", "-m", "branch-b: item1 status (collision), item3 title, item2 assignee"]);

      // Drive the REAL registered command, not a re-implementation of its pipeline.
      // This is what covers the wiring the unit tests cannot reach: ref resolution,
      // pmRootRelFromCtx, listChangedPaths, classifyPaths, the check-attr fence probe,
      // renderer selection and --output.
      const { commands } = await activateBrief();
      const runDiverge = async (options: Record<string, unknown>): Promise<DivergeCommandResult> =>
        (await runRegisteredCommandForTest(commands, {
          command: "brief diverge",
          args: ["branch-b"],
          options,
          pmRoot: ".agents/pm",
        })).result as DivergeCommandResult;

      // the command resolves the repo from process.cwd(), so run it inside the fixture
      const previousCwd = process.cwd();
      let jsonResult: DivergeCommandResult;
      let markdownResult: DivergeCommandResult;
      const outFile = join(tmpDir, "diverge.json");
      try {
        process.chdir(tmpDir);
        jsonResult = await runDiverge({ head: "branch-a", "include-clean": true, format: "json", output: outFile });
        markdownResult = await runDiverge({ head: "branch-a", "include-clean": true });
      } finally {
        process.chdir(previousCwd);
      }

      // --output path: the command reports the file it wrote plus a decision summary
      assert.equal(jsonResult.ok, true);
      assert.equal(jsonResult.format, "json");
      assert.equal(jsonResult.output, outFile);
      assert.equal(jsonResult.verdict, "review-required");

      const summary = JSON.parse(await readFile(outFile, "utf-8")) as {
        verdict: string;
        workspace: string;
        base: string;
        head: string;
        ancestorSha?: string;
        fence: { ok: boolean };
        items: Array<{ id: string; kind: string; collidingFields: string[] }>;
      };

      // ref resolution and workspace wiring came from the command, not the test
      assert.equal(summary.base, "branch-b");
      assert.equal(summary.head, "branch-a");
      assert.equal(summary.workspace, ".agents/pm");
      assert.ok(summary.ancestorSha, "merge base resolved by the command");

      const item1Result = summary.items.find((i) => i.id === item1);
      const item2Result = summary.items.find((i) => i.id === item2);
      const item3Result = summary.items.find((i) => i.id === item3);
      assert.ok(item1Result);
      assert.ok(item2Result);
      assert.ok(item3Result);
      assert.equal(item1Result!.kind, "field-collision");
      assert.ok(item1Result!.collidingFields.includes("/metadata/status"));
      assert.equal(item2Result!.kind, "union-safe");
      // item3: only branch-b changed it (title) → one-sided
      assert.ok(item3Result!.kind === "base-only" || item3Result!.kind === "head-only", `item3 should be one-sided, got ${item3Result!.kind}`);

      // renderer selection: the default markdown path returns the rendered-result
      // envelope the pm renderer hook consumes
      assert.equal(markdownResult.pmBriefRendered, true);
      const markdown = String(markdownResult.output);
      assert.match(markdown, /review-required/);
      assert.ok(markdown.includes(item1!), "markdown render names the colliding item");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// brief diverge — review round 2 (CodeRabbit findings)
// ---------------------------------------------------------------------------
describe("brief diverge / review round 2 hardening", () => {
  test("scanHistoryJsonl counts an object line without ts as malformed (single source of truth)", () => {
    // Previously parseHistoryJsonl dropped this line while countMalformedLines did
    // not count it, so the report under-stated the data loss.
    const text = [
      JSON.stringify({ ts: "2026-07-20T00:00:00Z", op: "create", after_hash: "a1" }),
      JSON.stringify({ op: "update", author: "bob" }), // parses as an object, but no ts
      "{not json at all",
      "",
      "   ",
      JSON.stringify(["an", "array"]), // parses, but is not an object
    ].join("\n");

    const scan = scanHistoryJsonl(text);
    assert.equal(scan.events.length, 1);
    assert.equal(scan.malformedLines, 3, "no-ts object, non-JSON line, and array line are all unusable");
    // The wrappers must agree with the single pass, and with each other.
    assert.deepEqual(parseHistoryJsonl(text), scan.events);
    assert.equal(countMalformedLines(text), scan.malformedLines);
    // Blank lines are never counted.
    assert.equal(scanHistoryJsonl("\n\n   \n").malformedLines, 0);
    assert.equal(scanHistoryJsonl(undefined).malformedLines, 0);
  });

  test("pmRootRelFromCtx accepts an in-repo directory whose name merely starts with dots", () => {
    // `rel.startsWith("..")` used to reject this legitimate sibling.
    assert.equal(pmRootRelFromCtx("/repo/..cache/pm", "/repo"), "..cache/pm");
    assert.equal(pmRootRelFromCtx("/repo/.agents/pm", "/repo"), ".agents/pm");
  });

  test("pmRootRelFromCtx rejects a pm root outside the repo and one equal to the repo root", () => {
    assert.throws(() => pmRootRelFromCtx("/elsewhere/pm", "/repo"), /outside the git repository root/);
    assert.throws(() => pmRootRelFromCtx("/repo/../pm", "/repo"), /outside the git repository root/);
    // An empty relative path would make every downstream prefix a bare "/…" and
    // match nothing, silently reporting no divergence. It must fail loudly.
    assert.throws(() => pmRootRelFromCtx("/repo", "/repo"), /resolves to the git repository root/);
  });

  test("git readers fail loudly instead of reporting a false clean verdict", () => {
    // A non-existent repo root makes git itself fail. The safety property is that
    // this surfaces as an error rather than as "nothing changed" / "file absent",
    // which would render as a `clean` verdict.
    const missing = "/nonexistent-repo-root-for-pm-brief-diverge-test";
    assert.throws(() => listChangedPaths(missing, "aaaa", "bbbb", ".agents/pm"), /git (diff|ls-tree).*(failed|could not run)/);
    assert.throws(() => readBlob(missing, "aaaa", ".agents/pm/history/x.jsonl"), /git show.*(failed|could not run)/);
    assert.throws(() => mergeBase(missing, "aaaa", "bbbb"), /git merge-base.*(failed|could not run)/);
  });

  test("mergeBase returns undefined only for the legitimate no-merge-base case", () => {
    // Real repo, two orphan roots: git exits 1, which means "unrelated histories"
    // and must stay a non-throwing undefined rather than becoming an error.
    const dir = mkdtempSync(join(tmpdir(), "pm-brief-mb-"));
    try {
      const git = (...args: string[]): void => {
        spawnSync("git", args, { cwd: dir, stdio: "pipe", encoding: "utf-8" });
      };
      git("init", "-q", "-b", "main", ".");
      git("config", "user.email", "t@t.t");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "a.txt"), "a");
      git("add", "-A");
      git("commit", "-qm", "root a");
      git("checkout", "-q", "--orphan", "other");
      git("rm", "-rq", "--cached", ".");
      writeFileSync(join(dir, "b.txt"), "b");
      git("add", "-A");
      git("commit", "-qm", "root b");

      assert.equal(mergeBase(dir, "main", "other"), undefined);
      // A shared history still yields a sha.
      assert.ok(mergeBase(dir, "main", "main"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// brief duplicates — post-merge near-duplicate sweep
// ---------------------------------------------------------------------------

/** Helper: build a synthetic SimilarItemMatch with sane defaults. */
function match(id: string, score: number, reason: SimilarItemMatch["reason"] = "title_token_jaccard", title = id): SimilarItemMatch {
  return { id, title, status: "open", type: "Task", score, reason };
}

/** Helper: build a PmItem with the fields the sweep needs. */
function dupItem(id: string, opts: { title?: string; status?: string; type?: string; createdAt?: string } = {}): PmItem {
  return {
    id,
    title: opts.title ?? id,
    type: opts.type ?? "Task",
    status: opts.status ?? "open",
    created_at: opts.createdAt,
  };
}

describe("brief duplicates", () => {
  test("selectDuplicateCandidates keeps all statuses by default and applies --status and --since filters", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { status: "open", createdAt: "2026-07-20T00:00:00Z" }),
      dupItem("pm-b", { status: "closed", createdAt: "2026-07-18T00:00:00Z" }),
      dupItem("pm-c", { status: "in_progress", createdAt: "2026-07-25T00:00:00Z" }),
    ];
    // default: all statuses
    assert.equal(selectDuplicateCandidates(items).length, 3);
    // status filter
    assert.equal(selectDuplicateCandidates(items, { statuses: ["open"] }).map((i) => i.id).join(","), "pm-a");
    // since filter: only items at or after the timestamp
    assert.equal(selectDuplicateCandidates(items, { since: "2026-07-25T00:00:00Z" }).map((i) => i.id).join(","), "pm-c");
    // since + status combined
    assert.equal(selectDuplicateCandidates(items, { statuses: ["open", "in_progress"], since: "2026-07-20T00:00:00Z" }).length, 2);
  });

  test("no-duplicates case yields an empty summary and a clean text line", () => {
    const items: PmItem[] = [dupItem("pm-a"), dupItem("pm-b")];
    const summary = buildDuplicateSweep(items, new Map(), { threshold: 0.6 });
    assert.equal(summary.count, 0);
    assert.equal(summary.pairs.length, 0);
    assert.equal(summary.scanned, 2);
    assert.match(renderTextDuplicates(summary), /No likely duplicate items found/);
    assert.match(renderMarkdownDuplicates(summary), /_No likely duplicate items found._/);
  });

  test("exact-title pair is reported with the exact_title reason", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "Fix flaky auth test" }),
      dupItem("pm-b", { title: "Fix flaky auth test" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 1, "exact_title")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    assert.equal(summary.count, 1);
    assert.equal(summary.pairs[0].reason, "exact_title");
    assert.equal(summary.pairs[0].score, 1);
  });

  test("token-jaccard pair is reported with the title_token_jaccard reason", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "Fix flaky auth test" }),
      dupItem("pm-b", { title: "flaky auth test fails intermittently" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.565, "title_token_jaccard")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    assert.equal(summary.count, 1);
    assert.equal(summary.pairs[0].reason, "title_token_jaccard");
    assert.equal(summary.pairs[0].score, 0.565);
  });

  test("pair collapsing: A~B and B~A collapse to one pair keyed on the sorted id pair", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "Fix flaky auth test" }),
      dupItem("pm-b", { title: "Fix flaky auth test" }),
    ];
    // Both directions report a match; the lower score should be overridden by the higher.
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.5, "title_token_jaccard")]],
      ["pm-b", [match("pm-a", 0.9, "title_token_jaccard")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    assert.equal(summary.count, 1, "A~B and B~A collapse to a single pair");
    assert.equal(summary.pairs[0].id, "pm-a|pm-b");
    assert.equal(summary.pairs[0].score, 0.9, "the highest score is kept");
  });

  test("ranking is by score descending then pair id for stable output", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "x" }),
      dupItem("pm-b", { title: "x" }),
      dupItem("pm-c", { title: "y" }),
      dupItem("pm-d", { title: "y" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.7)]],
      ["pm-c", [match("pm-d", 0.9)]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    assert.deepEqual(
      summary.pairs.map((p) => p.id),
      ["pm-c|pm-d", "pm-a|pm-b"],
      "higher score first",
    );
    // equal scores break ties by pair id ascending
    const even = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.8)]],
      ["pm-c", [match("pm-d", 0.8)]],
    ]);
    const tied = buildDuplicateSweep(items, even, { threshold: 0.6 });
    assert.deepEqual(tied.pairs.map((p) => p.id), ["pm-a|pm-b", "pm-c|pm-d"]);
  });

  test("remediation: both open relates the newer item to the older (by created_at)", () => {
    const older: DuplicatePairItem = { id: "pm-a", title: "A", status: "open", type: "Task", createdAt: "2026-07-01T00:00:00Z" };
    const newer: DuplicatePairItem = { id: "pm-b", title: "B", status: "open", type: "Task", createdAt: "2026-07-10T00:00:00Z" };
    assert.equal(
      duplicateRemediationCommand(older, newer),
      "pm update pm-b --dep id=pm-a,kind=related",
    );
    // argument order must not matter (unordered)
    assert.equal(
      duplicateRemediationCommand(newer, older),
      "pm update pm-b --dep id=pm-a,kind=related",
    );
  });

  test("remediation: exactly one closed links the open item to the closed one", () => {
    const open: DuplicatePairItem = { id: "pm-a", title: "A", status: "open", type: "Task", createdAt: "2026-07-01T00:00:00Z" };
    const closed: DuplicatePairItem = { id: "pm-b", title: "B", status: "closed", type: "Task", createdAt: "2026-07-10T00:00:00Z" };
    assert.equal(
      duplicateRemediationCommand(open, closed),
      "pm update pm-a --dep id=pm-b,kind=related",
    );
    // swapped argument order keeps the same command (open relates to closed)
    assert.equal(
      duplicateRemediationCommand(closed, open),
      "pm update pm-a --dep id=pm-b,kind=related",
    );
  });

  test("--limit truncates the ranked pair list", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "x" }),
      dupItem("pm-b", { title: "x" }),
      dupItem("pm-c", { title: "y" }),
      dupItem("pm-d", { title: "y" }),
      dupItem("pm-e", { title: "z" }),
      dupItem("pm-f", { title: "z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.9)]],
      ["pm-c", [match("pm-d", 0.8)]],
      ["pm-e", [match("pm-f", 0.7)]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6, limit: 2 });
    assert.equal(summary.count, 2);
    assert.deepEqual(summary.pairs.map((p) => p.id), ["pm-a|pm-b", "pm-c|pm-d"]);
  });

  test("text format renders both ids, titles, statuses, types, score, reason, and remediation", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "Fix flaky auth test", status: "open", type: "Task", createdAt: "2026-07-01T00:00:00Z" }),
      dupItem("pm-b", { title: "Fix flaky auth test", status: "in_progress", type: "Issue", createdAt: "2026-07-10T00:00:00Z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 1, "exact_title")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    const text = renderTextDuplicates(summary);
    assert.match(text, /pm-a\|pm-b  score 1  exact_title/);
    assert.match(text, /pm-a: Fix flaky auth test \(Task, open\)/);
    assert.match(text, /pm-b: Fix flaky auth test \(Issue, in_progress\)/);
    assert.match(text, /→ pm update pm-b --dep id=pm-a,kind=related/);
  });

  test("markdown format renders headers, score, reason, and remediation", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open" }),
      dupItem("pm-b", { title: "A", status: "closed" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.65, "title_token_jaccard")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    const md = renderMarkdownDuplicates(summary);
    assert.match(md, /# pm brief duplicates/);
    assert.match(md, /## pm-a\|pm-b — score 0\.65 \(title_token_jaccard\)/);
    assert.match(md, /`pm-a` A \(Task, open\)/);
    assert.match(md, /`pm-b` A \(Task, closed\)/);
    assert.match(md, /\*\*Suggested:\*\* `pm update pm-a --dep id=pm-b,kind=related`/);
  });

  test("json output is a bare object (not wrapped) with the expected shape", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
      dupItem("pm-b", { title: "A", status: "open", createdAt: "2026-07-10T00:00:00Z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.7, "title_token_jaccard")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6 });
    const parsed = JSON.parse(JSON.stringify(summary)) as DuplicateSweepSummary;
    // bare object: no envelope. `total`/`truncated` let a caller tell "1 pair found"
    // apart from "1 of 40 shown", matching brief since / brief diverge.
    assert.deepEqual(
      Object.keys(parsed).sort(),
      ["count", "generatedAt", "pairs", "scanned", "threshold", "total", "truncated"],
    );
    assert.equal(parsed.total, 1);
    assert.equal(parsed.truncated, false);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.threshold, 0.6);
    assert.equal(parsed.scanned, 2);
    const pair = parsed.pairs[0] as DuplicatePair;
    assert.equal(pair.id, "pm-a|pm-b");
    assert.equal(pair.score, 0.7);
    assert.equal(pair.reason, "title_token_jaccard");
    assert.equal(pair.items.length, 2);
    assert.equal(pair.items[0].id, "pm-a");
    assert.equal(pair.items[1].id, "pm-b");
    assert.match(pair.remediation, /pm update pm-b --dep id=pm-a,kind=related/);
  });

  test("score is rounded to 3 decimals", () => {
    const items: PmItem[] = [dupItem("pm-a"), dupItem("pm-b")];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.5652173913043478, "title_token_jaccard")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.3 });
    assert.equal(summary.pairs[0].score, 0.565);
  });

  test("parseDuplicateThreshold rejects below 0, above 1, and non-numeric values", () => {
    assert.equal(parseDuplicateThreshold(undefined, 0.6), 0.6);
    assert.equal(parseDuplicateThreshold("0.5", 0.6), 0.5);
    assert.equal(parseDuplicateThreshold("1", 0.6), 1);
    assert.equal(parseDuplicateThreshold("0", 0.6), 0);
    assert.throws(() => parseDuplicateThreshold("-0.1", 0.6), /between 0 and 1/);
    assert.throws(() => parseDuplicateThreshold("1.1", 0.6), /between 0 and 1/);
    assert.throws(() => parseDuplicateThreshold("abc", 0.6), /between 0 and 1/);
  });

  test("parseSinceTimestamp accepts ISO dates and full timestamps, rejects invalid formats", () => {
    assert.equal(parseSinceTimestamp("2026-07-20"), "2026-07-20");
    assert.equal(parseSinceTimestamp("2026-07-20T00:00:00Z"), "2026-07-20T00:00:00Z");
    assert.equal(parseSinceTimestamp("2026-07-20T00:00:00+02:00"), "2026-07-20T00:00:00+02:00");
    assert.throws(() => parseSinceTimestamp("7d"), /ISO 8601 timestamp/);
    assert.throws(() => parseSinceTimestamp("not-a-date"), /ISO 8601 timestamp/);
    assert.throws(() => parseSinceTimestamp("2026-13-40"), /ISO 8601 timestamp/);
  });

  test("brief duplicates command is registered with the expected flags", async () => {
    assert.ok((await registeredCommandPaths()).includes("brief duplicates"), "brief duplicates command should be registered");
    const flags = await registeredFlagLongs("brief duplicates");
    for (const expected of ["--threshold", "--limit", "--status", "--since", "--format", "--output"]) {
      assert.ok(flags.includes(expected), `flag ${expected} should be registered`);
    }
  });

  test("command run rejects an out-of-range --threshold before touching the tracker", async () => {
    const { commands } = await activateBrief();
    const run = (options: Record<string, unknown>) =>
      runRegisteredCommandForTest(commands, { command: "brief duplicates", options, pmRoot: "/nonexistent-tracker" });
    await assert.rejects(() => run({ threshold: "1.5" }), /between 0 and 1/);
    await assert.rejects(() => run({ threshold: "-0.2" }), /between 0 and 1/);
    await assert.rejects(() => run({ threshold: "abc" }), /between 0 and 1/);
  });

  test("command run rejects a non-ISO --since before touching the tracker", async () => {
    const { commands } = await activateBrief();
    const run = (options: Record<string, unknown>) =>
      runRegisteredCommandForTest(commands, { command: "brief duplicates", options, pmRoot: "/nonexistent-tracker" });
    await assert.rejects(() => run({ since: "7d" }), /ISO 8601 timestamp/);
  });

  test("buildDuplicateSweep reports truncation instead of hiding it", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "Shared title", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
      dupItem("pm-b", { title: "Shared title", status: "open", createdAt: "2026-07-02T00:00:00Z" }),
      dupItem("pm-c", { title: "Shared title", status: "open", createdAt: "2026-07-03T00:00:00Z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([
      ["pm-a", [match("pm-b", 0.9, "exact_title"), match("pm-c", 0.8, "exact_title")]],
      ["pm-b", [match("pm-c", 0.7, "exact_title")]],
    ]);
    const summary = buildDuplicateSweep(items, matches, { threshold: 0.6, limit: 1 });
    assert.equal(summary.count, 1, "only one pair is shown");
    assert.equal(summary.total, 3, "but three were found");
    assert.equal(summary.truncated, true, "and the caller can tell");
  });

  test("buildDuplicateSweep rejects a non-positive limit instead of reporting a clean tracker", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
      dupItem("pm-b", { title: "A", status: "open", createdAt: "2026-07-02T00:00:00Z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([["pm-a", [match("pm-b", 0.9, "exact_title")]]]);
    for (const limit of [0, -1, 1.5]) {
      assert.throws(
        () => buildDuplicateSweep(items, matches, { threshold: 0.6, limit }),
        /limit must be a positive integer/,
        `limit ${limit} must be rejected, not silently reported as no duplicates`,
      );
    }
  });

  test("selectDuplicateCandidates throws on an unparseable since instead of keeping everything", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
    ];
    // Date.parse yields NaN and `created < NaN` is false, so a naive guard would let
    // every item through and silently widen the sweep. This is the exported path a
    // direct SDK caller uses, so it must fail loudly.
    for (const bad of ["7d", "not-a-date", "totally bogus"]) {
      assert.throws(
        () => selectDuplicateCandidates(items, { since: bad }),
        /since must be an ISO 8601 timestamp/,
        `since ${JSON.stringify(bad)} must be rejected`,
      );
    }
  });

  test("selectDuplicateCandidates drops a since candidate that has no created_at", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-10T00:00:00Z" }),
      dupItem("pm-b", { title: "B", status: "open" }),
    ];
    const kept = selectDuplicateCandidates(items, { since: "2026-07-01T00:00:00Z" });
    assert.deepEqual(kept.map((i) => i.id), ["pm-a"], "an item with no created_at cannot be proven in-window");
  });

  test("collapseDuplicatePairs drops a pair whose matched id is absent from the loaded items", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
    ];
    const itemsById = new Map(items.map((i) => [i.id, i]));
    // The SDK returned a match for an id this sweep never loaded; it must be skipped
    // rather than producing a pair with fabricated title/status/type.
    const matches = new Map<string, SimilarItemMatch[]>([["pm-a", [match("pm-ghost", 0.95, "exact_title")]]]);
    assert.deepEqual(collapseDuplicatePairs(items, matches, itemsById), []);
  });

  test("buildDuplicateSweep uses a caller-supplied candidate list without re-filtering", () => {
    const items: PmItem[] = [
      dupItem("pm-a", { title: "A", status: "open", createdAt: "2026-07-01T00:00:00Z" }),
      dupItem("pm-b", { title: "A", status: "closed", createdAt: "2026-07-02T00:00:00Z" }),
    ];
    const matches = new Map<string, SimilarItemMatch[]>([["pm-a", [match("pm-b", 0.9, "exact_title")]]]);
    // `statuses` would exclude pm-b, but an explicit candidate list is authoritative:
    // one source of truth for what was scanned.
    const summary = buildDuplicateSweep(items, matches, {
      threshold: 0.6,
      statuses: ["open"],
      candidates: items,
    });
    assert.equal(summary.scanned, 2);
    assert.equal(summary.count, 1);
  });

  test("command run rejects an invalid --format", async () => {
    const { commands } = await activateBrief();
    const run = (options: Record<string, unknown>) =>
      runRegisteredCommandForTest(commands, { command: "brief duplicates", options, pmRoot: "/nonexistent-tracker" });
    await assert.rejects(() => run({ format: "yaml" }), /--format must be text, json, or markdown/);
  });
});

// ---------------------------------------------------------------------------
// brief governance — sdk/governance scanner integration
// ---------------------------------------------------------------------------

/** Helper: build a synthetic GovernanceSummary with sane defaults for render tests. */
function govSummary(overrides: Partial<GovernanceSummary> = {}): GovernanceSummary {
  return {
    duplicateClusters: [],
    duplicateClustersTotal: 0,
    staleInProgress: [],
    staleInProgressTotal: 0,
    storageFindings: [],
    storageFindingsTotal: 0,
    secretFindings: [],
    secretFindingsTotal: 0,
    threshold: 0.6,
    staleThresholdHours: 72,
    generatedAt: "2026-07-26T12:00:00.000Z",
    ...overrides,
  };
}

describe("brief governance", () => {
  test("governanceIsEmpty returns true for undefined and an all-empty summary", () => {
    assert.equal(governanceIsEmpty(undefined), true);
    assert.equal(governanceIsEmpty(govSummary()), true);
    assert.equal(
      governanceIsEmpty(govSummary({ duplicateClusters: [{ clusterId: "pm-a", items: [], maxScore: 1, reason: "exact_title", remediation: "pm update pm-b --dep id=pm-a,kind=related" }] })),
      false,
    );
  });

  test("buildBrief includes the governance section when provided and non-empty", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Task A", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const governance = govSummary({
      staleInProgress: [{ id: "pm-a", lastActivityAt: "2026-07-20T00:00:00Z", ageHours: 200, remediation: "pm update pm-a --status open" }],
      staleInProgressTotal: 1,
    });
    const brief = buildBrief(items, { governance, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    assert.ok(brief.governance, "governance section should be present");
    assert.equal(brief.governance!.staleInProgress.length, 1);
    assert.equal(brief.governance!.staleInProgress[0].id, "pm-a");
  });

  test("buildBrief omits the governance section when all findings are empty", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Task A", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const brief = buildBrief(items, { governance: govSummary(), generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    assert.equal(brief.governance, undefined, "empty governance should not appear in the brief");
  });

  test("renderMarkdownBrief includes a Governance section with actionable commands", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Fix flaky auth test", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const governance = govSummary({
      duplicateClusters: [{
        clusterId: "pm-a",
        items: [
          { id: "pm-a", title: "Fix flaky auth test", status: "open", type: "Task" },
          { id: "pm-b", title: "Fix flaky auth test", status: "open", type: "Task" },
        ],
        maxScore: 1.0,
        reason: "exact_title",
        remediation: "pm update pm-b --dep id=pm-a,kind=related",
      }],
      duplicateClustersTotal: 1,
    });
    const brief = buildBrief(items, { governance, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    const md = renderMarkdownBrief(brief);
    assert.match(md, /## Governance/);
    assert.match(md, /Duplicate clusters/);
    assert.match(md, /pm-a.*Fix flaky auth test/);
    assert.match(md, /pm update pm-b --dep id=pm-a,kind=related/);
  });

  test("renderAgentPrompt includes governance findings as compact actionable lines", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Task A", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const governance = govSummary({
      secretFindings: [{ itemId: "pm-a", field: "description", rule: "github_token", remediation: "pm update pm-a --description \"<redacted>\"" }],
      secretFindingsTotal: 1,
    });
    const brief = buildBrief(items, { governance, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    const prompt = renderAgentPrompt(brief);
    assert.match(prompt, /Governance findings/);
    assert.match(prompt, /secret in pm-a field `description`.*github_token/);
    // The secret VALUE must never appear in the output
    assert.doesNotMatch(prompt, /ghp_[A-Za-z0-9]/);
  });

  test("renderSlackBrief includes governance section", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Task A", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const governance = govSummary({
      duplicateClusters: [{
        clusterId: "pm-a",
        items: [{ id: "pm-a", title: "Task A", status: "open", type: "Task" }, { id: "pm-b", title: "Task A", status: "open", type: "Task" }],
        maxScore: 1,
        reason: "exact_title",
        remediation: "pm update pm-b --dep id=pm-a,kind=related",
      }],
      duplicateClustersTotal: 1,
      staleInProgress: [{ id: "pm-a", lastActivityAt: "2026-07-20T00:00:00Z", ageHours: 100, remediation: "pm update pm-a --status open" }],
      staleInProgressTotal: 1,
    });
    const brief = buildBrief(items, { governance, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    const slack = renderSlackBrief(brief);
    assert.match(slack, /\*Governance\*/);
    assert.match(slack, /• \*pm-a\* — score 1/);
    assert.doesNotMatch(slack, /\*\*pm-a\*\*/);
    assert.match(slack, /Stale in-progress/);
    assert.match(slack, /pm-a.*100h/);
  });

  test("renderTextGovernance renders a standalone summary with +N more rollup", () => {
    const summary = govSummary({
      duplicateClusters: [{
        clusterId: "pm-a",
        items: [{ id: "pm-a", title: "A", status: "open", type: "Task" }, { id: "pm-b", title: "A", status: "open", type: "Task" }],
        maxScore: 1.0,
        reason: "exact_title",
        remediation: "pm update pm-b --dep id=pm-a,kind=related",
      }],
      duplicateClustersTotal: 5,
    });
    const text = renderTextGovernance(summary);
    assert.match(text, /Duplicate clusters/);
    assert.match(text, /\(\+4 more\)/);
    assert.match(text, /pm update pm-b --dep id=pm-a,kind=related/);
  });

  test("renderTextGovernance renders no-findings case cleanly", () => {
    const text = renderTextGovernance(govSummary());
    assert.match(text, /No governance findings/);
  });

  test("renderMarkdownGovernance renders a markdown header and findings", () => {
    const summary = govSummary({
      storageFindings: [{
        kind: "history_conflict_marker",
        id: "pm-x",
        path: "history/pm-x.jsonl",
        detail: "unresolved merge-conflict markers at line 3",
        remediation: "pm history-repair pm-x",
      }],
      storageFindingsTotal: 1,
    });
    const md = renderMarkdownGovernance(summary);
    assert.match(md, /# pm brief governance/);
    assert.match(md, /Storage integrity/);
    assert.match(md, /pm history-repair pm-x/);
  });

  test("renderMarkdownGovernance renders the explicit no-findings message", () => {
    const md = renderMarkdownGovernance(govSummary());
    assert.match(md, /# pm brief governance/);
    assert.match(md, /_No governance findings\._/);
  });

  test("secret findings NEVER include scanned secret values in any render format", async () => {
    const awsKey = "AKIAIOSFODNN7EXAMPLE";
    const githubToken = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const items: PmItem[] = [
      { id: "pm-a", title: "A", description: `credential ${awsKey}`, type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
      { id: "pm-b", title: "B", body: `credential ${githubToken}`, type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
      { id: "pm-c", title: "C", nested: { token: awsKey }, type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    const governance = await collectGovernanceSignals(items, {
      pmRoot: join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "pm"),
      generatedAt: "2026-07-26T12:00:00Z",
    });
    const nestedFinding = governance.secretFindings.find((finding) => finding.itemId === "pm-c");
    assert.ok(nestedFinding, "custom nested field should be detected");
    assert.match(nestedFinding.remediation, /^pm get pm-c /);
    assert.doesNotMatch(nestedFinding.remediation, /--nested/);
    const directFinding = governance.secretFindings.find((finding) => finding.itemId === "pm-a");
    assert.ok(directFinding, "top-level description should be detected");
    assert.match(directFinding.remediation, /^pm update pm-a --description /);
    const brief = buildBrief(items, { governance, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    const md = renderMarkdownBrief(brief);
    const slack = renderSlackBrief(brief);
    const prompt = renderAgentPrompt(brief);
    const govText = renderTextGovernance(governance);
    const govMd = renderMarkdownGovernance(governance);
    for (const output of [md, slack, prompt, govText, govMd]) {
      // The detector RULE name is fine to print, but the matched secret value must never appear.
      assert.doesNotMatch(output, new RegExp(awsKey));
      assert.doesNotMatch(output, new RegExp(githubToken));
      // The rule names and fields SHOULD appear
      assert.match(output, /aws_access_key|github_token/);
    }
  });

  test("compactToBudget trims governance sections when over budget", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "Task A", type: "Task", status: "open", created_at: "2026-07-20T00:00:00Z", updated_at: "2026-07-20T00:00:00Z" },
    ];
    // Build a governance summary with many findings so compaction kicks in
    const clusters: GovernanceDuplicateCluster[] = Array.from({ length: 5 }, (_, i) => ({
      clusterId: `pm-cluster-${i}`,
      items: [{ id: `pm-${i}a`, title: `Dup ${i}`, status: "open", type: "Task" }, { id: `pm-${i}b`, title: `Dup ${i}`, status: "open", type: "Task" }],
      maxScore: 0.9,
      reason: "exact_title" as const,
      remediation: `pm update pm-${i}b --dep id=pm-${i}a,kind=related`,
    }));
    const governance = govSummary({
      duplicateClusters: clusters,
      duplicateClustersTotal: 5,
    });
    // Use a very small token budget to force compaction
    const brief = buildBrief(items, { governance, tokenBudget: 500, generatedAt: "2026-07-26T12:00:00Z", pmRoot: ".agents/pm", pmVersion: "test" });
    assert.equal(brief.budget.truncated, true);
    assert.ok(brief.governance, "governance should remain visible under budget pressure");
    assert.equal(brief.governance.duplicateClusters.length, 2);
    assert.equal(brief.governance.duplicateClustersTotal, 5);
  });

  test("malformed scanner input does not suppress independent secret findings", async () => {
    const summary = await collectGovernanceSignals([
      {
        id: "pm-safe",
        title: "Inspect credential",
        description: "AKIAIOSFODNN7EXAMPLE",
        type: "Task",
        status: "open",
      },
    ], { pmRoot: "\0invalid-pm-root", generatedAt: "2026-07-26T12:00:00Z" });
    assert.equal(summary.duplicateClustersTotal, 0);
    assert.equal(summary.staleInProgressTotal, 0);
    assert.equal(summary.storageFindingsTotal, 1);
    assert.equal(summary.storageFindings[0]?.kind, "unparseable_config");
    assert.equal(summary.secretFindingsTotal, 1);
  });

  test("brief governance command is registered with the expected flags", async () => {
    assert.ok((await registeredCommandPaths()).includes("brief governance"), "brief governance command should be registered");
    const flags = await registeredFlagLongs("brief governance");
    assert.ok(flags.includes("--threshold"), "--threshold flag should be registered");
    assert.ok(flags.includes("--stale-hours"), "--stale-hours flag should be registered");
    assert.ok(flags.includes("--format"), "--format flag should be registered");
  });

  test("brief command registers --no-governance and --governance-threshold flags", async () => {
    const flags = await registeredFlagLongs("brief");
    assert.ok(flags.includes("--no-governance"), "--no-governance flag should be registered");
    assert.ok(flags.includes("--governance-threshold"), "--governance-threshold flag should be registered");
    assert.ok(flags.includes("--stale-hours"), "--stale-hours flag should be registered");
  });
});

// ---------------------------------------------------------------------------
// brief governance end-to-end — real pm workspace with seeded findings
// ---------------------------------------------------------------------------

describe("brief governance end-to-end", () => {
  test("integration: real pm workspace with duplicates, stale in-progress, and a secret", async (t) => {
    const pmBin = process.env.PM_BIN ?? INSTALLED_PM_BIN;

    let pmAvailable = false;
    try {
      const r = spawnSync(pmBin, ["--version"], { stdio: "pipe", encoding: "utf-8" });
      pmAvailable = r.status === 0;
    } catch {
      pmAvailable = false;
    }
    if (!pmAvailable) {
      t.skip("pm not on PATH");
      return;
    }

    const tmpDir = await mkdtemp(join(tmpdir(), "pm-gov-e2e-"));
    try {
      const git = (args: string[]) => {
        const r = spawnSync("git", args, { cwd: tmpDir, stdio: "pipe", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
        return r.stdout.trim();
      };
      const pm = (args: string[]) => {
        const r = spawnSync(pmBin, args, { cwd: tmpDir, stdio: "pipe", encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
        if (r.status !== 0) throw new Error(`pm ${args.join(" ")} failed: ${r.stderr}`);
        return r.stdout.trim();
      };

      git(["init"]);
      git(["config", "user.email", "test@test.com"]);
      git(["config", "user.name", "Test"]);
      const pmPath = join(tmpDir, ".agents", "pm");
      pm(["init", "--pm-path", pmPath]);

      // Seed near-duplicate items (exact title match → duplicate cluster)
      pm(["--pm-path", pmPath, "create", "--title", "Fix flaky auth test", "--type", "Task", "--author", "agent-a", "--json"]);
      pm(["--pm-path", pmPath, "create", "--title", "Fix flaky auth test", "--type", "Task", "--author", "agent-b", "--json"]);
      pm(["--pm-path", pmPath, "create", "--title", "Fix flaky auth test", "--type", "Task", "--author", "agent-c", "--json"]);

      // Seed a stale in-progress item: create, set to in_progress, then backdate it.
      const staleJson = pm(["--pm-path", pmPath, "create", "--title", "Old in-progress work", "--type", "Task", "--author", "agent-a", "--json"]);
      const staleCreate = JSON.parse(staleJson) as { id?: string; item?: { id?: string } };
      const staleItemId = staleCreate.id ?? staleCreate.item?.id;
      assert.ok(staleItemId, "pm create must return the created item id");
      pm(["--pm-path", pmPath, "update", staleItemId, "--status", "in_progress", "--author", "agent-a"]);
      // Backdate the item's updated_at and history by editing the .toon and history files directly.
      const oldTimestamp = "2026-06-01T00:00:00.000Z";
      const settings = await readSettings(pmPath);
      const registry = resolveItemTypeRegistry(settings);
      const folder = registry.type_to_folder["Task"] ?? "tasks";
      const toonPath = join(pmPath, folder, `${staleItemId}.toon`);
      const toonContent = await readFile(toonPath, "utf-8");
      const backdated = toonContent.replace(/updated_at:\s*"[^"]*"/, `updated_at: "${oldTimestamp}"`);
      await writeFile(toonPath, backdated, "utf-8");
      // Backdate history entries too
      const historyPath = join(pmPath, "history", `${staleItemId}.jsonl`);
      try {
        const historyContent = await readFile(historyPath, "utf-8");
        const backdatedHistory = historyContent.replace(/"ts":\s*"[^"]*"/g, `"ts": "${oldTimestamp}"`);
        await writeFile(historyPath, backdatedHistory, "utf-8");
      } catch {
        // history file might not exist yet — that's OK
      }

      // Seed an item with a credential-shaped string in its description (fake but realistic)
      const secretJson = pm(["--pm-path", pmPath, "create", "--title", "Deploy with credentials", "--type", "Task", "--author", "agent-a", "--json"]);
      const secretCreate = JSON.parse(secretJson) as { id?: string; item?: { id?: string } };
      const secretItemId = secretCreate.id ?? secretCreate.item?.id;
      assert.ok(secretItemId, "pm create must return the created item id");
      pm(["--pm-path", pmPath, "update", secretItemId, "--description", "Use AWS key AKIAIOSFODNN7EXAMPLE for deployment", "--author", "agent-a"]);

      // Commit the seeded workspace
      git(["add", "-A"]);
      git(["commit", "-m", "seed governance test workspace"]);

      // Now run the REAL brief governance command through the registered command
      const { commands } = await activateBrief();
      const runGov = async (options: Record<string, unknown>): Promise<{ pmBriefRendered?: boolean; output?: string }> =>
        (await runRegisteredCommandForTest(commands, {
          command: "brief governance",
          options,
          pmRoot: pmPath,
        })).result as { pmBriefRendered?: boolean; output?: string };

      const jsonOutput = (await runGov({ format: "json", threshold: 0.5, "stale-hours": 1 })).output ?? "";
      const textOutput = (await runGov({ threshold: 0.5, "stale-hours": 1 })).output ?? "";

      // Parse the JSON output
      const summary = JSON.parse(jsonOutput) as GovernanceSummary;

      // 1. Duplicate clusters: the two "Fix flaky auth test" items should form a cluster
      assert.ok(summary.duplicateClustersTotal >= 1, `expected at least 1 duplicate cluster, got ${summary.duplicateClustersTotal}`);
      const dupCluster = summary.duplicateClusters.find((c) => c.items.some((i) => i.title === "Fix flaky auth test"));
      assert.ok(dupCluster, "duplicate cluster for 'Fix flaky auth test' should be present");
      assert.equal(dupCluster.items.length, 3);
      assert.equal(dupCluster.remediation.match(/pm update/g)?.length, 2, "every non-canonical duplicate should receive a remediation command");

      // 2. Stale in-progress: the backdated item should be stale with a 1h threshold
      assert.ok(summary.staleInProgressTotal >= 1, `expected at least 1 stale in-progress item, got ${summary.staleInProgressTotal}`);
      const staleFinding = summary.staleInProgress.find((s) => s.id === staleItemId);
      assert.ok(staleFinding, `stale item ${staleItemId} should be present`);
      assert.ok(staleFinding.ageHours > 1, "age should exceed the 1h threshold");

      // 3. Secrets: the AWS key in the description should be detected
      assert.ok(summary.secretFindingsTotal >= 1, `expected at least 1 secret finding, got ${summary.secretFindingsTotal}`);
      const secretFinding = summary.secretFindings.find((s) => s.itemId === secretItemId);
      assert.ok(secretFinding, `secret finding for ${secretItemId} should be present`);
      assert.equal(secretFinding.rule, "aws_access_key");
      // The secret VALUE must NEVER appear in the JSON output
      assert.doesNotMatch(jsonOutput, /AKIAIOSFODNN7EXAMPLE/);

      // 4. Text output: also verify no secret value leaks, and findings are present
      assert.match(textOutput, /Duplicate clusters/);
      assert.match(textOutput, /Stale in-progress/);
      assert.match(textOutput, /Secrets in item text/);
      assert.doesNotMatch(textOutput, /AKIAIOSFODNN7EXAMPLE/);
      // The detector rule SHOULD appear
      assert.match(textOutput, /aws_access_key/);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
