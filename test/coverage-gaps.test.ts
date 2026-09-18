import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { describe } from "node:test";
import { activateExtensionForTest, runRegisteredCommandForTest } from "@unbrained/pm-cli/sdk/testing";
import type { ExtensionActivationResult, ExtensionCapability } from "@unbrained/pm-cli/sdk/authoring";
import extension, {
  CommandError,
  buildBrief,
  buildDelta,
  buildDivergence,
  changedFieldPaths,
  checkAttrMerge,
  classifyItemDivergence,
  collapseDuplicatePairs,
  collectGovernanceSignals,
  collectPendingMergeDecisions,
  detectDefaultBase,
  detectStaleContext,
  eventKey,
  listChangedPaths,
  mergeBase,
  parseActivitySinceOutput,
  readActivitySince,
  readBlob,
  readPmItems,
  renderMarkdownBrief,
  normalizeItemPath,
  secretFieldFromPath,
  escapeLine,
  formatScoreValue,
  toGovernanceDuplicateCluster,
  renderMarkdownDelta,
  renderMarkdownDivergence,
  renderSlackDelta,
  renderSlackDivergence,
  renderTextDelta,
  renderTextDivergence,
  renderTextGovernance,
  resolveRef,
  resolveRepoRoot,
  scanHistoryJsonl,
  summarizeMomentum,
  type DeltaActivityEntry,
  type DeltaItemChange,
  type DuplicateCluster,
  type DeltaSummary,
  type DivergeEvent,
  type MergeDecisionEntry,
  type MergeDecisionsSummary,
  type PmItem,
  type SimilarItemMatch,
} from "../index.ts";

/** Capabilities the on-disk `manifest.json` declares. */
const MANIFEST_CAPABILITIES: readonly ExtensionCapability[] = (
  JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "manifest.json"), "utf8"),
  ) as { capabilities: ExtensionCapability[] }
).capabilities;

/** Latest project-local pm CLI used by real-workspace integration tests. */
const INSTALLED_PM_BIN = fileURLToPath(
  new URL(process.platform === "win32" ? "../node_modules/.bin/pm.cmd" : "../node_modules/.bin/pm", import.meta.url),
);

let cachedActivation: Promise<ExtensionActivationResult> | undefined;

/** Activate pm-brief through pm's real extension loader, once per test process. */
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

/** Tracker root for this repository, used by command tests that need a real corpus. */
function repoPmRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", ".agents", "pm");
}

/** Failed `spawnSync` result used to drive `readPmItems`' injectable process boundary. */
function failedSpawn(overrides: Partial<SpawnSyncReturns<string>> = {}): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: 1,
    signal: null,
    ...overrides,
  };
}

/** One activity row for `buildDelta` / parser tests. */
function actEntry(
  id: string,
  op: string,
  ts: string,
  patch: Array<{ op: "add" | "replace" | "remove"; path: string; value?: unknown }> = [],
): DeltaActivityEntry {
  return { ts, author: "pi-agent", op, id, patch };
}

/** Empty delta totals block used by renderer-only fixtures. */
function emptyTotals(): DeltaSummary["totals"] {
  return {
    itemsChanged: 0,
    events: 0,
    created: 0,
    closed: 0,
    canceled: 0,
    reopened: 0,
    statusChanged: 0,
    reprioritized: 0,
    retitled: 0,
    reassigned: 0,
    depsAdded: 0,
    depsRemoved: 0,
    notes: 0,
    comments: 0,
  };
}

/** Minimal per-item delta used by renderer-only fixtures. */
function deltaChange(id: string, overrides: Partial<DeltaItemChange> = {}): DeltaItemChange {
  return {
    id,
    title: id,
    type: "Task",
    created: false,
    closed: false,
    canceled: false,
    reopened: false,
    retitled: false,
    depsAdded: 0,
    depsRemoved: 0,
    notesAdded: 0,
    commentsAdded: 0,
    eventCount: 1,
    firstTs: "2026-07-20T00:00:00Z",
    lastTs: "2026-07-20T00:00:00Z",
    changeRank: 4,
    ...overrides,
  };
}

/** Fence that reports the merge driver as fully installed. */
const OK_FENCE = { attributesInstalled: true, driversConfigured: true, ok: true, missing: [] };

/** One history event for divergence classification tests. */
function divEvent(op: string, ts: string, path = "/metadata/status"): DivergeEvent {
  return { ts, author: "pi-agent", op, patch: [{ op: "replace", path, value: "open" }] };
}

describe("readPmItems spawn failures name the CLI, the spawn error, or a closed fallback", () => {
  test("stderr from a failed complete-corpus read is the error message", () => {
    assert.throws(
      () => readPmItems("/tracker", () => failedSpawn({ stderr: "tracker exploded\n" })),
      (error: unknown) => error instanceof CommandError && error.message === "tracker exploded",
    );
  });

  test("a spawn error is used when stderr is empty", () => {
    assert.throws(
      () => readPmItems("/tracker", () => failedSpawn({
        stderr: "",
        status: null,
        error: new Error("spawn ENOENT"),
      })),
      (error: unknown) => error instanceof CommandError && error.message === "spawn ENOENT",
    );
  });

  test("a silent non-zero complete-corpus read still fails closed", () => {
    assert.throws(
      () => readPmItems("/tracker", () => failedSpawn()),
      (error: unknown) =>
        error instanceof CommandError && error.message === "`pm list --all` complete-corpus read failed",
    );
  });
});

describe("activity since readers accept window bounds and keep equal timestamps stable", () => {
  test("readActivitySince forwards --to and clamps a non-finite limit instead of throwing", () => {
    const entries = readActivitySince(repoPmRoot(), {
      from: "3650d",
      to: "0d",
      limit: Number.NaN,
    });
    assert.ok(Array.isArray(entries));
  });

  test("parseActivitySinceOutput keeps equal timestamps in input order after a stable sort", () => {
    const parsed = parseActivitySinceOutput(JSON.stringify({
      activity: [
        { ts: "2026-07-20T11:00:00Z", id: "pm-late", op: "update" },
        { ts: "2026-07-20T10:00:00Z", id: "pm-early", op: "update" },
        { ts: "2026-07-20T10:00:00Z", id: "pm-tie", op: "update" },
      ],
    }));
    assert.deepEqual(parsed.map((entry) => entry.id), ["pm-early", "pm-tie", "pm-late"]);
  });
});

describe("buildDelta covers retitle, dep removal, unpatched comments, and format-specific budgets", () => {
  const items = new Map<string, PmItem>([
    ["pm-retitle", { id: "pm-retitle", title: "Renamed", type: "Task", status: "open", priority: 2 }],
    ["pm-deps", { id: "pm-deps", title: "Deps", type: "Task", status: "open", priority: 2 }],
    ["pm-comment", { id: "pm-comment", title: "Talk", type: "Task", status: "open", priority: 2 }],
    ["pm-quiet", { id: "pm-quiet", title: "Quiet", type: "Task", status: "open", priority: 2 }],
  ]);

  test("describeDeltaItem names retitles, removed deps, comments, and unclassified events", () => {
    const summary = buildDelta([
      actEntry("pm-retitle", "update", "2026-07-20T01:00:00Z", [
        { op: "replace", path: "/metadata/title", value: "Renamed" },
      ]),
      actEntry("pm-deps", "update", "2026-07-20T01:00:00Z", [
        { op: "remove", path: "/metadata/dependencies/0" },
        { op: "remove", path: "/metadata/dependencies/1" },
      ]),
      actEntry("pm-comment", "comment_add", "2026-07-20T01:00:00Z"),
      { ts: "2026-07-20T01:00:00Z", author: "pi-agent", op: "activity", id: "pm-quiet" },
      { ts: "2026-07-20T02:00:00Z", author: "pi-agent", op: "activity", id: "pm-quiet" },
    ], items, { since: "2026-07-20", workspace: ".agents/pm", pmVersion: "test" });
    const byId = new Map(summary.items.map((change) => [change.id, change]));
    assert.equal(byId.get("pm-retitle")?.retitled, true);
    assert.equal(byId.get("pm-deps")?.depsRemoved, 2);
    assert.equal(byId.get("pm-comment")?.commentsAdded, 1);
    assert.equal(byId.get("pm-quiet")?.eventCount, 2);
    const markdown = renderMarkdownDelta(summary);
    assert.match(markdown, /retitled/);
    assert.match(markdown, /-2 deps/);
    assert.match(markdown, /1 comment/);
    assert.match(markdown, /2 events/);
  });

  test("equal timestamps fall through to id ordering and text/slack budgets still truncate", () => {
    const many: DeltaActivityEntry[] = [];
    const byId = new Map<string, PmItem>();
    for (let index = 0; index < 8; index += 1) {
      const id = `pm-same-${String(index)}`;
      many.push(actEntry(id, "note_add", "2026-07-20T01:00:00Z", [
        { op: "add", path: "/metadata/notes/0", value: {} },
      ]));
      byId.set(id, { id, title: id, type: "Task", status: "open", priority: 2 });
    }
    const text = buildDelta(many, byId, {
      since: "2026-07-20",
      format: "text",
      tokenBudget: 1,
      maxItems: 8,
    });
    assert.equal(text.truncated, true);
    assert.ok((text.omittedItems ?? 0) > 0);
    const slack = buildDelta(many, byId, {
      since: "2026-07-20",
      format: "slack",
      tokenBudget: 1,
      maxItems: 8,
    });
    assert.equal(slack.truncated, true);
  });

  test("an empty window still names until/author in the markdown header", () => {
    const summary = buildDelta([], new Map(), {
      since: "2026-07-01",
      until: "2026-07-02",
      author: "alice",
    });
    assert.match(renderMarkdownDelta(summary), /until 2026-07-02 by alice/);
    assert.match(renderMarkdownDelta(summary), /No changes since 2026-07-01/);
  });

  test("renderers disclose truncation even when omittedItems is absent", () => {
    const summary: DeltaSummary = {
      since: "2026-07-20",
      generatedAt: "2026-07-22T00:00:00Z",
      workspace: ".agents/pm",
      pmVersion: "test",
      totals: { ...emptyTotals(), itemsChanged: 1, events: 1 },
      items: [deltaChange("pm-only", { notesAdded: 1 })],
      truncated: true,
    };
    assert.match(renderMarkdownDelta(summary), /truncated: 0 lower-ranked item/);
    assert.match(renderTextDelta(summary), /\(truncated, 0 omitted\)/);
    assert.match(renderSlackDelta(summary), /_\(0 omitted\)_/);
  });
});

describe("brief, next-work, and governance commands reject bad flags and honour nested selectors", () => {
  test("every command family rejects an unsupported --format before touching the tracker", async () => {
    const { commands } = await activateBrief();
    const reject = async (command: string, options: Record<string, unknown>, args: string[] = [], pattern: RegExp) => {
      await assert.rejects(
        runRegisteredCommandForTest(commands, { command, options, args, pmRoot: "/nonexistent-tracker" }),
        pattern,
      );
    };
    await reject("brief", { format: "html" }, [], /--format must be markdown, json, or slack/);
    await reject("brief next", { format: "yaml" }, [], /--format must be text or json/);
    await reject("brief stale", { format: "html" }, [], /--format must be text or json/);
    await reject("brief momentum", { format: "html" }, [], /--format must be text or json/);
    await reject("brief since", { format: "html" }, ["7d"], /--format must be markdown, text, json, or slack/);
    await reject("brief diverge", { format: "html", base: "HEAD", head: "HEAD" }, [], /--format must be markdown, text, json, or slack/);
    await reject("brief governance", { format: "html" }, [], /--format must be text, json, or markdown/);
  });

  test("brief since requires a checkpoint and accepts until/text/slack output", async () => {
    const { commands } = await activateBrief();
    await assert.rejects(
      runRegisteredCommandForTest(commands, {
        command: "brief since",
        args: [],
        options: {},
        pmRoot: repoPmRoot(),
      }),
      /pm brief since requires a <checkpoint>/,
    );
    const outputDir = await mkdtemp(join(tmpdir(), "pm-brief-since-formats-"));
    try {
      const run = async (options: Record<string, unknown>, args: string[]) =>
        (await runRegisteredCommandForTest(commands, {
          command: "brief since",
          args,
          options,
          global: { json: false },
          pmRoot: repoPmRoot(),
        })).result as { pmBriefRendered?: boolean; output?: string; ok?: boolean; format?: string };
      const text = await run({ format: "text", until: "0d" }, ["3650d"]);
      assert.equal(text.pmBriefRendered, true);
      assert.match(String(text.output), /Delta since /);
      const slackPath = join(outputDir, "delta.slack");
      const slack = await run({ format: "slack", output: slackPath, until: "0d" }, ["3650d"]);
      assert.equal(slack.ok, true);
      assert.equal(slack.format, "slack");
      assert.match(readFileSync(slackPath, "utf8"), /\*Delta since /);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("nested --focus arrays flatten and brief next json without --explain is a bare next list", async () => {
    const { commands } = await activateBrief();
    const focused = (await runRegisteredCommandForTest(commands, {
      command: "brief",
      options: { focus: [["pm-brief-gtiy"], "type:Issue"], format: "json", "no-governance": true },
      global: { json: false },
      pmRoot: repoPmRoot(),
    })).result as { output?: string };
    const brief = JSON.parse(String(focused.output)) as { focus: Array<{ id: string; type: string }> };
    assert.ok(brief.focus.some((item) => item.id === "pm-brief-gtiy"));
    assert.ok(brief.focus.some((item) => item.type === "Issue"));

    const next = (await runRegisteredCommandForTest(commands, {
      command: "brief next",
      options: { format: "json", count: 2 },
      global: { json: false },
      pmRoot: repoPmRoot(),
    })).result as { output?: string };
    const payload = JSON.parse(String(next.output)) as { next?: unknown; explanations?: unknown };
    assert.ok(Array.isArray(payload.next));
    assert.equal(payload.explanations, undefined);
  });

  test("brief duplicates and brief governance honour --json and reject a zero --limit", async () => {
    const { commands } = await activateBrief();
    await assert.rejects(
      runRegisteredCommandForTest(commands, {
        command: "brief duplicates",
        options: { limit: 0 },
        pmRoot: "/nonexistent-tracker",
      }),
      /--limit must be a positive integer/,
    );
    const duplicates = (await runRegisteredCommandForTest(commands, {
      command: "brief duplicates",
      options: { json: true, limit: 2, since: "2999-01-01" },
      pmRoot: repoPmRoot(),
    })).result as { output?: string };
    assert.equal((JSON.parse(String(duplicates.output)) as { count?: number }).count, 0);

    const governance = (await runRegisteredCommandForTest(commands, {
      command: "brief governance",
      options: { json: true, threshold: 1, "stale-hours": 0 },
      pmRoot: repoPmRoot(),
    })).result as { output?: string };
    assert.equal(typeof (JSON.parse(String(governance.output)) as { generatedAt?: unknown }).generatedAt, "string");
  });

  test("brief momentum lists closes that have no cycle time and statuses-only filters still explain emptiness", () => {
    const closedWithoutCycle: PmItem[] = [{
      id: "pm-closed-no-created",
      title: "Closed without created_at",
      type: "Task",
      status: "closed",
      closed_at: "2026-07-20T00:00:00Z",
      updated_at: "2026-07-20T00:00:00Z",
    }];
    const momentum = summarizeMomentum(closedWithoutCycle, {
      generatedAt: "2026-07-21T00:00:00Z",
      completedDays: 7,
    });
    assert.equal(momentum.closedCount, 1);
    assert.equal(momentum.cycleTime, undefined);
    assert.equal(momentum.recent[0]?.cycleDays, undefined);

    const brief = buildBrief([
      { id: "pm-open", title: "Open", type: "Task", status: "open", priority: 1 },
    ], { generatedAt: "2026-07-21T00:00:00Z", statuses: ["blocked"] });
    assert.ok(brief.insights?.some((insight) => insight.message.includes("no open work matched filters (status=blocked)")));
  });
});

describe("briefs, governance, and merge-decision renderers cover remaining fallbacks", () => {
  test("includeHistory without pmRoot reads the default tracker and missing blockers stay untitled", () => {
    const brief = buildBrief([
      {
        id: "pm-blocked",
        title: "Waiting",
        type: "Task",
        status: "open",
        priority: 1,
        blocked_by: ["pm-absent"],
      },
    ], {
      generatedAt: "2026-07-21T00:00:00Z",
      includeHistory: true,
      tokenBudget: 80,
    });
    assert.ok(brief.blockers.some((blocker) => blocker.blockedBy === "pm-absent" && blocker.title === undefined));
    assert.equal(brief.budget.truncated, true);
  });

  test("detectStaleContext keeps items that have no updated_at and governance defaults still scan", async () => {
    const defaults = await collectGovernanceSignals([{ id: "pm-defaults" }]);
    assert.equal(defaults.threshold, 0.6);
    assert.equal(defaults.staleThresholdHours, 72);
    const stale = detectStaleContext([
      { id: "pm-no-ts", title: "Ancient", type: "Task", status: "open" },
    ], { generatedAt: "2026-07-21T00:00:00Z", staleDays: 0 });
    assert.equal(stale[0]?.itemId, "pm-no-ts");
    assert.equal(stale[0]?.updatedAt, undefined);

    const summary = await collectGovernanceSignals([
      { id: "pm-sparse" },
    ], { pmRoot: "\0invalid-pm-root-for-defaults" });
    assert.equal(typeof summary.generatedAt, "string");
    assert.equal(summary.threshold, 0.6);
    assert.equal(summary.staleThresholdHours, 72);

    const malformedRoot = await mkdtemp(join(tmpdir(), "pm-brief-governance-settings-"));
    try {
      await writeFile(join(malformedRoot, "settings.json"), "{not-json}\n", "utf8");
      const malformed = await collectGovernanceSignals([{ id: "pm-malformed" }], { pmRoot: malformedRoot });
      assert.equal(malformed.storageFindingsTotal, 1);
    } finally {
      await rm(malformedRoot, { recursive: true, force: true });
    }
  });

  test("a very small brief budget reaches the tight governance compaction stage", () => {
    const brief = buildBrief([
      { id: "pm-budget", title: "A very long title that forces repeated compaction", type: "Task", status: "open", priority: 1 },
    ], { tokenBudget: 1, generatedAt: "2026-07-27T12:00:00Z" });
    assert.equal(brief.budget.truncated, true);
    assert.equal(brief.governance, undefined);
  });

  test("SDK edge adapters preserve quote, path, score, and missing-field contracts", () => {
    assert.equal(normalizeItemPath("\".agents/pm/tasks/pm-a.toon\""), ".agents/pm/tasks/pm-a.toon");
    assert.equal(secretFieldFromPath("$."), "(unknown field)");
    assert.equal(escapeLine(undefined), "");
    assert.equal(formatScoreValue(2), "2");
    assert.equal(formatScoreValue(1.25), "1.3");
    const cluster: DuplicateCluster = {
      id: "pm-a",
      items: [{ id: "pm-a", title: "Task A", status: "open", type: "Task" }],
      matches: [],
      max_score: 0,
    };
    const adapted = toGovernanceDuplicateCluster(cluster, new Map([["pm-a", { id: "pm-a", title: "Task A", type: "Task", status: "open" }]]));
    assert.equal(adapted.reason, "title_token_jaccard");
  });

  test("a preferred_side receipt with no recorded side renders as unrecorded, not as a branch name", () => {
    const entry: MergeDecisionEntry = {
      receiptId: "rec-none",
      itemId: "pm-a",
      itemPath: ".agents/pm/tasks/pm-a.toon",
      conflictResolution: "preferred_side",
      conflicts: [{ field: "title", discarded: "peer title" }],
    };
    const mergeDecisions: MergeDecisionsSummary = {
      pendingCount: 1,
      compromisedItemIds: ["pm-a"],
      receipts: [entry],
    };
    const brief = buildBrief([
      { id: "pm-a", title: "Task A", type: "Task", status: "open" },
    ], {
      generatedAt: "2026-07-27T12:00:00Z",
      mergeDecisions,
      pmRoot: ".agents/pm",
      pmVersion: "test",
    });
    assert.equal(brief.mergeDecisions?.receipts[0]?.preferred, undefined);
    assert.match(renderMarkdownBrief(brief), /kept side unrecorded/);
  });

  test("renderTextGovernance names omitted stale/secret rows and storage findings without an id", () => {
    const text = renderTextGovernance({
      duplicateClusters: [],
      duplicateClustersTotal: 0,
      staleInProgress: [{
        id: "pm-stale",
        lastActivityAt: "2026-07-20T00:00:00Z",
        ageHours: 200,
        remediation: "pm claim pm-stale",
      }],
      staleInProgressTotal: 4,
      storageFindings: [{
        kind: "unparseable_config",
        path: ".agents/pm/settings.json",
        detail: "invalid settings",
        remediation: "pm validate",
      }],
      storageFindingsTotal: 1,
      secretFindings: [{
        itemId: "pm-secret",
        field: "description",
        rule: "github_token",
        remediation: "pm get pm-secret",
      }],
      secretFindingsTotal: 6,
      threshold: 0.6,
      staleThresholdHours: 72,
      generatedAt: "2026-07-26T12:00:00.000Z",
    });
    assert.match(text, /Stale in-progress \(72h threshold\) \(\+3 more\)/);
    assert.match(text, /Secrets in item text \(\+5 more\)/);
    assert.match(text, /unparseable_config: invalid settings/);
    assert.doesNotMatch(text, /unparseable_config  /);
  });

  test("collapseDuplicatePairs with equal scores orders by pair id", () => {
    const items: PmItem[] = [
      { id: "pm-a", title: "A", type: "Task", status: "open" },
      { id: "pm-b", title: "B", type: "Task", status: "open" },
      { id: "pm-c", title: "C", type: "Task", status: "open" },
      { id: "pm-d", title: "D", type: "Task", status: "open" },
    ];
    const match = (id: string): SimilarItemMatch => ({
      id,
      title: id,
      status: "open",
      type: "Task",
      score: 0.8,
      reason: "exact_title",
    });
    const pairs = collapseDuplicatePairs(
      items,
      new Map([
        ["pm-c", [match("pm-d")]],
        ["pm-a", [match("pm-b")]],
      ]),
      new Map(items.map((item) => [item.id, item])),
    );
    assert.equal(pairs.length, 2);
    assert.deepEqual(pairs.map((pair) => pair.score), [0.8, 0.8]);
    assert.deepEqual(pairs.map((pair) => pair.id).sort(), pairs.map((pair) => pair.id));
  });
});

describe("divergence helpers cover sparse events, empty probes, and renderer fallbacks", () => {
  test("eventKey and changedFieldPaths tolerate missing hashes, authors, patches, and empty paths", () => {
    assert.equal(eventKey({ ts: "t0", op: "update" }), "t0||update");
    assert.equal(eventKey({ ts: "t0", author: "ada", op: "update", after_hash: "" }), "t0|ada|update");
    const fields = changedFieldPaths([
      { ts: "t0", op: "update" },
      { ts: "t1", op: "update", patch: [{ op: "add", path: "" }, { op: "add", path: "/title" }] },
    ]);
    assert.deepEqual([...fields], ["/title"]);
  });

  test("scanHistoryJsonl defaults op to activity and keeps events without after_hash", () => {
    const scan = scanHistoryJsonl(JSON.stringify({ ts: "2026-07-20T00:00:00Z" }));
    assert.equal(scan.events.length, 1);
    assert.equal(scan.events[0]?.op, "activity");
    assert.equal(scan.events[0]?.after_hash, undefined);
  });

  test("checkAttrMerge on an empty path list does not spawn git", () => {
    assert.equal(checkAttrMerge("/nonexistent-repo-root-for-empty-paths", []).size, 0);
  });

  test("buildDivergence drops unchanged items, keeps equal-id order, and budgets text/slack", () => {
    const unchanged = classifyItemDivergence({
      id: "pm-same",
      ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z")], itemPresent: true },
      base: { events: [divEvent("create", "2026-07-19T00:00:00Z")], itemPresent: true },
      head: { events: [divEvent("create", "2026-07-19T00:00:00Z")], itemPresent: true },
    });
    const collision = classifyItemDivergence({
      id: "pm-coll",
      ancestor: { events: [divEvent("create", "2026-07-19T00:00:00Z")], itemPresent: true },
      base: {
        events: [
          divEvent("create", "2026-07-19T00:00:00Z"),
          divEvent("update", "2026-07-20T01:00:00Z"),
        ],
        itemPresent: true,
      },
      head: {
        events: [
          divEvent("create", "2026-07-19T00:00:00Z"),
          divEvent("update", "2026-07-20T02:00:00Z"),
        ],
        itemPresent: true,
      },
    });
    const summary = buildDivergence([unchanged, collision, { ...collision }], {
      base: "main",
      head: "feat",
      baseSha: "s1",
      headSha: "s2",
      ancestorSha: "s0",
      workspace: ".agents/pm",
      pmVersion: "test",
      generatedAt: "2026-07-24T00:00:00Z",
      fence: OK_FENCE,
      format: "text",
      tokenBudget: 1,
      maxItems: 5,
    });
    assert.equal(summary.items.every((item) => item.kind !== "unchanged"), true);
    assert.ok(summary.items.length >= 1);
    const slack = buildDivergence([collision], {
      base: "main",
      head: "feat",
      baseSha: "s1",
      headSha: "s2",
      ancestorSha: "s0",
      workspace: ".agents/pm",
      pmVersion: "test",
      generatedAt: "2026-07-24T00:00:00Z",
      fence: OK_FENCE,
      format: "slack",
    });
    assert.equal(typeof slack.verdict, "string");
    const truncated = { ...slack, truncated: true, omittedItems: undefined };
    assert.match(renderMarkdownDivergence(truncated), /truncated: 0 lower-ranked item/);
    assert.match(renderTextDivergence(truncated), /\(truncated, 0 omitted\)/);
    assert.match(renderSlackDivergence(truncated), /_\(0 omitted\)_/);
  });

  test("equal-timestamp new events still classify and authors without names are dropped", () => {
    const item = classifyItemDivergence({
      id: "pm-tie",
      ancestor: { events: [], itemPresent: true },
      base: {
        events: [
          { ts: "2026-07-20T01:00:00Z", op: "update", patch: [{ op: "replace", path: "/metadata/priority", value: 1 }] },
          { ts: "2026-07-20T02:00:00Z", author: "ada", op: "update", patch: [{ op: "replace", path: "/metadata/assignee", value: "ada" }] },
        ],
        itemPresent: true,
      },
      head: {
        events: [
          { ts: "2026-07-20T01:00:00Z", op: "update", patch: [{ op: "replace", path: "/title", value: "n" }] },
        ],
        itemPresent: true,
      },
    });
    assert.equal(item.kind, "union-safe");
    assert.deepEqual(item.base.authors, ["ada"]);
  });
});

describe("collectPendingMergeDecisions degrades outside git and when cwd disappears", () => {
  test("a tracker that is not inside a git worktree still returns rather than throwing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pm-brief-nongit-"));
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(await collectPendingMergeDecisions(dir), undefined);
    } finally {
      process.chdir(previousCwd);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a deleted process cwd degrades to no pending decisions instead of failing the brief", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pm-brief-gone-cwd-"));
    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    await rm(tmpDir, { recursive: true, force: true });
    try {
      assert.equal(await collectPendingMergeDecisions(".agents/pm"), undefined);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

describe("git readers fail closed when stderr is empty and honour a non-origin symbolic default", () => {
  test("detectDefaultBase accepts origin/HEAD that does not use an origin/ prefix", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pm-brief-sym-"));
    try {
      const git = (args: string[]): string => {
        const result = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "pm-brief test"]);
      await writeFile(join(tmpDir, "README.md"), "fixture\n");
      git(["add", "README.md"]);
      git(["commit", "-m", "fixture"]);
      git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/heads/main"]);
      assert.equal(detectDefaultBase(tmpDir), "main");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("empty-stdout and silent non-zero git processes still fail closed", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX PATH override is not the Windows git lookup path");
      return;
    }
    const fakeBin = await mkdtemp(join(tmpdir(), "pm-brief-silent-git-"));
    const previousPath = process.env.PATH;
    try {
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit, "#!/bin/sh\nexit 0\n", "utf8");
      await chmod(fakeGit, 0o755);
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      assert.throws(() => resolveRepoRoot(process.cwd()), /not a git repository/);
      assert.throws(() => resolveRef(process.cwd(), "HEAD"), /unknown ref/);
      assert.equal(mergeBase(process.cwd(), "a", "b"), undefined);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test("a git that exits non-zero with empty stderr uses the numeric fallback", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX PATH override is not the Windows git lookup path");
      return;
    }
    const fakeBin = await mkdtemp(join(tmpdir(), "pm-brief-fail-git-"));
    const previousPath = process.env.PATH;
    try {
      const fakeGit = join(fakeBin, "git");
      await writeFile(fakeGit, "#!/bin/sh\nexit 2\n", "utf8");
      await chmod(fakeGit, 0o755);
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      assert.throws(() => resolveRepoRoot(process.cwd()), /not a git repository/);
      assert.throws(() => mergeBase(process.cwd(), "a", "b"), /exit 2/);
      assert.throws(() => listChangedPaths(process.cwd(), "a", "b", ".agents/pm"), /exit 2/);
      assert.throws(() => listChangedPaths(process.cwd(), undefined, "b", ".agents/pm"), /exit 2/);
      assert.throws(() => readBlob(process.cwd(), "dead", "x"), /exit 2/);
      assert.throws(() => checkAttrMerge(process.cwd(), ["x"]), /exit 2/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test("a missing git binary surfaces the spawn error rather than an empty change set", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX PATH override is not the Windows git lookup path");
      return;
    }
    const fakeBin = await mkdtemp(join(tmpdir(), "pm-brief-nogit-"));
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = fakeBin;
      assert.throws(() => resolveRepoRoot(process.cwd()), /spawn.*ENOENT|not a git repository/i);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });

  test("check-attr lines without the merge marker are ignored", async (t) => {
    if (process.platform === "win32") {
      t.skip("POSIX PATH override is not the Windows git lookup path");
      return;
    }
    const fakeBin = await mkdtemp(join(tmpdir(), "pm-brief-attr-git-"));
    const previousPath = process.env.PATH;
    try {
      const fakeGit = join(fakeBin, "git");
      await writeFile(
        fakeGit,
        [
          "#!/bin/sh",
          "echo 'not a merge line'",
          "echo '.agents/pm/history/x.jsonl: merge: pm-history'",
          "exit 0",
          "",
        ].join("\n"),
        "utf8",
      );
      await chmod(fakeGit, 0o755);
      process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;
      const resolved = checkAttrMerge(process.cwd(), [
        ".agents/pm/history/x.jsonl",
        ".agents/pm/tasks/x.toon",
      ]);
      assert.equal(resolved.get(".agents/pm/history/x.jsonl"), "pm-history");
      assert.equal(resolved.has(".agents/pm/tasks/x.toon"), false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      await rm(fakeBin, { recursive: true, force: true });
    }
  });
});

describe("brief diverge command covers default refs, text/slack, unrelated histories, and root toons", () => {
  test("omitting --head defaults to HEAD and text/slack renderers persist", async () => {
    const { commands } = await activateBrief();
    const json = (await runRegisteredCommandForTest(commands, {
      command: "brief diverge",
      options: { base: "HEAD", format: "json" },
      global: { json: false },
      pmRoot: repoPmRoot(),
    })).result as { output?: string };
    const summary = JSON.parse(String(json.output)) as { head?: string; verdict?: string };
    assert.equal(summary.head, "HEAD");
    assert.equal(typeof summary.verdict, "string");

    const outputDir = await mkdtemp(join(tmpdir(), "pm-brief-diverge-formats-"));
    try {
      const textPath = join(outputDir, "diverge.txt");
      const text = (await runRegisteredCommandForTest(commands, {
        command: "brief diverge",
        options: { base: "HEAD", head: "HEAD", format: "text", output: textPath },
        global: { json: false },
        pmRoot: repoPmRoot(),
      })).result as { ok?: boolean; format?: string; output?: string };
      assert.equal(text.ok, true);
      assert.equal(text.format, "text");
      assert.match(readFileSync(textPath, "utf8"), /No pm item divergence between HEAD and HEAD|Divergence: HEAD/);


      const slack = (await runRegisteredCommandForTest(commands, {
        command: "brief diverge",
        options: { base: "HEAD", head: "HEAD", format: "slack" },
        global: { json: false },
        pmRoot: repoPmRoot(),
      })).result as { output?: string };
      assert.match(String(slack.output), /No pm item divergence between HEAD and HEAD|\*Divergence:/);
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });

  test("unrelated histories, a root-level toon, and a blank driver config still produce a verdict", async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), "pm-brief-unrelated-"));
    const previousCwd = process.cwd();
    try {
      const git = (args: string[]): string => {
        const result = spawnSync("git", args, { cwd: tmpDir, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      const pm = (args: string[]): string => {
        const result = spawnSync(INSTALLED_PM_BIN, args, { cwd: tmpDir, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        return result.stdout.trim();
      };
      git(["init", "--initial-branch=main"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "pm-brief test"]);
      const pmPath = join(tmpDir, ".agents", "pm");
      pm(["init", "--pm-path", pmPath]);
      await writeFile(join(tmpDir, "orphan.toon"), "id: orphan\n");
      git(["add", "-A"]);
      git(["commit", "-m", "root a"]);
      git(["checkout", "--orphan", "other"]);
      git(["rm", "-rq", "--cached", "."]);
      pm(["init", "--pm-path", pmPath]);
      pm(["--pm-path", pmPath, "create", "--title", "Other", "--type", "Task", "--author", "agent-b", "--json"]);
      git(["add", "-A"]);
      git(["commit", "-m", "root b"]);
      git(["config", "merge.pm-item-toon.driver", " "]);
      git(["config", "merge.pm-history.driver", " "]);

      const { commands } = await activateBrief();
      process.chdir(tmpDir);
      const result = (await runRegisteredCommandForTest(commands, {
        command: "brief diverge",
        args: ["main"],
        options: { head: "other", format: "json", "include-clean": true },
        global: { json: false },
        pmRoot: ".agents/pm",
      })).result as { output?: string };
      const summary = JSON.parse(String(result.output)) as {
        unrelatedHistories?: boolean;
        verdict?: string;
        items?: Array<{ id: string }>;
      };
      assert.equal(summary.unrelatedHistories, true);
      assert.equal(typeof summary.verdict, "string");
    } finally {
      process.chdir(previousCwd);
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});
