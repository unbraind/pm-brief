import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import type { defineExtension as defineExtensionType } from "@unbrained/pm-cli/sdk";

const defineExtension: typeof defineExtensionType = ((extension: any) => extension) as any;

const PM_EXECUTABLE = process.platform === "win32" ? "pm.cmd" : "pm";
const PM_PATH_OPTION = "--pm-path";
const SAFE_PM_ID = /^[a-zA-Z0-9._-]+$/;

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
  closed_at?: string;
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
  dependencyOrder?: boolean;
  focusIds?: string[];
  focusTypes?: string[];
  statuses?: string[];
  assignee?: string;
  includeClosed?: boolean;
  includeHistory?: boolean;
  historyLimit?: number;
  staleDays?: number;
  completedDays?: number;
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
  rankingScore: number;
  confidence: number;
  rankingReasons: string[];
  requiredContext: string[];
  dependencyIds: string[];
  dependentIds: string[];
  tokenCostEstimate: number;
}

export interface NextItemScoreBreakdown {
  total: number;
  priority: number;
  blocked: number;
  dependencies: number;
  dependents: number;
  active: number;
  stale: number;
  linkedEvidence: number;
  release: number;
  deadline: number;
}

export interface NextItemExplanation {
  rank: number;
  item: BriefItem;
  score: NextItemScoreBreakdown;
  activeDependencies: number;
  activeDependents: number;
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

export interface BriefActivity {
  timestamp: string;
  author?: string;
  operation: string;
  itemId?: string;
  message?: string;
}

export interface MomentumClose {
  id: string;
  title: string;
  type: string;
  closedAt: string;
  cycleDays?: number;
}

export interface MomentumCycleTime {
  sampleSize: number;
  medianDays: number;
  p90Days: number;
}

export interface MomentumSummary {
  windowDays: number;
  closedCount: number;
  byType: Record<string, number>;
  throughputPerDay: number;
  cycleTime?: MomentumCycleTime;
  recent: MomentumClose[];
}

export interface RecommendedPmUpdate {
  itemId: string;
  command: string;
  reason: string;
  safeToAutoApply: boolean;
}

export interface BriefInsight {
  level: "info" | "warning";
  message: string;
  suggestion?: string;
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
  momentum: MomentumSummary;
  recentActivity?: BriefActivity[];
  decisionsNeeded: BriefItem[];
  recommendedPmUpdates: RecommendedPmUpdate[];
  insights?: BriefInsight[];
}

interface Relationship {
  from: string;
  to: string;
  kind: string;
}

interface RankedCandidate {
  item: PmItem;
  rank: RankEvidence;
  score: NextItemScoreBreakdown;
  activeDependencies: number;
  activeDependents: number;
}

interface FocusSelection {
  items: PmItem[];
  missingIds: string[];
  closedExcludedIds: string[];
}

interface RankEvidence {
  score: number;
  confidence: number;
  reasons: string[];
  blocked: boolean;
  activeDependencies: number;
  activeDependents: number;
}

interface RenderedCommandResult {
  pmBriefRendered: true;
  output: string;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function renderedCommandResult(output: string): RenderedCommandResult {
  return { pmBriefRendered: true, output: output.endsWith("\n") ? output : `${output}\n` };
}

function renderCommandResult(context: { result?: unknown }): string | null {
  const result = context.result as Partial<RenderedCommandResult> | null | undefined;
  return result?.pmBriefRendered === true && typeof result.output === "string" ? result.output : null;
}

function asArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(asArray);
  if (typeof value !== "string") return [];
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseFocus(values: string[]): { focusIds: string[]; focusTypes: string[] } {
  const focusIds: string[] = [];
  const focusTypes: string[] = [];
  for (const value of values) {
    const match = /^type\s*:\s*(.+)$/i.exec(value);
    if (match) {
      focusTypes.push(match[1].trim());
    } else {
      focusIds.push(value);
    }
  }
  return { focusIds, focusTypes };
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

function hasVisibleDependencyBlocker(item: PmItem, rels: Relationship[]): boolean {
  return rels.some((rel) => rel.from === item.id && (rel.kind === "blocked_by" || rel.kind === "depends_on"));
}

function ageDays(item: PmItem, now: Date): number {
  const raw = itemUpdatedAt(item);
  if (!raw) return 0;
  const time = Date.parse(raw);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((now.getTime() - time) / 86_400_000));
}

function objectLinkPaths(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return asArray(value);
  if (Array.isArray(value)) return value.flatMap(objectLinkPaths);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const path = text(record.path) || text(record.url) || text(record.href) || text(record.id);
    return path ? [path] : [];
  }
  return [];
}

function linksFor(item: PmItem): string[] {
  return uniqueStrings([...objectLinkPaths(item.docs), ...objectLinkPaths(item.files)]).slice(0, 6);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function isBlockingRelationship(rel: Relationship): boolean {
  return rel.kind === "blocked_by" || rel.kind === "depends_on";
}

function activeItemIds(items: PmItem[]): Set<string> {
  return new Set(items.filter((item) => !isClosed(item)).map((item) => item.id));
}

function deadlineScore(item: PmItem, now: Date): { score: number; reason?: string } {
  if (!item.deadline) return { score: 0 };
  const deadlineTime = Date.parse(item.deadline);
  if (!Number.isFinite(deadlineTime)) return { score: 0 };
  const msUntilDeadline = deadlineTime - now.getTime();
  const daysUntilDeadline = msUntilDeadline < 0 ? Math.floor(msUntilDeadline / 86_400_000) : Math.ceil(msUntilDeadline / 86_400_000);
  if (daysUntilDeadline < 0) {
    return { score: 25, reason: `deadline_overdue:${Math.abs(daysUntilDeadline)}d` };
  }
  if (daysUntilDeadline <= 14) {
    return { score: 20 - daysUntilDeadline, reason: `deadline_soon:${daysUntilDeadline}d` };
  }
  return { score: 0 };
}

function rankItem(item: PmItem, rels: Relationship[], activeIds: Set<string>, now: Date): RankEvidence {
  const reasons: string[] = [];
  let score = 0;
  const priority = typeof item.priority === "number" ? item.priority : 5;
  const priorityScore = Math.max(0, 100 - priority * 15);
  score += priorityScore;
  reasons.push(`priority:${priority}`);

  const deps = activeDependencyCount(item, rels, activeIds);
  const fanout = activeDependentCount(item, rels, activeIds);
  const blocked = deps > 0 && rels.some((rel) => rel.from === item.id && isBlockingRelationship(rel) && activeIds.has(rel.to));
  if (blocked) {
    score -= 80;
    reasons.push(`blocked_by_active_dependency:${deps}`);
  } else {
    score += 45;
    reasons.push("unblocked");
  }
  if (deps > 0) {
    score -= deps * 20;
    reasons.push(`active_dependencies:${deps}`);
  }
  if (fanout > 0) {
    score += fanout * 8;
    reasons.push(`unblocks_dependents:${fanout}`);
  }

  const status = statusOf(item).toLowerCase();
  if (status === "in_progress") {
    score += 20;
    reasons.push("already_in_progress");
  }

  const stale = ageDays(item, now);
  if (stale > 0) {
    score += Math.min(stale, 30) * 1.5;
    reasons.push(`stale_days:${stale}`);
  }

  const links = linksFor(item).length;
  if (links > 0) {
    score += Math.min(links, 4) * 6;
    reasons.push(`linked_evidence:${links}`);
  }

  if (text(item.release)) {
    score += 10;
    reasons.push(`release:${text(item.release)}`);
  }
  const deadline = deadlineScore(item, now);
  if (deadline.reason) {
    score += deadline.score;
    reasons.push(deadline.reason);
  }

  // Baseline 35 means "some pm metadata exists"; reasons, links, and timestamps raise confidence.
  const confidence = Math.max(15, Math.min(100, 35 + reasons.length * 8 + Math.min(links, 4) * 5 + (itemUpdatedAt(item) ? 8 : 0)));
  return { score: Math.round(score), confidence, reasons, blocked, activeDependencies: deps, activeDependents: fanout };
}

function toBriefItem(item: PmItem, rels: Relationship[], allItems: PmItem[], now: Date, activeIds?: Set<string>, rankOverride?: RankEvidence): BriefItem {
  const dependencyIds = uniqueStrings(rels.filter((rel) => rel.from === item.id).map((rel) => rel.to));
  const dependentIds = uniqueStrings(rels.filter((rel) => rel.to === item.id).map((rel) => rel.from));
  const stale = ageDays(item, now);
  const requiredContext = uniqueStrings([
    ...dependencyIds.map((id) => `dependency:${id}`),
    ...dependentIds.map((id) => `dependent:${id}`),
    ...linksFor(item),
  ]).slice(0, 8);
  const priority = typeof item.priority === "number" ? item.priority : undefined;
  const rank = rankOverride ?? rankItem(item, rels, activeIds ?? activeItemIds(allItems), now);
  const whyNow = rank.blocked
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
    rankingScore: rank.score,
    confidence: rank.confidence,
    rankingReasons: rank.reasons,
    requiredContext,
    dependencyIds,
    dependentIds,
    tokenCostEstimate: estimateTokens(compact),
  };
}

function scoreBreakdown(item: PmItem, rels: Relationship[], activeIds: Set<string>, now: Date, rank = rankItem(item, rels, activeIds, now)): NextItemScoreBreakdown {
  const priority = typeof item.priority === "number" ? item.priority : 5;
  const priorityScore = Math.max(0, 100 - priority * 15);
  const blockedScore = rank.blocked ? -80 : 45;
  const dependencyScore = rank.activeDependencies > 0 ? rank.activeDependencies * -20 : 0;
  const dependentScore = rank.activeDependents > 0 ? rank.activeDependents * 8 : 0;
  const activeBoost = statusOf(item).toLowerCase() === "in_progress" ? 20 : 0;
  const staleScore = Math.min(ageDays(item, now), 30) * 1.5;
  const linkedEvidenceScore = Math.min(linksFor(item).length, 4) * 6;
  const releaseScore = text(item.release) ? 10 : 0;
  const deadline = deadlineScore(item, now).score;
  return {
    total: rank.score,
    priority: priorityScore,
    blocked: blockedScore,
    dependencies: dependencyScore,
    dependents: dependentScore,
    active: activeBoost,
    stale: staleScore,
    linkedEvidence: linkedEvidenceScore,
    release: releaseScore,
    deadline,
  };
}

function activeDependencyCount(item: PmItem, rels: Relationship[], activeIds: Set<string>): number {
  return uniqueStrings(rels.filter((rel) => rel.from === item.id && isBlockingRelationship(rel) && activeIds.has(rel.to)).map((rel) => rel.to)).length;
}

function activeDependentCount(item: PmItem, rels: Relationship[], activeIds: Set<string>): number {
  return uniqueStrings(rels.filter((rel) => rel.to === item.id && isBlockingRelationship(rel) && activeIds.has(rel.from)).map((rel) => rel.from)).length;
}

function filterCandidates(items: PmItem[], options: BriefOptions): PmItem[] {
  return items
    .filter((item) => !isClosed(item))
    .filter((item) => !options.assignee || text(item.assignee) === options.assignee)
    .filter((item) => !options.statuses?.length || options.statuses.includes(statusOf(item)));
}

function rankCandidates(items: PmItem[], options: BriefOptions, now: Date, rels: Relationship[], activeIds = activeItemIds(items)): RankedCandidate[] {
  const candidates = filterCandidates(items, options);
  return candidates
    .map((item) => {
      const rank = rankItem(item, rels, activeIds, now);
      return {
        item,
        rank,
        score: scoreBreakdown(item, rels, activeIds, now, rank),
        activeDependencies: rank.activeDependencies,
        activeDependents: rank.activeDependents,
      };
    })
    .sort((a, b) => {
      if (options.dependencyOrder) {
        if (a.activeDependencies !== b.activeDependencies) return a.activeDependencies - b.activeDependencies;
        if (a.activeDependents !== b.activeDependents) return b.activeDependents - a.activeDependents;
      }
      return b.score.total - a.score.total || itemUpdatedAt(b.item).localeCompare(itemUpdatedAt(a.item)) || a.item.id.localeCompare(b.item.id);
    });
}

export function selectNextItems(items: PmItem[], options: BriefOptions = {}): BriefItem[] {
  const now = new Date(options.generatedAt ?? Date.now());
  const rels = items.flatMap(extractRelationships);
  const activeIds = activeItemIds(items);
  return rankCandidates(items, options, now, rels, activeIds)
    .slice(0, options.nextCount ?? 5)
    .map((candidate) => toBriefItem(candidate.item, rels, items, now, activeIds, candidate.rank));
}

export function explainNextItems(items: PmItem[], options: BriefOptions = {}): NextItemExplanation[] {
  const now = new Date(options.generatedAt ?? Date.now());
  const rels = items.flatMap(extractRelationships);
  const activeIds = activeItemIds(items);
  return rankCandidates(items, options, now, rels, activeIds)
    .slice(0, options.nextCount ?? 5)
    .map((candidate, index) => ({
      rank: index + 1,
      item: toBriefItem(candidate.item, rels, items, now, activeIds, candidate.rank),
      score: candidate.score,
      activeDependencies: candidate.activeDependencies,
      activeDependents: candidate.activeDependents,
    }));
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

function itemClosedAt(item: PmItem): string {
  // pm-cli 2026.7.11+ stamps closed_at when an item is closed. Older builds
  // never recorded a dedicated close timestamp, so fall back to updated_at
  // (typically the close operation was the last write for a closed item).
  // Deliberately do NOT fall back to created_at: without a real close signal
  // we cannot place the item in the momentum window, and using created_at
  // would inject a spurious 0-day cycle time. Such items are excluded instead.
  return text(item.closed_at) || text(item.updated_at);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function summarizeMomentum(items: PmItem[], options: BriefOptions = {}): MomentumSummary {
  const now = new Date(options.generatedAt ?? Date.now());
  const windowDays = Math.max(0, options.completedDays ?? 7);
  const cutoff = now.getTime() - windowDays * 86_400_000;
  const closed = items
    .filter((item) => isClosed(item))
    .map((item) => {
      const closedRaw = itemClosedAt(item);
      return { item, closedRaw, closedTime: Date.parse(closedRaw) };
    })
    .filter(({ closedTime }) => Number.isFinite(closedTime) && closedTime >= cutoff && closedTime <= now.getTime())
    .sort((a, b) => b.closedTime - a.closedTime || a.item.id.localeCompare(b.item.id));

  // Object.create(null): item types are user-controlled, so a type literally
  // named "toString"/"hasOwnProperty" must not collide with Object.prototype.
  const byType: Record<string, number> = Object.create(null);
  const cycleDaysList: number[] = [];
  const recent: MomentumClose[] = [];
  for (const { item, closedRaw, closedTime } of closed) {
    const type = typeOf(item);
    byType[type] = (byType[type] ?? 0) + 1;
    const createdTime = Date.parse(text(item.created_at));
    let cycleDays: number | undefined;
    if (Number.isFinite(createdTime) && closedTime >= createdTime) {
      cycleDays = round1((closedTime - createdTime) / 86_400_000);
      cycleDaysList.push(cycleDays);
    }
    if (recent.length < 5) {
      recent.push({ id: item.id, title: titleOf(item), type, closedAt: closedRaw, cycleDays });
    }
  }
  const throughputPerDay = windowDays > 0 ? Math.round((closed.length / windowDays) * 100) / 100 : 0;
  const cycleTime: MomentumCycleTime | undefined = cycleDaysList.length > 0
    ? { sampleSize: cycleDaysList.length, medianDays: round1(median(cycleDaysList)), p90Days: round1(percentile(cycleDaysList, 90)) }
    : undefined;
  return { windowDays, closedCount: closed.length, byType, throughputPerDay, cycleTime, recent };
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

function selectedFocus(items: PmItem[], options: BriefOptions): FocusSelection {
  const requestedIds = Array.from(new Set(options.focusIds ?? []));
  const requestedTypes = Array.from(new Set((options.focusTypes ?? []).map((entry) => entry.toLowerCase())));
  if (requestedIds.length === 0 && requestedTypes.length === 0) {
    const derived = selectNextItems(items, { ...options, nextCount: 3 })
      .map((next) => items.find((item) => item.id === next.id))
      .filter((item): item is PmItem => Boolean(item));
    return {
      items: derived,
      missingIds: [],
      closedExcludedIds: [],
    };
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const missingIds = requestedIds.filter((id) => !byId.has(id));
  const closedExcludedIds: string[] = [];
  const seenIds = new Set<string>();
  const selected: PmItem[] = [];
  const keep = (item: PmItem, explicitId = false): void => {
    if (seenIds.has(item.id)) return;
    if (options.includeClosed || !isClosed(item)) {
      seenIds.add(item.id);
      selected.push(item);
    } else if (explicitId) {
      closedExcludedIds.push(item.id);
    }
  };
  for (const id of requestedIds) {
    const item = byId.get(id);
    if (item) keep(item, true);
  }
  if (requestedTypes.length > 0) {
    for (const item of items) {
      if (requestedTypes.includes(typeOf(item).toLowerCase())) keep(item);
    }
  }
  return {
    items: selected,
    missingIds,
    closedExcludedIds,
  };
}

function summarizeIds(ids: string[]): string {
  const shown = ids.slice(0, 3);
  const suffix = ids.length > shown.length ? ` (+${ids.length - shown.length} more)` : "";
  return `${shown.join(", ")}${suffix}`;
}

function describeFilters(options: BriefOptions): string {
  const parts: string[] = [];
  if (options.assignee) parts.push(`assignee=${options.assignee}`);
  if (options.statuses?.length) parts.push(`status=${options.statuses.join(",")}`);
  return parts.join(", ");
}

function buildInsights(items: PmItem[], options: BriefOptions, focusSelection: FocusSelection, next: BriefItem[]): BriefInsight[] {
  const insights: BriefInsight[] = [];
  if (focusSelection.missingIds.length > 0) {
    insights.push({
      level: "warning",
      message: `requested focus id(s) were not found: ${summarizeIds(focusSelection.missingIds)}`,
      suggestion: SAFE_PM_ID.test(focusSelection.missingIds[0]!) ? `pm get ${focusSelection.missingIds[0]}` : undefined,
    });
  }
  if (focusSelection.closedExcludedIds.length > 0) {
    insights.push({
      level: "info",
      message: `closed focus item(s) were omitted: ${summarizeIds(focusSelection.closedExcludedIds)}`,
      suggestion: "pm brief --include-closed --format markdown",
    });
  }
  const openItems = items.filter((item) => !isClosed(item));
  const candidates = filterCandidates(items, options);
  if (next.length === 0) {
    if (openItems.length === 0) {
      insights.push({
        level: "info",
        message: "no open work items are available in this workspace",
        suggestion: "pm list-open --limit 20",
      });
    } else if (options.assignee || options.statuses?.length) {
      const activeFilters = describeFilters(options);
      const filterSuffix = activeFilters ? ` (${activeFilters})` : "";
      insights.push({
        level: "warning",
        message: `no open work matched filters${filterSuffix}`,
        suggestion: "pm brief --format markdown",
      });
    }
  } else if (candidates.length < Math.min(options.nextCount ?? 5, openItems.length) && (options.assignee || options.statuses?.length)) {
    const activeFilters = describeFilters(options);
    const filterSuffix = activeFilters ? ` (${activeFilters})` : "";
    insights.push({
      level: "info",
      message: `filters narrowed next-work candidates to ${candidates.length} item(s)${filterSuffix}`,
    });
  }
  return insights;
}

function compactToBudget(brief: AgentBrief): AgentBrief {
  const budget = brief.budget.requestedTokens;
  let estimated = estimateTokens(brief);
  if (estimated <= budget) return { ...brief, budget: { ...brief.budget, estimatedTokens: estimated, truncated: false } };
  const next = {
    ...brief,
    insights: brief.insights?.slice(0, 4),
    recommendedPmUpdates: brief.recommendedPmUpdates.slice(0, 5),
    staleContext: brief.staleContext.slice(0, 5),
    risks: brief.risks.slice(0, 8),
    momentum: { ...brief.momentum, recent: brief.momentum.recent.slice(0, 3) },
    recentActivity: brief.recentActivity?.slice(0, 8),
  };
  estimated = estimateTokens(next);
  if (estimated <= budget) return { ...next, budget: { ...next.budget, estimatedTokens: estimated, truncated: true } };
  const tighter = {
    ...next,
    insights: next.insights?.slice(0, 2),
    next: next.next.slice(0, 3),
    blockers: next.blockers.slice(0, 6),
    focus: next.focus.slice(0, 3),
    decisionsNeeded: next.decisionsNeeded.slice(0, 3),
    momentum: { ...next.momentum, recent: next.momentum.recent.slice(0, 2) },
    recentActivity: next.recentActivity?.slice(0, 5),
  };
  estimated = estimateTokens(tighter);
  return { ...tighter, budget: { ...tighter.budget, estimatedTokens: estimated, truncated: true } };
}

export function buildBrief(items: PmItem[], options: BriefOptions = {}): AgentBrief {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const now = new Date(generatedAt);
  const rels = items.flatMap(extractRelationships);
  const activeIds = activeItemIds(items);
  const focusSelection = selectedFocus(items, options);
  const focus = focusSelection.items.map((item) => toBriefItem(item, rels, items, now, activeIds));
  const next = selectNextItems(items, options);
  const insights = buildInsights(items, options, focusSelection, next);
  const blockers = rels
    .filter((rel) => rel.kind === "blocked_by" || rel.kind === "depends_on")
    .map((rel) => {
      const blocker = items.find((item) => item.id === rel.to);
      return { itemId: rel.from, blockedBy: rel.to, kind: rel.kind, title: blocker ? titleOf(blocker) : undefined, status: blocker ? statusOf(blocker) : undefined };
    });
  const decisionsNeeded = items
    .filter((item) => !isClosed(item) && typeOf(item).toLowerCase() === "decision")
    .slice(0, 5)
    .map((item) => toBriefItem(item, rels, items, now, activeIds));
  const staleContext = detectStaleContext(items, options).slice(0, 10);
  const momentum = summarizeMomentum(items, options);
  const risks = summarizeRisks(items, options).slice(0, 12);
  const recentActivity = options.includeHistory ? readRecentActivity(options.pmRoot ?? ".agents/pm", options.historyLimit ?? 10) : undefined;
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
    momentum,
    recentActivity,
    decisionsNeeded,
    recommendedPmUpdates,
    insights,
  });
}

function escapeLine(value: unknown): string {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function formatScoreValue(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1).replace(/\.0$/, "");
}

function formatSignedScoreValue(value: number): string {
  if (value === 0) return "0";
  const abs = formatScoreValue(Math.abs(value));
  return `${value > 0 ? "+" : "-"}${abs}`;
}

function renderNextExplanationLine(entry: NextItemExplanation): string {
  return `${entry.rank}. ${entry.item.id}: ${escapeLine(entry.item.title)} - ${entry.item.whyNow} [score ${formatScoreValue(entry.item.rankingScore)}; confidence ${entry.item.confidence}; evidence ${entry.item.rankingReasons.join(", ")}; deps ${entry.activeDependencies}, dependents ${entry.activeDependents}]`;
}

export function renderMarkdownBrief(brief: AgentBrief): string {
  const lines: string[] = [
    "# pm brief",
    "",
    `Generated: ${brief.generatedAt}`,
    `Workspace: ${brief.workspace.root} | pm ${brief.workspace.pmVersion} | items ${brief.workspace.itemCount}`,
    `Budget: requested ${brief.budget.requestedTokens}, estimated ${brief.budget.estimatedTokens}, truncated ${brief.budget.truncated}`,
    "",
  ];
  if (brief.insights?.length) {
    lines.push("## Brief Insights", "");
    for (const insight of brief.insights) {
      const suggestion = insight.suggestion ? ` | suggestion: \`${insight.suggestion}\`` : "";
      lines.push(`- ${insight.level}: ${escapeLine(insight.message)}${suggestion}`);
    }
    lines.push("");
  }
  lines.push("## Next Work", "");
  if (brief.next.length === 0) lines.push("_No open work matched the filters._");
  for (const item of brief.next) lines.push(`- ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status}) - ${item.whyNow}; score ${item.rankingScore}; confidence ${item.confidence}`);
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
  lines.push("", "## Momentum", "");
  const momentum = brief.momentum;
  if (momentum.closedCount === 0) {
    lines.push(`_No items closed in the last ${momentum.windowDays} day(s)._`);
  } else {
    const byType = Object.entries(momentum.byType).map(([type, count]) => `${type} ${count}`).join(", ");
    lines.push(`- Closed ${momentum.closedCount} item(s) in the last ${momentum.windowDays} day(s)${byType ? ` (${byType})` : ""}`);
    lines.push(`- Throughput: ${String(momentum.throughputPerDay)} item(s)/day`);
    if (momentum.cycleTime) {
      lines.push(`- Cycle time: median ${formatScoreValue(momentum.cycleTime.medianDays)}d, p90 ${formatScoreValue(momentum.cycleTime.p90Days)}d (n=${momentum.cycleTime.sampleSize})`);
    }
    for (const close of momentum.recent) {
      const cycle = close.cycleDays !== undefined ? ` - ${formatScoreValue(close.cycleDays)}d cycle` : "";
      lines.push(`  - ${close.id}: ${escapeLine(close.title)} (${close.type})${cycle}`);
    }
  }
  if (brief.recentActivity?.length) {
    lines.push("", "## Recent Activity", "");
    for (const entry of brief.recentActivity) {
      const who = entry.author ? ` by ${entry.author}` : "";
      const itemPart = entry.itemId ? ` ${entry.itemId}` : "";
      const msg = entry.message ? ` - ${escapeLine(entry.message)}` : "";
      lines.push(`- ${entry.timestamp}${who} ${entry.operation}${itemPart}${msg}`);
    }
  }
  lines.push("", "## Recommended PM Updates", "");
  if (brief.recommendedPmUpdates.length === 0) lines.push("_No update suggestions._");
  for (const update of brief.recommendedPmUpdates) lines.push(`- ${update.itemId}: \`${update.command}\` - ${update.reason}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderSlackBrief(brief: AgentBrief): string {
  const header = `*pm brief* — ${brief.generatedAt}`;
  const meta = `_${brief.workspace.root} | pm ${brief.workspace.pmVersion} | items ${brief.workspace.itemCount}_ (budget ${brief.budget.requestedTokens} ≈ ${brief.budget.estimatedTokens}${brief.budget.truncated ? ", trimmed" : ""})`;
  const lines: string[] = [header, meta, ""];
  if (brief.insights?.length) {
    lines.push("*Brief Insights*");
    for (const insight of brief.insights) {
      const suggestion = insight.suggestion ? ` — \`${insight.suggestion}\`` : "";
      lines.push(`• ${insight.level}: ${escapeLine(insight.message)}${suggestion}`);
    }
    lines.push("");
  }
  lines.push("*Next Work*");
  if (brief.next.length === 0) lines.push("_No open work matched the filters._");
  for (const item of brief.next) lines.push(`• \`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status}) — ${item.whyNow}; score ${item.rankingScore}; confidence ${item.confidence}`);
  lines.push("", "*Focus*");
  if (brief.focus.length === 0) lines.push("_No focus items._");
  for (const item of brief.focus) {
    const context = item.requiredContext.length > 0 ? ` — context: ${item.requiredContext.join(", ")}` : "";
    lines.push(`• \`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status})${context}`);
  }
  lines.push("", "*Blockers*");
  if (brief.blockers.length === 0) lines.push("_No visible blockers._");
  for (const blocker of brief.blockers) {
    const label = blocker.title ? ` ${escapeLine(blocker.title)}` : "";
    const status = blocker.status ? ` (${blocker.status})` : "";
    lines.push(`• \`${blocker.itemId}\` ${blocker.kind} \`${blocker.blockedBy}\`${label}${status}`);
  }
  lines.push("", "*Risks*");
  if (brief.risks.length === 0) lines.push("_No risks detected from visible pm metadata._");
  for (const risk of brief.risks) lines.push(`• ${risk.severity}: \`${risk.itemId}\` — ${risk.reason}`);
  lines.push("", "*Stale Context*");
  if (brief.staleContext.length === 0) lines.push("_No stale open items detected._");
  for (const stale of brief.staleContext) {
    lines.push(`• \`${stale.itemId}\` ${escapeLine(stale.title)} — ${stale.daysStale} day(s) stale`);
  }
  lines.push("", "*Momentum*");
  const momentum = brief.momentum;
  if (momentum.closedCount === 0) {
    lines.push(`_No items closed in the last ${momentum.windowDays} day(s)._`);
  } else {
    const byType = Object.entries(momentum.byType).map(([type, count]) => `${type} ${count}`).join(", ");
    lines.push(`• Closed ${momentum.closedCount} item(s) in the last ${momentum.windowDays} day(s)${byType ? ` (${byType})` : ""}`);
    lines.push(`• Throughput: ${String(momentum.throughputPerDay)} item(s)/day`);
    if (momentum.cycleTime) {
      lines.push(`• Cycle time: median ${formatScoreValue(momentum.cycleTime.medianDays)}d, p90 ${formatScoreValue(momentum.cycleTime.p90Days)}d (n=${momentum.cycleTime.sampleSize})`);
    }
    for (const close of momentum.recent) {
      const cycle = close.cycleDays !== undefined ? ` — ${formatScoreValue(close.cycleDays)}d cycle` : "";
      lines.push(`• \`${close.id}\` ${escapeLine(close.title)} (${close.type})${cycle}`);
    }
  }
  if (brief.recentActivity?.length) {
    lines.push("", "*Recent Activity*");
    for (const entry of brief.recentActivity) {
      const who = entry.author ? ` by ${entry.author}` : "";
      const itemPart = entry.itemId ? ` \`${entry.itemId}\`` : "";
      const msg = entry.message ? ` — ${escapeLine(entry.message)}` : "";
      lines.push(`• ${entry.timestamp}${who} ${entry.operation}${itemPart}${msg}`);
    }
  }
  lines.push("", "*Recommended PM Updates*");
  if (brief.recommendedPmUpdates.length === 0) lines.push("_No update suggestions._");
  for (const update of brief.recommendedPmUpdates) lines.push(`• \`${update.itemId}\` \`${update.command}\` — ${update.reason}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderAgentPrompt(brief: AgentBrief): string {
  const lines: string[] = [
    "You are continuing work in a pm-managed project.",
    "",
    "Use pm as the source of truth. Before editing, inspect the listed item(s), keep pm history current, and update or close items with concrete evidence after verification.",
    "",
    "Context budget:",
    `- requested=${brief.budget.requestedTokens} estimated=${brief.budget.estimatedTokens} truncated=${brief.budget.truncated}`,
    `- workspace=${brief.workspace.root} pm=${brief.workspace.pmVersion} items=${brief.workspace.itemCount}`,
    "",
    "Next work:",
  ];
  if (brief.next.length === 0) lines.push("- No open work matched the filters.");
  for (const item of brief.next) {
    lines.push(`- ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status}) because ${item.whyNow}; score=${item.rankingScore}; confidence=${item.confidence}`);
  }
  lines.push("", "Focus context:");
  if (brief.focus.length === 0) lines.push("- No explicit focus item.");
  for (const item of brief.focus.slice(0, 5)) {
    const context = item.requiredContext.length > 0 ? ` context=${item.requiredContext.join(",")}` : "";
    lines.push(`- ${item.id}: ${escapeLine(item.title)}${context}`);
  }
  lines.push("", "Blockers and risks:");
  if (brief.blockers.length === 0 && brief.risks.length === 0) lines.push("- No visible blockers or metadata risks.");
  for (const blocker of brief.blockers.slice(0, 5)) {
    const label = blocker.title ? `${blocker.blockedBy} ${escapeLine(blocker.title)}` : blocker.blockedBy;
    lines.push(`- blocker: ${blocker.itemId} ${blocker.kind} ${label}`);
  }
  for (const risk of brief.risks.slice(0, 5)) {
    lines.push(`- ${risk.severity} risk: ${risk.itemId} ${risk.reason}`);
  }
  lines.push("", "Suggested pm commands:");
  if (brief.recommendedPmUpdates.length === 0) lines.push("- No suggested pm updates.");
  for (const update of brief.recommendedPmUpdates.slice(0, 5)) {
    lines.push(`- ${update.command} # ${update.reason}`);
  }
  if (brief.recentActivity?.length) {
    lines.push("", "Recent activity:");
    for (const entry of brief.recentActivity.slice(0, 5)) {
      const who = entry.author ? ` by ${entry.author}` : "";
      const itemPart = entry.itemId ? ` ${entry.itemId}` : "";
      const msg = entry.message ? ` - ${escapeLine(entry.message)}` : "";
      lines.push(`- ${entry.timestamp}${who} ${entry.operation}${itemPart}${msg}`);
    }
  }
  if (brief.momentum.closedCount > 0) {
    const m = brief.momentum;
    const cycle = m.cycleTime ? `, median cycle ${formatScoreValue(m.cycleTime.medianDays)}d (p90 ${formatScoreValue(m.cycleTime.p90Days)}d)` : "";
    lines.push("", "Recent momentum:");
    lines.push(`- Closed ${m.closedCount} item(s) in the last ${m.windowDays} day(s); throughput ${String(m.throughputPerDay)}/day${cycle}.`);
  }
  lines.push("", "Working rules:");
  lines.push("- Do not assume context outside pm items and linked files.");
  lines.push("- Prefer the highest-ranked unblocked prerequisite before dependent work.");
  lines.push("- Record meaningful decisions, tests, and blockers in pm before handing off.");
  return `${lines.join("\n")}\n`;
}

export function readPmItems(pmRoot: string): PmItem[] {
  const result = spawnSync(PM_EXECUTABLE, [PM_PATH_OPTION, pmRoot, "list-all", "--json", "--include-body"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new CommandError(result.stderr?.trim() || result.error?.message || "`pm list-all --json --include-body` failed");
  }
  const parsed = JSON.parse(result.stdout);
  const items = Array.isArray(parsed) ? parsed : parsed.items ?? parsed.results ?? [];
  return items.filter((item: unknown): item is PmItem => Boolean(item) && typeof item === "object" && typeof (item as PmItem).id === "string");
}

function pmVersion(): string {
  const result = spawnSync(PM_EXECUTABLE, ["--version"], { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

export function readRecentActivity(pmRoot: string, limit = 10): BriefActivity[] {
  const safeLimit = Math.max(1, Math.min(limit, 100));
  const result = spawnSync(PM_EXECUTABLE, [PM_PATH_OPTION, pmRoot, "activity", "--json", "--compact", "--limit", String(safeLimit)], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const entries = (parsed as { compact_activity?: unknown[] })?.compact_activity ?? (parsed as { activity?: unknown[] })?.activity ?? [];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const timestamp = text(record.ts) || text(record.timestamp);
      if (!timestamp) return null;
      return {
        timestamp,
        author: text(record.author) || undefined,
        operation: text(record.op) || text(record.operation) || "activity",
        itemId: text(record.id) || text(record.item_id) || undefined,
        message: text(record.msg) || text(record.message) || undefined,
      } as BriefActivity;
    })
    .filter((entry): entry is BriefActivity => Boolean(entry))
    .slice(0, safeLimit);
}

function registerCommands(api: any): void {
  const commonFlags = [
    { long: "--token-budget", value_name: "n", description: "Approximate maximum output token budget (alias: --max-tokens; default: 4000 for brief, 2500 for prompt)", type: "string" },
    { long: "--max-tokens", value_name: "n", description: "Alias for --token-budget (default: 4000 for brief, 2500 for prompt)", type: "string" },
    { long: "--focus", value_name: "id|type:Type", description: "Focus item id or 'type:Type' to highlight all items of a type (repeatable or comma-separated)", type: "string" },
    { long: "--status", value_name: "status", description: "Statuses to include (comma-separated)", type: "string" },
    { long: "--assignee", value_name: "name", description: "Only include items assigned to this actor", type: "string" },
    { long: "--stale-days", value_name: "n", description: "Days before an open item is stale (default: 7)", type: "string" },
    { long: "--completed-days", value_name: "n", description: "Window in days for the momentum/velocity summary (default: 7)", type: "string" },
    { long: "--dependency-order", description: "Prefer prerequisite work before dependents in next-work ranking", type: "boolean" },
    { long: "--format", value_name: "format", description: "Output format: markdown, json, or slack", type: "string" },
    { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    { long: "--include-closed", description: "Allow closed focus items in the brief", type: "boolean" },
    { long: "--include-history", description: "Include recent pm activity in the brief", type: "boolean" },
    { long: "--history-limit", value_name: "n", description: "Number of recent activity entries to include (default: 10)", type: "string" },
  ];
  api.registerCommand({
    name: "brief",
    description: "Generate a token-budgeted agent brief from pm items.",
    intent: "turn pm state into compact next-work context for agents",
    examples: ["pm brief", "pm brief --focus pm-1234 --max-tokens 3000", "pm brief --dependency-order --format json"],
    flags: commonFlags,
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? (readBool(options, "json") ? "json" : "markdown")).toLowerCase();
      if (format !== "markdown" && format !== "json" && format !== "slack") throw new CommandError("--format must be markdown, json, or slack", EXIT_CODE.USAGE);
      const { focusIds, focusTypes } = parseFocus(asArray(options.focus));
      const includeHistory = readBool(options, "include-history", "includeHistory");
      const historyLimit = readInt(options, ["history-limit", "historyLimit"], 10);
      const brief = buildBrief(readPmItems(ctx.pm_root), {
        tokenBudget: readInt(options, ["token-budget", "tokenBudget", "max-tokens", "maxTokens"], 4000),
        dependencyOrder: readBool(options, "dependency-order", "dependencyOrder"),
        focusIds,
        focusTypes,
        statuses: asArray(options.status),
        assignee: readString(options, "assignee"),
        includeClosed: readBool(options, "include-closed", "includeClosed"),
        includeHistory,
        historyLimit,
        staleDays: readNonNegativeInt(options, ["stale-days", "staleDays"], 7),
        completedDays: readInt(options, ["completed-days", "completedDays"], 7),
        generatedAt: new Date().toISOString(),
        pmRoot: ctx.pm_root,
        pmVersion: pmVersion(),
      });
      const output = format === "json" ? `${JSON.stringify(brief, null, 2)}\n` : format === "slack" ? renderSlackBrief(brief) : renderMarkdownBrief(brief);
      const outputPath = readString(options, "output");
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format, output: outputPath, next: brief.next.length, risks: brief.risks.length, truncated: brief.budget.truncated };
      }
      return renderedCommandResult(output);
    },
  });
  api.registerCommand({
    name: "brief prompt",
    description: "Render a compact copy-pasteable agent handoff prompt from pm state.",
    intent: "turn pm state into executable next-turn instructions for coding agents",
    examples: ["pm brief prompt", "pm brief prompt --focus pm-1234 --max-tokens 2000", "pm brief prompt --dependency-order --output HANDOFF.md"],
    flags: commonFlags.filter((flag) => flag.long !== "--format"),
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const { focusIds, focusTypes } = parseFocus(asArray(options.focus));
      const includeHistory = readBool(options, "include-history", "includeHistory");
      const historyLimit = readInt(options, ["history-limit", "historyLimit"], 10);
      const brief = buildBrief(readPmItems(ctx.pm_root), {
        tokenBudget: readInt(options, ["token-budget", "tokenBudget", "max-tokens", "maxTokens"], 2500),
        dependencyOrder: readBool(options, "dependency-order", "dependencyOrder"),
        focusIds,
        focusTypes,
        statuses: asArray(options.status),
        assignee: readString(options, "assignee"),
        includeClosed: readBool(options, "include-closed", "includeClosed"),
        includeHistory,
        historyLimit,
        staleDays: readNonNegativeInt(options, ["stale-days", "staleDays"], 7),
        completedDays: readInt(options, ["completed-days", "completedDays"], 7),
        generatedAt: new Date().toISOString(),
        pmRoot: ctx.pm_root,
        pmVersion: pmVersion(),
      });
      const output = renderAgentPrompt(brief);
      const outputPath = readString(options, "output");
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format: "prompt", output: outputPath, next: brief.next.length, risks: brief.risks.length, truncated: brief.budget.truncated };
      }
      return renderedCommandResult(output);
    },
  });
  api.registerCommand({
    name: "brief next",
    description: "Return ranked next work items from pm state.",
    examples: ["pm brief next --count 5", "pm brief next --dependency-order --format json"],
    flags: [
      { long: "--count", short: "-n", value_name: "n", description: "Number of next items (default: 5)", type: "string" },
      { long: "--assignee", value_name: "name", description: "Only include items assigned to this actor", type: "string" },
      { long: "--dependency-order", description: "Prefer prerequisite work before dependents", type: "boolean" },
      { long: "--explain", description: "Include compact ranking evidence in text output", type: "boolean" },
      { long: "--confidence", description: "Include ranking confidence in text output", type: "boolean" },
      { long: "--format", value_name: "format", description: "Output format: text or json", type: "string" },
    ],
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? "text").toLowerCase();
      if (format !== "text" && format !== "json") throw new CommandError("--format must be text or json", EXIT_CODE.USAGE);
      const nextOptions: BriefOptions = {
        nextCount: readInt(options, ["count"], 5),
        assignee: readString(options, "assignee"),
        dependencyOrder: readBool(options, "dependency-order", "dependencyOrder"),
        generatedAt: new Date().toISOString(),
      };
      const allItems = readPmItems(ctx.pm_root);
      const explain = readBool(options, "explain");
      const confidence = readBool(options, "confidence");
      const explained = explain ? explainNextItems(allItems, nextOptions) : [];
      const next = explain ? explained.map((entry) => entry.item) : selectNextItems(allItems, nextOptions);
      if (format === "json") {
        const payload = explain ? { next, explanations: explained } : { next };
        return renderedCommandResult(`${JSON.stringify(payload, null, 2)}\n`);
      }
      const textOutput = explain
        ? explained.map((entry) => renderNextExplanationLine(entry)).join("\n")
        : next.map((item) => {
          const parts = [`${item.id}: ${escapeLine(item.title)} - ${item.whyNow}`, `score ${item.rankingScore}`];
          if (confidence) parts.push(`confidence ${item.confidence}`);
          return parts.join(" | ");
        }).join("\n");
      return renderedCommandResult(`${textOutput}\n`);
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
        return renderedCommandResult(`${JSON.stringify({ stale }, null, 2)}\n`);
      }
      return renderedCommandResult(`${stale.map((item) => `${item.itemId}: ${escapeLine(item.title)} - ${item.daysStale} day(s) stale`).join("\n")}\n`);
    },
  });
  api.registerCommand({
    name: "brief momentum",
    description: "Summarize recently closed pm items with throughput and cycle time.",
    intent: "give agents velocity context (what shipped, how fast) for planning decisions",
    examples: ["pm brief momentum", "pm brief momentum --days 14", "pm brief momentum --format json"],
    flags: [
      { long: "--days", value_name: "n", description: "Window in days for closed-item lookback (default: 7)", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: text or json", type: "string" },
    ],
    async run(ctx: any) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? "text").toLowerCase();
      if (format !== "text" && format !== "json") throw new CommandError("--format must be text or json", EXIT_CODE.USAGE);
      const momentum = summarizeMomentum(readPmItems(ctx.pm_root), {
        completedDays: readInt(options, ["days"], 7),
        generatedAt: new Date().toISOString(),
      });
      if (format === "json") {
        return renderedCommandResult(`${JSON.stringify({ momentum }, null, 2)}\n`);
      }
      const lines: string[] = [];
      if (momentum.closedCount === 0) {
        lines.push(`No items closed in the last ${momentum.windowDays} day(s).`);
      } else {
        const byType = Object.entries(momentum.byType).map(([type, count]) => `${type} ${count}`).join(", ");
        lines.push(`Closed ${momentum.closedCount} item(s) in the last ${momentum.windowDays} day(s)${byType ? ` (${byType})` : ""}`);
        lines.push(`Throughput: ${String(momentum.throughputPerDay)} item(s)/day`);
        if (momentum.cycleTime) {
          lines.push(`Cycle time: median ${formatScoreValue(momentum.cycleTime.medianDays)}d, p90 ${formatScoreValue(momentum.cycleTime.p90Days)}d (n=${momentum.cycleTime.sampleSize})`);
        }
        for (const close of momentum.recent) {
          const cycle = close.cycleDays !== undefined ? ` - ${formatScoreValue(close.cycleDays)}d cycle` : "";
          lines.push(`  ${close.id}: ${escapeLine(close.title)} (${close.type})${cycle}`);
        }
      }
      return renderedCommandResult(`${lines.join("\n")}\n`);
    },
  });
}

export default defineExtension({
  name: "pm-brief",
  version: "2026.7.11",
  description: "Token-budgeted agent briefs and next-work plans for pm workspaces",
  activate(api: any) {
    registerCommands(api);
    if (typeof api.registerRenderer === "function") {
      api.registerRenderer("toon", renderCommandResult);
      api.registerRenderer("json", renderCommandResult);
    }
  },
});
