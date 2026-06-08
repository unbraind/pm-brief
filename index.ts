import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

export const EXIT_CODE = {
  GENERIC_FAILURE: 1,
  USAGE: 2,
} as const;

export class CommandError extends Error {
  exitCode: number;
  constructor(message: string, exitCode: number = EXIT_CODE.GENERIC_FAILURE) {
    super(message);
    this.name = "CommandError";
    this.exitCode = exitCode;
  }
}

export interface PmItem {
  id: string;
  title?: string;
  type?: string;
  status?: string;
  priority?: number;
  assignee?: string;
  tags?: string[];
  body?: string;
  description?: string;
  parent?: string;
  sprint?: string;
  release?: string;
  deadline?: string;
  created_at?: string;
  updated_at?: string;
  deps?: unknown;
  dependencies?: unknown;
  blocked_by?: unknown;
  blockedBy?: unknown;
  docs?: unknown;
  files?: unknown;
  [key: string]: unknown;
}

export interface BriefOptions {
  tokenBudget?: number;
  focusIds?: string[];
  statuses?: string[];
  assignee?: string;
  includeClosed?: boolean;
  staleDays?: number;
  nextCount?: number;
  generatedAt?: string;
  pmRoot?: string;
  pmVersion?: string;
}

export interface BriefItem {
  id: string;
  title: string;
  type: string;
  status: string;
  priority?: number;
  assignee?: string;
  tags: string[];
  whyNow: string;
  requiredContext: string[];
  dependencyIds: string[];
  dependentIds: string[];
  tokenCostEstimate: number;
}

export interface BriefBlocker {
  itemId: string;
  blockedBy: string;
  kind: string;
  title?: string;
  status?: string;
}

export interface BriefRisk {
  itemId: string;
  severity: "low" | "medium" | "high";
  reason: string;
}

export interface StaleContextFinding {
  itemId: string;
  title: string;
  updatedAt?: string;
  daysStale: number;
}

export interface RecommendedPmUpdate {
  itemId: string;
  command: string;
  reason: string;
  safeToAutoApply: boolean;
}

export interface AgentBrief {
  generatedAt: string;
  workspace: {
    root: string;
    pmVersion: string;
    itemCount: number;
  };
  budget: {
    requestedTokens: number;
    estimatedTokens: number;
    truncated: boolean;
  };
  focus: BriefItem[];
  next: BriefItem[];
  blockers: BriefBlocker[];
  risks: BriefRisk[];
  staleContext: StaleContextFinding[];
  decisionsNeeded: BriefItem[];
  recommendedPmUpdates: RecommendedPmUpdate[];
}

interface Relationship {
  from: string;
  to: string;
  kind: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asArray);
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function readBool(options: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.some((key) => options[key] === true || options[key] === "true" || options[key] === "1");
}

function readString(options: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = options[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readInt(options: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = options[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new CommandError(`--${key} must be a positive integer`, EXIT_CODE.USAGE);
    }
    return parsed;
  }
  return fallback;
}

function readNonNegativeInt(options: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const value = options[key];
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseInt(String(value), 10);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new CommandError(`--${key} must be zero or a positive integer`, EXIT_CODE.USAGE);
    }
    return parsed;
  }
  return fallback;
}

function statusOf(item: PmItem): string {
  return text(item.status) || "unknown";
}

function typeOf(item: PmItem): string {
  return text(item.type) || "Item";
}

function titleOf(item: PmItem): string {
  return text(item.title) || "(untitled)";
}

function isClosed(item: PmItem): boolean {
  const status = statusOf(item).toLowerCase();
  return status === "closed" || status === "done" || status === "canceled" || status === "cancelled";
}

function parseRelationshipValue(value: unknown, fallbackKind: string): Array<{ to: string; kind: string }> {
  if (!value) return [];
  if (typeof value === "string") return asArray(value).map((to) => ({ to, kind: fallbackKind }));
  if (Array.isArray(value)) return value.flatMap((entry) => parseRelationshipValue(entry, fallbackKind));
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const to = text(record.id) || text(record.to) || text(record.target) || text(record.target_id) || text(record.item_id);
    if (!to) return [];
    return [{ to, kind: text(record.kind) || text(record.type) || fallbackKind }];
  }
  return [];
}

export function extractRelationships(item: PmItem): Relationship[] {
  return [
    ...parseRelationshipValue(item.deps, "depends_on"),
    ...parseRelationshipValue(item.dependencies, "depends_on"),
    ...parseRelationshipValue(item.blocked_by, "blocked_by"),
    ...parseRelationshipValue(item.blockedBy, "blocked_by"),
  ].filter((rel) => rel.to && rel.to !== item.id).map((rel) => ({ from: item.id, to: rel.to, kind: rel.kind }));
}

function estimateTokens(value: unknown): number {
  return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function itemUpdatedAt(item: PmItem): string {
  return text(item.updated_at) || text(item.created_at);
}

function ageDays(item: PmItem, now: Date): number {
  const raw = itemUpdatedAt(item);
  if (!raw) return 0;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
}

function linksFor(item: PmItem): string[] {
  return [...asArray(item.docs), ...asArray(item.files)].slice(0, 6);
}

function toBriefItem(item: PmItem, rels: Relationship[], allItems: PmItem[], now: Date): BriefItem {
  const dependencyIds = rels.filter((rel) => rel.from === item.id).map((rel) => rel.to);
  const dependentIds = rels.filter((rel) => rel.to === item.id).map((rel) => rel.from);
  const stale = ageDays(item, now);
  const requiredContext = [
    ...dependencyIds.map((id) => `dependency:${id}`),
    ...dependentIds.map((id) => `dependent:${id}`),
    ...linksFor(item),
  ].slice(0, 8);
  const priority = typeof item.priority === "number" ? item.priority : undefined;
  const blocked = rels.some((rel) => rel.from === item.id && (rel.kind === "blocked_by" || rel.kind === "depends_on"));
  const whyNow = blocked
    ? "blocked: resolve prerequisite before implementation"
    : priority !== undefined
      ? `priority ${priority}`
      : stale > 0
        ? `updated ${stale} day(s) ago`
        : "active open work";
  const compact = {
    id: item.id,
    title: titleOf(item),
    body: text(item.body) || text(item.description),
    deps: dependencyIds,
    dependents: dependentIds,
    context: requiredContext,
    visible: allItems.length,
  };
  return {
    id: item.id,
    title: titleOf(item),
    type: typeOf(item),
    status: statusOf(item),
    priority,
    assignee: text(item.assignee) || undefined,
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    whyNow,
    requiredContext,
    dependencyIds,
    dependentIds,
    tokenCostEstimate: estimateTokens(compact),
  };
}

function scoreItem(item: PmItem, rels: Relationship[], now: Date): number {
  const priority = typeof item.priority === "number" ? item.priority : 5;
  const blockedPenalty = rels.some((rel) => rel.from === item.id && (rel.kind === "blocked_by" || rel.kind === "depends_on")) ? 100 : 0;
  const activeBoost = statusOf(item).toLowerCase() === "in_progress" ? -10 : 0;
  const stalePenalty = Math.min(ageDays(item, now), 30) / 10;
  return priority * 10 + blockedPenalty + activeBoost + stalePenalty;
}

export function selectNextItems(items: PmItem[], options: BriefOptions = {}): BriefItem[] {
  const now = new Date(options.generatedAt ?? Date.now());
  const rels = items.flatMap(extractRelationships);
  return items
    .filter((item) => !isClosed(item))
    .filter((item) => !options.assignee || text(item.assignee) === options.assignee)
    .filter((item) => !options.statuses?.length || options.statuses.includes(statusOf(item)))
    .sort((a, b) => scoreItem(a, rels, now) - scoreItem(b, rels, now) || itemUpdatedAt(b).localeCompare(itemUpdatedAt(a)) || a.id.localeCompare(b.id))
    .slice(0, options.nextCount ?? 5)
    .map((item) => toBriefItem(item, rels, items, now));
}

export function detectStaleContext(items: PmItem[], options: BriefOptions = {}): StaleContextFinding[] {
  const now = new Date(options.generatedAt ?? Date.now());
  const staleDays = options.staleDays ?? 7;
  return items
    .filter((item) => !isClosed(item))
    .map((item) => ({ item, days: ageDays(item, now) }))
    .filter(({ days }) => days >= staleDays)
    .sort((a, b) => b.days - a.days || a.item.id.localeCompare(b.item.id))
    .map(({ item, days }) => ({ itemId: item.id, title: titleOf(item), updatedAt: itemUpdatedAt(item) || undefined, daysStale: days }));
}

export function summarizeRisks(items: PmItem[], options: BriefOptions = {}): BriefRisk[] {
  const now = new Date(options.generatedAt ?? Date.now());
  const risks: BriefRisk[] = [];
  const rels = items.flatMap(extractRelationships);
  for (const item of items.filter((candidate) => !isClosed(candidate))) {
    if (rels.some((rel) => rel.from === item.id && (rel.kind === "blocked_by" || rel.kind === "depends_on"))) {
      risks.push({ itemId: item.id, severity: "high", reason: "blocked by visible dependency" });
    }
    if (item.deadline && Date.parse(item.deadline) < now.getTime()) {
      risks.push({ itemId: item.id, severity: "high", reason: `deadline passed: ${item.deadline}` });
    }
    const days = ageDays(item, now);
    if (days >= (options.staleDays ?? 7)) {
      risks.push({ itemId: item.id, severity: "medium", reason: `stale context: ${days} day(s) since update` });
    }
  }
  return risks;
}

function selectedFocus(items: PmItem[], options: BriefOptions): PmItem[] {
  const ids = new Set(options.focusIds ?? []);
  const candidates = ids.size > 0 ? items.filter((item) => ids.has(item.id)) : selectNextItems(items, { ...options, nextCount: 3 }).map((next) => items.find((item) => item.id === next.id)).filter((item): item is PmItem => Boolean(item));
  return candidates.filter((item) => options.includeClosed || !isClosed(item));
}

function compactToBudget(brief: AgentBrief): AgentBrief {
  const budget = brief.budget.requestedTokens;
  let estimated = estimateTokens(brief);
  if (estimated <= budget) return { ...brief, budget: { ...brief.budget, estimatedTokens: estimated, truncated: false } };
  const next = { ...brief, recommendedPmUpdates: brief.recommendedPmUpdates.slice(0, 5), staleContext: brief.staleContext.slice(0, 5), risks: brief.risks.slice(0, 8) };
  estimated = estimateTokens(next);
  if (estimated <= budget) return { ...next, budget: { ...next.budget, estimatedTokens: estimated, truncated: true } };
  const tighter = { ...next, next: next.next.slice(0, 3), blockers: next.blockers.slice(0, 6), focus: next.focus.slice(0, 3), decisionsNeeded: next.decisionsNeeded.slice(0, 3) };
  estimated = estimateTokens(tighter);
  return { ...tighter, budget: { ...tighter.budget, estimatedTokens: estimated, truncated: true } };
}

export function buildBrief(items: PmItem[], options: BriefOptions = {}): AgentBrief {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const now = new Date(generatedAt);
  const rels = items.flatMap(extractRelationships);
  const focus = selectedFocus(items, options).map((item) => toBriefItem(item, rels, items, now));
  const next = selectNextItems(items, options);
  const blockers = rels
    .filter((rel) => rel.kind === "blocked_by" || rel.kind === "depends_on")
    .map((rel) => {
      const blocker = items.find((item) => item.id === rel.to);
      return { itemId: rel.from, blockedBy: rel.to, kind: rel.kind, title: blocker ? titleOf(blocker) : undefined, status: blocker ? statusOf(blocker) : undefined };
    });
  const decisionsNeeded = items
    .filter((item) => !isClosed(item) && typeOf(item).toLowerCase() === "decision")
    .slice(0, 5)
    .map((item) => toBriefItem(item, rels, items, now));
  const staleContext = detectStaleContext(items, options).slice(0, 10);
  const risks = summarizeRisks(items, options).slice(0, 12);
  const recommendedPmUpdates: RecommendedPmUpdate[] = [
    ...staleContext.slice(0, 5).map((finding) => ({
      itemId: finding.itemId,
      command: `pm append ${finding.itemId} "Context refreshed: <summary>"`,
      reason: `${finding.daysStale} day(s) since last update`,
      safeToAutoApply: false,
    })),
    ...blockers.slice(0, 5).map((blocker) => ({
      itemId: blocker.itemId,
      command: `pm deps ${blocker.itemId}`,
      reason: `inspect ${blocker.kind} relationship before changing code`,
      safeToAutoApply: false,
    })),
  ];
  return compactToBudget({
    generatedAt,
    workspace: {
      root: options.pmRoot ?? ".agents/pm",
      pmVersion: options.pmVersion ?? "unknown",
      itemCount: items.length,
    },
    budget: {
      requestedTokens: options.tokenBudget ?? 4000,
      estimatedTokens: 0,
      truncated: false,
    },
    focus,
    next,
    blockers,
    risks,
    staleContext,
    decisionsNeeded,
    recommendedPmUpdates,
  });
}

function escapeLine(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

export function renderMarkdownBrief(brief: AgentBrief): string {
  const lines: string[] = [
    "# pm brief",
    "",
    `Generated: ${brief.generatedAt}`,
    `Workspace: ${brief.workspace.root} | pm ${brief.workspace.pmVersion} | items ${brief.workspace.itemCount}`,
    `Budget: requested ${brief.budget.requestedTokens}, estimated ${brief.budget.estimatedTokens}, truncated ${brief.budget.truncated}`,
    "",
    "## Next Work",
    "",
  ];
  if (brief.next.length === 0) lines.push("_No open work matched the filters._");
  for (const item of brief.next) lines.push(`- ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status}) - ${item.whyNow}`);
  lines.push("", "## Focus", "");
  if (brief.focus.length === 0) lines.push("_No focus items._");
  for (const item of brief.focus) {
    lines.push(`- ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status})`);
    if (item.requiredContext.length > 0) lines.push(`  - context: ${item.requiredContext.join(", ")}`);
  }
  lines.push("", "## Blockers", "");
  if (brief.blockers.length === 0) lines.push("_No visible blockers._");
  for (const blocker of brief.blockers) {
    const label = blocker.title ? `${blocker.blockedBy} ${escapeLine(blocker.title)}` : blocker.blockedBy;
    const status = blocker.status ? ` (${blocker.status})` : "";
    lines.push(`- ${blocker.itemId} ${blocker.kind} ${label}${status}`);
  }
  lines.push("", "## Risks", "");
  if (brief.risks.length === 0) lines.push("_No risks detected from visible pm metadata._");
  for (const risk of brief.risks) lines.push(`- ${risk.severity}: ${risk.itemId} - ${risk.reason}`);
  lines.push("", "## Stale Context", "");
  if (brief.staleContext.length === 0) lines.push("_No stale open items detected._");
  for (const stale of brief.staleContext) lines.push(`- ${stale.itemId}: ${escapeLine(stale.title)} - ${stale.daysStale} day(s) stale`);
  lines.push("", "## Recommended PM Updates", "");
  if (brief.recommendedPmUpdates.length === 0) lines.push("_No update suggestions._");
  for (const update of brief.recommendedPmUpdates) lines.push(`- ${update.itemId}: \`${update.command}\` - ${update.reason}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function readPmItems(pmRoot: string): PmItem[] {
  const result = spawnSync("pm", ["--path", pmRoot, "list-all", "--json", "--include-body"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new CommandError(result.stderr.trim() || "`pm list-all --json --include-body` failed");
  const parsed = JSON.parse(result.stdout);
  const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
  return items.filter((item: unknown): item is PmItem => Boolean(item) && typeof item === "object" && typeof (item as PmItem).id === "string");
}

function pmVersion(): string {
  const result = spawnSync("pm", ["--version"], { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function registerCommands(api: any): void {
  const commonFlags = [
    { long: "--token-budget", value_name: "n", description: "Approximate maximum output token budget (default: 4000)", type: "string" },
    { long: "--focus", value_name: "id", description: "Focus item id (repeatable or comma-separated)", type: "string" },
    { long: "--status", value_name: "status", description: "Statuses to include (comma-separated)", type: "string" },
    { long: "--assignee", value_name: "name", description: "Only include items assigned to this actor", type: "string" },
    { long: "--stale-days", value_name: "n", description: "Days before an open item is stale (default: 7)", type: "string" },
    { long: "--format", value_name: "format", description: "Output format: markdown or json", type: "string" },
    { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    { long: "--include-closed", description: "Allow closed focus items in the brief", type: "boolean" },
  ];
  api.registerCommand({
    name: "brief",
    description: "Generate a token-budgeted agent brief from pm items.",
    intent: "turn pm state into compact next-work context for agents",
    examples: ["pm brief", "pm brief --focus pm-1234 --token-budget 3000", "pm brief --format json"],
    flags: commonFlags,
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? (readBool(options, "json") ? "json" : "markdown")).toLowerCase();
      if (format !== "markdown" && format !== "json") throw new CommandError("--format must be markdown or json", EXIT_CODE.USAGE);
      const brief = buildBrief(readPmItems(ctx.pm_root), {
        tokenBudget: readInt(options, ["token-budget", "tokenBudget"], 4000),
        focusIds: asArray(options.focus),
        statuses: asArray(options.status),
        assignee: readString(options, "assignee"),
        includeClosed: readBool(options, "include-closed", "includeClosed"),
        staleDays: readNonNegativeInt(options, ["stale-days", "staleDays"], 7),
        generatedAt: new Date().toISOString(),
        pmRoot: ctx.pm_root,
        pmVersion: pmVersion(),
      });
      const output = format === "json" ? `${JSON.stringify(brief, null, 2)}\n` : renderMarkdownBrief(brief);
      const outputPath = readString(options, "output");
      if (outputPath) writeFileSync(outputPath, output, "utf-8");
      else console.error(output.trimEnd());
      return format === "json" ? brief : { ok: true, format, next: brief.next.length, risks: brief.risks.length, truncated: brief.budget.truncated };
    },
  });
  api.registerCommand({
    name: "brief next",
    description: "Return ranked next work items from pm state.",
    examples: ["pm brief next --count 5", "pm brief next --format json"],
    flags: [
      { long: "--count", short: "-n", value_name: "n", description: "Number of next items (default: 5)", type: "string" },
      { long: "--assignee", value_name: "name", description: "Only include items assigned to this actor", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: text or json", type: "string" },
    ],
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? "text").toLowerCase();
      if (format !== "text" && format !== "json") throw new CommandError("--format must be text or json", EXIT_CODE.USAGE);
      const next = selectNextItems(readPmItems(ctx.pm_root), {
        nextCount: readInt(options, ["count"], 5),
        assignee: readString(options, "assignee"),
        generatedAt: new Date().toISOString(),
      });
      if (format === "json") {
        console.error(JSON.stringify({ next }, null, 2));
        return { next: next.length, format };
      }
      console.error(next.map((item) => `${item.id}: ${item.title} - ${item.whyNow}`).join("\n"));
      return { next: next.length, format };
    },
  });
  api.registerCommand({
    name: "brief stale",
    description: "List stale open or in-progress pm items.",
    examples: ["pm brief stale --days 14", "pm brief stale --format json"],
    flags: [
      { long: "--days", value_name: "n", description: "Days before an item is stale (default: 7)", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: text or json", type: "string" },
    ],
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? "text").toLowerCase();
      if (format !== "text" && format !== "json") throw new CommandError("--format must be text or json", EXIT_CODE.USAGE);
      const stale = detectStaleContext(readPmItems(ctx.pm_root), {
        staleDays: readNonNegativeInt(options, ["days"], 7),
        generatedAt: new Date().toISOString(),
      });
      if (format === "json") {
        console.error(JSON.stringify({ stale }, null, 2));
        return { stale: stale.length, format };
      }
      console.error(stale.map((item) => `${item.itemId}: ${item.title} - ${item.daysStale} day(s) stale`).join("\n"));
      return { stale: stale.length, format };
    },
  });
}

export default defineExtension({
  name: "pm-brief",
  version: "2026.6.8",
  description: "Token-budgeted agent briefs and next-work plans for pm workspaces",
  activate(api: any) {
    registerCommands(api);
  },
});
