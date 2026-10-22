import { createHash } from "node:crypto";
import { PmClient, certifyCompleteListResult, createPmCliExpectedError, estimatePmOutputTokens } from "@unbrained/pm-cli/sdk";
import type { ListedItem } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

/** Exact recorded text with an item-relative JSON Pointer and UTF-16 range. */
export interface DecisionExcerpt { source: string; start: number; end: number; text: string }
/** One proposal remains independent, including all recorded outcomes and blockers. */
export interface DecisionAlternative {
  id: string;
  revision: string;
  statements: DecisionExcerpt[];
  omitted: number;
  restore: string;
}
/** Extractive comparison; ordering follows the caller and never implies preference. */
export interface DecisionAlternativesDigest {
  protocol: "pm-brief.alternatives/v1";
  alternatives: DecisionAlternative[];
  estimatedTokenCeiling: number;
}
/** Backend-neutral read context; injected native clients retain the active host dispatcher. */
export interface DecisionAlternativesOptions { pmRoot: string; client?: PmClient; tokenBudget?: number }
/** Stable expected failure categories for SDK consumers. */
export type DecisionAlternativesRefusalCode = "invalid" | "missing" | "tracker" | "budget";
/** Typed refusal with a recovery action, never an empty successful comparison. */
export class DecisionAlternativesError extends Error {
  /** Machine-readable failure category. */
  readonly code: DecisionAlternativesRefusalCode;
  /** Concrete correction to perform before retrying. */
  readonly remedy: string;
  /** Retain machine and human recovery information independently. */
  constructor(code: DecisionAlternativesRefusalCode, message: string, remedy: string) {
    super(message); this.name = "DecisionAlternativesError"; this.code = code; this.remedy = remedy;
  }
}

const REQUIRED = ["title", "status", "resolution", "expected_result", "actual_result", "close_reason", "review_verdict", "review_verdict_source", "review_reason", "review_commit", "plan_decisions", "blocked_by", "blocked_reason", "plan_resume_context"];
const OPTIONAL = ["body", "description", "plan_scope", "docs", "files", "tests", "plan_validation", "comments", "notes", "learnings"];

/** Reject malformed agent selection before reading a tracker. */
function validate(ids: string[], budget: number): void {
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > 32 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) || !Number.isSafeInteger(budget) || budget < 1 || budget > 64000) {
    throw new DecisionAlternativesError("invalid", "Invalid alternative selection or token budget", "Supply 2-32 distinct exact item ids and an integer --token-budget from 1 to 64000 (default 4000)");
  }
}
/** Walk recorded JSON values without inventing summaries or dropping conflicting entries. */
function excerpts(value: unknown, source: string): DecisionExcerpt[] {
  if (value === null || value === undefined || value === "") return [];
  if (Array.isArray(value)) return value.flatMap((entry, i) => excerpts(entry, `${source}/${i}`));
  if (typeof value === "object") return Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).flatMap(([key, entry]) => excerpts(entry, `${source}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`));
  const text = String(value);
  // Whole paragraphs preserve complete recorded sentences, including punctuation.
  return [...text.matchAll(/[^\r\n]+(?:\r?\n(?!\s*\r?\n)[^\r\n]+)*/g)].map(match => ({ source, start: match.index, end: match.index + match[0].length, text: match[0] }));
}
/** Measure citations, omission counts, recovery commands and framing with the native estimator. */
function measure(digest: DecisionAlternativesDigest): number {
  digest.estimatedTokenCeiling = 64000;
  digest.estimatedTokenCeiling = estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(digest, null, 2)) * 2 + 256);
  return digest.estimatedTokenCeiling;
}
/** Compare explicitly selected native records read-only; never recommend, merge outcomes or invoke git. */
export async function buildDecisionAlternatives(ids: string[], options: DecisionAlternativesOptions): Promise<DecisionAlternativesDigest> {
  const budget = options.tokenBudget ?? 4000; validate(ids, budget);
  let items: ListedItem[];
  try {
    const client = options.client ?? new PmClient({ pmRoot: options.pmRoot, noExtensions: true });
    items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
  } catch {
    throw new DecisionAlternativesError("tracker", "Cannot certify the tracker snapshot", "Run pm health and resolve unreadable or incomplete records before retrying");
  }
  const rows = new Map(items.map(item => [item.id, item]));
  if (ids.some(id => !rows.has(id))) throw new DecisionAlternativesError("missing", "A selected alternative does not exist", "Check the exact ids with pm list --all --full; no alternative is silently removed");
  const optional: DecisionExcerpt[][] = [];
  const alternatives = ids.map(id => {
    const item = rows.get(id)!;
    const extra = OPTIONAL.flatMap(field => excerpts(item[field], `${id}#/${field}`));
    optional.push(extra);
    return { id, revision: createHash("sha256").update(JSON.stringify(item)).digest("hex"), statements: REQUIRED.flatMap(field => excerpts(item[field], `${id}#/${field}`)), omitted: extra.length, restore: `pm get ${id} --json --output-budget unbounded --output-limit unbounded` };
  });
  const digest: DecisionAlternativesDigest = { protocol: "pm-brief.alternatives/v1", alternatives, estimatedTokenCeiling: 0 };
  if (measure(digest) > budget) throw new DecisionAlternativesError("budget", "Mandatory alternative context exceeds the token budget", "Increase --token-budget (maximum 64000) or compare fewer items; titles, statuses, outcomes and blocker context are never dropped");
  // Round-robin optional excerpts give each proposal context without ranking it.
  const longest = Math.max(...optional.map(rows => rows.length));
  for (let i = 0; i < longest; i++) for (let j = 0; j < alternatives.length; j++) {
    const excerpt = optional[j][i]; if (!excerpt) continue;
    const alternative = alternatives[j]; alternative.statements.push(excerpt); alternative.omitted--;
    if (measure(digest) > budget) { alternative.statements.pop(); alternative.omitted++; }
  }
  measure(digest); return digest;
}

/** Register a native structured command so host TOON/JSON and error contracts remain authoritative. */
export function registerDecisionAlternativesCommand(api: ExtensionApi): void {
  api.registerCommand({
    name: "brief alternatives",
    description: "Compare recorded proposals and evidence with citations, without picking a winner",
    flags: [{ long: "--token-budget", type: "string", value_name: "n", description: "Conservative TOON/JSON token ceiling including citations and omissions (default 4000, maximum 64000)" }],
    async run(ctx) {
      try {
        return await buildDecisionAlternatives(ctx.args, { pmRoot: ctx.pm_root, client: ctx.sdk?.client, tokenBudget: ctx.options.tokenBudget === undefined ? undefined : Number(ctx.options.tokenBudget) });
      } catch (error) {
        const refusal = error instanceof DecisionAlternativesError ? error : new DecisionAlternativesError("tracker", "Alternative comparison could not complete", "Run pm health and check tracker permissions before retrying");
        throw createPmCliExpectedError(`alternatives ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: 2, context: { code: `alternatives_${refusal.code}`, required: refusal.remedy } });
      }
    },
  });
}
