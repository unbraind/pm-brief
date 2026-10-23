import { readFile } from "node:fs/promises";
import { PmClient, certifyCompleteListResult, createPmCliExpectedError, estimatePmOutputTokens, scanMutationSecrets } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";
import { buildBrief } from "./index.ts";
import type { AgentBrief } from "./index.ts";

/** Fixed audiences; callers may narrow a profile but cannot widen it. */
export type DisclosureProfile = "internal" | "external" | "public";
/** Brief sections containing the same ranked-item shape. */
type ItemSection = "focus" | "next" | "decisionsNeeded";
/** Supported scalar fields in ranked items. */
type ItemField = "id" | "title" | "type" | "status" | "priority" | "assignee" | "whyNow" | "rankingScore" | "confidence" | "tokenCostEstimate" | "mergeCompromised";
/** Known selectors, using * for array indices; unknown selectors are refused. */
export type DisclosureField = "generatedAt" | "workspace.root" | "workspace.pmVersion" | "workspace.itemCount"
  | "budget.requestedTokens" | "budget.estimatedTokens" | "budget.truncated"
  | `${ItemSection}.*.${ItemField}`
  | `${ItemSection}.*.${"tags" | "rankingReasons" | "requiredContext" | "dependencyIds" | "dependentIds"}.*`
  | `blockers.*.${"itemId" | "blockedBy" | "kind" | "title" | "status"}`
  | `risks.*.${"itemId" | "severity" | "reason"}`
  | `staleContext.*.${"itemId" | "title" | "updatedAt" | "daysStale"}`
  | `recentActivity.*.${"timestamp" | "author" | "operation" | "itemId" | "message"}`
  | `recommendedPmUpdates.*.${"itemId" | "command" | "reason" | "safeToAutoApply"}`
  | `insights.*.${"level" | "message" | "suggestion"}`;
/** Explicit audience and optional additional denials. No permissive extension fields. */
export interface DisclosurePolicy { profile: DisclosureProfile; exclude?: DisclosureField[] }
/** JSON values retained after validation and disclosure checks. */
export type DisclosureValue = string | number | boolean | DisclosureValue[] | { [key: string]: DisclosureValue };
/** Value-free reasons; profile/policy paths use * for all matching array indices. */
export type DisclosureExclusionReason = "profile" | "policy" | "secret" | "unknown_field" | "invalid_value";
/** Field-level JSON Pointer paths and occurrence counts grouped by exclusion reason. */
export type DisclosureExclusion = Record<DisclosureExclusionReason, Record<string, number>>;
/** Agent-sized rendering with a manifest; dry runs contain no brief values. */
export interface DisclosureResult {
  protocol: "pm-brief.disclosure/v1";
  profile: DisclosureProfile;
  dryRun: boolean;
  sourceTruncated: boolean;
  brief?: { [key: string]: DisclosureValue };
  exclusions: DisclosureExclusion;
  estimatedTokenCeiling: number;
}
/** Pure rendering controls; the budget includes the full exclusion manifest. */
export interface DisclosureRenderOptions { dryRun?: boolean; tokenBudget?: number }
/** Native, backend-neutral tracker context; never invokes git or writes records. */
export interface DisclosureOptions extends DisclosureRenderOptions { pmRoot: string; client?: PmClient; generatedAt?: string }
/** Stable refusal categories shared by the SDK and native CLI. */
export type DisclosureRefusalCode = "policy" | "invalid" | "tracker" | "budget";
/** Expected failure containing no source values, paths, policy text or nested causes. */
export class DisclosureError extends Error {
  /** Stable machine category for recovery logic. */
  readonly code: DisclosureRefusalCode;
  /** Safe action to take before retrying. */
  readonly remedy: string;
  /** Preserve recovery information without exposing the failing input. */
  constructor(code: DisclosureRefusalCode, message: string, remedy: string) {
    super(message); this.name = "DisclosureError"; this.code = code; this.remedy = remedy;
  }
  /** Normalize an unexpected failure without retaining potentially forbidden nested text. */
  static from(error: unknown): DisclosureError {
    return error instanceof DisclosureError ? error : new DisclosureError("tracker", "Disclosure could not complete", "Run pm health and check tracker permissions before retrying");
  }
}

const LEVEL: Record<DisclosureProfile, number> = { public: 0, external: 1, internal: 2 };
const FIELDS = new Map<string, number>([
  ["generatedAt", 0], ["workspace.root", 2], ["workspace.pmVersion", 2], ["workspace.itemCount", 0],
  ["budget.requestedTokens", 2], ["budget.estimatedTokens", 2], ["budget.truncated", 2],
]);
for (const section of ["focus", "next", "decisionsNeeded"]) {
  for (const field of ["id", "title", "type", "status", "priority"]) FIELDS.set(`${section}.*.${field}`, 0);
  for (const field of ["whyNow", "rankingScore", "confidence", "tokenCostEstimate", "mergeCompromised", "tags.*", "rankingReasons.*", "dependencyIds.*", "dependentIds.*"]) FIELDS.set(`${section}.*.${field}`, 1);
  for (const field of ["assignee", "requiredContext.*"]) FIELDS.set(`${section}.*.${field}`, 2);
}
for (const field of ["itemId", "blockedBy", "kind", "title", "status"]) FIELDS.set(`blockers.*.${field}`, 1);
for (const field of ["itemId", "severity", "reason"]) FIELDS.set(`risks.*.${field}`, 1);
for (const field of ["itemId", "title", "updatedAt", "daysStale"]) FIELDS.set(`staleContext.*.${field}`, 1);
for (const field of ["timestamp", "author", "operation", "itemId", "message"]) FIELDS.set(`recentActivity.*.${field}`, 2);
for (const field of ["itemId", "command", "reason", "safeToAutoApply"]) FIELDS.set(`recommendedPmUpdates.*.${field}`, 2);
for (const field of ["level", "message", "suggestion"]) FIELDS.set(`insights.*.${field}`, 2);

/** Compile only trusted profile selectors; data keys remain exact path segments. */
const FIELD_PATHS = [...FIELDS].map(([field, level]) => ({ field: field as DisclosureField, level, segments: field.split(".") }));

/** Match a structured data-path prefix; profile wildcards accept only numeric array indices. */
function matchesDisclosurePath(pattern: readonly string[], path: readonly (string | number)[]): boolean {
  return path.length <= pattern.length && path.every((segment, i) => pattern[i] === "*" ? typeof segment === "number" : pattern[i] === segment);
}

/** Refuse a malformed or widening policy without echoing its contents. */
function invalidPolicy(): never {
  throw new DisclosureError("policy", "Unknown or invalid disclosure policy", "Use only profile (internal, external or public) and optional exclude containing documented field selectors; policies can only remove fields");
}
/** Check JSON object shape without coercing arrays or null into a policy. */
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
/** Validate policy keys and every field selector before any tracker read or render. */
export function parseDisclosurePolicy(value: unknown): DisclosurePolicy {
  if (!object(value) || !Object.hasOwn(value, "profile") || Reflect.ownKeys(value).some(key => key !== "profile" && key !== "exclude") || typeof value.profile !== "string" || !Object.hasOwn(LEVEL, value.profile)) return invalidPolicy();
  if (value.exclude !== undefined && (!Array.isArray(value.exclude) || value.exclude.length > FIELDS.size || value.exclude.some(field => typeof field !== "string" || !FIELDS.has(field)))) return invalidPolicy();
  return { profile: value.profile as DisclosureProfile, exclude: value.exclude === undefined ? [] : [...new Set(value.exclude as DisclosureField[])] };
}
/** Bound the entire native JSON/TOON envelope, including framing and diagnostics. */
function budget(options: DisclosureRenderOptions): number {
  const amount = options.tokenBudget ?? 8000;
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > 64000 || (options.dryRun !== undefined && typeof options.dryRun !== "boolean")) throw new DisclosureError("invalid", "Invalid disclosure controls", "Use a boolean dryRun and an integer --token-budget from 1 to 64000 (default 8000)");
  return amount;
}
/** Account for the complete manifest after both source and render exclusions. */
function bounded(result: DisclosureResult, limit: number): DisclosureResult {
  result.estimatedTokenCeiling = 64000;
  result.estimatedTokenCeiling = estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(result, null, 2)) * 2 + 256);
  if (result.estimatedTokenCeiling > limit) throw new DisclosureError("budget", "Disclosure and its exclusion manifest exceed the token budget", "Increase --token-budget (maximum 64000) or supply a smaller brief; no exclusion evidence is silently dropped");
  return result;
}
/** Render the same brief through a closed field vocabulary before native serialization. */
export function renderDisclosureBrief(brief: AgentBrief, input: DisclosurePolicy, options: DisclosureRenderOptions = {}): DisclosureResult {
  const policy = parseDisclosurePolicy(input); const limit = budget(options);
  if (!object(brief)) throw new DisclosureError("invalid", "Invalid brief", "Supply the object returned by buildBrief; arbitrary scalar or array input is not a brief");
  const exclusions: DisclosureExclusion = { profile: {}, policy: {}, secret: {}, unknown_field: {}, invalid_value: {} };
  const denied = new Set(policy.exclude);
  const active = new Set<object>();
  /** Aggregate repeated policy paths without source values or redundant per-row metadata. */
  function exclude(reason: DisclosureExclusionReason, path: string): void { exclusions[reason][path] = (exclusions[reason][path] ?? 0) + 1; }
  /** Traverse only known containers; never expose unknown key text or scan diagnostics. */
  function walk(value: unknown, segments: readonly (string | number)[], path: string): DisclosureValue | undefined {
    if (typeof value === "object" && value !== null && active.has(value)) throw new DisclosureError("invalid", "Invalid recursive brief", "Supply an acyclic buildBrief result; known containers have a fixed vocabulary and nesting shape");
    const matches = FIELD_PATHS.filter(entry => matchesDisclosurePath(entry.segments, segments));
    const exact = matches.find(entry => entry.segments.length === segments.length);
    if (exact !== undefined) {
      const { field, level } = exact;
      if (level > LEVEL[policy.profile]) { exclude("profile", `/${field.replaceAll(".", "/")}`); return undefined; }
      if (denied.has(field)) { exclude("policy", `/${field.replaceAll(".", "/")}`); return undefined; }
      if (!(typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) { exclude("invalid_value", path); return undefined; }
      if (scanMutationSecrets(value).length > 0) { exclude("secret", path); return undefined; }
      return value;
    }
    if (matches.length === 0) { exclude("unknown_field", path); return undefined; }
    if (Array.isArray(value)) {
      active.add(value);
      const result: DisclosureValue[] = [];
      for (let i = 0; i < value.length; i++) {
        const entry = walk(value[i], [...segments, i], `${path}/${i}`); if (entry !== undefined) result.push(entry);
      }
      active.delete(value); return result;
    }
    if (object(value)) {
      active.add(value);
      const result: Record<string, DisclosureValue> = {};
      for (const [i, [key, entry]] of Object.entries(value).entries()) {
        if (entry === undefined) continue;
        const child = [...segments, key];
        const known = FIELD_PATHS.some(field => matchesDisclosurePath(field.segments, child));
        const rendered = walk(entry, child, `${path}/${known ? key : `@${i}`}`);
        if (rendered !== undefined) result[key] = rendered;
      }
      active.delete(value); return result;
    }
    exclude("invalid_value", path); return undefined;
  }
  const filtered = walk(brief, [], "") as Record<string, DisclosureValue>;
  const result: DisclosureResult = { protocol: "pm-brief.disclosure/v1", profile: policy.profile, dryRun: options.dryRun ?? false, sourceTruncated: brief.budget?.truncated === true, exclusions, estimatedTokenCeiling: 64000 };
  if (!result.dryRun) result.brief = filtered;
  return bounded(result, limit);
}
/** Read a certified native snapshot and reuse pm-brief ranking before disclosure. */
export async function buildDisclosureBrief(input: DisclosurePolicy, options: DisclosureOptions): Promise<DisclosureResult> {
  const policy = parseDisclosurePolicy(input); budget(options);
  let brief: AgentBrief;
  const sourceSecrets: Record<string, number> = {};
  try {
    const client = options.client ?? new PmClient({ pmRoot: options.pmRoot, noExtensions: true });
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    // Guard before compaction: a shortened credential may no longer match its detector.
    const protectedItems = items.flatMap((item, i) => {
      if (scanMutationSecrets(item.id).length) { sourceSecrets[`/source/${i}`] = 1; return []; }
      const safe = { ...item };
      for (const [j, [field, value]] of Object.entries(item).entries()) {
        if (scanMutationSecrets(value).length) { delete safe[field]; sourceSecrets[`/source/${i}/@${j}`] = 1; }
      }
      return [safe];
    });
    brief = buildBrief(protectedItems, { pmRoot: ".agents/pm", generatedAt: options.generatedAt });
  } catch {
    throw new DisclosureError("tracker", "Cannot build a certified disclosure brief", "Run pm health and resolve unreadable or incomplete records before retrying");
  }
  const result = renderDisclosureBrief(brief, policy, { ...options, tokenBudget: 64000 });
  Object.assign(result.exclusions.secret, sourceSecrets);
  return bounded(result, budget(options));
}
/** Register native structured output and sanitized expected errors, with no git dependency. */
export function registerDisclosureCommand(api: ExtensionApi): void {
  api.registerCommand({
    name: "brief disclose",
    description: "Render a brief for an explicit stakeholder profile with a value-free exclusion manifest",
    flags: [
      { long: "--audience", type: "string", value_name: "audience", description: "Required audience: internal, external or public (or supply --policy)" },
      { long: "--policy", type: "string", value_name: "file", description: "JSON policy containing profile and optional exclude; cannot widen a profile" },
      { long: "--dry-run", type: "boolean", description: "Explain exclusions without returning brief values" },
      { long: "--token-budget", type: "string", value_name: "n", description: "Conservative complete JSON/TOON ceiling (default 8000; maximum 64000)" },
    ],
    async run(ctx) {
      try {
        if (ctx.args.length || (ctx.options.audience !== undefined && ctx.options.policy !== undefined)) return invalidPolicy();
        let policy: DisclosurePolicy;
        if (ctx.options.policy !== undefined) {
          try { policy = parseDisclosurePolicy(JSON.parse(await readFile(String(ctx.options.policy), "utf8"))); }
          catch { return invalidPolicy(); }
        } else policy = parseDisclosurePolicy({ profile: ctx.options.audience });
        return await buildDisclosureBrief(policy, { pmRoot: ctx.pm_root, client: ctx.sdk?.client, dryRun: ctx.options.dryRun as boolean | undefined, tokenBudget: ctx.options.tokenBudget === undefined ? undefined : Number(ctx.options.tokenBudget) });
      } catch (error) {
        const refusal = DisclosureError.from(error);
        throw createPmCliExpectedError(`disclosure ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: 2, context: { code: `disclosure_${refusal.code}`, required: refusal.remedy } });
      }
    },
  });
}
