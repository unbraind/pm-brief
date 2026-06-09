import assert from "node:assert/strict";
import test from "node:test";
import extension, {
  buildBrief,
  detectStaleContext,
  extractRelationships,
  renderMarkdownBrief,
  selectNextItems,
  summarizeRisks,
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
  assert.deepEqual(commands.map((command) => command.name), ["brief", "brief next", "brief stale"]);
});

test("extractRelationships normalizes dependency fields", () => {
  assert.deepEqual(extractRelationships(items[0]!), [{ from: "pm-a", to: "pm-b", kind: "blocked_by" }]);
});

test("selectNextItems ranks unblocked priority before blocked work", () => {
  const next = selectNextItems(items, { generatedAt: "2026-06-06T00:00:00Z", nextCount: 3 });
  assert.deepEqual(next.map((item) => item.id), ["pm-b", "pm-c", "pm-a"]);
  assert.equal(next[2]?.whyNow, "blocked: resolve prerequisite before implementation");
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
  assert.match(markdown, /pm-a blocked_by pm-b Approve changelog \(open\)/);
  assert.match(markdown, /Recommended PM Updates/);
});
