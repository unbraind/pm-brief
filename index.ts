import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve as pathResolve, relative as pathRelative, sep as pathSep, isAbsolute as pathIsAbsolute } from "node:path";
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import type { ExtensionApi, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";
import { findSimilarItems } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, SimilarItemMatch, ItemMetadata } from "@unbrained/pm-cli/sdk";
import {
  findDuplicateClusters,
  scanStaleInProgressItems,
  scanStorageIntegrity,
  scanMutationSecrets,
} from "@unbrained/pm-cli/sdk/governance";
import type {
  DuplicateCluster,
  SecretGuardFinding,
  StorageIntegrityScanResult,
  StaleInProgressScan,
} from "@unbrained/pm-cli/sdk/governance";
import { listMergeReceipts, findGitWorkspaceRoot } from "@unbrained/pm-cli/sdk/merge";
import type { MergeDecisionReceipt, MergePreferredSide } from "@unbrained/pm-cli/sdk/merge";
import { readSettings, resolveItemTypeRegistry } from "@unbrained/pm-cli/sdk";

export type { SimilarItemMatch } from "@unbrained/pm-cli/sdk";
export type {
  DuplicateCluster,
  SecretGuardFinding,
  StorageIntegrityScanResult,
  StaleInProgressScan,
} from "@unbrained/pm-cli/sdk/governance";
export type { MergeDecisionReceipt, MergePreferredSide } from "@unbrained/pm-cli/sdk/merge";

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
  /**
   * Canonical ranked item ids from `pm next` (recommended → ready → blocked).
   * When present, `next`/`brief next` order candidates by this list so both
   * commands agree with `pm next` on the top-ranked item; the local evidence
   * scorer is still computed for `--explain` breakdowns and is used as the
   * deterministic tiebreak for any candidate `pm next` did not rank.
   */
  nextOrder?: string[];
  /** Pre-collected governance findings from sdk/governance scanners; when omitted the brief carries no governance section. */
  governance?: GovernanceSummary;
  /** Pre-collected pending merge-decision receipts; when omitted or empty the brief carries no merge-decisions section. */
  mergeDecisions?: MergeDecisionsSummary;
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
  /**
   * True when this item has a pending merge-decision receipt in this clone — a
   * peer agent's scalar edit was discarded by the field-aware merge driver and
   * is not yet represented in committed history, so the item's context is
   * compromised. Rendered as an inline `\u26a0 merge` marker.
   */
  mergeCompromised?: boolean;
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
  /** Governance findings from sdk/governance scanners; present when the brief collected them. */
  governance?: GovernanceSummary;
  /** Pending merge-decision receipts; present only when there is at least one pending receipt. */
  mergeDecisions?: MergeDecisionsSummary;
}

// ---------------------------------------------------------------------------
// Merge decisions — pending field-aware merge receipts surfaced in the brief
// ---------------------------------------------------------------------------

/**
 * One scalar conflict recorded by the field-aware merge driver, kept compact for
 * the brief. The discarded value is collapsed to one line and length-capped so a
 * multi-kilobyte description cannot blow the token budget.
 */
export interface MergeDecisionConflict {
  /** Metadata field name (or `body`) that collided between the two branches. */
  field: string;
  /** Value the merge discarded, collapsed to one line and truncated for display. */
  discarded: string;
}

/** One pending merge-decision receipt surfaced in the brief. */
export interface MergeDecisionEntry {
  /** Clone-local receipt identity (opaque). */
  receiptId: string;
  /** Item whose merge produced the receipt. */
  itemId: string;
  /** Item path with one matched layer of surrounding quotes stripped (upstream #771). */
  itemPath: string;
  /** Side the driver kept for scalar conflicts. */
  preferred: MergePreferredSide;
  /** Scalar conflicts, each with its discarded value truncated for display. */
  conflicts: MergeDecisionConflict[];
}

/** Pending merge-decision receipts attached to the brief; omitted when there are none. */
export interface MergeDecisionsSummary {
  /** Total pending receipts found in this clone. */
  pendingCount: number;
  /**
   * Ids of EVERY item with a pending receipt, in first-seen receipt order, computed
   * from all pending receipts before any display cap is applied. This is the
   * correctness set behind the `⚠ merge ` item markers: bare ids are token-cheap,
   * so unlike `receipts` this list is NEVER capped — capping it once let items past
   * {@link MERGE_DECISION_MAX_RECEIPTS} render with no warning marker even though a
   * merge had discarded their scalar context.
   */
  compromisedItemIds: string[];
  /**
   * Per-receipt compact entries, capped at {@link MERGE_DECISION_MAX_RECEIPTS} for
   * the token budget. RENDERING ONLY — never derive the compromised-id set from
   * this list; use {@link MergeDecisionsSummary.compromisedItemIds} instead.
   */
  receipts: MergeDecisionEntry[];
}


/** One duplicate cluster found by `findDuplicateClusters`, with an actionable remediation command. */
export interface GovernanceDuplicateCluster {
  /** Stable cluster key from the SDK (derived from the lexically first item id). */
  clusterId: string;
  /** Member items, ordered by id, with the fields a brief needs. */
  items: Array<{ id: string; title: string; status: string; type: string }>;
  /** Strongest pair score in the cluster on the 0..1 scale. */
  maxScore: number;
  /** Strongest deterministic match signal (`exact_title`, `issue_code`, or `title_token_jaccard`). */
  reason: "exact_title" | "issue_code" | "title_token_jaccard";
  /** Advisory remediation command string; never executed by the brief. */
  remediation: string;
}

/** One stale unclaimed in-progress item found by `scanStaleInProgressItems`. */
export interface GovernanceStaleItem {
  /** Stable item identifier. */
  id: string;
  /** ISO timestamp of the most recent recorded activity. */
  lastActivityAt: string;
  /** Whole hours elapsed at scan time. */
  ageHours: number;
  /** Advisory remediation command string. */
  remediation: string;
}

/** One storage-integrity finding from `scanStorageIntegrity`, classified by kind. */
export interface GovernanceStorageFinding {
  /** Finding category derived from the SDK scan result. */
  kind:
    | "unreadable_item_file"
    | "duplicate_item_id"
    | "history_conflict_marker"
    | "history_unparseable"
    | "resurrected_item"
    | "unparseable_config";
  /** Item id when the finding is item-scoped; undefined for config findings. */
  id?: string;
  /** Tracker-relative path of the affected file. */
  path: string;
  /** Human-readable detail (conflict marker text, parse failure reason, etc.). */
  detail: string;
  /** Advisory remediation command string. */
  remediation: string;
}

/** One credential-shaped match from `scanMutationSecrets`. The secret value is NEVER included. */
export interface GovernanceSecretFinding {
  /** Item whose text contained the match. */
  itemId: string;
  /** Object path of the match (e.g. `$.description`), mapped to a field name for display. */
  field: string;
  /** Stable detector identifier (`github_token`, `npm_token`, `slack_token`, `private_key`, `aws_access_key`, `high_entropy_assignment`). */
  rule: SecretGuardFinding["rule"];
  /** Advisory remediation command string. */
  remediation: string;
}

/** Token-budgeted governance findings attached to the brief. */
export interface GovernanceSummary {
  /** Duplicate clusters, capped for the budget; see `duplicateClustersTotal` for the real count. */
  duplicateClusters: GovernanceDuplicateCluster[];
  /** Total duplicate clusters found before budget truncation. */
  duplicateClustersTotal: number;
  /** Stale in-progress items, capped for the budget. */
  staleInProgress: GovernanceStaleItem[];
  /** Total stale in-progress items before budget truncation. */
  staleInProgressTotal: number;
  /** Storage-integrity findings, capped for the budget. */
  storageFindings: GovernanceStorageFinding[];
  /** Total storage-integrity findings before budget truncation. */
  storageFindingsTotal: number;
  /** Credential-shaped matches (item id + field + rule only, never the value), capped for the budget. */
  secretFindings: GovernanceSecretFinding[];
  /** Total secret findings before budget truncation. */
  secretFindingsTotal: number;
  /** Effective similarity threshold applied to the duplicate scan. */
  threshold: number;
  /** Effective stale-in-progress threshold in hours. */
  staleThresholdHours: number;
  /** ISO timestamp the governance summary was generated. */
  generatedAt: string;
}

export interface DeltaActivityEntry {
  ts: string;
  author?: string;
  op: string;
  id: string;
  patch?: Array<{
    op: "add" | "replace" | "remove";
    path: string;
    value?: unknown;
  }>;
  before_hash?: string;
  after_hash?: string;
  message?: string;
}

export interface DeltaItemChange {
  id: string;
  title: string;
  type: string;
  currentStatus?: string;
  currentPriority?: number;
  created: boolean;
  closed: boolean;
  canceled: boolean;
  reopened: boolean;
  closeReason?: string;
  statusTransition?: { from?: string; to: string };
  statusLabel?: string;
  priorityChange?: { from?: string; to: number };
  retitled: boolean;
  reassigned?: { to: string };
  depsAdded: number;
  depsRemoved: number;
  notesAdded: number;
  commentsAdded: number;
  eventCount: number;
  firstTs: string;
  lastTs: string;
  changeRank: number;
}

export interface DeltaSummary {
  since: string;
  until?: string;
  author?: string;
  generatedAt: string;
  workspace: string;
  pmVersion: string;
  totals: {
    itemsChanged: number;
    events: number;
    created: number;
    closed: number;
    canceled: number;
    reopened: number;
    statusChanged: number;
    reprioritized: number;
    retitled: number;
    reassigned: number;
    depsAdded: number;
    depsRemoved: number;
    notes: number;
    comments: number;
  };
  items: DeltaItemChange[];
  truncated?: boolean;
  omittedItems?: number;
  budget?: { requestedTokens: number; estimatedTokens: number };
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

/**
 * Resolve the effective output format for a brief command.
 *
 * `--json` is a host-owned global: the CLI consumes it into `ctx.global`, never
 * into `ctx.options`. Reading it from `options` therefore silently never matched,
 * so `pm brief --json` returned markdown and `pm brief --json | jq .` failed on a
 * parse error rather than producing the documented JSON. An explicit `--format`
 * still wins, so `--format markdown --json` stays markdown by the author's
 * intent; `options` is consulted as a fallback for direct handler callers in
 * tests.
 */
function resolveBriefFormat(
  options: Record<string, unknown>,
  global: { json?: boolean } | undefined,
  fallback: string,
): string {
  const explicit = readString(options, "format");
  if (explicit) return explicit.toLowerCase();
  const wantsJson = global?.json === true || readBool(options, "json");
  return wantsJson ? "json" : fallback;
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

function isClosedStatus(status: string): boolean {
  const value = status.trim().toLowerCase();
  return value === "closed" || value === "done" || value === "canceled" || value === "cancelled";
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
  const rels = [
    ...parseRelationshipValue(item.deps, "depends_on"),
    ...parseRelationshipValue(item.dependencies, "depends_on"),
    ...parseRelationshipValue(item.blocked_by, "blocked_by"),
    ...parseRelationshipValue(item.blockedBy, "blocked_by"),
  ].filter((rel) => rel.to && rel.to !== item.id).map((rel) => ({ from: item.id, to: rel.to, kind: rel.kind }));
  // pm's `update --blocked-by <id>` denormalizes the edge into BOTH item.dependencies
  // (a blocked_by-kind object) AND item.blocked_by (a string), so the same edge is
  // parsed twice. Dedup by (from,to,kind): a relationship is uniquely identified by
  // that triple, so this drops only redundant duplicates and is a no-op for
  // singly-sourced edges (e.g. depends_on, which has no denormalized string field).
  const seen = new Set<string>();
  return rels.filter((rel) => {
    const key = JSON.stringify([rel.from, rel.to, rel.kind]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  // When `pm next` supplied a canonical order, it is the authoritative ranking
  // so `brief next` agrees with `pm next`. Unranked candidates fall after ranked
  // ones and keep the deterministic local-score tiebreak. An explicit
  // `--dependency-order` request is a deliberate override of the default ranking,
  // so it takes precedence over canonical order and prerequisite-first sorting wins.
  const nextOrderRank = !options.dependencyOrder && options.nextOrder?.length
    ? new Map(options.nextOrder.map((id, index) => [id, index]))
    : undefined;
  const canonicalRank = (id: string): number => nextOrderRank?.get(id) ?? Number.POSITIVE_INFINITY;
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
      if (nextOrderRank) {
        // Compare ranks directly: subtracting two POSITIVE_INFINITY sentinels
        // (both candidates absent from pm next) would yield NaN — an invalid
        // comparator result. Only diverge when the ranks actually differ.
        const ar = canonicalRank(a.item.id);
        const br = canonicalRank(b.item.id);
        if (ar !== br) return ar - br;
      }
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

// ---------------------------------------------------------------------------
// Governance collection — sdk/governance scanner wrappers
// ---------------------------------------------------------------------------

/** Default similarity threshold for the brief's duplicate-cluster scan. */
const GOVERNANCE_DUPLICATE_THRESHOLD = 0.6;
/** Default stale-in-progress threshold in hours (mirrors the pm workspace default). */
const GOVERNANCE_STALE_HOURS = 72;
/** Per-section caps applied before budget compaction; the brief never dumps an unbounded list. */
const GOVERNANCE_MAX_CLUSTERS = 3;
const GOVERNANCE_MAX_STALE = 5;
const GOVERNANCE_MAX_STORAGE = 5;
const GOVERNANCE_MAX_SECRETS = 5;
/** Top-level item fields that `pm update` accepts as direct value flags. */
const SECRET_REMEDIABLE_FIELDS = new Set(["title", "description", "body"]);

// ---------------------------------------------------------------------------
// Merge decisions — pending field-aware merge receipt collection
// ---------------------------------------------------------------------------

/** Display length cap for a discarded merge value — keeps the brief token-cheap. */
const MERGE_DECISION_VALUE_MAX = 120;
/** Cap on receipts surfaced before budget compaction; the brief never dumps an unbounded list. */
const MERGE_DECISION_MAX_RECEIPTS = 10;

/**
 * Strip one matched layer of surrounding single or double quotes from a Git-supplied
 * item path. The field-aware merge driver records the `%P` path verbatim, and Git
 * wraps paths containing single quotes in a pair of single quotes (doubling internal
 * quotes), so a path like `'.pm/tasks/lab-fx0u.toon'` arrives with a stray wrapping
 * layer that makes it unreadable in output. Upstream tracking issue: unbraind/pm-cli#771
 * — this normalization is removable once the driver strips the wrapping layer itself.
 */
function normalizeItemPath(itemPath: string): string {
  const trimmed = itemPath.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === "'" || first === "\"") && first === last) return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Collapse a discarded merge value to one line and cap its length, reusing the
 * file's `escapeLine` helper for newline normalization. Long values are truncated
 * with an ellipsis rather than dumped, so a multi-kilobyte description cannot blow
 * the brief's token budget.
 */
function truncateForBrief(value: unknown): string {
  const collapsed = escapeLine(value);
  return collapsed.length > MERGE_DECISION_VALUE_MAX ? `${collapsed.slice(0, MERGE_DECISION_VALUE_MAX)}\u2026` : collapsed;
}

/**
 * Convert a raw SDK `MergeDecisionReceipt` into the brief's budget-friendly shape.
 * Only scalar conflict `decisions` carry a discarded value worth surfacing; clean
 * takes (`fields_from_theirs`) and union collections (`union_fields`) merge
 * without loss and are intentionally not reported here.
 */
function toMergeDecisionEntry(receipt: MergeDecisionReceipt): MergeDecisionEntry {
  return {
    receiptId: receipt.id,
    itemId: normalizeItemPath(receipt.item_id),
    itemPath: normalizeItemPath(receipt.item_path),
    preferred: receipt.preferred,
    conflicts: receipt.decisions.map((decision) => ({
      field: decision.field,
      discarded: truncateForBrief(decision.discarded),
    })),
  };
}

/**
 * Collect pending merge-decision receipts from this clone's
 * `.git/pm-merge-receipts` directory. A pending receipt means a peer agent's scalar
 * edit was discarded by the field-aware merge driver and that fact is not yet
 * represented in committed history, so an agent resuming after a merge would
 * otherwise load a context that silently omits the peer's work. Returns a compact
 * summary, or `undefined` when there are no pending receipts (the quiet path that
 * keeps the common case noise-free). Receipt reading is advisory context: any
 * failure also yields `undefined`, so a broken receipt store degrades the brief
 * instead of failing it.
 */
export async function collectPendingMergeDecisions(pmRoot: string): Promise<MergeDecisionsSummary | undefined> {
  // Advisory invariant: receipt reading is context, not gating — any failure here
  // (corrupt receipt, permission error, SDK-side throw) degrades the brief to
  // "no pending merge decisions" and must NEVER fail the command.
  try {
    // `findGitWorkspaceRoot` walks up from the tracker root to the enclosing worktree;
    // outside a git repo it returns null and there can be no receipts to read.
    const workspaceRoot = await findGitWorkspaceRoot(pathResolve(pmRoot));
    const cwd = workspaceRoot ?? process.cwd();
    const receipts = await listMergeReceipts(cwd);
    const pending = receipts.filter((receipt) => receipt.state === "pending");
    if (pending.length === 0) return undefined;
    const entries = pending.map(toMergeDecisionEntry);
    return {
      pendingCount: entries.length,
      // Computed from ALL pending receipts, before the cap below. Bare ids are
      // token-cheap, so this correctness set is never capped.
      compromisedItemIds: [...new Set(entries.map((entry) => entry.itemId))],
      // INVARIANT: MERGE_DECISION_MAX_RECEIPTS is a DISPLAY/token-cost cap only and
      // must never constrain the compromised-id set above — the last two bugs on
      // this branch came from letting a rendering bound reach correctness data.
      receipts: entries.slice(0, MERGE_DECISION_MAX_RECEIPTS),
    };
  } catch {
    return undefined;
  }
}

/** True when the merge-decisions section is absent or has no receipts. */
export function mergeDecisionsIsEmpty(m: MergeDecisionsSummary | undefined): boolean {
  return !m || m.receipts.length === 0;
}

/**
 * Set of item ids that have a pending merge-decision receipt, for cross-referencing
 * against focus/next/decision items. Reads the summary's NEVER-capped id list:
 * deriving this from the display-capped `receipts` list silently dropped the
 * `⚠ merge ` marker for every item past the cap, presenting compromised context as
 * trustworthy — the exact failure this feature exists to prevent.
 */
function compromisedItemIds(m: MergeDecisionsSummary | undefined): Set<string> {
  if (!m) return new Set();
  return new Set(m.compromisedItemIds);
}


/**
 * Map a `scanMutationSecrets` JSON-path (e.g. `$.description`) to a short field
 * name for display. The path is the only location information the SDK returns —
 * the matched secret value is never present, so the field name is the safest
 * identifier we can give an agent.
 */
function secretFieldFromPath(path: string): string {
  // `$.description` → `description`; `$.nested[0].body` → `nested.body`
  return path
    .replace(/^\$\./, "")
    .replace(/\[\d+\]/g, "")
    .trim() || "(unknown field)";
}

/**
 * Build the advisory remediation command for a duplicate cluster. Picks the
 * canonical member (oldest by `created_at`, falling back to id order) and
 * relates every other member to it. The command is output only.
 */
function duplicateClusterRemediation(
  cluster: DuplicateCluster,
  itemsById: ReadonlyMap<string, PmItem>,
): string {
  if (cluster.items.length < 2) return "";
  const sorted = [...cluster.items].sort((a, b) => {
    const aCreated = Date.parse(itemsById.get(a.id)?.created_at ?? "");
    const bCreated = Date.parse(itemsById.get(b.id)?.created_at ?? "");
    if (Number.isFinite(aCreated) && Number.isFinite(bCreated) && aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    return a.id.localeCompare(b.id);
  });
  const canonical = sorted[0];
  return sorted
    .slice(1)
    .map((other) => `pm update ${other.id} --dep id=${canonical.id},kind=related`)
    .join(" && ");
}

/**
 * Convert a raw SDK `DuplicateCluster` into the brief's budget-friendly shape
 * with an actionable remediation command.
 */
function toGovernanceDuplicateCluster(
  cluster: DuplicateCluster,
  itemsById: ReadonlyMap<string, PmItem>,
): GovernanceDuplicateCluster {
  const reason = cluster.matches[0]?.reason ?? "title_token_jaccard";
  return {
    clusterId: cluster.id,
    items: cluster.items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      type: item.type,
    })),
    maxScore: Math.round(cluster.max_score * 1000) / 1000,
    reason,
    remediation: duplicateClusterRemediation(cluster, itemsById),
  };
}

/**
 * Convert a raw SDK `StaleInProgressScan` into the brief's governance shape with
 * the remediation command the SDK already provides.
 */
function toGovernanceStaleItems(scan: StaleInProgressScan): GovernanceStaleItem[] {
  return scan.items.map((item) => ({
    id: item.id,
    lastActivityAt: item.last_activity_at,
    ageHours: item.age_hours,
    remediation: `pm update ${item.id} --status open  # or pm claim ${item.id} if still active`,
  }));
}

/**
 * Convert a raw SDK `StorageIntegrityScanResult` into the brief's classified
 * governance findings with actionable remediation commands.
 */
function toGovernanceStorageFindings(scan: StorageIntegrityScanResult): GovernanceStorageFinding[] {
  const findings: GovernanceStorageFinding[] = [];
  for (const row of scan.unreadable_item_files) {
    findings.push({
      kind: "unreadable_item_file",
      id: row.id,
      path: row.path,
      detail: "item file could not be parsed by the standard read path",
      remediation: `pm get ${row.id}  # inspect the parse failure`,
    });
  }
  for (const row of scan.duplicate_item_ids) {
    findings.push({
      kind: "duplicate_item_id",
      id: row.id,
      path: row.paths.join(", "),
      detail: `id ${row.id} claimed by ${row.paths.length} item documents (cross-branch add/add collision)`,
      remediation: `pm get ${row.id}  # resolve the add/add collision, then delete the loser`,
    });
  }
  for (const row of scan.history_conflict_marker_streams) {
    findings.push({
      kind: "history_conflict_marker",
      id: row.id,
      path: row.path,
      detail: `unresolved merge-conflict markers${row.line !== undefined ? ` at line ${row.line}` : ""}`,
      remediation: `pm history-repair ${row.id}`,
    });
  }
  for (const row of scan.history_unparseable_streams) {
    findings.push({
      kind: "history_unparseable",
      id: row.id,
      path: row.path,
      detail: row.detail,
      remediation: `pm history-repair ${row.id}`,
    });
  }
  for (const row of scan.resurrected_items) {
    findings.push({
      kind: "resurrected_item",
      id: row.id,
      path: `history/${row.id}.jsonl`,
      detail: `live item whose newest history operation is a delete (by ${row.deleted_by} at ${row.deleted_at})`,
      remediation: `pm delete ${row.id}  # or remove the stale delete event`,
    });
  }
  for (const row of scan.unparseable_config_files) {
    findings.push({
      kind: "unparseable_config",
      path: row.path,
      detail: row.detail,
      remediation: `pm validate  # config parse failure at ${row.path}`,
    });
  }
  return findings;
}

/**
 * Scan every item's text fields for credential-shaped content using the shared
 * `scanMutationSecrets` primitive. Only the item id, the field path, and the
 * detector rule are reported — the matched secret value is NEVER returned by the
 * SDK and is NEVER printed by the brief.
 */
function scanItemSecrets(items: readonly PmItem[]): GovernanceSecretFinding[] {
  const findings: GovernanceSecretFinding[] = [];
  for (const item of items) {
    // Pass the whole item as the payload so the SDK inspects every string leaf
    // (title, description, body, and any custom string field).
    const raw: SecretGuardFinding[] = scanMutationSecrets(item);
    for (const finding of raw) {
      const field = secretFieldFromPath(finding.path);
      findings.push({
        itemId: item.id,
        field,
        rule: finding.rule,
        remediation: SECRET_REMEDIABLE_FIELDS.has(field)
          ? `pm update ${item.id} --${field} "<redacted: remove the ${finding.rule}>"`
          : `pm get ${item.id}  # inspect and remove the detected secret from its unsupported field`,
      });
    }
  }
  return findings;
}

/**
 * Map a `PmItem` (the brief's loose, all-optional shape from `pm list-all`) into
 * the `ItemMetadata` the stale-work scanner requires. The brief reads items via
 * `pm list-all --json --include-body`, which always includes the `ItemMetadata`
 * required fields, so missing values default to safe empties rather than
 * `any`-casting the array.
 */
function toItemMetadata(item: PmItem): ItemMetadata {
  const priority = item.priority;
  return {
    id: item.id,
    title: text(item.title) || "(untitled)",
    description: text(item.description),
    type: (text(item.type) || "Task") as ItemMetadata["type"],
    status: (text(item.status) || "open") as ItemMetadata["status"],
    priority: (priority === 0 || priority === 1 || priority === 2 || priority === 3 || priority === 4 ? priority : 2) as ItemMetadata["priority"],
    tags: Array.isArray(item.tags) ? item.tags.filter((t): t is string => typeof t === "string") : [],
    created_at: item.created_at ?? new Date(0).toISOString(),
    updated_at: item.updated_at ?? item.created_at ?? new Date(0).toISOString(),
  };
}

/** Options controlling the governance scan. */
export interface GovernanceScanOptions {
  /** Similarity threshold on the 0..1 scale (default 0.6). */
  threshold?: number;
  /** Stale-in-progress threshold in hours (default 72). */
  staleHours?: number;
  /** Timestamp used for the report header; defaults to now. */
  generatedAt?: string;
  /** Explicit pm workspace root. */
  pmRoot?: string;
}

/**
 * Collect governance findings from the sdk/governance scanners: duplicate
 * clusters, stale in-progress items, storage-integrity problems, and
 * credential-shaped secrets in item text. Independent asynchronous scans run
 * concurrently and each scanner degrades to an empty section on failure, so an
 * advisory cannot suppress the core brief. The returned summary is pre-capped
 * per section. The secret value is NEVER returned or printed.
 */
export async function collectGovernanceSignals(
  items: readonly PmItem[],
  options: GovernanceScanOptions = {},
): Promise<GovernanceSummary> {
  const pmRoot = options.pmRoot ?? ".agents/pm";
  const threshold = options.threshold ?? GOVERNANCE_DUPLICATE_THRESHOLD;
  const staleHours = options.staleHours ?? GOVERNANCE_STALE_HOURS;
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const metadata = items.map(toItemMetadata);
  const parsedItemIds = new Set(items.map((item) => item.id));
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const [duplicateResult, staleResult, storageResult] = await Promise.allSettled([
    findDuplicateClusters({ pmRoot, threshold }),
    scanStaleInProgressItems(pmRoot, metadata, {
      threshold_hours: staleHours,
      now: new Date(generatedAt),
    }),
    (async (): Promise<GovernanceStorageFinding[]> => {
      const settings = await readSettings(pmRoot);
      const typeRegistry = resolveItemTypeRegistry(settings);
      return toGovernanceStorageFindings(
        await scanStorageIntegrity(pmRoot, parsedItemIds, typeRegistry.type_to_folder),
      );
    })(),
  ]);
  const allClusters = duplicateResult.status === "fulfilled"
    ? duplicateResult.value.clusters
      .map((cluster) => toGovernanceDuplicateCluster(cluster, itemsById))
      .sort((a, b) => b.maxScore - a.maxScore)
    : [];
  const allStale = staleResult.status === "fulfilled"
    ? toGovernanceStaleItems(staleResult.value)
    : [];
  const allStorage = storageResult.status === "fulfilled" ? storageResult.value : [];
  let allSecrets: GovernanceSecretFinding[] = [];
  try {
    allSecrets = scanItemSecrets(items);
  } catch {
    // Secret scanning is advisory; malformed custom data must not suppress the brief.
  }

  return {
    duplicateClusters: allClusters.slice(0, GOVERNANCE_MAX_CLUSTERS),
    duplicateClustersTotal: allClusters.length,
    staleInProgress: allStale.slice(0, GOVERNANCE_MAX_STALE),
    staleInProgressTotal: allStale.length,
    storageFindings: allStorage.slice(0, GOVERNANCE_MAX_STORAGE),
    storageFindingsTotal: allStorage.length,
    secretFindings: allSecrets.slice(0, GOVERNANCE_MAX_SECRETS),
    secretFindingsTotal: allSecrets.length,
    threshold,
    staleThresholdHours: staleHours,
    generatedAt,
  };
}

/**
 * Apply per-section budget caps to a governance summary. Called by
 * `compactToBudget` when the brief is over its token budget; the `Total` fields
 * preserve the real finding count so an agent still knows how many were hidden.
 */
function compactGovernance(g: GovernanceSummary, clusters: number, stale: number, storage: number, secrets: number): GovernanceSummary {
  return {
    ...g,
    duplicateClusters: g.duplicateClusters.slice(0, clusters),
    staleInProgress: g.staleInProgress.slice(0, stale),
    storageFindings: g.storageFindings.slice(0, storage),
    secretFindings: g.secretFindings.slice(0, secrets),
  };
}

/** True when every governance section is empty (nothing to surface). */
export function governanceIsEmpty(g: GovernanceSummary | undefined): boolean {
  if (!g) return true;
  return (
    g.duplicateClusters.length === 0 &&
    g.staleInProgress.length === 0 &&
    g.storageFindings.length === 0 &&
    g.secretFindings.length === 0
  );
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
    // Trim governance from the default caps (3/5/5/5) to the tight caps (2/3/3/3)
    // at the first compaction step so it competes fairly with the other sections.
    governance: brief.governance ? compactGovernance(brief.governance, 2, 3, 3, 3) : undefined,
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
    // At the tightest level, drop governance to 1/2/2/2 — the Total fields keep
    // the real finding count visible so an agent still knows there is more.
    governance: next.governance ? compactGovernance(next.governance, 1, 2, 2, 2) : undefined,
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
  // Cross-reference: mark any next/focus/decision item that has a pending merge-
  // decision receipt so the agent sees at a glance its context is compromised.
  const compromised = compromisedItemIds(options.mergeDecisions);
  const mark = (items: BriefItem[]): BriefItem[] =>
    compromised.size === 0 ? items : items.map((item) => (compromised.has(item.id) ? { ...item, mergeCompromised: true } : item));
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
  const markedFocus = mark(focus);
  const markedNext = mark(next);
  const markedDecisions = mark(decisionsNeeded);
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
    focus: markedFocus,
    next: markedNext,
    blockers,
    risks,
    staleContext,
    momentum,
    recentActivity,
    decisionsNeeded: markedDecisions,
    recommendedPmUpdates,
    insights,
    governance: governanceIsEmpty(options.governance) ? undefined : options.governance,
    mergeDecisions: mergeDecisionsIsEmpty(options.mergeDecisions) ? undefined : options.mergeDecisions,
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

/**
 * Render the governance section as markdown lines. Shared by the markdown and
 * agent-prompt renderers so the governance output stays consistent. Returns an
 * empty array when there is no governance section or every subsection is empty.
 */
function renderGovernanceMarkdown(g: GovernanceSummary | undefined): string[] {
  if (!g || governanceIsEmpty(g)) return [];
  const lines: string[] = ["## Governance", ""];
  if (g.duplicateClusters.length > 0) {
    const more = g.duplicateClustersTotal > g.duplicateClusters.length ? ` (+${g.duplicateClustersTotal - g.duplicateClusters.length} more)` : "";
    lines.push(`### Duplicate clusters (threshold ${g.threshold})${more}`, "");
    for (const cluster of g.duplicateClusters) {
      lines.push(`- **${cluster.clusterId}** — score ${cluster.maxScore} (${cluster.reason})`);
      for (const item of cluster.items) lines.push(`  - \`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status})`);
      if (cluster.remediation) lines.push(`  - → \`${cluster.remediation}\``);
    }
    lines.push("");
  }
  if (g.staleInProgress.length > 0) {
    const more = g.staleInProgressTotal > g.staleInProgress.length ? ` (+${g.staleInProgressTotal - g.staleInProgress.length} more)` : "";
    lines.push(`### Stale in-progress (${g.staleThresholdHours}h threshold)${more}`, "");
    for (const item of g.staleInProgress) {
      lines.push(`- \`${item.id}\` — ${item.ageHours}h since last activity (${item.lastActivityAt})`);
      if (item.remediation) lines.push(`  - → \`${item.remediation}\``);
    }
    lines.push("");
  }
  if (g.storageFindings.length > 0) {
    const more = g.storageFindingsTotal > g.storageFindings.length ? ` (+${g.storageFindingsTotal - g.storageFindings.length} more)` : "";
    lines.push(`### Storage integrity${more}`, "");
    for (const finding of g.storageFindings) {
      const idPart = finding.id ? ` \`${finding.id}\`` : "";
      lines.push(`- ${finding.kind}${idPart}: ${finding.detail} (${finding.path})`);
      if (finding.remediation) lines.push(`  - → \`${finding.remediation}\``);
    }
    lines.push("");
  }
  if (g.secretFindings.length > 0) {
    const more = g.secretFindingsTotal > g.secretFindings.length ? ` (+${g.secretFindingsTotal - g.secretFindings.length} more)` : "";
    // ⚠ Secret values are NEVER printed — only the item id, field, and detector rule.
    lines.push(`### ⚠ Secrets in item text${more}`, "");
    for (const finding of g.secretFindings) {
      lines.push(`- \`${finding.itemId}\` field \`${finding.field}\` — detector: ${finding.rule}`);
      if (finding.remediation) lines.push(`  - → \`${finding.remediation}\``);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Render the governance section as Slack-formatted lines. Returns an empty
 * array when there is no governance section or every subsection is empty.
 */
function renderGovernanceSlack(g: GovernanceSummary | undefined): string[] {
  if (!g || governanceIsEmpty(g)) return [];
  const lines: string[] = ["*Governance*", ""];
  if (g.duplicateClusters.length > 0) {
    const more = g.duplicateClustersTotal > g.duplicateClusters.length ? ` (+${g.duplicateClustersTotal - g.duplicateClusters.length} more)` : "";
    lines.push(`_Duplicate clusters (threshold ${g.threshold})${more}_`);
    for (const cluster of g.duplicateClusters) {
      lines.push(`• *${cluster.clusterId}* — score ${cluster.maxScore} (${cluster.reason})`);
      for (const item of cluster.items) lines.push(`  • \`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status})`);
      if (cluster.remediation) lines.push(`  • → \`${cluster.remediation}\``);
    }
    lines.push("");
  }
  if (g.staleInProgress.length > 0) {
    const more = g.staleInProgressTotal > g.staleInProgress.length ? ` (+${g.staleInProgressTotal - g.staleInProgress.length} more)` : "";
    lines.push(`_Stale in-progress (${g.staleThresholdHours}h)${more}_`);
    for (const item of g.staleInProgress) {
      lines.push(`• \`${item.id}\` — ${item.ageHours}h since last activity`);
      if (item.remediation) lines.push(`  • → \`${item.remediation}\``);
    }
    lines.push("");
  }
  if (g.storageFindings.length > 0) {
    const more = g.storageFindingsTotal > g.storageFindings.length ? ` (+${g.storageFindingsTotal - g.storageFindings.length} more)` : "";
    lines.push(`_Storage integrity${more}_`);
    for (const finding of g.storageFindings) {
      const idPart = finding.id ? ` \`${finding.id}\`` : "";
      lines.push(`• ${finding.kind}${idPart}: ${finding.detail} (${finding.path})`);
      if (finding.remediation) lines.push(`  • → \`${finding.remediation}\``);
    }
    lines.push("");
  }
  if (g.secretFindings.length > 0) {
    const more = g.secretFindingsTotal > g.secretFindings.length ? ` (+${g.secretFindingsTotal - g.secretFindings.length} more)` : "";
    lines.push(`_⚠ Secrets in item text${more}_`);
    for (const finding of g.secretFindings) {
      lines.push(`• \`${finding.itemId}\` field \`${finding.field}\` — detector: ${finding.rule}`);
      if (finding.remediation) lines.push(`  • → \`${finding.remediation}\``);
    }
    lines.push("");
  }
  return lines;
}

/**
 * Render the governance section as compact agent-prompt lines. Returns an empty
 * array when there is no governance section or every subsection is empty.
 */
function renderGovernanceAgentPrompt(g: GovernanceSummary | undefined): string[] {
  if (!g || governanceIsEmpty(g)) return [];
  const lines: string[] = ["Governance findings (act before starting new work):"];
  for (const cluster of g.duplicateClusters) {
    const members = cluster.items.map((i) => `${i.id}:${escapeLine(i.title)}`).join(", ");
    lines.push(`- duplicate cluster ${cluster.clusterId} (score ${cluster.maxScore}, ${cluster.reason}): ${members}`);
    if (cluster.remediation) lines.push(`  - ${cluster.remediation}`);
  }
  for (const item of g.staleInProgress) {
    lines.push(`- stale in-progress ${item.id}: ${item.ageHours}h since last activity`);
    if (item.remediation) lines.push(`  - ${item.remediation}`);
  }
  for (const finding of g.storageFindings) {
    const idPart = finding.id ? ` ${finding.id}` : "";
    lines.push(`- storage ${finding.kind}${idPart}: ${finding.detail} (${finding.path})`);
    if (finding.remediation) lines.push(`  - ${finding.remediation}`);
  }
  for (const finding of g.secretFindings) {
    // ⚠ Never print the secret value — only the item id, field, and detector rule.
    lines.push(`- ⚠ secret in ${finding.itemId} field \`${finding.field}\` (detector: ${finding.rule}) — remove before publishing`);
    if (finding.remediation) lines.push(`  - ${finding.remediation}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Merge decisions — rendering (markdown / slack / agent-prompt / text)
// ---------------------------------------------------------------------------

/**
 * Render the pending merge-decisions section as markdown lines. Returns an empty
 * array when there are no pending receipts, so the common case stays quiet. Each
 * receipt lists its item id, the conflicting field names, and the discarded value
 * (truncated) so an agent resuming after a merge can see a peer's work was dropped.
 */
function renderMergeDecisionsMarkdown(m: MergeDecisionsSummary | undefined): string[] {
  if (mergeDecisionsIsEmpty(m)) return [];
  const lines: string[] = ["## \u26a0 Pending Merge Decisions", ""];
  const more = m!.pendingCount > m!.receipts.length ? ` (+${m!.pendingCount - m!.receipts.length} more)` : "";
  lines.push(`_${m!.pendingCount} pending receipt(s) — a peer agent's scalar edit was discarded by the field-aware merge driver and is not yet in committed history.${more}_`, "");
  for (const entry of m!.receipts) {
    const fields = entry.conflicts.map((c) => c.field).join(", ");
    lines.push(`- \`${entry.itemId}\` (kept ${entry.preferred}) — fields: ${fields}`);
    for (const conflict of entry.conflicts) {
      lines.push(`  - \`${conflict.field}\` discarded: ${conflict.discarded}`);
    }
    lines.push(`  - reconcile with \`pm merge reconcile\``);
  }
  lines.push("");
  return lines;
}

/**
 * Render the pending merge-decisions section as Slack-formatted lines. Returns an
 * empty array when there are no pending receipts.
 */
function renderMergeDecisionsSlack(m: MergeDecisionsSummary | undefined): string[] {
  if (mergeDecisionsIsEmpty(m)) return [];
  const lines: string[] = ["*\u26a0 Pending Merge Decisions*", ""];
  const more = m!.pendingCount > m!.receipts.length ? ` _(+${m!.pendingCount - m!.receipts.length} more)_` : "";
  lines.push(`_${m!.pendingCount} pending receipt(s) — a peer's scalar edit was discarded and is not yet in committed history${more}_`, "");
  for (const entry of m!.receipts) {
    const fields = entry.conflicts.map((c) => c.field).join(", ");
    lines.push(`• \`${entry.itemId}\` (kept ${entry.preferred}) — fields: ${fields}`);
    for (const conflict of entry.conflicts) {
      lines.push(`  • \`${conflict.field}\` discarded: ${conflict.discarded}`);
    }
    lines.push(`  • reconcile with \`pm merge reconcile\``);
  }
  lines.push("");
  return lines;
}

/**
 * Render the pending merge-decisions section as compact agent-prompt lines.
 * Returns an empty array when there are no pending receipts.
 */
/**
 * Trailing notice naming receipts omitted by {@link MERGE_DECISION_MAX_RECEIPTS}.
 *
 * `pendingCount` is the TRUE number of pending receipts while `receipts` is capped
 * for token cost, so a renderer that iterates `receipts` alone silently drops the
 * remainder — the exact silent loss this section exists to surface. Returns an
 * empty array when nothing was omitted.
 */
function mergeDecisionOmittedLines(m: MergeDecisionsSummary): string[] {
  const omitted = m.pendingCount - m.receipts.length;
  if (omitted <= 0) return [];
  return [`- \u26a0 ${omitted} further pending decision(s) not shown — run \`pm merge report\` for the full list`];
}

function renderMergeDecisionsAgentPrompt(m: MergeDecisionsSummary | undefined): string[] {
  if (mergeDecisionsIsEmpty(m)) return [];
  const lines: string[] = ["Pending merge decisions (a peer agent's scalar edit was discarded and is NOT in committed history — your context is compromised):"];
  for (const entry of m!.receipts) {
    const conflicts = entry.conflicts.map((c) => `${c.field}=${c.discarded}`).join(", ");
    lines.push(`- \u26a0 ${entry.itemId} (kept ${entry.preferred}): discarded ${conflicts}`);
    lines.push(`  - run \`pm merge reconcile\` to record the decision in history`);
  }
  lines.push(...mergeDecisionOmittedLines(m!));
  return lines;
}

/** Compact text line for one merge-decision entry, shared by the text diverge renderer. */
function mergeDecisionEntryText(entry: MergeDecisionEntry): string {
  const conflicts = entry.conflicts.map((c) => `${c.field}=${c.discarded}`).join(", ");
  return `${entry.itemId} (kept ${entry.preferred}): ${conflicts}`;
}

/**
 * Inline marker prepended to an item line when the item has a pending merge-decision
 * receipt. Uses the same \u26a0 warning glyph the file already uses for fence and
 * secret warnings, so the annotation convention stays consistent across sections.
 */
function mergeMarker(item: BriefItem): string {
  return item.mergeCompromised ? "\u26a0 merge " : "";
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
  for (const item of brief.next) lines.push(`- ${mergeMarker(item)}${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status}) - ${item.whyNow}; score ${item.rankingScore}; confidence ${item.confidence}`);
  lines.push("", "## Focus", "");
  if (brief.focus.length === 0) lines.push("_No focus items._");
  for (const item of brief.focus) {
    lines.push(`- ${mergeMarker(item)}${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status})`);
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
  lines.push(...renderGovernanceMarkdown(brief.governance));
  lines.push(...renderMergeDecisionsMarkdown(brief.mergeDecisions));
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
  for (const item of brief.next) lines.push(`• ${mergeMarker(item)}\`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status}) — ${item.whyNow}; score ${item.rankingScore}; confidence ${item.confidence}`);
  lines.push("", "*Focus*");
  if (brief.focus.length === 0) lines.push("_No focus items._");
  for (const item of brief.focus) {
    const context = item.requiredContext.length > 0 ? ` — context: ${item.requiredContext.join(", ")}` : "";
    lines.push(`• ${mergeMarker(item)}\`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status})${context}`);
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
  lines.push(...renderGovernanceSlack(brief.governance));
  lines.push(...renderMergeDecisionsSlack(brief.mergeDecisions));
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
    lines.push(`- ${mergeMarker(item)}${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status}) because ${item.whyNow}; score=${item.rankingScore}; confidence=${item.confidence}`);
  }
  lines.push("", "Focus context:");
  if (brief.focus.length === 0) lines.push("- No explicit focus item.");
  for (const item of brief.focus.slice(0, 5)) {
    const context = item.requiredContext.length > 0 ? ` context=${item.requiredContext.join(",")}` : "";
    lines.push(`- ${mergeMarker(item)}${item.id}: ${escapeLine(item.title)}${context}`);
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
  const govLines = renderGovernanceAgentPrompt(brief.governance);
  if (govLines.length > 0) {
    lines.push("");
    lines.push(...govLines);
  }
  const mergeLines = renderMergeDecisionsAgentPrompt(brief.mergeDecisions);
  if (mergeLines.length > 0) {
    lines.push("");
    lines.push(...mergeLines);
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
  return parsePmItemsOutput(result.stdout);
}

export function parsePmItemsOutput(output: string): PmItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Unable to parse pm item JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const items = Array.isArray(parsed) ? parsed : record.items ?? record.results ?? [];
  if (!Array.isArray(items)) return [];
  return items.filter((item: unknown): item is PmItem => Boolean(item) && typeof item === "object" && typeof (item as PmItem).id === "string");
}

function pmVersion(): string {
  const result = spawnSync(PM_EXECUTABLE, ["--version"], { encoding: "utf-8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

/**
 * Ask the CLI's canonical `pm next` scorer for its ranked order so `brief`/`brief
 * next` agree with `pm next` on the top-ranked item (companion gyi1). Returns the
 * recommended item first, then ready work, then blocked work, deduplicated. On any
 * failure it returns an empty list so callers transparently fall back to the local
 * evidence scorer rather than hard-failing.
 */
export function readNextOrderedIds(pmRoot: string, options: { limit?: number; assignee?: string } = {}): string[] {
  const args = [PM_PATH_OPTION, pmRoot, "next", "--json"];
  if (options.limit && Number.isFinite(options.limit)) args.push("--limit", String(Math.max(1, Math.floor(options.limit))));
  if (options.assignee) args.push("--assignee", options.assignee);
  const result = spawnSync(PM_EXECUTABLE, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as { recommended?: { id?: unknown } | null; ready?: unknown; blocked?: unknown };
  const idOf = (entry: unknown): string | undefined => {
    if (!entry || typeof entry !== "object") return undefined;
    const id = (entry as { id?: unknown }).id;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  };
  const ordered: string[] = [];
  const recommendedId = idOf(record.recommended);
  if (recommendedId) ordered.push(recommendedId);
  for (const bucket of [record.ready, record.blocked]) {
    if (!Array.isArray(bucket)) continue;
    for (const entry of bucket) {
      const id = idOf(entry);
      if (id) ordered.push(id);
    }
  }
  return uniqueStrings(ordered);
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

/**
 * Read full activity entries (with JSON-Patch payloads) since a checkpoint via
 * `pm activity --json --full --from <from> [--to] [--author] --limit <n>`. Mirrors
 * the spawnSync/CommandError idioms of `readRecentActivity` and `readPmItems`.
 * Returns normalized `DeltaActivityEntry[]` sorted ascending by ts so the
 * classifier can walk each item's events chronologically.
 */
export function readActivitySince(
  pmRoot: string,
  options: { from: string; to?: string; author?: string; limit?: number },
): DeltaActivityEntry[] {
  const requested = Math.floor(options.limit ?? 1000);
  const limit = Number.isFinite(requested) ? Math.max(1, Math.min(requested, 5000)) : 1000;
  const args = [PM_PATH_OPTION, pmRoot, "activity", "--json", "--full", "--from", options.from];
  if (options.to) args.push("--to", options.to);
  if (options.author) args.push("--author", options.author);
  args.push("--limit", String(limit));
  const result = spawnSync(PM_EXECUTABLE, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new CommandError(result.stderr?.trim() || result.error?.message || "`pm activity --json --full` failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CommandError(`Unable to parse pm activity JSON: ${detail}`);
  }
  if (!parsed || typeof parsed !== "object") return [];
  const record = parsed as Record<string, unknown>;
  const entries = record.activity;
  if (!Array.isArray(entries)) return [];
  const normalized: DeltaActivityEntry[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const ts = text(r.ts);
    const id = text(r.id);
    if (!ts || !id) continue;
    const patch = Array.isArray(r.patch)
      ? (r.patch as DeltaActivityEntry["patch"])
      : undefined;
    normalized.push({
      ts,
      author: text(r.author) || undefined,
      op: text(r.op) || "activity",
      id,
      patch,
      before_hash: text(r.before_hash) || undefined,
      after_hash: text(r.after_hash) || undefined,
      message: text(r.message) || undefined,
    });
  }
  normalized.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return normalized;
}

const OPEN_STATUSES = new Set(["open", "in_progress", "ready"]);
const CLOSED_STATUSES = new Set(["closed", "done", "canceled", "cancelled"]);

/** JSON-Patch paths that represent a dependency/relationship edit, across pm
 * versions and extension schemas. Real pm 2026.7.22 uses `/metadata/dependencies`. */
function isDependencyPath(path: string): boolean {
  for (const root of ["/metadata/dependencies", "/metadata/blocked_by", "/metadata/relationships", "/metadata/deps", "/relationships"]) {
    if (path === root || path.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * Pure classifier: groups full activity entries by item id and aggregates all
 * events in the window into one `DeltaItemChange` per changed item, joined with
 * the current state in `itemsById`. Deterministic ordering puts the most
 * decision-relevant changes first, then applies a token/item budget.
 */
export function buildDelta(
  entries: DeltaActivityEntry[],
  itemsById: Map<string, PmItem>,
  options: {
    since: string;
    until?: string;
    author?: string;
    generatedAt?: string;
    workspace?: string;
    pmVersion?: string;
    maxItems?: number;
    tokenBudget?: number;
    format?: string;
  } = { since: "" },
): DeltaSummary {
  const generatedAt = options.generatedAt ?? new Date().toISOString();

  const byId = new Map<string, DeltaActivityEntry[]>();
  for (const entry of entries) {
    let bucket = byId.get(entry.id);
    if (!bucket) {
      bucket = [];
      byId.set(entry.id, bucket);
    }
    bucket.push(entry);
  }

  const items: DeltaItemChange[] = [];
  for (const [id, rawEvents] of byId) {
    const events = [...rawEvents].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const item = itemsById.get(id);

    let created = false;
    let closed = false;
    let canceled = false;
    let reopened = false;
    let closeReason: string | undefined;
    let retitled = false;
    let reassignedTo: string | undefined;
    let depsAdded = 0;
    let depsRemoved = 0;
    let notesAdded = 0;
    let commentsAdded = 0;
    let titleFromPatch: string | undefined;
    const statusValues: string[] = [];
    const priorityValues: number[] = [];

    for (const e of events) {
      const op = e.op;
      if (op === "create") {
        // Creation establishes the item's baseline, not field-level deltas: its
        // patch sets title/status/priority/assignee for the first time. Counting
        // those as retitled/reprioritized/reassigned/status-changed would flag
        // every new item as if it had been edited. Record only the `created` flag
        // (and a title fallback for items no longer in the workspace), then skip.
        created = true;
        if (e.patch && !titleFromPatch) {
          const titlePatch = e.patch.find((p) => p.path === "/metadata/title" || p.path === "/title");
          if (titlePatch && typeof titlePatch.value === "string") titleFromPatch = titlePatch.value;
        }
        continue;
      }
      if (op === "close") closed = true;
      if (op === "cancel") canceled = true;
      if (op === "reopen") reopened = true;
      const opCountedNote = op === "note_add";
      const opCountedComment = op === "comment_add";
      if (opCountedNote) notesAdded++;
      if (opCountedComment) commentsAdded++;
      if (!e.patch) continue;
      for (const p of e.patch) {
        const path = p.path;
        const pop = p.op;
        if (typeof path !== "string") continue;
        if (path === "/metadata/status") {
          if (typeof p.value === "string") statusValues.push(p.value);
        }
        if (path === "/metadata/close_reason" && (pop === "add" || pop === "replace")) {
          if (typeof p.value === "string") closeReason = p.value;
        }
        if (path === "/metadata/priority" && (pop === "add" || pop === "replace")) {
          if (typeof p.value === "number") priorityValues.push(p.value);
        }
        if (path === "/metadata/title" || path === "/title") {
          retitled = true;
          if (typeof p.value === "string" && !titleFromPatch) titleFromPatch = p.value;
        }
        if (path === "/metadata/assignee" && (pop === "add" || pop === "replace")) {
          if (typeof p.value === "string") reassignedTo = p.value;
        }
        // Real pm (2026.7.22) stores all dependency kinds (depends_on/blocks/
        // blocked_by/related) in a single `/metadata/dependencies` array; older
        // shapes and extension schemas may use the other roots. Match them all.
        if (isDependencyPath(path)) {
          if (pop === "add") depsAdded++;
          // A `close`/`cancel` emits `remove /metadata/dependencies` as a
          // side-effect of tearing down edges — that is not a user-driven
          // dependency removal, so it must not surface as "-1 dep".
          else if (pop === "remove" && op !== "close" && op !== "cancel") depsRemoved++;
        }
        if (path === "/metadata/notes" || path.startsWith("/metadata/notes/")) {
          if (pop === "add" && !opCountedNote) notesAdded++;
        }
        if (path === "/metadata/comments" || path.startsWith("/metadata/comments/")) {
          if (pop === "add" && !opCountedComment) commentsAdded++;
        }
      }
    }

    if (!closed && statusValues.some((v) => v === "closed")) closed = true;
    if (!canceled && statusValues.some((v) => v === "canceled" || v === "cancelled")) canceled = true;
    if (!reopened && statusValues.length >= 2) {
      let hadClosed = false;
      for (const v of statusValues) {
        if (CLOSED_STATUSES.has(v)) hadClosed = true;
        if (hadClosed && OPEN_STATUSES.has(v)) {
          reopened = true;
          break;
        }
      }
    }

    let statusTransition: { from?: string; to: string } | undefined;
    if (statusValues.length >= 1) {
      const distinct: string[] = [];
      for (const v of statusValues) {
        if (distinct.length === 0 || distinct[distinct.length - 1] !== v) distinct.push(v);
      }
      const to = statusValues[statusValues.length - 1];
      if (distinct.length >= 2) {
        statusTransition = { from: distinct[distinct.length - 2], to };
      } else {
        statusTransition = { to };
      }
    }

    let statusLabel: string | undefined;
    if (statusTransition) {
      const to = statusTransition.to;
      const from = statusTransition.from;
      if (to === "in_progress" && from !== "in_progress") statusLabel = "started";
      if (to === "blocked") statusLabel = "newly blocked";
      if (from === "blocked" && (to === "open" || to === "in_progress")) statusLabel = "unblocked";
    }
    if (reopened) statusLabel = "reopened";

    let priorityChange: { from?: string; to: number } | undefined;
    if (priorityValues.length >= 1) {
      const distinct: number[] = [];
      for (const v of priorityValues) {
        if (distinct.length === 0 || distinct[distinct.length - 1] !== v) distinct.push(v);
      }
      const to = priorityValues[priorityValues.length - 1];
      if (distinct.length >= 2) {
        priorityChange = { from: String(distinct[distinct.length - 2]), to };
      } else {
        priorityChange = { to };
      }
    }

    const title = item ? titleOf(item) : titleFromPatch ?? "(unknown/removed)";
    const type = item ? typeOf(item) : "Item";
    const currentStatus = item ? statusOf(item) : undefined;
    const currentPriority = item && typeof item.priority === "number" ? item.priority : undefined;
    const firstTs = events[0].ts;
    const lastTs = events[events.length - 1].ts;

    let changeRank = 4;
    if (created) changeRank = 0;
    else if (closed || canceled) changeRank = 1;
    else if (reopened) changeRank = 2;
    else if (statusTransition !== undefined || priorityChange !== undefined) changeRank = 3;

    items.push({
      id,
      title,
      type,
      currentStatus,
      currentPriority,
      created,
      closed,
      canceled,
      reopened,
      closeReason,
      statusTransition,
      statusLabel,
      priorityChange,
      retitled,
      reassigned: reassignedTo !== undefined ? { to: reassignedTo } : undefined,
      depsAdded,
      depsRemoved,
      notesAdded,
      commentsAdded,
      eventCount: events.length,
      firstTs,
      lastTs,
      changeRank,
    });
  }

  items.sort((a, b) => {
    if (a.changeRank !== b.changeRank) return a.changeRank - b.changeRank;
    const pa = typeof a.currentPriority === "number" ? a.currentPriority : 99;
    const pb = typeof b.currentPriority === "number" ? b.currentPriority : 99;
    if (pa !== pb) return pa - pb;
    if (a.lastTs !== b.lastTs) return a.lastTs > b.lastTs ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // Lifecycle-category counts mirror primary-section membership so every count
  // equals the number of items rendered under that section (each item lands in
  // exactly one). retitled/reassigned/deps/notes/comments are cross-cutting
  // presence/sum counts surfaced on the same per-item line.
  const primaryCounts: Record<string, number> = {};
  for (const i of items) {
    const key = primaryDeltaSection(i);
    primaryCounts[key] = (primaryCounts[key] ?? 0) + 1;
  }
  const totals = {
    itemsChanged: items.length,
    events: entries.length,
    created: primaryCounts.Created ?? 0,
    closed: primaryCounts.Closed ?? 0,
    canceled: primaryCounts.Canceled ?? 0,
    reopened: primaryCounts.Reopened ?? 0,
    statusChanged: primaryCounts["Status changes"] ?? 0,
    reprioritized: primaryCounts.Reprioritized ?? 0,
    retitled: items.filter((i) => i.retitled).length,
    reassigned: items.filter((i) => i.reassigned !== undefined).length,
    depsAdded: items.reduce((n, i) => n + i.depsAdded, 0),
    depsRemoved: items.reduce((n, i) => n + i.depsRemoved, 0),
    notes: items.reduce((n, i) => n + i.notesAdded, 0),
    comments: items.reduce((n, i) => n + i.commentsAdded, 0),
  };

  const summary: DeltaSummary = {
    since: options.since,
    until: options.until,
    author: options.author,
    generatedAt,
    workspace: options.workspace ?? ".agents/pm",
    pmVersion: options.pmVersion ?? "unknown",
    totals,
    items,
  };

  applyDeltaBudget(summary, options.maxItems ?? 40, options.tokenBudget ?? 4000, options.format);
  return summary;
}

/** Estimate the token cost of a summary rendered in the SAME format the caller
 * will emit, so the budget constrains the actual output (not always markdown). */
function estimateDeltaTokens(summary: DeltaSummary, format?: string): number {
  const rendered =
    format === "json" ? `${JSON.stringify(summary, null, 2)}\n`
    : format === "text" ? renderTextDelta(summary)
    : format === "slack" ? renderSlackDelta(summary)
    : renderMarkdownDelta(summary);
  return estimateTokens(rendered);
}

function applyDeltaBudget(summary: DeltaSummary, maxItems: number, tokenBudget: number, format?: string): void {
  const full = summary.items;
  // Guard the exported API: maxItems <= 0 must not slice from the end.
  const cap = Math.max(1, Math.floor(Number.isFinite(maxItems) ? maxItems : 40));
  let working = full.slice(0, cap);
  const probe = (items: DeltaItemChange[]) => estimateDeltaTokens({ ...summary, items }, format);
  if (working.length > 1 && probe(working) > tokenBudget) {
    while (working.length > 1 && probe(working) > tokenBudget) {
      working = working.slice(0, -1);
    }
  }
  const omitted = full.length - working.length;
  summary.items = working;
  summary.truncated = omitted > 0 ? true : undefined;
  summary.omittedItems = omitted > 0 ? omitted : undefined;
  summary.budget = { requestedTokens: tokenBudget, estimatedTokens: probe(working) };
}

function describeDeltaItem(change: DeltaItemChange): string {
  const parts: string[] = [];
  if (change.created) parts.push("created");
  if (change.closed) {
    parts.push("closed");
    if (change.closeReason) parts.push(`(${change.closeReason})`);
  }
  if (change.canceled) parts.push("canceled");
  if (change.reopened) parts.push("reopened");
  if (change.statusTransition) {
    const t = change.statusTransition;
    const from = t.from ? `${t.from} → ${t.to}` : `→ ${t.to}`;
    parts.push(`status ${from}`);
  }
  if (change.statusLabel) parts.push(change.statusLabel);
  if (change.priorityChange) {
    const p = change.priorityChange;
    parts.push(p.from ? `priority ${p.from} → ${p.to}` : `priority → ${p.to}`);
  }
  if (change.retitled) parts.push("retitled");
  if (change.reassigned) parts.push(`assigned → ${change.reassigned.to}`);
  if (change.depsAdded > 0) parts.push(`+${change.depsAdded} dep${change.depsAdded === 1 ? "" : "s"}`);
  if (change.depsRemoved > 0) parts.push(`-${change.depsRemoved} dep${change.depsRemoved === 1 ? "" : "s"}`);
  if (change.notesAdded > 0) parts.push(`${change.notesAdded} note${change.notesAdded === 1 ? "" : "s"}`);
  if (change.commentsAdded > 0) parts.push(`${change.commentsAdded} comment${change.commentsAdded === 1 ? "" : "s"}`);
  const detail = parts.length > 0 ? parts.join("; ") : `${change.eventCount} event${change.eventCount === 1 ? "" : "s"}`;
  return detail;
}

function deltaRefreshCommand(summary: DeltaSummary, format?: string): string {
  const parts = ["pm", "brief", "since", summary.since];
  if (summary.until) parts.push("--until", summary.until);
  if (summary.author) parts.push("--author", summary.author);
  if (format) parts.push("--format", format);
  return parts.join(" ");
}

/**
 * Normalize an agent-friendly bare relative window (e.g. "7d", "24h", "2w") to the
 * `pm activity --from`/`--to` accepted form ("-7d"): a leading minus means "N ago".
 * Bare forms WITHOUT the minus silently match nothing in `pm activity`, so agents
 * that naturally type `pm brief since 7d` would otherwise get an empty delta. ISO
 * timestamps, plain dates, and already-signed relatives pass through unchanged.
 */
export function normalizeCheckpoint(value: string): string {
  const trimmed = value.trim();
  return /^\d+(s|m|h|d|w|M)$/.test(trimmed) ? `-${trimmed}` : trimmed;
}

/** Fixed render order for delta sections; each changed item appears in exactly one. */
const DELTA_SECTION_ORDER = [
  "Created",
  "Closed",
  "Canceled",
  "Reopened",
  "Status changes",
  "Reprioritized",
  "Dependencies",
  "Discussion",
  "Other",
] as const;

/**
 * The single primary section an item belongs to. Each item's rendered line already
 * lists ALL of its changes (see describeDeltaItem), so partitioning by one primary
 * category keeps output deterministic and token-efficient — no item is repeated
 * across sections.
 */
function primaryDeltaSection(i: DeltaItemChange): string {
  if (i.created) return "Created";
  if (i.closed) return "Closed";
  if (i.canceled) return "Canceled";
  if (i.reopened) return "Reopened";
  if (i.statusTransition !== undefined) return "Status changes";
  if (i.priorityChange !== undefined) return "Reprioritized";
  if (i.depsAdded > 0 || i.depsRemoved > 0) return "Dependencies";
  if (i.notesAdded > 0 || i.commentsAdded > 0) return "Discussion";
  return "Other";
}

/** Group already-sorted items into their primary sections, preserving item order. */
function groupDeltaSections(items: DeltaItemChange[]): Array<{ title: string; members: DeltaItemChange[] }> {
  const groups = new Map<string, DeltaItemChange[]>();
  for (const item of items) {
    const key = primaryDeltaSection(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return DELTA_SECTION_ORDER.filter((title) => groups.has(title)).map((title) => ({ title, members: groups.get(title)! }));
}

export function renderMarkdownDelta(summary: DeltaSummary): string {
  if (summary.items.length === 0) {
    const header = `# Delta since ${summary.since}${summary.until ? ` until ${summary.until}` : ""}${summary.author ? ` by ${summary.author}` : ""}`;
    return `${header}\n\nNo changes since ${summary.since}.\n`;
  }
  const header = `# Delta since ${summary.since}${summary.until ? ` until ${summary.until}` : ""}${summary.author ? ` by ${summary.author}` : ""}`;
  const lines: string[] = [
    header,
    "",
    `${summary.workspace} · pm ${summary.pmVersion} · generated ${summary.generatedAt}`,
    "",
    "## Summary",
    "",
  ];
  const t = summary.totals;
  lines.push(
    `- ${t.itemsChanged} item(s) changed across ${t.events} event(s): ${t.created} created, ${t.closed} closed, ${t.canceled} canceled, ${t.reopened} reopened, ${t.statusChanged} status changed, ${t.reprioritized} reprioritized, ${t.retitled} retitled, ${t.reassigned} reassigned, ${t.depsAdded} deps added, ${t.depsRemoved} deps removed, ${t.notes} notes, ${t.comments} comments.`,
  );
  if (summary.truncated) {
    lines.push(`- _truncated: ${summary.omittedItems ?? 0} lower-ranked item(s) omitted to fit budget_`);
  }
  lines.push("");

  const section = (title: string, members: DeltaItemChange[]) => {
    if (members.length === 0) return;
    lines.push(`## ${title}`, "");
    for (const change of members) {
      lines.push(`- ${change.id}: ${escapeLine(change.title)} (${change.type}) — ${describeDeltaItem(change)}`);
    }
    lines.push("");
  };

  for (const { title, members } of groupDeltaSections(summary.items)) section(title, members);

  lines.push("## Refresh", "");
  lines.push("```", deltaRefreshCommand(summary), "```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export function renderTextDelta(summary: DeltaSummary): string {
  if (summary.items.length === 0) {
    return `No changes since ${summary.since}.\n`;
  }
  const t = summary.totals;
  const lines: string[] = [
    `Delta since ${summary.since}${summary.until ? ` until ${summary.until}` : ""}${summary.author ? ` by ${summary.author}` : ""} (${summary.workspace}, pm ${summary.pmVersion})`,
    `${t.itemsChanged} item(s) changed across ${t.events} event(s)${summary.truncated ? ` (truncated, ${summary.omittedItems ?? 0} omitted)` : ""}`,
    "",
  ];
  for (const change of summary.items) {
    lines.push(`${change.id}: ${escapeLine(change.title)} — ${describeDeltaItem(change)}`);
  }
  lines.push("");
  lines.push(`Refresh: ${deltaRefreshCommand(summary)}`);
  return `${lines.join("\n")}\n`;
}

export function renderSlackDelta(summary: DeltaSummary): string {
  if (summary.items.length === 0) {
    return `No changes since ${summary.since}.\n`;
  }
  const header = `*Delta since ${summary.since}${summary.until ? ` until ${summary.until}` : ""}${summary.author ? ` by ${summary.author}` : ""}*`;
  const meta = `_${summary.workspace} | pm ${summary.pmVersion} | generated ${summary.generatedAt}_`;
  const lines: string[] = [header, meta, ""];
  const t = summary.totals;
  lines.push(`*Summary* — ${t.itemsChanged} item(s) / ${t.events} event(s): ${t.created} created, ${t.closed} closed, ${t.canceled} canceled, ${t.reopened} reopened, ${t.statusChanged} status, ${t.reprioritized} repri, ${t.notes} notes, ${t.comments} comments${summary.truncated ? ` _(${summary.omittedItems ?? 0} omitted)_` : ""}`);
  lines.push("");
  const section = (title: string, members: DeltaItemChange[]) => {
    if (members.length === 0) return;
    lines.push(`*${title}*`);
    for (const change of members) {
      lines.push(`• \`${change.id}\` ${escapeLine(change.title)} (${change.type}) — ${describeDeltaItem(change)}`);
    }
    lines.push("");
  };
  for (const { title, members } of groupDeltaSections(summary.items)) section(title, members);
  lines.push(`Refresh: \`${deltaRefreshCommand(summary)}\``);
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// brief diverge — pre-merge pm item divergence preview
// ---------------------------------------------------------------------------

/** Fields that change on every write and must never, on their own, cause a collision. */
export const BENIGN_FIELDS = new Set(["/metadata/updated_at", "/metadata/updated", "/updated_at"]);

export interface DivergeEvent {
  ts: string;
  author?: string;
  op: string;
  patch?: Array<{ op: "add" | "replace" | "remove" | string; path: string; value?: unknown }>;
  before_hash?: string;
  after_hash?: string;
}

export interface DivergeItemSide {
  events: DivergeEvent[];
  itemPresent: boolean;
  malformedLines?: number;
}

export type DivergeKind =
  | "head-only"
  | "base-only"
  | "unchanged"
  | "duplicate-id"
  | "delete-vs-edit"
  | "field-collision"
  | "union-safe";

export interface DivergeItem {
  id: string;
  kind: DivergeKind;
  severity: "low" | "medium" | "high";
  collidingFields: string[];
  base: {
    eventCount: number;
    authors: string[];
    firstTs: string | undefined;
    lastTs: string | undefined;
    fields: string[];
    itemPresent: boolean;
    malformedLines: number;
  };
  head: {
    eventCount: number;
    authors: string[];
    firstTs: string | undefined;
    lastTs: string | undefined;
    fields: string[];
    itemPresent: boolean;
    malformedLines: number;
  };
}

export interface FenceStatus {
  attributesInstalled: boolean;
  driversConfigured: boolean;
  ok: boolean;
  missing: string[];
}

export interface DivergenceSummary {
  base: string;
  head: string;
  baseSha: string;
  headSha: string;
  ancestorSha: string | undefined;
  /**
   * True when base and head share no common ancestor. Always present so a JSON
   * consumer never has to infer it from an omitted `ancestorSha` (JSON.stringify
   * drops `undefined`). A `clean` verdict here means only "no item was touched by
   * both sides" — an unrelated-histories merge still rewrites the whole tree and
   * needs `--allow-unrelated-histories`, so the flag must be machine-readable.
   */
  unrelatedHistories: boolean;
  workspace: string;
  pmVersion: string;
  generatedAt: string;
  verdict: "clean" | "union-safe" | "review-required";
  totals: {
    itemsChanged: number;
    headOnly: number;
    baseOnly: number;
    unionSafe: number;
    fieldCollision: number;
    duplicateId: number;
    deleteVsEdit: number;
  };
  items: DivergeItem[];
  truncated?: boolean;
  omittedItems?: number;
  budget?: { requestedTokens: number; estimatedTokens: number };
  fence: FenceStatus;
  recommendedCommands: string[];
  /** Pending merge-decision receipts already in this clone; present only when there is at least one. */
  mergeDecisions?: MergeDecisionsSummary;
}

// ---- git readers (spawnSync git, cwd = repo root, maxBuffer 64 MiB) ----------

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** `git rev-parse --show-toplevel`; throws CommandError if not a git repo. */
export function resolveRepoRoot(cwd: string): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  if (result.status !== 0 || !result.stdout) {
    const detail = result.stderr?.trim() || result.error?.message || "not a git repository";
    throw new CommandError(`Unable to determine git repo root: ${detail}`, EXIT_CODE.USAGE);
  }
  return result.stdout.trim();
}

/** `git rev-parse --verify <ref>^{commit}`; throws CommandError naming the unknown ref. */
export function resolveRef(repoRoot: string, ref: string): string {
  const result = spawnSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  if (result.status !== 0 || !result.stdout) {
    const detail = result.stderr?.trim() || result.error?.message || "unknown ref";
    throw new CommandError(`Unknown git ref '${ref}': ${detail}`, EXIT_CODE.USAGE);
  }
  return result.stdout.trim();
}

/** Try origin/HEAD, main, master — return the first ref that resolves. Throw if none. */
export function detectDefaultBase(repoRoot: string): string {
  const symResult = spawnSync("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  if (symResult.status === 0 && symResult.stdout) {
    const symbolic = symResult.stdout.trim();
    const stripped = symbolic.startsWith("origin/") ? symbolic.slice("origin/".length) : symbolic;
    if (refResolves(repoRoot, stripped)) return stripped;
  }
  for (const candidate of ["main", "master"] as const) {
    if (refResolves(repoRoot, candidate)) return candidate;
  }
  throw new CommandError("Unable to detect a default base branch (tried origin/HEAD, main, master). Specify --base explicitly.", EXIT_CODE.USAGE);
}

function refResolves(repoRoot: string, ref: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

/**
 * Fail loudly when git could not run at all, as opposed to running and reporting
 * an expected negative result.
 *
 * This distinction is the whole safety property of `pm brief diverge`: a spawn
 * error, a killed process, or a `maxBuffer` overflow on a large ledger must never
 * be indistinguishable from "nothing changed" / "file absent", because that
 * renders as a `clean` verdict and an agent merges on the strength of it.
 * Exit *status* is deliberately left to each caller — for `merge-base` a non-zero
 * status is a legitimate answer, for `diff` it is not.
 */
function assertGitRan(result: ReturnType<typeof spawnSync>, what: string): void {
  if (result.error) {
    throw new CommandError(`git ${what} could not run: ${result.error.message}`, EXIT_CODE.USAGE);
  }
  if (result.signal) {
    throw new CommandError(`git ${what} was terminated by signal ${result.signal} (output may have exceeded the ${GIT_MAX_BUFFER} byte buffer)`, EXIT_CODE.USAGE);
  }
}

/**
 * `git merge-base a b`; undefined when the refs share no ancestor (unrelated
 * histories). Exit status 1 is that legitimate "no merge base" answer; any other
 * non-zero status is a real failure and must not be reported as unrelated
 * histories.
 */
export function mergeBase(repoRoot: string, a: string, b: string): string | undefined {
  const result = spawnSync("git", ["merge-base", a, b], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  assertGitRan(result, "merge-base");
  if (result.status === 1) return undefined;
  if (result.status !== 0) {
    throw new CommandError(`git merge-base failed: ${result.stderr?.trim() || `exit ${String(result.status)}`}`, EXIT_CODE.USAGE);
  }
  const sha = result.stdout?.trim();
  return sha || undefined;
}

/** `git diff --name-only --diff-filter=ACMRD <from> <to> -- <pathspec>`, or `git ls-tree` when fromSha is undefined. */
export function listChangedPaths(repoRoot: string, fromSha: string | undefined, toSha: string, pathspec: string): string[] {
  const args: string[] = fromSha
    ? ["diff", "--name-only", "--diff-filter=ACMRD", fromSha, toSha, "--", pathspec]
    : ["ls-tree", "-r", "--name-only", toSha, "--", pathspec];
  const result = spawnSync("git", args, { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  assertGitRan(result, args[0] ?? "diff");
  // Neither `diff` nor `ls-tree` has a "negative but fine" exit code here: an
  // empty change set is reported as status 0 with empty stdout.
  if (result.status !== 0) {
    throw new CommandError(`git ${args[0]} failed: ${result.stderr?.trim() || `exit ${String(result.status)}`}`, EXIT_CODE.USAGE);
  }
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/**
 * `git show <sha>:<path>`; undefined when the path does not exist at that
 * revision — the normal signal for "this item did not exist yet on that side".
 *
 * git reports a missing path with status 128 and a recognizable stderr, which is
 * also the status it uses for genuine errors (bad object, unreadable repo). The
 * stderr shape is therefore matched explicitly so a corrupt object cannot be
 * silently read as an absent item.
 */
export function readBlob(repoRoot: string, sha: string, path: string): string | undefined {
  const result = spawnSync("git", ["show", `${sha}:${path}`], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  assertGitRan(result, "show");
  if (result.status === 0) return result.stdout;
  const stderr = result.stderr?.trim() ?? "";
  if (/(does not exist|exists on disk, but not in|unknown revision or path|no such path)/i.test(stderr)) {
    return undefined;
  }
  throw new CommandError(`git show ${sha}:${path} failed: ${stderr || `exit ${String(result.status)}`}`, EXIT_CODE.USAGE);
}

// ---- path model --------------------------------------------------------------

/** Derive the pm workspace path relative to the repo root, normalized to POSIX separators. */
export function pmRootRelFromCtx(pmRoot: string, repoRoot: string): string {
  const absPmRoot = pathResolve(repoRoot, pmRoot);
  const rel = pathRelative(repoRoot, absPmRoot);
  // Test the parent-directory boundary rather than a bare ".." prefix, so a
  // legitimately named in-repo directory such as `..cache/pm` is not rejected as
  // being outside the repository.
  if (rel === ".." || rel.startsWith(`..${pathSep}`) || pathIsAbsolute(rel)) {
    throw new CommandError(`pm root '${pmRoot}' is outside the git repository root '${repoRoot}'`, EXIT_CODE.USAGE);
  }
  // An empty relative path means the pm root *is* the repository root, which would
  // make every downstream prefix (`${pmRootRel}/history/`) start with a bare "/"
  // and match nothing — the command would silently report no divergence at all.
  // Fail loudly instead.
  if (!rel) {
    throw new CommandError(`pm root '${pmRoot}' resolves to the git repository root '${repoRoot}'; pm brief diverge needs the tracker in a subdirectory so its paths can be matched against git output`, EXIT_CODE.USAGE);
  }
  return rel.split(pathSep).join("/");
}

// ---- event identity + parsing ------------------------------------------------

/**
 * Single-pass scan of a JSON-Lines history ledger.
 *
 * Returns the usable events *and* the count of unusable non-blank lines from one
 * `JSON.parse` per line. Doing this in one pass is both a correctness and a cost
 * fix: two independent scans previously disagreed about what "malformed" means —
 * a line that parsed as an object but carried no `ts` was dropped from the events
 * yet not counted as malformed, so the report under-stated exactly the data loss a
 * pre-merge check exists to surface. Ledgers can approach the 64 MiB read buffer,
 * so parsing each line twice was also the dominant cost of the command.
 *
 * "Unusable" therefore means any non-blank line that is not parseable JSON, is not
 * an object, or lacks a usable `ts` — the same predicate that decides whether the
 * line contributes an event.
 */
export function scanHistoryJsonl(text: string | undefined): { events: DivergeEvent[]; malformedLines: number } {
  if (!text) return { events: [], malformedLines: 0 };
  const events: DivergeEvent[] = [];
  let malformedLines = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: Record<string, unknown> | undefined;
    try {
      const candidate = JSON.parse(trimmed) as unknown;
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = undefined;
    }
    const ts = parsed && typeof parsed.ts === "string" ? parsed.ts : "";
    if (!parsed || !ts) {
      malformedLines++;
      continue;
    }
    events.push({
      ts,
      author: typeof parsed.author === "string" ? parsed.author : undefined,
      op: typeof parsed.op === "string" ? parsed.op : "activity",
      patch: Array.isArray(parsed.patch) ? (parsed.patch as DivergeEvent["patch"]) : undefined,
      before_hash: typeof parsed.before_hash === "string" ? parsed.before_hash : undefined,
      after_hash: typeof parsed.after_hash === "string" ? parsed.after_hash : undefined,
    });
  }
  return { events, malformedLines };
}

/** Parse a JSON-Lines history ledger text into DivergeEvent[]; thin wrapper over {@link scanHistoryJsonl}. */
export function parseHistoryJsonl(text: string | undefined): DivergeEvent[] {
  return scanHistoryJsonl(text).events;
}

/** Count unusable (non-blank, non-event) lines in a history ledger text; thin wrapper over {@link scanHistoryJsonl}. */
export function countMalformedLines(text: string | undefined): number {
  return scanHistoryJsonl(text).malformedLines;
}

/** Identity key for an event: after_hash when available, else ts|author|op. */
export function eventKey(e: DivergeEvent): string {
  return e.after_hash && e.after_hash.length > 0 ? e.after_hash : `${e.ts}|${e.author ?? ""}|${e.op ?? ""}`;
}

/** Events on a side whose key is not in the ancestor set. */
export function newEvents(sideEvents: DivergeEvent[], ancestorKeys: Set<string>): DivergeEvent[] {
  return sideEvents.filter((e) => !ancestorKeys.has(eventKey(e)));
}

// ---- field extraction --------------------------------------------------------

/** Extract every patch[].path, normalizing trailing numeric segments so array appends merge. */
export function changedFieldPaths(events: DivergeEvent[]): Set<string> {
  const fields = new Set<string>();
  for (const e of events) {
    if (!e.patch) continue;
    for (const p of e.patch) {
      if (typeof p.path !== "string" || !p.path) continue;
      fields.add(normalizeFieldPath(p.path));
    }
  }
  return fields;
}

/** Normalize trailing numeric array segments: /metadata/tags/3 → /metadata/tags. */
export function normalizeFieldPath(path: string): string {
  const segments = path.split("/");
  // drop trailing numeric segments
  while (segments.length > 1 && /^\d+$/.test(segments[segments.length - 1]!)) {
    segments.pop();
  }
  return segments.join("/");
}

// ---- per-item classification -------------------------------------------------

export function classifyItemDivergence(input: {
  id: string;
  ancestor: DivergeItemSide;
  base: DivergeItemSide;
  head: DivergeItemSide;
}): DivergeItem {
  const { id, ancestor, base, head } = input;

  const ancestorKeys = new Set(ancestor.events.map(eventKey));
  const baseNew = newEvents(base.events, ancestorKeys);
  const headNew = newEvents(head.events, ancestorKeys);

  const baseHasNew = baseNew.length > 0;
  const headHasNew = headNew.length > 0;

  const baseFields = [...changedFieldPaths(baseNew)].filter((f) => !BENIGN_FIELDS.has(f)).sort();
  const headFields = [...changedFieldPaths(headNew)].filter((f) => !BENIGN_FIELDS.has(f)).sort();

  const baseSide = summarizeSide(baseNew, base.itemPresent, base.malformedLines ?? 0);
  const headSide = summarizeSide(headNew, head.itemPresent, head.malformedLines ?? 0);

  let kind: DivergeKind;
  let severity: "low" | "medium" | "high";
  let collidingFields: string[] = [];

  if (!baseHasNew && !headHasNew) {
    kind = "unchanged";
    severity = "low";
  } else if (headHasNew && !baseHasNew) {
    kind = "head-only";
    severity = "low";
  } else if (baseHasNew && !headHasNew) {
    kind = "base-only";
    severity = "low";
  } else {
    // both sides have new events
    const ancestorPresent = ancestor.itemPresent;
    const basePresent = base.itemPresent;
    const headPresent = head.itemPresent;

    if (!ancestorPresent && basePresent && headPresent) {
      kind = "duplicate-id";
      severity = "high";
    } else if (basePresent !== headPresent) {
      // .toon absent on exactly one side but that side (or the other) has new events
      kind = "delete-vs-edit";
      severity = "high";
    } else {
      const collision = baseFields.filter((f) => headFields.includes(f));
      if (collision.length > 0) {
        kind = "field-collision";
        severity = "medium";
        collidingFields = [...new Set(collision)].sort();
      } else {
        kind = "union-safe";
        severity = "low";
      }
    }
  }

  return { id, kind, severity, collidingFields, base: baseSide, head: headSide };
}

/**
 * Summarize one side's contribution. Deliberately scoped to the events that are
 * NEW relative to the merge base — `eventCount` is the count of new events, not of
 * the side's whole history, since only new events can collide.
 */
function summarizeSide(newSideEvents: DivergeEvent[], itemPresent: boolean, malformedLines: number): DivergeItem["base"] {
  const sorted = [...newSideEvents].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const fields = [...changedFieldPaths(newSideEvents)].filter((f) => !BENIGN_FIELDS.has(f)).sort();
  const authors = [...new Set(sorted.map((e) => e.author ?? "").filter(Boolean))].sort();
  return {
    eventCount: newSideEvents.length,
    authors,
    firstTs: sorted[0]?.ts,
    lastTs: sorted[sorted.length - 1]?.ts,
    fields,
    itemPresent,
    malformedLines,
  };
}

// ---- fence check -------------------------------------------------------------

/**
 * Ask git which merge driver it would actually apply to representative pm paths.
 *
 * `git check-attr` is the authoritative resolver: it honours `.gitattributes` in
 * every parent directory of the target, the untracked `.git/info/attributes`, and
 * the global/system attributes files. Parsing only the repo-root `.gitattributes`
 * misses all of those, so a correctly fenced workspace could be reported as
 * unfenced — a false warning that tells the agent to run `pm merge install` it does
 * not need, and, worse, leaves the reverse case (reporting a fence that git will not
 * apply) equally possible.
 *
 * Returns a map of probe path to resolved `merge` attribute value. Values git
 * reports as `unspecified`, `unset` or `set` carry no driver name and are dropped.
 */
export function checkAttrMerge(repoRoot: string, paths: string[]): Map<string, string> {
  const resolved = new Map<string, string>();
  if (paths.length === 0) return resolved;
  const result = spawnSync("git", ["check-attr", "merge", "--", ...paths], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  assertGitRan(result, "check-attr");
  if (result.status !== 0) {
    throw new CommandError(`git check-attr failed: ${result.stderr?.trim() || `exit ${String(result.status)}`}`, EXIT_CODE.USAGE);
  }
  for (const line of result.stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Output shape: "<path>: merge: <value>". A path may itself contain ": ", so
    // split from the right on the known ": merge: " separator.
    const marker = trimmed.lastIndexOf(": merge: ");
    if (marker < 0) continue;
    const path = trimmed.slice(0, marker);
    const value = trimmed.slice(marker + ": merge: ".length).trim();
    if (!value || value === "unspecified" || value === "unset" || value === "set") continue;
    resolved.set(path, value);
  }
  return resolved;
}

/**
 * Build the probe paths whose resolved `merge` attribute decides fence status: one
 * history ledger and one item file. Real paths from the divergence scan are
 * preferred so the probe reflects the directories actually in play; the
 * conventional fallbacks keep the check meaningful when nothing changed.
 */
export function fenceProbePaths(pmRootRel: string, observedItemPath?: string): { historyPath: string; itemPath: string } {
  return {
    historyPath: `${pmRootRel}/history/pm-fence-probe.jsonl`,
    itemPath: observedItemPath ?? `${pmRootRel}/tasks/pm-fence-probe.toon`,
  };
}

export function evaluateFence(input: {
  /** Resolved `merge` attribute for an item `.toon` path, from `git check-attr`. */
  itemToonAttr?: string;
  /** Resolved `merge` attribute for a history `.jsonl` path, from `git check-attr`. */
  historyAttr?: string;
  itemToonDriver?: string;
  historyDriver?: string;
}): FenceStatus {
  const missing: string[] = [];

  const hasItemToon = input.itemToonAttr === "pm-item-toon";
  const hasHistory = input.historyAttr === "pm-history";
  const attributesInstalled = hasItemToon && hasHistory;
  if (!attributesInstalled) missing.push(".gitattributes merge=pm-item-toon / merge=pm-history entries");

  const driversConfigured = Boolean(input.itemToonDriver) && Boolean(input.historyDriver);
  if (!driversConfigured) missing.push("git config merge.pm-item-toon.driver / merge.pm-history.driver");

  return { attributesInstalled, driversConfigured, ok: attributesInstalled && driversConfigured, missing };
}

// ---- aggregate ---------------------------------------------------------------

const DIVERGE_SEVERITY_RANK: Record<DivergeKind, number> = {
  "duplicate-id": 0,
  "delete-vs-edit": 1,
  "field-collision": 2,
  "union-safe": 3,
  "head-only": 4,
  "base-only": 5,
  unchanged: 6,
};

export function buildDivergence(
  items: DivergeItem[],
  options: {
    base: string;
    head: string;
    baseSha: string;
    headSha: string;
    ancestorSha: string | undefined;
    workspace: string;
    pmVersion: string;
    generatedAt?: string;
    fence: FenceStatus;
    includeClean?: boolean;
    maxItems?: number;
    tokenBudget?: number;
    format?: string;
    ancestorDate?: string;
    mergeDecisions?: MergeDecisionsSummary;
  },
): DivergenceSummary {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const includeClean = options.includeClean ?? false;

  // filter out unchanged items always; head-only/base-only only with --include-clean
  const visible = items.filter((item) => {
    if (item.kind === "unchanged") return false;
    if (!includeClean && (item.kind === "head-only" || item.kind === "base-only")) return false;
    return true;
  });

  // deterministic ordering: most decision-relevant first, tie-break by id ascending
  visible.sort((a, b) => {
    const rankDiff = DIVERGE_SEVERITY_RANK[a.kind] - DIVERGE_SEVERITY_RANK[b.kind];
    if (rankDiff !== 0) return rankDiff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const totals = {
    itemsChanged: items.filter((i) => i.kind !== "unchanged").length,
    headOnly: items.filter((i) => i.kind === "head-only").length,
    baseOnly: items.filter((i) => i.kind === "base-only").length,
    unionSafe: items.filter((i) => i.kind === "union-safe").length,
    fieldCollision: items.filter((i) => i.kind === "field-collision").length,
    duplicateId: items.filter((i) => i.kind === "duplicate-id").length,
    deleteVsEdit: items.filter((i) => i.kind === "delete-vs-edit").length,
  };

  const hasReview = totals.fieldCollision > 0 || totals.duplicateId > 0 || totals.deleteVsEdit > 0;
  const hasBothSided = totals.unionSafe + totals.fieldCollision + totals.duplicateId + totals.deleteVsEdit > 0;
  const verdict: DivergenceSummary["verdict"] = !hasBothSided ? "clean" : hasReview ? "review-required" : "union-safe";

  // recommended commands (ordered, deduped, only what applies)
  const recommendedCommands: string[] = [];
  const unrelatedHistories = options.ancestorSha === undefined;
  if (!options.fence.ok) recommendedCommands.push("pm merge install");
  // Without a merge base git refuses outright ("fatal: refusing to merge unrelated
  // histories"), so recommending the bare form would hand the agent a command that
  // cannot succeed.
  recommendedCommands.push(
    unrelatedHistories ? `git merge --allow-unrelated-histories ${options.base}` : `git merge ${options.base}`,
  );
  if (hasBothSided) recommendedCommands.push("pm merge reconcile");
  const highSeverity = visible.filter((i) => i.severity === "high").slice(0, 5);
  for (const item of highSeverity) {
    recommendedCommands.push(`pm history ${item.id} --verify`);
  }
  if (options.ancestorSha && options.ancestorDate) {
    recommendedCommands.push(`pm brief since ${options.ancestorDate}`);
  }
  // When pending merge-decision receipts are present they belong in the recommended
  // next steps too — the agent should reconcile them before trusting its context.
  if (!mergeDecisionsIsEmpty(options.mergeDecisions)) {
    recommendedCommands.push("pm merge reconcile");
  }

  // apply maxItems + token budget trimming (same pattern as buildDelta)
  const maxItems = Math.max(1, Math.floor(options.maxItems ?? 40));
  const tokenBudget = options.tokenBudget ?? 4000;

  const summary: DivergenceSummary = {
    base: options.base,
    head: options.head,
    baseSha: options.baseSha,
    headSha: options.headSha,
    ancestorSha: options.ancestorSha,
    unrelatedHistories,
    workspace: options.workspace,
    pmVersion: options.pmVersion,
    generatedAt,
    verdict,
    totals,
    items: visible,
    fence: options.fence,
    recommendedCommands: dedupeStrings(recommendedCommands),
    mergeDecisions: mergeDecisionsIsEmpty(options.mergeDecisions) ? undefined : options.mergeDecisions,
  };

  applyDivergenceBudget(summary, maxItems, tokenBudget, options.format);
  return summary;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function estimateDivergenceTokens(summary: DivergenceSummary, format?: string): number {
  const rendered =
    format === "json" ? `${JSON.stringify(summary, null, 2)}\n`
    : format === "text" ? renderTextDivergence(summary)
    : format === "slack" ? renderSlackDivergence(summary)
    : renderMarkdownDivergence(summary);
  return estimateTokens(rendered);
}

function applyDivergenceBudget(summary: DivergenceSummary, maxItems: number, tokenBudget: number, format?: string): void {
  const full = summary.items;
  const capped = full.slice(0, maxItems);
  const probe = (items: DivergeItem[]) => estimateDivergenceTokens({ ...summary, items }, format);

  // Binary search the longest prefix that fits the budget. Dropping one item per
  // iteration re-rendered the whole summary each time, so a 40-item report cost ~40
  // full renders; this converges in ~log2(n) probes to the identical prefix length.
  // Items are already ordered most-decision-relevant first, so a prefix is the right
  // thing to keep, and at least one item is always retained.
  let working = capped;
  if (capped.length > 1 && probe(capped) > tokenBudget) {
    let fits = 1;                 // length 1 is always kept, fitting or not
    let tooBig = capped.length;   // known not to fit
    while (tooBig - fits > 1) {
      const mid = fits + Math.floor((tooBig - fits) / 2);
      if (probe(capped.slice(0, mid)) > tokenBudget) tooBig = mid;
      else fits = mid;
    }
    working = capped.slice(0, fits);
  }

  const omitted = full.length - working.length;
  summary.items = working;
  summary.truncated = omitted > 0 ? true : undefined;
  summary.omittedItems = omitted > 0 ? omitted : undefined;
  summary.budget = { requestedTokens: tokenBudget, estimatedTokens: probe(working) };
}

// ---- renderers ---------------------------------------------------------------

const DIVERGE_KIND_LABELS: Record<DivergeKind, string> = {
  "duplicate-id": "Duplicate ID (high)",
  "delete-vs-edit": "Delete vs Edit (high)",
  "field-collision": "Field Collision (medium)",
  "union-safe": "Union-Safe (low)",
  "head-only": "Head Only",
  "base-only": "Base Only",
  unchanged: "Unchanged",
};

function divergeItemLine(item: DivergeItem): string {
  const parts = [`${item.id}: ${DIVERGE_KIND_LABELS[item.kind]}`];
  if (item.collidingFields.length > 0) parts.push(`fields: ${item.collidingFields.join(", ")}`);
  parts.push(`base(${item.base.eventCount} ev, ${item.base.authors.join(",") || "-"}) head(${item.head.eventCount} ev, ${item.head.authors.join(",") || "-"})`);
  return parts.join(" — ");
}

export function renderMarkdownDivergence(summary: DivergenceSummary): string {
 const header = `# Divergence: ${summary.base} ← ${summary.head}`;
  if (summary.items.length === 0 && summary.totals.itemsChanged === 0) {
    // A clean divergence is exactly when a pending merge decision matters MOST:
    // nothing else changed, so the only thing worth reporting is that a peer's
    // value was discarded. Returning early here hid it from the DEFAULT output
    // while the JSON payload carried it (caught in review by Greptile's T-Rex run).
    const clean = `${header}\n\nNo pm item divergence between ${summary.base} and ${summary.head}.\n`;
    if (mergeDecisionsIsEmpty(summary.mergeDecisions)) return clean;
    return `${clean}\n${renderMergeDecisionsAgentPrompt(summary.mergeDecisions).join("\n")}\n`;
  }
  const lines: string[] = [
    header,
    "",
    `**Verdict: ${summary.verdict}** · ${summary.workspace} · pm ${summary.pmVersion} · generated ${summary.generatedAt}`,
    "",
  ];

  const t = summary.totals;
  lines.push(`## Totals`, "");
  lines.push(`- ${t.itemsChanged} item(s) changed: ${t.duplicateId} duplicate-id, ${t.deleteVsEdit} delete-vs-edit, ${t.fieldCollision} field-collision, ${t.unionSafe} union-safe, ${t.headOnly} head-only, ${t.baseOnly} base-only.`);
  if (summary.truncated) {
    lines.push(`- _truncated: ${summary.omittedItems ?? 0} lower-ranked item(s) omitted to fit budget_`);
  }
  if (summary.unrelatedHistories) {
    lines.push(`- _unrelated histories: ${summary.base} and ${summary.head} share no common ancestor; every changed item is one-sided._`);
  }
  lines.push("");

  if (!summary.fence.ok) {
    lines.push("## ⚠ Merge Driver Fence Not Installed", "");
    lines.push("The pm field-aware merge driver is NOT fully installed. Even **union-safe** items will hard-conflict on merge.");
    lines.push("Missing: " + summary.fence.missing.join("; "));
    lines.push("Run `pm merge install` before merging.", "");
  }
  lines.push(...renderMergeDecisionsMarkdown(summary.mergeDecisions));

  // group items by kind in severity order
  const grouped = groupDivergeItems(summary.items);
  for (const { title, members } of grouped) {
    lines.push(`## ${title}`, "");
    for (const item of members) {
      lines.push(`- ${divergeItemLine(item)}`);
    }
    lines.push("");
  }

  if (summary.recommendedCommands.length > 0) {
    lines.push("## Recommended next steps", "", "```");
    for (const cmd of summary.recommendedCommands) lines.push(cmd);
    lines.push("```", "");
  }

  return `${lines.join("\n")}\n`;
}

export function renderTextDivergence(summary: DivergenceSummary): string {
  if (summary.items.length === 0 && summary.totals.itemsChanged === 0) {
    const clean = `No pm item divergence between ${summary.base} and ${summary.head}.\n`;
    if (mergeDecisionsIsEmpty(summary.mergeDecisions)) return clean;
    const entries = summary.mergeDecisions!.receipts.map((e) => `  - \u26a0 ${mergeDecisionEntryText(e)}`);
    const omitted = mergeDecisionOmittedLines(summary.mergeDecisions!).map((line) => `  ${line.replace(/^- /, "")}`);
    return `${clean}\nPending merge decisions (run \`pm merge reconcile\`):\n${[...entries, ...omitted].join("\n")}\n`;
  }
  const t = summary.totals;
  const lines: string[] = [
    `Divergence: ${summary.base} <- ${summary.head} (verdict: ${summary.verdict})`,
    `${summary.workspace} | pm ${summary.pmVersion} | generated ${summary.generatedAt}`,
    `${t.itemsChanged} item(s) changed: ${t.duplicateId} dup-id, ${t.deleteVsEdit} del-vs-edit, ${t.fieldCollision} collision, ${t.unionSafe} union-safe, ${t.headOnly} head-only, ${t.baseOnly} base-only${summary.truncated ? ` (truncated, ${summary.omittedItems ?? 0} omitted)` : ""}`,
  ];
  if (summary.unrelatedHistories) {
    lines.push("unrelated histories: no common ancestor");
  }
  if (!summary.fence.ok) {
    lines.push(`WARNING: merge driver fence not installed (${summary.fence.missing.join("; ")}). Even union-safe items will hard-conflict. Run 'pm merge install'.`);
  }
  if (!mergeDecisionsIsEmpty(summary.mergeDecisions)) {
    const m = summary.mergeDecisions!;
    lines.push(`\u26a0 ${m.pendingCount} pending merge decision(s):`);
    for (const entry of m.receipts) lines.push(`  ${mergeDecisionEntryText(entry)}`);
    // Stating pendingCount is not enough on its own: receipts is capped, so the
    // omitted entries need naming and a route to the full list, exactly as the
    // clean-divergence path does.
    lines.push(...mergeDecisionOmittedLines(m).map((line) => `  ${line.replace(/^- /, "")}`));
  }
  lines.push("");
  for (const item of summary.items) {
    lines.push(divergeItemLine(item));
  }
  if (summary.recommendedCommands.length > 0) {
    lines.push("", "Recommended next steps:");
    for (const cmd of summary.recommendedCommands) lines.push(`  ${cmd}`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderSlackDivergence(summary: DivergenceSummary): string {
  if (summary.items.length === 0 && summary.totals.itemsChanged === 0) {
    const clean = `No pm item divergence between ${summary.base} and ${summary.head}.\n`;
    if (mergeDecisionsIsEmpty(summary.mergeDecisions)) return clean;
    const entries = summary.mergeDecisions!.receipts.map((e) => `• \u26a0 ${mergeDecisionEntryText(e)}`);
    const omitted = mergeDecisionOmittedLines(summary.mergeDecisions!).map((line) => line.replace(/^- /, "• "));
    return `${clean}\n*Pending merge decisions* — run \`pm merge reconcile\`\n${[...entries, ...omitted].join("\n")}\n`;
  }
  const t = summary.totals;
  const lines: string[] = [
    `*Divergence: ${summary.base} <- ${summary.head}*`,
    `_${summary.workspace} | pm ${summary.pmVersion} | generated ${summary.generatedAt}_`,
    `*Verdict: ${summary.verdict}* — ${t.itemsChanged} item(s): ${t.duplicateId} dup-id, ${t.deleteVsEdit} del-vs-edit, ${t.fieldCollision} collision, ${t.unionSafe} union-safe, ${t.headOnly} head-only, ${t.baseOnly} base-only${summary.truncated ? ` _(${summary.omittedItems ?? 0} omitted)_` : ""}`,
  ];
  if (summary.unrelatedHistories) {
    lines.push("_unrelated histories: no common ancestor_");
  }
  lines.push("");
  if (!summary.fence.ok) {
    lines.push(`*⚠ Merge driver fence not installed* — missing: ${summary.fence.missing.join("; ")}. Even union-safe items will hard-conflict. Run \`pm merge install\`.`);
  }
  lines.push(...renderMergeDecisionsSlack(summary.mergeDecisions));
  const grouped = groupDivergeItems(summary.items);
  for (const { title, members } of grouped) {
    lines.push(`*${title}*`);
    for (const item of members) {
      lines.push(`• \`${item.id}\` ${DIVERGE_KIND_LABELS[item.kind]}${item.collidingFields.length > 0 ? ` _fields: ${item.collidingFields.join(", ")}_` : ""} — base(${item.base.eventCount}ev) head(${item.head.eventCount}ev)`);
    }
    lines.push("");
  }
  if (summary.recommendedCommands.length > 0) {
    lines.push("*Recommended next steps*");
    for (const cmd of summary.recommendedCommands) lines.push(`\`${cmd}\``);
  }
  return `${lines.join("\n")}\n`;
}

function groupDivergeItems(items: DivergeItem[]): Array<{ title: string; members: DivergeItem[] }> {
  const order: DivergeKind[] = ["duplicate-id", "delete-vs-edit", "field-collision", "union-safe", "head-only", "base-only"];
  const groups = new Map<DivergeKind, DivergeItem[]>();
  for (const item of items) {
    const bucket = groups.get(item.kind);
    if (bucket) bucket.push(item);
    else groups.set(item.kind, [item]);
  }
  return order.filter((kind) => groups.has(kind)).map((kind) => ({ title: DIVERGE_KIND_LABELS[kind], members: groups.get(kind)! }));
}

// ---------------------------------------------------------------------------
// brief duplicates — post-merge near-duplicate item sweep
// ---------------------------------------------------------------------------

/** One side of a collapsed duplicate pair, carrying the fields the report needs. */
export interface DuplicatePairItem {
  /** Stable item id from the pm tracker. */
  id: string;
  /** Item title as stored in the tracker. */
  title: string;
  /** Lifecycle status (open, in_progress, closed, ...). */
  status: string;
  /** Item type (Task, Feature, Issue, ...). */
  type: string;
  /** Creation timestamp (ISO) used to pick the canonical item; undefined when missing. */
  createdAt?: string;
}

/** A collapsed, unordered near-duplicate pair keyed by a stable sorted-id pair. */
export interface DuplicatePair {
  /** Stable sorted-id pair key, e.g. "pm-a|pm-b". */
  id: string;
  /** Both members of the pair, sorted by id for stable output. */
  items: [DuplicatePairItem, DuplicatePairItem];
  /** Highest similarity score observed for the pair, rounded to 3 decimals. */
  score: number;
  /** Strongest deterministic match signal from the SDK (`exact_title`, `issue_code`, or `title_token_jaccard`). */
  reason: SimilarItemMatch["reason"];
  /** Advisory remediation command string; never executed by this command. */
  remediation: string;
}

/** Options controlling which items are scanned and how pairs are ranked/truncated. */
export interface DuplicateSweepOptions {
  /** Inclusive similarity threshold on the 0..1 scale (default 0.6). */
  threshold?: number;
  /** Maximum pairs to report, after ranking (default 20). */
  limit?: number;
  /** Statuses to consider as scan candidates; empty means all statuses. */
  statuses?: string[];
  /** When set, only items whose `created_at` is at or after this ISO timestamp are scanned. */
  since?: string;
  /** Timestamp used for the report header; defaults to now. */
  generatedAt?: string;
  /**
   * Candidates already selected by the caller. Supplying this skips re-running
   * the status/since filter and keeps one source of truth for the candidate set.
   */
  candidates?: readonly PmItem[];
}

/** Result of a post-merge near-duplicate sweep, returned as a bare object for JSON output. */
export interface DuplicateSweepSummary {
  /** Pairs ranked by score descending then pair id, truncated to `limit`. */
  pairs: DuplicatePair[];
  /** Number of pairs in `pairs` (equals `pairs.length`). */
  count: number;
  /** Total ranked pairs found before truncation to `limit`. */
  total: number;
  /** True when `limit` hid pairs, so `count` is not the whole finding. */
  truncated: boolean;
  /** Effective threshold applied to every `findSimilarItems` call. */
  threshold: number;
  /** Number of candidate items actually scanned with `findSimilarItems`. */
  scanned: number;
  /** ISO timestamp the summary was generated. */
  generatedAt: string;
}

/**
 * Select the candidate items that `brief duplicates` will scan with the SDK
 * similarity primitive. Mirrors the `--status` / `--since` filtering of the
 * command line: an empty `statuses` list means all statuses, and `since` keeps
 * only items created at or after the given ISO timestamp (post-merge mode).
 */
export function selectDuplicateCandidates(items: PmItem[], options: DuplicateSweepOptions = {}): PmItem[] {
  const statuses = options.statuses ?? [];
  // An unparseable `since` must FAIL, not silently widen the sweep. `Date.parse`
  // returns NaN for garbage, and `created < NaN` is always false, so a naive guard
  // would let every item through and report a "full sweep" the caller never asked
  // for. The CLI path pre-validates via parseSinceTimestamp, but this function is
  // exported, so direct SDK callers get the same protection here.
  let since = Number.NaN;
  if (options.since !== undefined) {
    since = Date.parse(options.since);
    if (!Number.isFinite(since)) {
      throw new CommandError(
        `since must be an ISO 8601 timestamp (received ${JSON.stringify(options.since)})`,
        EXIT_CODE.USAGE,
      );
    }
  }
  return items.filter((item) => {
    if (statuses.length && !statuses.includes(statusOf(item))) return false;
    if (Number.isFinite(since)) {
      const created = item.created_at ? Date.parse(item.created_at) : Number.NaN;
      if (!Number.isFinite(created) || created < since) return false;
    }
    return true;
  });
}

/**
 * Parse a `--since` value as a strict ISO 8601 timestamp (a bare date such as
 * `2026-07-20` or a full `2026-07-20T00:00:00Z`). Throws a `CommandError` with a
 * usage exit code when the value is not a parseable ISO timestamp, instead of
 * silently returning an empty result (the silent-empty bug filed as pm-cli#651).
 */
export function parseSinceTimestamp(raw: string): string {
  const value = raw.trim();
  const iso = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value);
  const parsed = iso ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new CommandError(
      `--since expects an ISO 8601 timestamp such as 2026-07-20 or 2026-07-20T00:00:00Z (got "${raw}")`,
      EXIT_CODE.USAGE,
    );
  }
  return value;
}

/**
 * Parse and validate `--threshold` on the inclusive 0..1 scale. Rejects
 * non-numeric, below-zero, and above-one values with a `CommandError` usage exit.
 */
export function parseDuplicateThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new CommandError(`--threshold must be a number between 0 and 1 (got "${raw}")`, EXIT_CODE.USAGE);
  }
  return value;
}

function pairItemId(left: string, right: string): string {
  return left < right ? `${left}|${right}` : `${right}|${left}`;
}

function duplicatePairItem(item: PmItem): DuplicatePairItem {
  return {
    id: item.id,
    title: titleOf(item),
    status: statusOf(item),
    type: typeOf(item),
    createdAt: item.created_at,
  };
}

/**
 * Build the advisory remediation command for a collapsed pair. The command is
 * output only and is never executed by `brief duplicates`:
 * - exactly one member closed → relate the open item to the closed one;
 * - otherwise (both open, both closed, or unknown) → keep the older (by
 *   `created_at`) as canonical and relate the newer to it, falling back to id
 *   ordering when creation timestamps are missing.
 */
export function duplicateRemediationCommand(a: DuplicatePairItem, b: DuplicatePairItem): string {
  const aClosed = isClosedStatus(a.status);
  const bClosed = isClosedStatus(b.status);
  if (aClosed !== bClosed) {
    const open = aClosed ? b : a;
    const closed = aClosed ? a : b;
    return `pm update ${open.id} --dep id=${closed.id},kind=related`;
  }
  const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
  const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
  let older: DuplicatePairItem;
  let newer: DuplicatePairItem;
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
    if (aTime <= bTime) { older = a; newer = b; } else { older = b; newer = a; }
  } else if (Number.isFinite(aTime)) {
    older = a; newer = b;
  } else if (Number.isFinite(bTime)) {
    older = b; newer = a;
  } else {
    older = a.id <= b.id ? a : b;
    newer = a.id <= b.id ? b : a;
  }
  return `pm update ${newer.id} --dep id=${older.id},kind=related`;
}

/**
 * Collapse raw per-candidate similarity matches into unordered pairs. When A
 * matches B and B matches A, a single pair keyed on the stable sorted-id pair is
 * emitted and keeps the highest score (and that score's reason) seen in either
 * direction. Pairs are ranked by score descending then pair id for stable output.
 */
export function collapseDuplicatePairs(
  candidates: readonly PmItem[],
  matchesByCandidate: ReadonlyMap<string, readonly SimilarItemMatch[]>,
  itemsById: ReadonlyMap<string, PmItem>,
): DuplicatePair[] {
  const best = new Map<
    string,
    { score: number; reason: SimilarItemMatch["reason"]; leftId: string; rightId: string }
  >();
  for (const candidate of candidates) {
    const matches = matchesByCandidate.get(candidate.id);
    if (!matches || matches.length === 0) continue;
    for (const match of matches) {
      if (match.id === candidate.id) continue;
      const key = pairItemId(candidate.id, match.id);
      const prior = best.get(key);
      if (!prior || match.score > prior.score) {
        best.set(key, { score: match.score, reason: match.reason, leftId: candidate.id, rightId: match.id });
      }
    }
  }
  const pairs: DuplicatePair[] = [];
  for (const [key, entry] of best) {
    // The ids travel in the entry rather than being re-parsed out of the key, so
    // the pair key stays an opaque identifier and nothing depends on ids never
    // containing the separator.
    const leftItem = itemsById.get(entry.leftId);
    const rightItem = itemsById.get(entry.rightId);
    // The matched side always comes from the SDK; the candidate side is a loaded
    // item. Both must resolve so titles/statuses/types/created_at are real.
    if (!leftItem || !rightItem) continue;
    const left = duplicatePairItem(leftItem);
    const right = duplicatePairItem(rightItem);
    const [a, b] = left.id <= right.id ? [left, right] : [right, left];
    pairs.push({
      id: key,
      items: [a, b],
      score: Math.round(entry.score * 1000) / 1000,
      reason: entry.reason,
      remediation: duplicateRemediationCommand(a, b),
    });
  }
  pairs.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return pairs;
}

/** Maximum similarity scans in flight at once during a duplicate sweep. */
const DUPLICATE_SCAN_CONCURRENCY = 8;

/**
 * Score every candidate against the tracker with the shared SDK similarity
 * primitive, running at most {@link DUPLICATE_SCAN_CONCURRENCY} scans at a time.
 *
 * Concurrency is safe and order-independent here: each scan is an independent
 * read, and `collapseDuplicatePairs` folds the results into unordered pairs and
 * re-sorts them, so the completion order cannot change the report. The cap exists
 * so a large workspace does not open an unbounded number of concurrent reads.
 *
 * Do not expect a large speed-up from raising the cap: the underlying scan is
 * CPU-bound, so on a 1,934-item tracker this bought ~7% wall clock but halved peak
 * memory (526MB to 268MB). See pm-cli#709 for the batch primitive that would
 * actually remove the cost.
 */
export async function scanCandidatesForDuplicates(
  candidates: readonly PmItem[],
  pmRoot: string,
  threshold: number,
): Promise<Map<string, SimilarItemMatch[]>> {
  const matchesByCandidate = new Map<string, SimilarItemMatch[]>();
  let next = 0;
  const workers = Array.from(
    { length: Math.min(DUPLICATE_SCAN_CONCURRENCY, candidates.length) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        const result = await findSimilarItems(
          { title: titleOf(candidate), description: candidate.description, excludeIds: [candidate.id] },
          { pmRoot, threshold, limit: 20 },
        );
        matchesByCandidate.set(candidate.id, result.items);
      }
    },
  );
  await Promise.all(workers);
  return matchesByCandidate;
}

/**
 * Build the full duplicate-sweep summary from precomputed per-candidate matches.
 * This is the pure, testable core of `brief duplicates`: it selects candidates
 * (status/since filtering), collapses matches into ranked pairs, truncates to
 * `limit`, and attaches the report metadata. The command handler supplies the
 * `findSimilarItems` results so tests never need a live tracker.
 */
export function buildDuplicateSweep(
  items: PmItem[],
  matchesByCandidate: ReadonlyMap<string, readonly SimilarItemMatch[]>,
  options: DuplicateSweepOptions = {},
): DuplicateSweepSummary {
  const threshold = options.threshold ?? 0.6;
  const limit = options.limit ?? 20;
  const itemsById = new Map<string, PmItem>();
  for (const item of items) itemsById.set(item.id, item);
  // A negative or zero limit is a caller mistake, not "no duplicates". Silently
  // returning an empty report alongside a non-zero `scanned` reads as a clean
  // tracker, which is the most misleading possible answer.
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CommandError(`limit must be a positive integer (received ${limit})`, EXIT_CODE.USAGE);
  }
  // The caller already had to select candidates in order to scan them, so it can
  // pass that exact list through. Re-deriving it here would run the same filter a
  // second time and leave two places that must agree about what a candidate is.
  const candidates = options.candidates ?? selectDuplicateCandidates(items, options);
  const ranked = collapseDuplicatePairs(candidates, matchesByCandidate, itemsById);
  const pairs = ranked.slice(0, limit);
  return {
    pairs,
    count: pairs.length,
    // `total` and `truncated` let a caller tell "3 pairs found" apart from "3 of
    // 40 shown", matching what `brief since` and `brief diverge` already expose.
    total: ranked.length,
    truncated: ranked.length > pairs.length,
    threshold,
    scanned: candidates.length,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  };
}

/** Render a duplicate-sweep summary as plain text (the default format). */
export function renderTextDuplicates(summary: DuplicateSweepSummary): string {
  const lines: string[] = [];
  if (summary.pairs.length === 0) {
    lines.push(`No likely duplicate items found (threshold ${summary.threshold}, scanned ${summary.scanned}).`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(`pm brief duplicates — ${summary.pairs.length} likely duplicate pair(s) (threshold ${summary.threshold}, scanned ${summary.scanned})`);
  lines.push("");
  for (const pair of summary.pairs) {
    lines.push(`${pair.id}  score ${pair.score}  ${pair.reason}`);
    for (const item of pair.items) {
      lines.push(`  ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status})`);
    }
    lines.push(`  → ${pair.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Render a duplicate-sweep summary as markdown. */
export function renderMarkdownDuplicates(summary: DuplicateSweepSummary): string {
  const lines: string[] = ["# pm brief duplicates", ""];
  lines.push(`Threshold ${summary.threshold} | scanned ${summary.scanned} | pairs ${summary.pairs.length} | generated ${summary.generatedAt}`);
  lines.push("");
  if (summary.pairs.length === 0) {
    lines.push("_No likely duplicate items found._");
    return `${lines.join("\n")}\n`;
  }
  for (const pair of summary.pairs) {
    lines.push(`## ${pair.id} — score ${pair.score} (${pair.reason})`);
    for (const item of pair.items) {
      lines.push(`- \`${item.id}\` ${escapeLine(item.title)} (${item.type}, ${item.status})`);
    }
    lines.push("");
    lines.push(`**Suggested:** \`${pair.remediation}\``);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}


/** Render a standalone governance summary as plain text (the `brief governance` default format). */
export function renderTextGovernance(g: GovernanceSummary): string {
  const lines: string[] = [`pm brief governance — generated ${g.generatedAt}`, ""];
  let any = false;
  if (g.duplicateClusters.length > 0) {
    any = true;
    const more = g.duplicateClustersTotal > g.duplicateClusters.length ? ` (+${g.duplicateClustersTotal - g.duplicateClusters.length} more)` : "";
    lines.push(`Duplicate clusters (threshold ${g.threshold})${more}:`);
    for (const cluster of g.duplicateClusters) {
      lines.push(`  ${cluster.clusterId}  score ${cluster.maxScore}  ${cluster.reason}`);
      for (const item of cluster.items) lines.push(`    ${item.id}: ${escapeLine(item.title)} (${item.type}, ${item.status})`);
      if (cluster.remediation) lines.push(`    \u2192 ${cluster.remediation}`);
    }
    lines.push("");
  }
  if (g.staleInProgress.length > 0) {
    any = true;
    const more = g.staleInProgressTotal > g.staleInProgress.length ? ` (+${g.staleInProgressTotal - g.staleInProgress.length} more)` : "";
    lines.push(`Stale in-progress (${g.staleThresholdHours}h threshold)${more}:`);
    for (const item of g.staleInProgress) {
      lines.push(`  ${item.id}: ${item.ageHours}h since last activity (${item.lastActivityAt})`);
      if (item.remediation) lines.push(`    \u2192 ${item.remediation}`);
    }
    lines.push("");
  }
  if (g.storageFindings.length > 0) {
    any = true;
    const more = g.storageFindingsTotal > g.storageFindings.length ? ` (+${g.storageFindingsTotal - g.storageFindings.length} more)` : "";
    lines.push(`Storage integrity${more}:`);
    for (const finding of g.storageFindings) {
      const idPart = finding.id ? ` ${finding.id}` : "";
      lines.push(`  ${finding.kind}${idPart}: ${finding.detail} (${finding.path})`);
      if (finding.remediation) lines.push(`    \u2192 ${finding.remediation}`);
    }
    lines.push("");
  }
  if (g.secretFindings.length > 0) {
    any = true;
    const more = g.secretFindingsTotal > g.secretFindings.length ? ` (+${g.secretFindingsTotal - g.secretFindings.length} more)` : "";
    // \u26a0 Secret values are NEVER printed \u2014 only item id, field, and detector rule.
    lines.push(`\u26a0 Secrets in item text${more}:`);
    for (const finding of g.secretFindings) {
      lines.push(`  ${finding.itemId} field ${finding.field} \u2014 detector: ${finding.rule}`);
      if (finding.remediation) lines.push(`    \u2192 ${finding.remediation}`);
    }
    lines.push("");
  }
  if (!any) lines.push("No governance findings.");
  return `${lines.join("\n")}\n`;
}

/** Render a standalone governance summary as markdown. */
export function renderMarkdownGovernance(g: GovernanceSummary): string {
  const lines = ["# pm brief governance", "", `Generated: ${g.generatedAt}`, ""];
  const body = renderGovernanceMarkdown(g);
  if (body.length === 0) lines.push("_No governance findings._");
  else lines.push(...body);
  return `${lines.join("\n")}\n`;
}

function registerCommands(api: ExtensionApi): void {
  const commonFlags: FlagDefinition[] = [
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
    { long: "--no-governance", description: "Skip the sdk/governance scan (duplicate clusters, stale in-progress, storage integrity, secrets) for a faster brief", type: "boolean" },
    { long: "--governance-threshold", value_name: "0..1", description: "Similarity threshold for the governance duplicate-cluster scan (default: 0.6)", type: "string" },
    { long: "--stale-hours", value_name: "n", description: "Stale in-progress threshold in hours for the governance scan (default: 72)", type: "string" },
  ];
  api.registerCommand({
    name: "brief",
    description: "Generate a token-budgeted agent brief from pm items.",
    intent: "turn pm state into compact next-work context for agents",
    examples: ["pm brief", "pm brief --focus pm-1234 --max-tokens 3000", "pm brief --dependency-order --format json"],
    flags: commonFlags,
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = resolveBriefFormat(options, ctx.global, "markdown");
      if (format !== "markdown" && format !== "json" && format !== "slack") throw new CommandError("--format must be markdown, json, or slack", EXIT_CODE.USAGE);
      const { focusIds, focusTypes } = parseFocus(asArray(options.focus));
      const includeHistory = readBool(options, "include-history", "includeHistory");
      const historyLimit = readInt(options, ["history-limit", "historyLimit"], 10);
      const briefDependencyOrder = readBool(options, "dependency-order", "dependencyOrder");
      const skipGovernance = readBool(options, "no-governance", "noGovernance");
      const generatedAt = new Date().toISOString();
      const items = readPmItems(ctx.pm_root);
      // Collect governance findings unless explicitly skipped. The scanners run
      // concurrently with no dependency on the brief's ranking, so they do not
      // block the build — but they are awaited here so the JSON/text output is
      // complete in one pass.
      const governance = skipGovernance ? undefined : await collectGovernanceSignals(items, {
        threshold: parseDuplicateThreshold(readString(options, "governance-threshold"), 0.6),
        staleHours: readNonNegativeInt(options, ["stale-hours", "staleHours"], 72),
        generatedAt,
        pmRoot: ctx.pm_root,
      });
      // Pending merge-decision receipts are always surfaced (never skippable): a
      // pending receipt means a peer's edit was silently discarded and the agent's
      // context is compromised, which is never safe to hide. `pm validate` reports
      // ok: true and never mentions receipts (unbraind/pm-cli#770).
      const mergeDecisions = await collectPendingMergeDecisions(ctx.pm_root);
      const brief = buildBrief(items, {
        tokenBudget: readInt(options, ["token-budget", "tokenBudget", "max-tokens", "maxTokens"], 4000),
        dependencyOrder: briefDependencyOrder,
        focusIds,
        focusTypes,
        statuses: asArray(options.status),
        assignee: readString(options, "assignee"),
        includeClosed: readBool(options, "include-closed", "includeClosed"),
        includeHistory,
        historyLimit,
        staleDays: readNonNegativeInt(options, ["stale-days", "staleDays"], 7),
        completedDays: readInt(options, ["completed-days", "completedDays"], 7),
        generatedAt,
        pmRoot: ctx.pm_root,
        pmVersion: pmVersion(),
        governance,
        mergeDecisions,
        // Keep the brief's next-work section aligned with `pm next` (companion gyi1).
        // Skipped under `--dependency-order` so the explicit prerequisite-first sort wins.
        nextOrder: briefDependencyOrder ? undefined : readNextOrderedIds(ctx.pm_root, { limit: 200, assignee: readString(options, "assignee") }),
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
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const { focusIds, focusTypes } = parseFocus(asArray(options.focus));
      const includeHistory = readBool(options, "include-history", "includeHistory");
      const historyLimit = readInt(options, ["history-limit", "historyLimit"], 10);
      const skipGovernance = readBool(options, "no-governance", "noGovernance");
      const generatedAt = new Date().toISOString();
      const items = readPmItems(ctx.pm_root);
      const governance = skipGovernance ? undefined : await collectGovernanceSignals(items, {
        threshold: parseDuplicateThreshold(readString(options, "governance-threshold"), 0.6),
        staleHours: readNonNegativeInt(options, ["stale-hours", "staleHours"], 72),
        generatedAt,
        pmRoot: ctx.pm_root,
      });
      const mergeDecisions = await collectPendingMergeDecisions(ctx.pm_root);
      const brief = buildBrief(items, {
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
        generatedAt,
        pmRoot: ctx.pm_root,
        pmVersion: pmVersion(),
        governance,
        mergeDecisions,
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
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = resolveBriefFormat(options, ctx.global, "text");
      if (format !== "text" && format !== "json") throw new CommandError("--format must be text or json", EXIT_CODE.USAGE);
      const nextCount = readInt(options, ["count"], 5);
      const assignee = readString(options, "assignee");
      const dependencyOrder = readBool(options, "dependency-order", "dependencyOrder");
      const nextOptions: BriefOptions = {
        nextCount,
        assignee,
        dependencyOrder,
        generatedAt: new Date().toISOString(),
        // Delegate ranking to the canonical `pm next` scorer so `brief next`
        // agrees with `pm next` on the top item (companion gyi1). Request a
        // generous window so the shown top-N is ordered from the full ready set.
        // Skipped when `--dependency-order` is requested: that flag deliberately
        // overrides the default ranking, so we avoid both the override and the
        // extra `pm next` subprocess.
        nextOrder: dependencyOrder ? undefined : readNextOrderedIds(ctx.pm_root, { limit: Math.max(nextCount, 200), assignee }),
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
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = resolveBriefFormat(options, ctx.global, "text");
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
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = resolveBriefFormat(options, ctx.global, "text");
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
  api.registerCommand({
    name: "brief since",
    description: "Summarize what changed in the workspace since a checkpoint (delta brief).",
    intent: "give an agent resuming work a precise, token-budgeted delta instead of a full re-read",
    examples: ["pm brief since 7d", "pm brief since 2026-07-20 --format json", "pm brief since 2026-07-20T00:00:00Z --until 2026-07-22 --by alice"],
    arguments: [{ name: "checkpoint", required: true, description: "Lower bound: a bare relative window treated as 'ago' (e.g. 7d, 24h, 2w), a signed relative (-7d), an ISO timestamp, or a date (2026-07-20)" }],
    flags: [
      { long: "--until", value_name: "checkpoint", description: "Upper bound timestamp/relative (pm activity --to)", type: "string" },
      { long: "--by", value_name: "name", description: "Only include changes made by this author", type: "string" },
      { long: "--limit", value_name: "n", description: "Max activity entries to scan (default 1000)", type: "string" },
      { long: "--max-items", value_name: "n", description: "Max changed items to render (default 40)", type: "string" },
      { long: "--token-budget", value_name: "n", description: "Approx max output token budget (alias --max-tokens; default 4000)", type: "string" },
      { long: "--max-tokens", value_name: "n", description: "Alias for --token-budget", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: markdown, text, json, or slack (default markdown)", type: "string" },
      { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const rawCheckpoint = (ctx.args?.[0] ?? "").trim();
      if (!rawCheckpoint) throw new CommandError("pm brief since requires a <checkpoint> (ISO timestamp or relative window like 7d)", EXIT_CODE.USAGE);
      const checkpoint = normalizeCheckpoint(rawCheckpoint);
      const format = resolveBriefFormat(options, ctx.global, "markdown");
      if (!["markdown", "text", "json", "slack"].includes(format)) throw new CommandError("--format must be markdown, text, json, or slack", EXIT_CODE.USAGE);
      const untilRaw = readString(options, "until");
      const until = untilRaw ? normalizeCheckpoint(untilRaw) : undefined;
      // This is a *filter* ("whose changes to show"), which is a different
      // concept from pm's host-owned global `--author` ("override mutation
      // author for this invocation"). The global cannot be reused here: agents
      // routinely run `pm --author <agent-id> …`, which would silently narrow
      // every brief to that agent's own changes. Hence the distinct `--by`.
      const author = readString(options, "by");
      const limit = readInt(options, ["limit"], 1000);
      const maxItems = readInt(options, ["max-items", "maxItems"], 40);
      const tokenBudget = readInt(options, ["token-budget", "tokenBudget", "max-tokens", "maxTokens"], 4000);
      const workspace = ctx.pm_root ?? ".agents/pm";
      const entries = readActivitySince(workspace, { from: checkpoint, to: until, author, limit });
      const items = readPmItems(workspace);
      const itemsById = new Map<string, PmItem>();
      for (const item of items) itemsById.set(item.id, item);
      const summary = buildDelta(entries, itemsById, {
        since: checkpoint,
        until,
        author,
        generatedAt: new Date().toISOString(),
        workspace,
        pmVersion: pmVersion(),
        maxItems,
        tokenBudget,
        format,
      });
      const outputPath = readString(options, "output");
      if (format === "json") {
        const output = `${JSON.stringify(summary, null, 2)}\n`;
        if (outputPath) {
          writeFileSync(outputPath, output, "utf-8");
          return { ok: true, format, output: outputPath, itemsChanged: summary.totals.itemsChanged, truncated: summary.truncated ?? false };
        }
        return renderedCommandResult(output);
      }
      const output = format === "text" ? renderTextDelta(summary) : format === "slack" ? renderSlackDelta(summary) : renderMarkdownDelta(summary);
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format, output: outputPath, itemsChanged: summary.totals.itemsChanged, truncated: summary.truncated ?? false };
      }
      return renderedCommandResult(output);
    },
  });
  api.registerCommand({
    name: "brief diverge",
    description: "Preview pm item divergence between two git branches before merging (multi-agent collision check).",
    intent: "let an agent see which items both branches touched, and whether the field-aware merge driver will resolve them cleanly, before running git merge",
    examples: ["pm brief diverge", "pm brief diverge main", "pm brief diverge --base main --head feat/other --format json"],
    arguments: [{ name: "base", required: false, description: "Base ref to compare against (default: origin/HEAD, else main, else master)" }],
    flags: [
      { long: "--base", value_name: "ref", description: "Explicit base ref (wins over positional)", type: "string" },
      { long: "--head", value_name: "ref", description: "Head ref (default: HEAD)", type: "string" },
      { long: "--include-clean", description: "Also list items touched by only one side individually", type: "boolean" },
      { long: "--max-items", value_name: "n", description: "Max items to render (default 40)", type: "string" },
      { long: "--token-budget", value_name: "n", description: "Approx max output token budget (alias --max-tokens; default 4000)", type: "string" },
      { long: "--max-tokens", value_name: "n", description: "Alias for --token-budget", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: markdown, text, json, or slack (default markdown)", type: "string" },
      { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const positionalBase = (ctx.args?.[0] ?? "").trim() || undefined;
      const explicitBase = readString(options, "base");
      const headRef = readString(options, "head") ?? "HEAD";
      const includeClean = readBool(options, "include-clean", "includeClean");
      const maxItems = readInt(options, ["max-items", "maxItems"], 40);
      const tokenBudget = readInt(options, ["token-budget", "tokenBudget", "max-tokens", "maxTokens"], 4000);
      const format = resolveBriefFormat(options, ctx.global, "markdown");
      if (!["markdown", "text", "json", "slack"].includes(format)) throw new CommandError("--format must be markdown, text, json, or slack", EXIT_CODE.USAGE);

      const workspace = ctx.pm_root ?? ".agents/pm";
      const cwd = process.cwd();
      const repoRoot = resolveRepoRoot(cwd);
      const pmRootRel = pmRootRelFromCtx(workspace, repoRoot);

      // resolve refs
      const baseRef = explicitBase ?? positionalBase ?? detectDefaultBase(repoRoot);
      const baseSha = resolveRef(repoRoot, baseRef);
      const headSha = resolveRef(repoRoot, headRef);
      const ancestorSha = mergeBase(repoRoot, baseSha, headSha);

      // ancestor commit date for the 'pm brief since' recommendation
      let ancestorDate: string | undefined;
      if (ancestorSha) {
        const dateResult = spawnSync("git", ["show", "-s", "--format=%cI", ancestorSha], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
        if (dateResult.status === 0 && dateResult.stdout?.trim()) ancestorDate = dateResult.stdout.trim();
      }

      // collect changed paths on each side relative to the ancestor
      const basePaths = ancestorSha
        ? listChangedPaths(repoRoot, ancestorSha, baseSha, pmRootRel)
        : listChangedPaths(repoRoot, undefined, baseSha, pmRootRel);
      const headPaths = ancestorSha
        ? listChangedPaths(repoRoot, ancestorSha, headSha, pmRootRel)
        : listChangedPaths(repoRoot, undefined, headSha, pmRootRel);

      // classify each path as history or toon, extract item ids
      const baseHistoryIds = new Set<string>();
      const baseToonIds = new Set<string>();
      classifyPaths(basePaths, pmRootRel, baseHistoryIds, baseToonIds);
      const headHistoryIds = new Set<string>();
      const headToonIds = new Set<string>();
      classifyPaths(headPaths, pmRootRel, headHistoryIds, headToonIds);

      // union of all touched item ids
      const allIds = new Set<string>([...baseHistoryIds, ...headHistoryIds, ...baseToonIds, ...headToonIds]);

      // Fence check: ask git which merge driver it would actually apply, rather than
      // parsing the repo-root .gitattributes — git also honours attributes files in
      // parent directories of the target and the untracked .git/info/attributes.
      // Probe a real observed .toon path when one is available so the answer reflects
      // the directory actually in play.
      const observedToonPath = [...basePaths, ...headPaths].find((p) => p.endsWith(".toon"));
      const probes = fenceProbePaths(pmRootRel, observedToonPath);
      const attrs = checkAttrMerge(repoRoot, [probes.historyPath, probes.itemPath]);
      const fence = evaluateFence({
        historyAttr: attrs.get(probes.historyPath),
        itemToonAttr: attrs.get(probes.itemPath),
        itemToonDriver: gitConfigGet(repoRoot, "merge.pm-item-toon.driver"),
        historyDriver: gitConfigGet(repoRoot, "merge.pm-history.driver"),
      });

      // The set of item ids with a .toon at a revision depends only on the revision,
      // so each of the three trees is listed exactly once here rather than once per
      // item per side (which cost 3N full-tree scans on a single invocation).
      // listChangedPaths is reused so a failed ls-tree raises instead of being read
      // as "the item is absent", which would misclassify items as delete-vs-edit.
      const toonIdsAt = (sha: string): Set<string> => {
        const toonIds = new Set<string>();
        classifyPaths(listChangedPaths(repoRoot, undefined, sha, pmRootRel), pmRootRel, new Set<string>(), toonIds);
        return toonIds;
      };
      const ancestorToonIds = ancestorSha ? toonIdsAt(ancestorSha) : new Set<string>();
      const baseToonIdsPresent = toonIdsAt(baseSha);
      const headToonIdsPresent = toonIdsAt(headSha);

      const items: DivergeItem[] = [];
      for (const itemId of allIds) {
        const historyRel = `${pmRootRel}/history/${itemId}.jsonl`;

        // One scan per ledger: scanHistoryJsonl returns events and the unusable-line
        // count together, so a ledger near the 64 MiB buffer is not JSON-parsed twice.
        const ancestorScan = ancestorSha ? scanHistoryJsonl(readBlob(repoRoot, ancestorSha, historyRel)) : { events: [], malformedLines: 0 };
        const ancestorPresent = ancestorToonIds.has(itemId);
        const baseScan = scanHistoryJsonl(readBlob(repoRoot, baseSha, historyRel));
        const basePresent = baseToonIdsPresent.has(itemId);
        const headScan = scanHistoryJsonl(readBlob(repoRoot, headSha, historyRel));
        const headPresent = headToonIdsPresent.has(itemId);

        items.push(classifyItemDivergence({
          id: itemId,
          ancestor: { events: ancestorScan.events, itemPresent: ancestorPresent },
          base: { events: baseScan.events, itemPresent: basePresent, malformedLines: baseScan.malformedLines },
          head: { events: headScan.events, itemPresent: headPresent, malformedLines: headScan.malformedLines },
        }));
      }

      const summary = buildDivergence(items, {
        base: baseRef,
        head: headRef,
        baseSha,
        headSha,
        ancestorSha,
        ancestorDate,
        workspace,
        pmVersion: pmVersion(),
        generatedAt: new Date().toISOString(),
        fence,
        includeClean,
        maxItems,
        tokenBudget,
        format,
        mergeDecisions: await collectPendingMergeDecisions(workspace),
      });

      const outputPath = readString(options, "output");
      if (format === "json") {
        const output = `${JSON.stringify(summary, null, 2)}\n`;
        if (outputPath) {
          writeFileSync(outputPath, output, "utf-8");
          return { ok: true, format, output: outputPath, verdict: summary.verdict, itemsChanged: summary.totals.itemsChanged, truncated: summary.truncated ?? false };
        }
        return renderedCommandResult(output);
      }
      const output = format === "text" ? renderTextDivergence(summary) : format === "slack" ? renderSlackDivergence(summary) : renderMarkdownDivergence(summary);
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format, output: outputPath, verdict: summary.verdict, itemsChanged: summary.totals.itemsChanged, truncated: summary.truncated ?? false };
      }
      return renderedCommandResult(output);
    },
  });
  api.registerCommand({
    name: "brief duplicates",
    description: "Sweep the merged tracker for near-duplicate items the create-time advisory cannot see across branches.",
    intent: "close the loop after merging multiple agent branches: report the duplicate pairs that landed on main and suggest a relate remediation for each",
    examples: ["pm brief duplicates", "pm brief duplicates --threshold 0.5 --since 2026-07-25", "pm brief duplicates --format json --limit 5"],
    flags: [
      { long: "--threshold", value_name: "0..1", description: "Inclusive similarity threshold on the 0..1 scale (default: 0.6)", type: "string" },
      { long: "--limit", value_name: "n", description: "Maximum pairs to report after ranking (default: 20)", type: "string" },
      { long: "--status", value_name: "status", description: "Statuses to consider as scan candidates, comma-separated (default: all)", type: "string" },
      { long: "--since", value_name: "ISO", description: "Post-merge mode: only scan items whose created_at is at or after this ISO 8601 timestamp", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: text, json, or markdown (default: text)", type: "string" },
      { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? (readBool(options, "json") ? "json" : "text")).toLowerCase();
      if (format !== "text" && format !== "json" && format !== "markdown") throw new CommandError("--format must be text, json, or markdown", EXIT_CODE.USAGE);
      const threshold = parseDuplicateThreshold(readString(options, "threshold"), 0.6);
      const limit = readNonNegativeInt(options, ["limit"], 20);
      if (limit <= 0) throw new CommandError("--limit must be a positive integer", EXIT_CODE.USAGE);
      const statuses = asArray(options.status);
      const sinceRaw = readString(options, "since");
      const since = sinceRaw ? parseSinceTimestamp(sinceRaw) : undefined;

      const workspace = ctx.pm_root ?? ".agents/pm";
      const items = readPmItems(workspace);
      const candidates = selectDuplicateCandidates(items, { statuses, since });
      // `findSimilarItems` is the shared SDK primitive `pm create` advisory mode uses,
      // so `brief duplicates` agrees exactly with create-time duplicate reports.
      // Each candidate excludes itself so an item never matches itself.
      //
      // The scans run with BOUNDED CONCURRENCY rather than one after another. Each
      // scan is an independent read and the results are collapsed into pairs and
      // re-sorted afterwards, so completion order cannot affect the output.
      //
      // Measured honestly on a real 1,934-item tracker: 39.1s/526MB sequential vs
      // 36.3s/268MB concurrent. The wall-clock gain is modest (~7%) because
      // `findSimilarItems` is CPU-bound — it tokenizes and scores in-process — and
      // concurrency cannot parallelize CPU work on a single-threaded event loop. The
      // real win is peak memory, roughly halved, because scan results are collapsed
      // as they arrive instead of N full result sets piling up. Removing the
      // remaining cost needs an SDK-side batch primitive (filed upstream as
      // pm-cli#709); `--since` remains the mitigation that actually matters.
      const matchesByCandidate = await scanCandidatesForDuplicates(candidates, workspace, threshold);
      const summary = buildDuplicateSweep(items, matchesByCandidate, { threshold, limit, statuses, since, generatedAt: new Date().toISOString(), candidates });

      if (format === "json") {
        const output = `${JSON.stringify(summary, null, 2)}\n`;
        const outputPath = readString(options, "output");
        if (outputPath) {
          writeFileSync(outputPath, output, "utf-8");
          return { ok: true, format, output: outputPath, count: summary.count, scanned: summary.scanned };
        }
        return renderedCommandResult(output);
      }
      const output = format === "markdown" ? renderMarkdownDuplicates(summary) : renderTextDuplicates(summary);
      const outputPath = readString(options, "output");
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format, output: outputPath, count: summary.count, scanned: summary.scanned };
      }
      return renderedCommandResult(output);
    },
  });
  api.registerCommand({
    name: "brief governance",
    description: "Surface governance findings (duplicate clusters, stale in-progress, storage integrity, secrets) from sdk/governance scanners.",
    intent: "give an agent or CI a cheap, token-budgeted view of the things that will waste its time: duplicates, dead in-progress work, storage corruption, and committed secrets",
    examples: ["pm brief governance", "pm brief governance --threshold 0.5 --format json", "pm brief governance --stale-hours 168"],
    flags: [
      { long: "--threshold", value_name: "0..1", description: "Similarity threshold for the duplicate-cluster scan (default: 0.6)", type: "string" },
      { long: "--stale-hours", value_name: "n", description: "Stale in-progress threshold in hours (default: 72)", type: "string" },
      { long: "--format", value_name: "format", description: "Output format: text, json, or markdown (default: text)", type: "string" },
      { long: "--output", value_name: "file", description: "Write output to a file", type: "string" },
    ],
    async run(ctx: CommandHandlerContext) {
      const options = ctx.options as Record<string, unknown>;
      const format = (readString(options, "format") ?? (readBool(options, "json") ? "json" : "text")).toLowerCase();
      if (format !== "text" && format !== "json" && format !== "markdown") throw new CommandError("--format must be text, json, or markdown", EXIT_CODE.USAGE);
      const threshold = parseDuplicateThreshold(readString(options, "threshold"), 0.6);
      const staleHours = readNonNegativeInt(options, ["stale-hours", "staleHours"], 72);
      const workspace = ctx.pm_root ?? ".agents/pm";
      const items = readPmItems(workspace);
      const summary = await collectGovernanceSignals(items, {
        threshold,
        staleHours,
        generatedAt: new Date().toISOString(),
        pmRoot: workspace,
      });
      if (format === "json") {
        const output = `${JSON.stringify(summary, null, 2)}\n`;
        const outputPath = readString(options, "output");
        if (outputPath) {
          writeFileSync(outputPath, output, "utf-8");
          return { ok: true, format, output: outputPath, duplicates: summary.duplicateClustersTotal, stale: summary.staleInProgressTotal, storage: summary.storageFindingsTotal, secrets: summary.secretFindingsTotal };
        }
        return renderedCommandResult(output);
      }
      const output = format === "markdown" ? renderMarkdownGovernance(summary) : renderTextGovernance(summary);
      const outputPath = readString(options, "output");
      if (outputPath) {
        writeFileSync(outputPath, output, "utf-8");
        return { ok: true, format, output: outputPath, duplicates: summary.duplicateClustersTotal, stale: summary.staleInProgressTotal, storage: summary.storageFindingsTotal, secrets: summary.secretFindingsTotal };
      }
      return renderedCommandResult(output);
    },
  });
}

function gitConfigGet(repoRoot: string, key: string): string | undefined {
  const result = spawnSync("git", ["config", "--get", key], { cwd: repoRoot, encoding: "utf-8", maxBuffer: GIT_MAX_BUFFER });
  if (result.status !== 0) return undefined;
  const value = result.stdout?.trim();
  return value || undefined;
}

function classifyPaths(paths: string[], pmRootRel: string, historyIds: Set<string>, toonIds: Set<string>): void {
  const historyPrefix = `${pmRootRel}/history/`;
  for (const path of paths) {
    if (path.startsWith(historyPrefix) && path.endsWith(".jsonl")) {
      const basename = path.slice(historyPrefix.length, -".jsonl".length);
      historyIds.add(basename);
    } else if (path.endsWith(".toon")) {
      const slashIdx = path.lastIndexOf("/");
      const basename = slashIdx >= 0 ? path.slice(slashIdx + 1, -".toon".length) : path.slice(0, -".toon".length);
      toonIds.add(basename);
    }
  }
}

export default defineExtension({
  name: "pm-brief",
  version: "2026.7.27",
  description: "Token-budgeted agent briefs and next-work plans for pm workspaces",
  activate(api: ExtensionApi) {
    registerCommands(api);
    if (typeof api.registerRenderer === "function") {
      api.registerRenderer("toon", renderCommandResult);
      api.registerRenderer("json", renderCommandResult);
    }
  },
});
