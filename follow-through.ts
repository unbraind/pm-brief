import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import {
  PmClient, certifyCompleteListResult, createPmCliExpectedError, estimatePmOutputTokens,
  getHistoryPath, readHistorySnapshot, readSettings, resolveRuntimeStatusRegistry, verifyHistoryEntries,
} from "@unbrained/pm-cli/sdk";
import type { ListedItem } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

/** One explicit judgement about an exact native observation revision. */
export interface FollowThroughObservation { item: string; revision: string; verdict: "observed" | "contradicted" }
/** A declared consequence, with independent observations and follow-up work. */
export interface FollowThroughOutcome { id: string; expected: string; observations: FollowThroughObservation[]; actions: string[] }
/** Stored on a native Decision as brief_follow_through; status never implies adoption. */
export interface FollowThroughDeclaration { version: 1; adopted: boolean; outcomes: FollowThroughOutcome[] }
/** Read-only selection, validated before acquiring SDK state. */
export interface FollowThroughRequest { decision: string; tokenBudget?: number }
/** Native SDK context; the host supplies its own client when invoking the command. */
export interface FollowThroughOptions { pmRoot: string; client?: PmClient }
/** Typed recovery categories shared by SDK and CLI. */
export type FollowThroughRefusalCode = "invalid" | "missing" | "not_adopted" | "tracker" | "changed" | "budget";
/** A safe expected failure with a concrete next action. */
export class FollowThroughError extends Error {
  /** Stable category, independent of human wording. */
  readonly code: FollowThroughRefusalCode;
  /** Concrete correction before retrying. */
  readonly remedy: string;
  /** Preserve diagnostics without echoing tracker content. */
  constructor(code: FollowThroughRefusalCode, message: string, remedy: string) {
    super(message); this.name = "FollowThroughError"; this.code = code; this.remedy = remedy;
  }
}
/** Current evidence is kept apart from stale, missing or empty observations. */
export interface FollowThroughEvidence extends FollowThroughObservation {
  freshness: "current" | "changed" | "missing" | "empty" | "unreadable";
  currentRevision: string | null;
}
/** Native roles decide follow-up state; terminal work is never outcome evidence. */
export interface FollowThroughAction { item: string; state: "pending" | "blocked" | "done" | "canceled" | "terminal" | "missing"; roles: string[] }
/** Every declared row survives compaction, including malformed rows. */
export interface FollowThroughRow {
  id: string;
  state: "unsupported" | "observed" | "contradicted" | "conflicted";
  omitted: number;
  expected?: string;
  observations?: FollowThroughEvidence[];
  actions?: FollowThroughAction[];
  refusal?: { code: "invalid_outcome"; remedy: string };
}
/** Whole-outcome summaries and exact omission counts, sized for native JSON and TOON. */
export interface DecisionFollowThroughBrief {
  protocol: "pm-brief.follow-through/v1";
  decision: string;
  outcomes: FollowThroughRow[];
  restore: string;
  estimatedTokenCeiling: number;
}

/** Single strict schema for command input and persisted declarations. */
export const FOLLOW_THROUGH_SCHEMA = {
  id: { max: 200, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
  revision: { max: 64, pattern: /^[a-f0-9]{64}$/ },
  expected: { max: 16000 },
  outcomes: { max: 128 },
  observations: { max: 32 },
  actions: { max: 32 },
  tokenBudget: { min: 1, max: 64000, default: 1500 },
} as const;

/** Reject invalid JSON data without invoking getters or printing supplied values. */
function invalid(): never { throw new FollowThroughError("invalid", "Invalid follow-through data", "Use version 1, explicit adopted boolean, 1..128 dense outcome rows with unique ids, expected text (1..16000 characters), observations {item,revision,verdict}, and action ids (at most 32 each); reject unknown keys; tokenBudget must be an integer 1..64000"); }
/** Read a strict plain own-data object with exactly the allowed keys. */
function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key !== "string" || ![...required, ...optional].includes(key)) || required.some(key => !Object.hasOwn(value, key))) return invalid();
  const result: Record<string, unknown> = Object.create(null);
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!Object.hasOwn(descriptor, "value")) return invalid();
    result[key] = descriptor.value;
  }
  return result;
}
/** Detach dense bounded arrays, excluding accessors and extra properties. */
function array(value: unknown, max: number): unknown[] {
  if (!value || typeof value !== "object" || utilTypes.isProxy(value) || !Array.isArray(value) || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return invalid();
    result.push(descriptor.value);
  }
  return result;
}
/** Apply a text field's own schema without rewriting recorded whitespace. */
function text(value: unknown, rule: { max: number; pattern?: RegExp }): string {
  if (typeof value !== "string" || !value.trim() || value.length > rule.max || value.includes("\0") || (rule.pattern && !rule.pattern.test(value))) return invalid();
  return value;
}
/** Validate a single outcome, shared by persisted readers and declaration producers. */
function outcome(value: unknown): FollowThroughOutcome {
  const row = record(value, ["id", "expected", "observations", "actions"]); const schema = FOLLOW_THROUGH_SCHEMA;
  const observations = array(row.observations, schema.observations.max).map((value): FollowThroughObservation => {
    const row = record(value, ["item", "revision", "verdict"]);
    if (row.verdict !== "observed" && row.verdict !== "contradicted") return invalid();
    return { item: text(row.item, schema.id), revision: text(row.revision, schema.revision), verdict: row.verdict };
  });
  const actions = array(row.actions, schema.actions.max).map(value => text(value, schema.id));
  if (new Set(actions).size !== actions.length || new Set(observations.map(row => row.item)).size !== observations.length) return invalid();
  return { id: text(row.id, schema.id), expected: text(row.expected, schema.expected), observations, actions };
}
/** Parse a complete producer declaration; invalid records refuse before native writes. */
export function parseFollowThroughDeclaration(value: unknown): FollowThroughDeclaration {
  const row = declaration(value); const outcomes = row.outcomes.map(outcome);
  if (new Set(outcomes.map(row => row.id)).size !== outcomes.length) return invalid();
  return { version: 1, adopted: row.adopted, outcomes };
}
/** Validate the framing once; readers isolate malformed individual outcome records below. */
function declaration(value: unknown): { adopted: boolean; outcomes: unknown[] } {
  const row = record(value, ["version", "adopted", "outcomes"]);
  if (row.version !== 1 || typeof row.adopted !== "boolean") return invalid();
  const outcomes = array(row.outcomes, FOLLOW_THROUGH_SCHEMA.outcomes.max);
  if (!outcomes.length) return invalid();
  return { adopted: row.adopted, outcomes };
}
/** Validate the SDK/CLI selection through one boundary, before any tracker access. */
export function parseFollowThroughRequest(value: unknown): Required<FollowThroughRequest> {
  const row = record(value, ["decision"], ["tokenBudget"]); const rule = FOLLOW_THROUGH_SCHEMA.tokenBudget;
  const tokenBudget = row.tokenBudget === undefined ? rule.default : row.tokenBudget;
  if (typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget < rule.min || tokenBudget > rule.max) return invalid();
  return { decision: text(row.decision, FOLLOW_THROUGH_SCHEMA.id), tokenBudget };
}
/** Bind evidence to SDK-read state AND the complete append-only stream, detecting ABA/replay. */
async function revision(item: ListedItem, pmRoot: string): Promise<string> {
  const history = await readHistorySnapshot(getHistoryPath(pmRoot, item.id), item.id);
  if (!history.entries.length || !verifyHistoryEntries(history.entries).ok) throw new FollowThroughError("tracker", "Observation history is unavailable", "Restore readable verified native history before certifying observation revisions");
  return createHash("sha256").update(JSON.stringify([item, history.raw])).digest("hex");
}
/** Isolate unreadable observation history from otherwise independent outcomes. */
async function availableRevision(item: ListedItem, pmRoot: string): Promise<string | null> {
  try { return await revision(item, pmRoot); } catch { return null; }
}
/** Obtain a copyable source revision without interpreting content or item status. */
export async function readFollowThroughObservation(item: string, options: FollowThroughOptions): Promise<{ item: string; revision: string }> {
  const selected = parseFollowThroughRequest({ decision: item });
  try {
    const client = options.client ?? new PmClient({ pmRoot: options.pmRoot, noExtensions: true });
    const rows = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const source = rows.find(row => row.id === selected.decision);
    if (!source) throw new FollowThroughError("missing", "Observation item does not exist", "Select an exact native item id from pm list --all --full");
    const current = await revision(source, options.pmRoot);
    const fresh = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items.find(row => row.id === source.id);
    if (!fresh || current !== await revision(fresh, options.pmRoot)) throw new FollowThroughError("changed", "Observation changed during read", "Read the observation again before recording its judgement");
    return { item: source.id, revision: current };
  } catch (error) {
    if (error instanceof FollowThroughError) throw error;
    throw new FollowThroughError("tracker", "Cannot read observation revision", "Run pm health and restore readable native item and history state");
  }
}
/** Native estimator covers pretty JSON, TOON escaping/framing, and the receipt itself. */
function measure(result: DecisionFollowThroughBrief): number {
  result.estimatedTokenCeiling = 64000;
  result.estimatedTokenCeiling = estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(result, null, 2)) * 2 + 256);
  return result.estimatedTokenCeiling;
}
/** Compare declared consequences after explicit adoption, without writing, inferring or selecting work. */
export async function buildDecisionFollowThroughBrief(value: FollowThroughRequest, options: FollowThroughOptions): Promise<DecisionFollowThroughBrief> {
  const request = parseFollowThroughRequest(value);
  try {
    const client = options.client ?? new PmClient({ pmRoot: options.pmRoot, noExtensions: true });
    const settings = await readSettings(options.pmRoot);
    const registry = resolveRuntimeStatusRegistry(settings.schema);
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const rows = new Map(items.map(row => [row.id, row])); const decision = rows.get(request.decision);
    if (!decision) throw new FollowThroughError("missing", "Decision does not exist", "Select an exact native Decision id from pm list --all --full");
    if (decision.type !== "Decision" || decision.brief_follow_through === undefined) throw new FollowThroughError("not_adopted", "No explicit Decision declaration", "Record brief_follow_through on a native Decision with version 1, adopted true and declared outcomes; closed status is insufficient");
    const declared = declaration(decision.brief_follow_through);
    if (!declared.adopted) throw new FollowThroughError("not_adopted", "Decision has not been explicitly adopted", "Explicitly adopt the declaration before following its outcomes; alternatives remain available before adoption");
    const revisions = new Map<string, string | null>(); const details: Partial<FollowThroughRow>[] = [];
    const parsed = declared.outcomes.map(value => { try { return outcome(value); } catch { return null; } });
    const result: DecisionFollowThroughBrief = { protocol: "pm-brief.follow-through/v1", decision: decision.id, outcomes: [], restore: `pm get ${decision.id} --full`, estimatedTokenCeiling: 0 };
    for (const [index, entry] of parsed.entries()) {
      if (!entry || parsed.some((other, position) => position !== index && other?.id === entry.id)) {
        result.outcomes.push({ id: `index:${index}`, state: "unsupported", omitted: 0, refusal: { code: "invalid_outcome", remedy: `Correct brief_follow_through.outcomes[${index}] through native update; other outcomes remain independent` } }); details.push({}); continue;
      }
      const observations: FollowThroughEvidence[] = [];
      for (const observation of entry.observations) {
        const source = rows.get(observation.item);
        if (source && !revisions.has(source.id)) revisions.set(source.id, await availableRevision(source, options.pmRoot));
        const currentRevision = revisions.get(observation.item) ?? null;
        observations.push({ ...observation, currentRevision, freshness: !source ? "missing" : currentRevision === null ? "unreadable" : currentRevision !== observation.revision ? "changed" : !source.actual_result?.trim() ? "empty" : "current" });
      }
      const current = observations.filter(row => row.freshness === "current");
      const observed = current.some(row => row.verdict === "observed"); const contradicted = current.some(row => row.verdict === "contradicted");
      const actions: FollowThroughAction[] = entry.actions.map(item => {
        const source = rows.get(item); const roles = [...(source ? registry.by_id.get(source.status)?.roles ?? [] : [])];
        const state = !source ? "missing" : roles.includes("terminal_canceled") ? "canceled" : roles.includes("terminal_done") ? "done" : roles.includes("terminal") ? "terminal" : roles.includes("blocked") ? "blocked" : "pending";
        return { item, state, roles };
      });
      result.outcomes.push({ id: entry.id, state: observed && contradicted ? "conflicted" : contradicted ? "contradicted" : observed ? "observed" : "unsupported", omitted: 1 + observations.length + actions.length });
      details.push({ expected: entry.expected, observations, actions });
    }
    // Re-read everything used before returning. Saved declarations are never authority for a later read.
    const fresh = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    if (JSON.stringify(items) !== JSON.stringify(fresh) || JSON.stringify(settings) !== JSON.stringify(await readSettings(options.pmRoot))) throw new FollowThroughError("changed", "Tracker changed during follow-through", "Retry against current native state");
    for (const [id, expected] of revisions) if (expected !== await availableRevision(rows.get(id)!, options.pmRoot)) throw new FollowThroughError("changed", "Observation history changed during follow-through", "Retry and review the changed observation revision before renewing its judgement");
    if (measure(result) > request.tokenBudget) throw new FollowThroughError("budget", "Outcome summaries exceed the token budget", "Increase --token-budget up to 64000; every outcome and invalid-row refusal must remain visible");
    // Whole detail groups fit or are explicitly omitted. State and outcome identity are mandatory.
    for (const [index, detail] of details.entries()) {
      const row = result.outcomes[index]; if (row.refusal) continue;
      const omitted = row.omitted; Object.assign(row, detail); row.omitted = 0;
      if (measure(result) > request.tokenBudget) { delete row.expected; delete row.observations; delete row.actions; row.omitted = omitted; }
    }
    measure(result);
    validateFollowThroughAccounting(result, request.tokenBudget);
    return result;
  } catch (error) {
    if (error instanceof FollowThroughError) throw error;
    throw new FollowThroughError("tracker", "Cannot certify follow-through state", "Run pm health and restore readable native items, history and status definitions");
  }
}

/** Validate every emitted number against the same declaration and budget bounds. */
export function validateFollowThroughAccounting(result: DecisionFollowThroughBrief, budget: number): void {
  const schema = FOLLOW_THROUGH_SCHEMA;
  if (!Number.isSafeInteger(result.estimatedTokenCeiling) || result.estimatedTokenCeiling < 1 || result.estimatedTokenCeiling > budget || !Number.isSafeInteger(budget) || budget < schema.tokenBudget.min || budget > schema.tokenBudget.max || result.outcomes.some(row => !Number.isSafeInteger(row.omitted) || row.omitted < 0 || row.omitted > 1 + schema.observations.max + schema.actions.max)) throw new FollowThroughError("budget", "Output accounting is outside its domain", "Retry with a larger token budget and valid bounded declarations");
}

/** Register native declaration metadata and read-only host-rendered JSON/TOON commands. */
export function registerDecisionFollowThroughCommands(api: ExtensionApi): void {
  api.registerItemFields([{ name: "brief_follow_through", type: "object", optional: true }]);
  for (const observation of [false, true]) api.registerCommand({
    name: observation ? "brief observation" : "brief follow-through",
    description: observation ? "Read a native observation revision for an explicit outcome judgement" : "Follow declared consequences after explicit Decision adoption",
    arguments: [{ name: observation ? "item" : "decision", required: true, description: "Exact native item id" }],
    read_output: { row_keys: [] },
    flags: observation ? [] : [{ long: "--token-budget", type: "string", value_name: "n", description: "Complete TOON/JSON ceiling 1..64000 (default 1500)" }],
    async run(ctx) {
      try {
        if (ctx.args.length !== 1 || (ctx.options.tokenBudget !== undefined && (typeof ctx.options.tokenBudget !== "string" || !/^[0-9]+$/.test(ctx.options.tokenBudget)))) return invalid();
        const options = { pmRoot: ctx.pm_root, client: ctx.sdk?.client };
        return observation ? await readFollowThroughObservation(ctx.args[0], options) : await buildDecisionFollowThroughBrief({ decision: ctx.args[0], ...(ctx.options.tokenBudget === undefined ? {} : { tokenBudget: Number(ctx.options.tokenBudget) }) }, options);
      } catch (error) {
        const refusal = error instanceof FollowThroughError ? error : new FollowThroughError("tracker", "Follow-through read failed", "Run pm health and retry against readable native state");
        throw createPmCliExpectedError(`follow-through ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: 2, context: { code: `follow_through_${refusal.code}`, required: refusal.remedy } });
      }
    },
  });
}
