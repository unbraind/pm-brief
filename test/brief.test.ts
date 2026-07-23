import assert from "node:assert/strict";
import test, { describe } from "node:test";
import extension, {
  buildBrief,
  buildDelta,
  detectStaleContext,
  explainNextItems,
  extractRelationships,
  normalizeCheckpoint,
  parsePmItemsOutput,
  readRecentActivity,
  renderAgentPrompt,
  renderMarkdownBrief,
  renderMarkdownDelta,
  renderSlackBrief,
  renderSlackDelta,
  renderTextDelta,
  selectNextItems,
  summarizeMomentum,
  summarizeRisks,
  type DeltaActivityEntry,
  type PmItem,
} from "../dist/index.js";

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

test("extension registers brief commands", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  assert.deepEqual(commands.map((command) => command.name), ["brief", "brief prompt", "brief next", "brief stale", "brief momentum", "brief since"]);
  const nextFlags = commands.find((command) => command.name === "brief next")?.flags as Array<Record<string, unknown>>;
  assert.ok(nextFlags.some((flag) => flag.long === "--explain"));
  assert.ok(nextFlags.some((flag) => flag.long === "--confidence"));
});

test("brief next command exposes explain flag", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  const nextCommand = commands.find((command) => command.name === "brief next");
  assert.ok(nextCommand, "brief next command should be registered");
  const flags = (nextCommand.flags as Array<{ long?: string }>).map((flag) => flag.long);
  assert.ok(flags.includes("--explain"));
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

test("extension registers --include-history, --history-limit, and --format slack flags", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  const briefCommand = commands.find((command) => command.name === "brief");
  const flags = (briefCommand?.flags as Array<{ long?: string }>).map((flag) => flag.long);
  assert.ok(flags.includes("--include-history"));
  assert.ok(flags.includes("--history-limit"));
  const formatFlag = (briefCommand?.flags as Array<{ long?: string; description?: string }>).find((flag) => flag.long === "--format");
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

test("brief command registers a --completed-days flag and brief momentum exposes --days", () => {
  const commands: Array<Record<string, unknown>> = [];
  extension.activate({ registerCommand(command: Record<string, unknown>) { commands.push(command); } });
  const briefFlags = (commands.find((command) => command.name === "brief")?.flags as Array<{ long?: string }>).map((flag) => flag.long);
  assert.ok(briefFlags.includes("--completed-days"));
  const momentumCommand = commands.find((command) => command.name === "brief momentum");
  assert.ok(momentumCommand, "brief momentum command should be registered");
  const momentumFlags = (momentumCommand.flags as Array<{ long?: string }>).map((flag) => flag.long);
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
});
