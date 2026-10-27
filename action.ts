import { createHash } from "node:crypto";
import {
  PmClient, certifyCompleteListResult, createPmCliExpectedError, estimatePmOutputTokens,
  getContracts, readSettings, readWorkflowPolicies, resolveRuntimeStatusRegistry,
  resolveItemBlockers, computeActionabilityReport, resolveItemTypeRegistry, buildItemChildrenRollup,
  evaluateTransition, resolveTypeWorkflows, evaluateWorkflowPolicies,
  createLifecycleCompletenessPolicies, resolveTerminalReason, workflowPolicyApplies,
} from "@unbrained/pm-cli/sdk";
import type { ListedItem, WorkflowPolicy, WorkflowPolicyInput } from "@unbrained/pm-cli/sdk";
import type { ExtensionApi } from "@unbrained/pm-cli/sdk/authoring";

/** Exact native linkage requirement; presence never claims the artifact passed validation. */
export interface ActionEvidence { kind: "docs" | "files" | "tests"; ref: string }
/** One explicit action, with prospective close inputs and optional declared evidence. */
export interface ActionPrerequisiteRequest {
  command: string;
  item: string;
  actor?: string;
  input?: { reason?: string; resolution?: string; expectedResult?: string; actualResult?: string };
  requiredEvidence?: ActionEvidence[];
  tokenBudget?: number;
}
/** Tracker-bound SDK context, acquired only when a valid request needs data. */
export interface ActionPrerequisiteOptions { pmRoot: string; client?: PmClient }
/** Stable machine refusal vocabulary with actionable recovery. */
export type ActionRefusalCode = "invalid" | "missing" | "tracker" | "unsupported" | "budget" | "changed";
/** Expected failures retain recovery without echoing untrusted inputs or item bodies. */
export class ActionPrerequisiteError extends Error {
  /** Category independent of human wording. */
  readonly code: ActionRefusalCode;
  /** Concrete next action for the caller. */
  readonly remedy: string;
  /** Preserve a safe diagnostic and a separate machine-readable remedy. */
  constructor(code: ActionRefusalCode, message: string, remedy: string) {
    super(message); this.name = "ActionPrerequisiteError"; this.code = code; this.remedy = remedy;
  }
}
/** A content-free checklist entry; satisfied values are recoverable references. */
export interface ActionPrerequisiteEntry {
  kind: "input" | "prerequisite" | "readiness" | "evidence" | "policy";
  key: string;
  state: "missing" | "satisfied" | "unresolved";
  ref?: string;
  remedy?: string;
}
/** Bounded read-only result; ready describes inputs, never authorizes a future mutation. */
export interface ActionPrerequisiteBrief {
  protocol: "pm-brief.action/v1";
  preview: true;
  command: string;
  item: { id: string; revision: string; status: string; roles: string[] };
  ready: boolean;
  checklist: ActionPrerequisiteEntry[];
  refusals: { code: "unsupported"; capability: string; remedy: string }[];
  estimatedTokenCeiling: number;
}

/** The single strict boundary schema used by SDK and CLI, including dense bounded arrays. */
export const ACTION_PREREQUISITE_SCHEMA = {
  command: { max: 80, pattern: /^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/ },
  item: { max: 200, pattern: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/ },
  actor: { max: 128 },
  input: { keys: ["reason", "resolution", "expectedResult", "actualResult"], max: 16000 },
  requiredEvidence: { max: 64, kinds: ["docs", "files", "tests"], refMax: 1024 },
  tokenBudget: { min: 1, max: 64000, default: 4000 },
} as const;

/** Reject malformed requests before acquiring a client or reading a tracker. */
function invalid(): never {
  throw new ActionPrerequisiteError("invalid", "Invalid action prerequisite request", "Use exact command and item, optional actor, close input strings (at most 16000 characters), up to 64 dense unique evidence links, and integer tokenBudget 1..64000; unknown keys are rejected");
}
/** Own JSON objects only; inherited keys and exotic containers cannot provide input. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  return value as Record<string, unknown>;
}
/** Apply one schema rule without coercing sparse values, numbers or whitespace. */
function text(value: unknown, rule: { max: number; pattern?: RegExp }): string {
  if (typeof value !== "string" || value.length < 1 || value.length > rule.max || !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || (rule.pattern && !rule.pattern.test(value))) return invalid();
  return value;
}
/** Parse, detach and normalize defaults once using the same boundary for every producer. */
export function parseActionPrerequisiteRequest(value: unknown): ActionPrerequisiteRequest {
  const schema = ACTION_PREREQUISITE_SCHEMA; const row = record(value);
  if (Reflect.ownKeys(row).some(key => typeof key !== "string" || !Object.hasOwn(schema, key))) return invalid();
  if (!Object.hasOwn(row, "command") || !Object.hasOwn(row, "item")) return invalid();
  const command = text(row.command, schema.command); const item = text(row.item, schema.item);
  const tokenBudget = row.tokenBudget === undefined ? schema.tokenBudget.default : row.tokenBudget;
  if (typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget < schema.tokenBudget.min || tokenBudget > schema.tokenBudget.max) return invalid();
  const result: ActionPrerequisiteRequest = { command, item, tokenBudget };
  if (row.actor !== undefined) result.actor = text(row.actor, schema.actor);
  if (row.input !== undefined) {
    const input = record(row.input); result.input = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !schema.input.keys.some(allowed => allowed === key)) return invalid();
      const value = input[key];
      // Blank prospective values are legal and remain missing under the SDK evaluator.
      if (typeof value !== "string" || value.length > schema.input.max || value.includes("\0")) return invalid();
      Object.assign(result.input, { [key]: value });
    }
  }
  if (row.requiredEvidence !== undefined) {
    const links = row.requiredEvidence;
    if (!Array.isArray(links) || links.length > schema.requiredEvidence.max || Object.keys(links).length !== links.length) return invalid();
    const seen = new Set<string>(); result.requiredEvidence = [];
    for (const link of links) {
      const entry = record(link);
      if (Reflect.ownKeys(entry).length !== 2 || !Object.hasOwn(entry, "kind") || !Object.hasOwn(entry, "ref") || !schema.requiredEvidence.kinds.some(kind => kind === entry.kind)) return invalid();
      const ref = text(entry.ref, { max: schema.requiredEvidence.refMax }); const identity = `${entry.kind}\0${ref}`;
      if (seen.has(identity)) return invalid(); seen.add(identity);
      result.requiredEvidence.push({ kind: entry.kind as ActionEvidence["kind"], ref });
    }
  }
  return result;
}

/** Bind every preview to the exact SDK snapshot, with no normalization invented here. */
function revision(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
/** Escape native field paths as item-relative JSON Pointers. */
function pointer(value: string): string { return value.split(".").map(part => part.replace(/~/g, "~0").replace(/\//g, "~1")).join("/"); }

/** Compose native facts for one intended close or start action, without calling any writer. */
export async function buildActionPrerequisiteBrief(value: ActionPrerequisiteRequest, options: ActionPrerequisiteOptions): Promise<ActionPrerequisiteBrief> {
  const request = parseActionPrerequisiteRequest(value);
  const client = options.client ?? new PmClient({ pmRoot: options.pmRoot, noExtensions: true });
  try {
    const settings = await readSettings(options.pmRoot);
    const policies = await readWorkflowPolicies(options.pmRoot);
    const items = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const item = items.find(row => row.id === request.item);
    if (!item) throw new ActionPrerequisiteError("missing", "Selected item does not exist", "Select an exact id from pm list --all --full");
    const contracts = await getContracts({ pmRoot: options.pmRoot, ...(["close", "start-task"].includes(request.command) ? { command: request.command } : {}), availabilityOnly: true, noExtensions: true });
    const native = contracts.action_availability?.find(row => row.provider === "core" && row.invocable && row.command_path?.split("|").includes(request.command));
    const registry = resolveRuntimeStatusRegistry(settings.schema);
    const result: ActionPrerequisiteBrief = { protocol: "pm-brief.action/v1", preview: true, command: request.command, item: { id: item.id, revision: revision(item), status: item.status, roles: [...(registry.by_id.get(item.status)?.roles ?? [])] }, ready: false, checklist: [], refusals: [], estimatedTokenCeiling: 0 };
    const entries = new Map<string, ActionPrerequisiteEntry>();
    const refuse = (capability: string, remedy: string): void => { result.refusals.push({ code: "unsupported", capability, remedy }); };
    const add = (entry: ActionPrerequisiteEntry): void => { entries.set(`${entry.kind}:${entry.key}`, entry); };
    const supported = native && ["close", "start-task"].includes(native.action);
    const closing = native?.action === "close";
    const starting = native?.action === "start-task";
    if (!supported) refuse("command", "Use the exact native close or start-task command; inspect other actions with pm contracts --command <command> --full");
    if (native?.action !== "close" && request.input && Object.keys(request.input).length) refuse("close-input", "Supply close inputs only for a close preview");
    const rows = new Map(items.map(row => [row.id.toLowerCase(), row]));
    for (const blocker of resolveItemBlockers(item, rows, registry)) {
      add({ kind: "prerequisite", key: blocker.id, state: blocker.resolved ? "satisfied" : "unresolved", ref: `${blocker.id}#/status`, ...(blocker.resolved ? {} : { remedy: blocker.external ? "Resolve this external prerequisite through its owning integration" : "Resolve the prerequisite or correct its native relationship before acting" }) });
    }
    const report = computeActionabilityReport([item], items, registry, resolveItemTypeRegistry(settings));
    if (closing) {
      const children = buildItemChildrenRollup(item.id, items, registry, items.length);
      if (children.truncated) throw new ActionPrerequisiteError("budget", "Native child prerequisites are incomplete", "Inspect the complete native child projection before retrying; no unfinished child is silently omitted");
      for (const child of children.sample) if (!registry.terminal_statuses.has(child.status)) add({ kind: "prerequisite", key: child.id, state: "unresolved", ref: `${child.id}#/status`, remedy: "Resolve this unfinished direct child before closing its parent" });
    }
    for (const [key, unresolved] of [["blocked-status", starting && registry.blocked_statuses.has(item.status)], ["active-children", starting && report.containers.some(row => row.item.id === item.id)], ["human-decision", starting && report.decisions.some(row => row.item.id === item.id)], ["outcome-gate", starting && report.gates.some(row => row.item.id === item.id)]] as const) {
      if (unresolved) add({ kind: "readiness", key, state: "unresolved", ref: `${item.id}#/status`, remedy: "Resolve the SDK readiness classification before attempting the selected action" });
    }
    if ((starting && !registry.active_statuses.has(item.status)) || (closing && registry.terminal_statuses.has(item.status))) add({ kind: "readiness", key: "inactive", state: "unresolved", ref: `${item.id}#/status`, remedy: "Review the configured lifecycle role; use native reopen/update where appropriate" });
    for (const [index, evidence] of (request.requiredEvidence ?? []).entries()) {
      const links = item[evidence.kind] ?? [];
      const found = links.findIndex(link => ("command" in link && link.command === evidence.ref) || link.path === evidence.ref);
      add({ kind: "evidence", key: `${evidence.kind}:${evidence.ref}`, state: found < 0 ? "missing" : "satisfied", ref: found < 0 ? `request#/requiredEvidence/${index}` : `${item.id}#/${evidence.kind}/${found}`, ...(found < 0 ? { remedy: `Record the required native ${evidence.kind} link; linkage alone does not prove validation` } : {}) });
    }
    if (supported) {
      const after: ListedItem = { ...item, status: closing ? registry.close_status : registry.in_progress_status };
      const inputFields = { resolution: "resolution", expectedResult: "expected_result", actualResult: "actual_result" } as const;
      for (const [option, field] of Object.entries(inputFields)) {
        const proposed = request.input?.[option as keyof typeof inputFields];
        if (proposed?.trim()) after[field] = proposed.trim();
      }
      const reason = resolveTerminalReason({ explicit: request.input?.reason, resolution: request.input?.resolution });
      if (closing && reason.closeReason !== undefined) after.close_reason = reason.closeReason;
      const context: WorkflowPolicyInput = { operation: closing ? "close" : "update", author: request.actor ?? "unknown", before: item, after };
      const fieldRef = (field: string): string => {
        if (field === "close_reason" && closing && reason.source !== "none") return `request#/input/${reason.source === "explicit" ? "reason" : "resolution"}`;
        const option = Object.entries(inputFields).find(([, name]) => name === field)?.[0];
        return option && request.input?.[option as keyof typeof inputFields]?.trim() ? `request#/input/${option}` : `${item.id}#/${pointer(field)}`;
      };
      const fieldRules = (rules: WorkflowPolicy[], kind: "input" | "policy"): void => {
        const document = { version: 1 as const, enforcement: policies.enforcement, policies: rules };
        const evaluated = evaluateWorkflowPolicies(document, context);
        for (const rule of rules) {
          const decision = evaluated.decisions.find(row => row.policy_id === rule.id);
          if (!decision) continue;
          if (rule.rule.kind === "require_fields") {
            for (const field of rule.rule.fields) if (!entries.has(`input:${field}`)) add({ kind, key: field, state: decision.missing_fields.includes(field) ? "missing" : "satisfied", ref: fieldRef(field), ...(decision.missing_fields.includes(field) ? { remedy: decision.remediation } : {}) });
          } else {
            if (rule.rule.kind === "approval") refuse(`policy:${rule.id}`, "Verify content-bound approvals through native policy-check before acting; this preview does not certify approval history");
            add({ kind: "policy", key: rule.id, state: decision.satisfied ? "satisfied" : "unresolved", ref: `schema/policies.json#${rule.id}`, ...(decision.satisfied ? {} : { remedy: decision.remediation }) });
          }
        }
      };
      if (closing) {
        const closeEvidence = createLifecycleCompletenessPolicies().policies.find(rule => rule.id === "completeness-resolution")!;
        fieldRules([{ ...closeEvidence, subject: { operations: ["close"] } }], "input");
        if (settings.governance.require_close_reason) add({ kind: "input", key: "reason", state: reason.source === "none" ? "missing" : "satisfied", ...(reason.source === "none" ? { remedy: "Supply an author-controlled close reason or prospective resolution" } : { ref: `request#/input/${reason.source === "explicit" ? "reason" : "resolution"}` }) });
      }
      fieldRules(policies.policies, "policy");
      if (policies.policies.some(rule => workflowPolicyApplies(rule, context) && ["authors", "field_writers"].includes(rule.rule.kind)) && !request.actor) add({ kind: "input", key: "actor", state: "missing", remedy: "Supply the intended mutation actor to evaluate author-dependent policies" });
      if ((settings.governance.workflow_enforcement ?? "off") !== "off") {
        const transition = evaluateTransition({ typeName: item.type, fromStatus: item.status, toStatus: after.status, typeWorkflows: resolveTypeWorkflows(settings.schema), statusRegistry: registry });
        if (!transition.allowed) add({ kind: "policy", key: "transition", state: "unresolved", ref: "settings.json#/schema/type_workflows", remedy: "Follow an allowed transition from the configured type workflow" });
      }
      if (!closing && item.assignee && item.assignee !== request.actor) add({ kind: "readiness", key: "ownership", state: "unresolved", ref: `${item.id}#/assignee`, remedy: "Resolve the current claim through native claim/release before starting" });
    }
    // A preview has no lease: refuse if any observed record or policy changed while composing it.
    const fresh = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    if (revision(items) !== revision(fresh) || revision(settings) !== revision(await readSettings(options.pmRoot)) || revision(policies) !== revision(await readWorkflowPolicies(options.pmRoot))) throw new ActionPrerequisiteError("changed", "Tracker changed during preview", "Retry against current SDK state; never execute a saved checklist as a frozen plan");
    result.checklist = [...entries.values()];
    result.ready = result.refusals.length === 0 && result.checklist.every(row => row.state === "satisfied");
    result.estimatedTokenCeiling = estimatePmOutputTokens(Buffer.byteLength(JSON.stringify({ ...result, estimatedTokenCeiling: 64000 }, null, 2)) * 2 + 256);
    if (!Number.isSafeInteger(result.estimatedTokenCeiling) || result.estimatedTokenCeiling < 1 || result.estimatedTokenCeiling > request.tokenBudget!) throw new ActionPrerequisiteError("budget", "Complete prerequisite checklist exceeds the token budget", "Increase tokenBudget (maximum 64000) or narrow declared evidence; no missing requirement is silently omitted");
    return result;
  } catch (error) {
    if (error instanceof ActionPrerequisiteError) throw error;
    throw new ActionPrerequisiteError("tracker", "Cannot certify native action prerequisites", "Run pm health and inspect native command contracts and workspace policies before retrying");
  }
}

/** Register the read-only native TOON/JSON command using the same SDK request parser. */
export function registerActionPrerequisiteCommand(api: ExtensionApi): void {
  api.registerCommand({
    name: "brief action",
    description: "Preview the smallest prerequisite checklist for one native command and item",
    intent: "Compose native admission facts and required evidence without attempting the selected action",
    arguments: [{ name: "command", required: true, description: "Exact native close or start-task command" }, { name: "item", required: true, description: "Exact selected item id" }],
    examples: ["pm brief action close project-123", "pm --json brief action start-task project-123"],
    read_output: { row_keys: [] },
    flags: [
      { long: "--request", type: "string", value_name: "json", description: "Optional JSON object with actor, input and requiredEvidence" },
      { long: "--token-budget", type: "string", value_name: "n", description: "Complete TOON/JSON ceiling, 1..64000 (default 4000)" },
    ],
    async run(ctx) {
      try {
        if (ctx.args.length !== 2 || (ctx.options.request !== undefined && (typeof ctx.options.request !== "string" || ctx.options.request.length > 196608)) || (ctx.options.tokenBudget !== undefined && typeof ctx.options.tokenBudget !== "string")) return invalid();
        const extra = ctx.options.request === undefined ? {} : record(JSON.parse(ctx.options.request as string));
        if (Object.hasOwn(extra, "command") || Object.hasOwn(extra, "item") || Object.hasOwn(extra, "tokenBudget")) return invalid();
        return await buildActionPrerequisiteBrief({ ...extra, command: ctx.args[0], item: ctx.args[1], ...(ctx.options.tokenBudget === undefined ? {} : { tokenBudget: Number(ctx.options.tokenBudget) }) }, { pmRoot: ctx.pm_root, client: ctx.sdk?.client });
      } catch (error) {
        const refusal = error instanceof ActionPrerequisiteError ? error : new ActionPrerequisiteError("invalid", "Invalid request JSON", "Supply a JSON object following ACTION_PREREQUISITE_SCHEMA");
        throw createPmCliExpectedError(`action ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: 2, context: { code: `action_${refusal.code}`, required: refusal.remedy } });
      }
    },
  });
}
