import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { PmClient, acquireLock, certifyCompleteListResult, createPmCliExpectedError, estimatePmOutputTokens, isPmCliExpectedError } from "@unbrained/pm-cli/sdk";
import type { ListedItem } from "@unbrained/pm-cli/sdk";
import type { CommandHandlerContext, ExtensionApi, FlagDefinition } from "@unbrained/pm-cli/sdk/authoring";

/** An explicit question or unresolved assumption with a stable response key. */
export interface HandoffPrompt { id: string; text: string }
/** Required native tracker linkage; presence proves linkage, never artifact contents or test success. */
export interface HandoffEvidence { id: string; item: string; kind: "docs" | "files" | "tests"; ref: string }
/** Sender-authored obligations; every collection must be supplied, even when intentionally empty. */
export interface HandoffContract {
  focus: string[];
  questions: HandoffPrompt[];
  assumptions: HandoffPrompt[];
  requiredEvidence: HandoffEvidence[];
}
/** Content-addressed full item revision, including transitive declared blockers and missing targets. */
export interface HandoffRevision { id: string; revision: string | null; title: string; status: string; blockers: string[] }
/** Immutable stored contract; protocol and digest prevent accidental cross-packet acknowledgment. */
export interface HandoffDocument extends HandoffContract {
  protocol: "pm-brief.handoff/v1";
  sender: string;
  createdAt: string;
  items: HandoffRevision[];
}
/** Transport packet with live missing-evidence disclosure and a conservative byte-based token ceiling. */
export interface HandoffPacket {
  id: string;
  digest: string;
  contract: HandoffDocument;
  missingEvidence: string[];
  estimatedTokenCeiling: number;
}
/** Receiver statements keyed by every question, assumption and evidence obligation. */
export interface HandoffResponse {
  digest: string;
  questions: Record<string, string>;
  assumptions: Record<string, string>;
  evidence: Record<string, string>;
}
/** Read-only or native mutation context; no filesystem or git backend assumptions. */
export interface HandoffOptions { pmRoot: string; author?: string; client?: PmClient; tokenBudget?: number }
/** Receipt validity is recomputed on each read; missing evidence cannot become a ready acknowledgment. */
export interface HandoffReceipt {
  id: string;
  receiver: string;
  response: HandoffResponse;
  dependencies?: HandoffAcknowledgedGroup[];
  acknowledgedAt: string;
  valid: boolean;
  ready: boolean;
  staleItems: string[];
  missingEvidence: string[];
}
/** Complete contract and selected receiver receipts, with no silent row omission. */
export interface HandoffStatus { packet: HandoffPacket; staleItems: string[]; receipts: HandoffReceipt[]; estimatedTokenCeiling: number }
/** Receiver answers to one group, bound to its exact target source revision. */
export interface HandoffRenewalGroup {
  id: string;
  target: string;
  questions: Record<string, string>;
  assumptions: Record<string, string>;
  evidence: Record<string, string>;
}
/** Partial renewal input; only groups shown by repair need responses. */
export interface HandoffRenewal { digest: string; groups: HandoffRenewalGroup[] }
/** Changed source coordinate relative to the receiver's last acknowledgment. */
export interface HandoffRepairChange { id: string; from: string | null; to: string | null }
/** One focused obligation group requiring renewed receiver understanding. */
export interface HandoffRepairGroup extends HandoffContract {
  id: string;
  target: string;
  changes: HandoffRepairChange[];
  missingEvidence: string[];
}
/** Compact receiver-specific delta; unchanged obligations are counted, never repeated. */
export interface HandoffRepair {
  protocol: "pm-brief.repair/v1";
  id: string;
  digest: string;
  receiver: string;
  groups: HandoffRepairGroup[];
  validAcknowledgments: number;
  totalGroups: number;
  skippedReceipts: { index: number; reason: string }[];
  estimatedTokenCeiling: number;
}
/** Exact native edge coordinate covered by one acknowledgment, including its metadata revision. */
export interface HandoffCoveredEdge { from: string; to: string; kind: string; revision: string }
/** Exact native evidence-link coordinate; revision includes every SDK-read link field. */
export interface HandoffCoveredEvidence { item: string; kind: "docs" | "files" | "tests"; ref?: string; revision: string }
/** Recorded coverage is retained across graph edits; missing items keep a null revision. */
export interface HandoffDependencySet {
  items: HandoffRevision[];
  edges: HandoffCoveredEdge[];
  evidenceLinks: HandoffCoveredEvidence[];
}
/** One initial acknowledgment's exact per-group dependency set. */
export interface HandoffAcknowledgedGroup extends HandoffDependencySet { id: string }
/** Stored group receipt stays on the existing native contract comment stream. */
interface RenewalRecord { receiver: string; digest: string; groups: (HandoffRenewalGroup & { items: HandoffRevision[]; edges?: HandoffCoveredEdge[]; evidenceLinks?: HandoffCoveredEvidence[] })[] }
/** Stable refusal categories callers can branch on without parsing prose. */
export type HandoffRefusalCode = "invalid" | "missing" | "identity" | "stale" | "responses" | "integrity" | "budget" | "tracker" | "unacknowledged";
/** Expected failure with a concrete recovery action; tracker writes never precede validation. */
export class HandoffError extends Error {
  /** Machine-readable reason for refusing an operation. */
  readonly code: HandoffRefusalCode;
  /** Action the caller can take before retrying. */
  readonly remedy: string;
  /** Preserve the typed category separately from human-readable context. */
  constructor(code: HandoffRefusalCode, message: string, remedy: string) {
    super(message); this.name = "HandoffError"; this.code = code; this.remedy = remedy;
  }
}

const PROTOCOL = "pm-brief.handoff/v1";
const ACK_PREFIX = "pm-brief.ack/v1 ";
const RENEW_PREFIX = "pm-brief.renew/v1 ";
const TAG = "pm-brief-handoff";
const KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Refuse malformed or excessive agent input without leaking its raw value. */
function invalid(): never { throw new HandoffError("invalid", "Invalid handoff input", "Supply the documented contract/response JSON: unique ASCII obligation/actor keys of 1-128 characters, native item identifiers using safe ASCII characters, nonempty obligation text/references up to 2000 code units, and collections of at most 32 entries"); }
/** Require a JSON record and reject arrays and null. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
/** Bound obligation text; native snapshot text uses an explicit cap and the aggregate packet budget. */
function string(value: unknown, maxLength = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) return invalid();
  return value;
}
/** Validate identifiers independently from prose and paths. */
function key(value: unknown, maxLength = 128): string { const result = string(value, maxLength); if (!KEY.test(result)) return invalid(); return result; }
/** Require explicitly supplied, bounded collections. */
function array(value: unknown): unknown[] { if (!Array.isArray(value) || value.length > 32) return invalid(); return value; }
/** Refuse duplicate obligation ids rather than losing receiver responses in an object map. */
function unique(values: string[]): string[] { if (new Set(values).size !== values.length) return invalid(); return values; }
/** Parse prompt rows from an untrusted contract. */
function prompts(value: unknown): HandoffPrompt[] {
  const result = array(value).map(value => { const row = record(value); return { id: key(row.id), text: string(row.text) }; });
  unique(result.map(row => row.id)); return result;
}
/** Validate and normalize the SDK and CLI contract through the same runtime boundary. */
export function parseHandoffContract(value: unknown): HandoffContract {
  const input = record(value);
  const focus = unique(array(input.focus).map(value => key(value, Infinity)));
  if (focus.length === 0) return invalid();
  const requiredEvidence = array(input.requiredEvidence).map((value): HandoffEvidence => {
    const row = record(value);
    if (row.kind !== "docs" && row.kind !== "files" && row.kind !== "tests") return invalid();
    return { id: key(row.id), item: key(row.item, Infinity), kind: row.kind, ref: string(row.ref) };
  });
  unique(requiredEvidence.map(row => row.id));
  return { focus, questions: prompts(input.questions), assumptions: prompts(input.assumptions), requiredEvidence };
}
/** Validate response maps without treating omitted questions as implied assent. */
function responseMap(value: unknown): Record<string, string> {
  const rows = Object.entries(record(value)); if (rows.length > 32) return invalid();
  return Object.fromEntries(rows.map(([id, value]) => [key(id), string(value)]));
}
/** Parse explicit receiver statements; digest binds them to exactly one packet. */
export function parseHandoffResponse(value: unknown): HandoffResponse {
  const input = record(value); const digest = string(input.digest);
  if (!/^[a-f0-9]{64}$/.test(digest)) return invalid();
  return { digest, questions: responseMap(input.questions), assumptions: responseMap(input.assumptions), evidence: responseMap(input.evidence) };
}
/** Canonical JSON makes revisions independent of object key insertion order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.entries(value).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(",")}}`;
  return JSON.stringify(value);
}
/** Content-address every full tracker row and protocol object with SHA-256. */
function digest(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }
/** Reuse the active host dispatcher when supplied; otherwise use the installed SDK in process. */
function client(options: HandoffOptions): PmClient { return options.client ?? new PmClient({ pmRoot: options.pmRoot, author: options.author, noExtensions: true }); }
/** Require explicit receiver/sender attribution rather than inventing an agent identity. */
function author(options: HandoffOptions): string {
  const value = options.author ?? process.env.PM_AUTHOR;
  if (!value?.trim()) throw new HandoffError("identity", "Handoff mutations require an author", "Set PM_AUTHOR or supply author in the SDK options");
  return key(value);
}
/** Retry only native lock contention on reads and idempotent appends; never repeat a create. */
async function retryLocked<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || !isPmCliExpectedError(error) || error.code !== "lock_conflict") throw error;
      await new Promise<void>(resolve => { setTimeout(resolve, 50); });
    }
  }
}
/** Certify complete full rows before computing any revision or evidence assessment. */
async function corpus(options: HandoffOptions): Promise<ListedItem[]> {
  try { return certifyCompleteListResult(await retryLocked(() => client(options).listAllComplete({ includeBody: true }))).items; }
  catch { throw new HandoffError("tracker", "Cannot certify the tracker snapshot", "Run pm health and resolve incomplete or invalid source reads before retrying"); }
}
/** Follow native declared blocker edges and the scalar blocker when it names an item. */
function blockers(item: ListedItem, rows: Map<string, ListedItem>): string[] {
  const ids = (item.dependencies ?? []).filter(edge => edge.kind === "blocked_by").map(edge => edge.id);
  if (item.blocked_by && KEY.test(item.blocked_by)) ids.push(item.blocked_by);
  for (const row of rows.values()) if ((row.dependencies ?? []).some(edge => edge.kind === "blocks" && edge.id === item.id)) ids.push(row.id);
  return [...new Set(ids)].sort();
}
/** Snapshot transitive blockers, including missing targets, without silently truncating the closure. */
function revisions(contract: HandoffContract, items: ListedItem[]): HandoffRevision[] {
  const rows = new Map(items.map(item => [item.id, item]));
  const pending = [...contract.focus, ...contract.requiredEvidence.map(row => row.item)];
  const result = new Map<string, HandoffRevision>();
  for (const id of pending) {
    key(id, Infinity);
    if (result.has(id)) continue;
    if (result.size >= 64) throw new HandoffError("budget", "Handoff dependency closure exceeds 64 items", "Split the contract into smaller focused handoffs");
    const item = rows.get(id); const deps = item ? blockers(item, rows) : [];
    result.set(id, { id, revision: item ? digest(item) : null, title: item ? string(item.title, Infinity) : "Missing item", status: item ? string(item.status, Infinity) : "missing", blockers: deps });
    pending.push(...deps);
  }
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Check native linkage only; missing requirements always survive into every receipt and status read. */
function missingEvidence(contract: HandoffContract, items: ListedItem[]): string[] {
  const rows = new Map(items.map(item => [item.id, item]));
  return contract.requiredEvidence.filter(requirement => {
    const links = rows.get(requirement.item)?.[requirement.kind] ?? [];
    return !links.some(link => ("command" in link && link.command === requirement.ref) || link.path === requirement.ref);
  }).map(row => row.id);
}
/** Bound full output conservatively for JSON and native TOON, including UTF-8 and framing overhead. */
function bounded<T extends { estimatedTokenCeiling: number }>(value: T, options: HandoffOptions): T {
  const budget = options.tokenBudget ?? 4000;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 64000) return invalid();
  value.estimatedTokenCeiling = estimatePmOutputTokens(Buffer.byteLength(JSON.stringify(value, null, 2)) * 2 + 256);
  if (value.estimatedTokenCeiling > budget) throw new HandoffError("budget", "Complete handoff exceeds the token budget", "Increase --token-budget (maximum 64000), narrow the contract or filter --receiver; obligations are never silently dropped");
  return value;
}
/** Refuse missing focused items while retaining missing blockers/evidence targets as visible context. */
function requireFocus(contract: HandoffContract, items: ListedItem[]): void {
  if (contract.focus.some(id => !items.some(item => item.id === id))) throw new HandoffError("missing", "A focused item does not exist", "Check focus ids with pm get before creating the contract");
}
/** Generate a bounded packet from a certified tracker read without creating records or invoking git. */
export async function previewHandoff(input: HandoffContract, options: HandoffOptions): Promise<HandoffPacket> {
  const contract = parseHandoffContract(input); const sender = author(options); const items = await corpus(options);
  requireFocus(contract, items);
  const document: HandoffDocument = { protocol: PROTOCOL, sender, createdAt: new Date().toISOString(), ...contract, items: revisions(contract, items) };
  return bounded({ id: "preview", digest: digest(document), contract: document, missingEvidence: missingEvidence(contract, items), estimatedTokenCeiling: 0 }, options);
}
/** Create one native Decision artifact; no source item or claim is modified. */
export async function createHandoff(input: HandoffContract, options: HandoffOptions): Promise<HandoffPacket> {
  const packet = await previewHandoff(input, options);
  bounded({ ...packet, id: "reserved".repeat(32) }, options);
  try {
    const created = await client(options).create({ type: "Decision", title: `Handoff: ${packet.contract.focus.join(", ")}`.slice(0, 160), body: JSON.stringify({ document: packet.contract, digest: packet.digest }), tags: TAG, author: packet.contract.sender, allowDuplicate: true });
    packet.id = created.item.id;
  } catch { throw new HandoffError("tracker", "Handoff operation could not complete", "Run pm health and check tracker permissions before retrying; inspect existing handoff records before repeating a create"); }
  return bounded(packet, options);
}
/** Decode only recognized packet artifacts and verify their content-addressed body before use. */
function readPacket(id: string, items: ListedItem[]): { packet: HandoffPacket; source: ListedItem } {
  const source = items.find(item => item.id === key(id, Infinity));
  if (!source) throw new HandoffError("missing", "Handoff packet does not exist", "Use the packet id returned by pm brief handoff create");
  try {
    if (!source.tags.includes(TAG) || typeof source.body !== "string") throw new Error();
    const stored = record(JSON.parse(source.body)); const raw = record(stored.document);
    if (raw.protocol !== PROTOCOL || stored.digest !== digest(raw)) throw new Error();
    const contract = parseHandoffContract(raw);
    const snapshots = raw.items;
    if (!Array.isArray(snapshots) || snapshots.length > 64) throw new Error();
    const items = snapshots.map(value => {
      const row = record(value);
      if (row.revision !== null && (typeof row.revision !== "string" || !/^[a-f0-9]{64}$/.test(row.revision))) throw new Error();
      if (!Array.isArray(row.blockers) || row.blockers.some(id => typeof id !== "string" || !KEY.test(id))) throw new Error();
      return { id: key(row.id, Infinity), revision: row.revision, title: string(row.title, Infinity), status: string(row.status, Infinity), blockers: row.blockers as string[] };
    });
    unique(items.map(row => row.id));
    const document: HandoffDocument = { protocol: PROTOCOL, sender: key(raw.sender), createdAt: string(raw.createdAt), ...contract, items };
    if (digest(document) !== stored.digest) throw new Error();
    return { source, packet: { id, digest: stored.digest as string, contract: document, missingEvidence: [], estimatedTokenCeiling: 0 } };
  } catch { throw new HandoffError("integrity", "Handoff artifact is malformed or has changed", "Create a new handoff packet from current items; never edit a stored contract body"); }
}
/** Compare the entire saved blocker closure, including targets that have disappeared or appeared. */
function staleItems(packet: HandoffPacket, items: ListedItem[]): string[] {
  const current = revisions(packet.contract, items); const previous = packet.contract.items;
  return [...new Set([...previous, ...current].map(row => row.id))].filter(id => previous.find(row => row.id === id)?.revision !== current.find(row => row.id === id)?.revision).sort();
}
/** Require one explicit, nonempty statement for each obligation and refuse unknown response keys. */
function requireResponses(response: HandoffResponse, contract: HandoffContract): void {
  for (const [values, ids] of [[response.questions, contract.questions.map(row => row.id)], [response.assumptions, contract.assumptions.map(row => row.id)], [response.evidence, contract.requiredEvidence.map(row => row.id)]] as const) {
    if (Object.keys(values).length !== ids.length || ids.some(id => !Object.hasOwn(values, id))) throw new HandoffError("responses", "Receiver responses do not cover the contract exactly", "Respond to every question, assumption and evidence id, including missing evidence; remove unknown response keys");
  }
}
/** Read all receipts and recompute validity; receiver filters affect output only, never stored data. */
export async function inspectHandoff(id: string, options: HandoffOptions, receiver?: string): Promise<HandoffStatus> {
  return handoffStatus(id, await corpus(options), options, receiver);
}
/** Assess receipts using the same certified source snapshot used for recording coverage. */
function handoffStatus(id: string, items: ListedItem[], options: HandoffOptions, receiver?: string): HandoffStatus {
  if (receiver !== undefined) key(receiver);
  const { packet, source } = readPacket(id, items);
  const stale = staleItems(packet, items); packet.missingEvidence = missingEvidence(packet.contract, items); bounded(packet, options);
  const receipts: HandoffReceipt[] = [];
  for (const comment of source.comments ?? []) {
    if (!comment.text.startsWith(ACK_PREFIX)) continue;
    try {
      const raw = record(JSON.parse(comment.text.slice(ACK_PREFIX.length))); const response = parseHandoffResponse(raw.response);
      const who = key(raw.receiver); requireResponses(response, packet.contract);
      if (who !== comment.author || response.digest !== packet.digest) throw new Error();
      if (receiver !== undefined && who !== receiver) continue;
      const dependencies = readAcknowledgedGroups(raw.dependencies, packet, source);
      receipts.push({ id: digest(raw), receiver: who, response, ...(dependencies === undefined ? {} : { dependencies }), acknowledgedAt: comment.created_at, valid: stale.length === 0, ready: stale.length === 0 && packet.missingEvidence.length === 0, staleItems: stale, missingEvidence: packet.missingEvidence });
    } catch { throw new HandoffError("integrity", "A handoff receipt is malformed or belongs to another contract", "Inspect the native packet comments; preserve history and create a fresh packet"); }
  }
  return bounded({ packet, staleItems: stale, receipts, estimatedTokenCeiling: 0 }, options);
}
/** Append an idempotent receiver receipt under the native comment lock; concurrent receivers never overwrite. */
export async function acknowledgeHandoff(id: string, input: HandoffResponse, options: HandoffOptions): Promise<HandoffStatus> {
  const receiver = author(options); const response = parseHandoffResponse(input);
  const items = await corpus(options);
  const before = handoffStatus(id, items, options, receiver);
  if (response.digest !== before.packet.digest || before.staleItems.length > 0) throw new HandoffError("stale", "The handoff no longer matches the receiver's snapshot", "Create and read a fresh packet, then respond against its digest and current blocker revisions");
  requireResponses(response, before.packet.contract);
  // Reserve the full receipt before mutation so a small budget never leaves an unseen write.
  const dependencies = obligationGroups(before.packet).map(group => ({ id: group.id, ...dependencySet(group, groupItems(group.id, before.packet.contract.items), items) }));
  const raw = { receiver, response, dependencies }; const text = ACK_PREFIX + canonical(raw);
  if (before.receipts.some(receipt => receipt.id === digest(raw))) return before;
  bounded({ ...before, receipts: [...before.receipts, { id: digest(raw), receiver, response, dependencies, acknowledgedAt: new Date().toISOString(), valid: true, ready: before.packet.missingEvidence.length === 0, staleItems: [], missingEvidence: before.packet.missingEvidence }] }, options);
  try { await retryLocked(() => client(options).comments(id, { add: text, author: receiver, ifAbsent: true })); }
  catch { throw new HandoffError("tracker", "Handoff receipt could not be appended", "Retry the same acknowledgment after the current tracker writer finishes; check pm health and permissions if contention persists"); }
  // A source edit racing the append is reported stale, never upgraded into a valid receipt.
  return inspectHandoff(id, options, receiver);
}
/** Parse revision-bound partial responses without accepting duplicate group keys. */
export function parseHandoffRenewal(value: unknown): HandoffRenewal {
  const input = record(value);
  const digest = parseHandoffResponse({ digest: input.digest, questions: {}, assumptions: {}, evidence: {} }).digest;
  if (!Array.isArray(input.groups) || input.groups.length < 1 || input.groups.length > 64) return invalid();
  const groups = input.groups.map(value => {
    const row = record(value);
    const response = parseHandoffResponse({ digest: row.target, questions: row.questions, assumptions: row.assumptions, evidence: row.evidence });
    return { id: key(row.id, Infinity), target: response.digest, questions: response.questions, assumptions: response.assumptions, evidence: response.evidence };
  });
  unique(groups.map(group => group.id));
  return { digest, groups };
}
/** Traverse a saved or current blocker graph without introducing another dependency model. */
function groupItems(root: string, items: HandoffRevision[]): HandoffRevision[] {
  const pending = [root]; const found = new Map<string, HandoffRevision>();
  for (const id of pending) {
    const item = items.find(item => item.id === id);
    if (!item || found.has(id)) continue;
    found.set(id, item); pending.push(...item.blockers);
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Bind a group to the immutable contract and full current SDK-read source coordinates. */
function groupTarget(digestValue: string, id: string, items: HandoffRevision[]): string { return digest({ digest: digestValue, id, items }); }
/** Partition the existing contract by focus closure; evidence outside every focus gets its own root. */
function obligationGroups(packet: HandoffPacket): (HandoffContract & { id: string })[] {
  const contract = packet.contract;
  const roots = [...contract.focus];
  const covered = new Set(roots.flatMap(id => groupItems(id, contract.items).map(row => row.id)));
  for (const evidence of contract.requiredEvidence) if (!covered.has(evidence.item) && !roots.includes(evidence.item)) roots.push(evidence.item);
  return roots.map(id => {
    const ids = new Set(groupItems(id, contract.items).map(row => row.id));
    const focused = contract.focus.includes(id);
    return { id, focus: [id], questions: focused ? contract.questions : [], assumptions: focused ? contract.assumptions : [], requiredEvidence: contract.requiredEvidence.filter(row => ids.has(row.item)) };
  });
}
/** Read every previously covered identity plus its live blockers and required evidence; never prune on edge removal. */
function dependencySet(group: HandoffContract, recorded: HandoffRevision[], items: ListedItem[]): HandoffDependencySet {
  const snapshots = revisions({ ...group, focus: [...new Set([...group.focus, ...recorded.map(row => row.id)])] }, items);
  const ids = new Set(snapshots.map(row => row.id));
  const edges: HandoffCoveredEdge[] = []; const evidenceLinks: HandoffCoveredEvidence[] = [];
  for (const item of items) {
    if (!ids.has(item.id)) continue;
    for (const edge of item.dependencies ?? []) edges.push({ from: item.id, to: edge.id, kind: edge.kind, revision: digest(edge) });
    if (item.blocked_by) edges.push({ from: item.id, to: item.blocked_by, kind: "blocked_by", revision: digest({ blocked_by: item.blocked_by }) });
    for (const kind of ["docs", "files", "tests"] as const) for (const link of item[kind] ?? []) evidenceLinks.push({ item: item.id, kind, ref: "command" in link && typeof link.command === "string" ? link.command : link.path, revision: digest(link) });
  }
  const order = (a: unknown, b: unknown) => canonical(a).localeCompare(canonical(b), "en");
  return { items: snapshots, edges: edges.sort(order), evidenceLinks: evidenceLinks.sort(order) };
}
/** Decode recorded revisions with the existing immutable artifact validator; old receipts remain readable. */
function recordedItems(value: unknown, packet: HandoffPacket, source: ListedItem): HandoffRevision[] {
  const document = { ...packet.contract, items: value };
  const body = JSON.stringify({ document, digest: digest(document) });
  return readPacket(packet.id, [{ ...source, body }]).packet.contract.items;
}
/** Validate explicit edge/link inventories without manufacturing historical data for legacy receipts. */
function readInventory(raw: Record<string, unknown>, snapshots: HandoffRevision[]): Pick<HandoffDependencySet, "edges" | "evidenceLinks"> | undefined {
  if (raw.edges === undefined && raw.evidenceLinks === undefined) return undefined;
  if (!Array.isArray(raw.edges) || !Array.isArray(raw.evidenceLinks)) return invalid();
  const ids = new Set(snapshots.map(row => row.id));
  const hash = (value: unknown) => parseHandoffResponse({ digest: value, questions: {}, assumptions: {}, evidence: {} }).digest;
  const edges = raw.edges.map(value => {
    const edge = record(value); const from = key(edge.from, Infinity);
    if (!ids.has(from)) return invalid();
    return { from, to: string(edge.to, Infinity), kind: string(edge.kind, Infinity), revision: hash(edge.revision) };
  });
  const evidenceLinks = raw.evidenceLinks.map((value): HandoffCoveredEvidence => {
    const link = record(value); const item = key(link.item, Infinity);
    if (!ids.has(item) || (link.kind !== "docs" && link.kind !== "files" && link.kind !== "tests")) return invalid();
    return { item, kind: link.kind, ref: link.ref === undefined ? undefined : string(link.ref, Infinity), revision: hash(link.revision) };
  });
  return { edges, evidenceLinks };
}
/** Validate an initial acknowledgment's complete group coverage, allowing older records without inventories. */
function readAcknowledgedGroups(value: unknown, packet: HandoffPacket, source: ListedItem): HandoffAcknowledgedGroup[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalid();
  const groups = obligationGroups(packet);
  const dependencies = value.map(value => {
    const row = record(value); const id = key(row.id, Infinity);
    const items = recordedItems(row.items, packet, source); const inventory = readInventory(row, items);
    if (!inventory || !groups.some(group => group.id === id)) return invalid();
    return { id, items, ...inventory };
  });
  unique(dependencies.map(row => row.id));
  if (dependencies.length !== groups.length) return invalid();
  return dependencies;
}
/** Preserve all coverage identities while advancing their last recorded revisions after renewal. */
function previousCoverage(packet: HandoffPacket, group: HandoffContract & { id: string }, initial: HandoffAcknowledgedGroup[], records: RenewalRecord[]): HandoffRevision[] {
  const baseline = groupItems(group.id, packet.contract.items);
  const saved = [baseline, ...initial.filter(row => row.id === group.id).map(row => row.items), ...records.flatMap(row => row.groups).filter(row => row.id === group.id).map(row => row.items)];
  const byId = new Map<string, HandoffRevision>();
  for (const items of saved) for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id, "en"));
}
/** Decode only attributable complete protocol records; foreign comments remain untouched and disclosed. */
function repairReceipts(source: ListedItem, packet: HandoffPacket, groups: (HandoffContract & { id: string })[], receiver: string): { acknowledged: boolean; initial: HandoffAcknowledgedGroup[]; records: RenewalRecord[]; skipped: HandoffRepair["skippedReceipts"] } {
  let acknowledged = false; const initial: HandoffAcknowledgedGroup[] = [];
  const records: RenewalRecord[] = []; const skipped: HandoffRepair["skippedReceipts"] = [];
  for (const [index, comment] of (source.comments ?? []).entries()) {
    if (!comment.text.startsWith(ACK_PREFIX) && !comment.text.startsWith(RENEW_PREFIX)) continue;
    try {
      const renewal = comment.text.startsWith(RENEW_PREFIX);
      const raw = record(JSON.parse(comment.text.slice(renewal ? RENEW_PREFIX.length : ACK_PREFIX.length)));
      const who = key(raw.receiver);
      if (who !== comment.author) throw new Error();
      if (!renewal) {
        const response = parseHandoffResponse(raw.response); requireResponses(response, packet.contract);
        if (response.digest !== packet.digest) throw new Error();
        const dependencies = readAcknowledgedGroups(raw.dependencies, packet, source);
        if (who === receiver && !acknowledged) { initial.push(...(dependencies ?? [])); acknowledged = true; }
        continue;
      }
      const parsed = parseHandoffRenewal(raw);
      if (parsed.digest !== packet.digest) throw new Error();
      const persisted = (raw.groups as unknown[]).map((value, i) => {
        const row = record(value); const group = parsed.groups[i];
        const obligation = groups.find(candidate => candidate.id === group.id);
        if (!obligation || !Array.isArray(row.items) || row.items.length > 64) throw new Error();

        // Reuse the immutable packet decoder for structural and canonical revision validation.
        const items = recordedItems(row.items, packet, source);
        const inventory = readInventory(row, items);
        const covered = new Set(items.map(row => row.id));
        requireResponses({ digest: packet.digest, ...group }, { ...obligation, requiredEvidence: packet.contract.requiredEvidence.filter(row => covered.has(row.item)) });
        if (group.target !== groupTarget(packet.digest, group.id, items)) throw new Error();
        return { ...group, items, ...inventory };
      });
      if (who === receiver) records.push({ receiver: who, digest: parsed.digest, groups: persisted });
    } catch { skipped.push({ index: index + 1, reason: "Foreign or malformed receipt: protocol, attribution, contract or group binding does not match" }); }
  }
  return { acknowledged, initial, records, skipped };
}
/** Compute only pending groups from one certified SDK snapshot, preserving unrelated understanding. */
function repairSnapshot(id: string, items: ListedItem[], options: HandoffOptions, receiver: string): { repair: HandoffRepair; current: Map<string, HandoffDependencySet> } {
  const { packet, source } = readPacket(id, items); const groups = obligationGroups(packet);
  const receipts = repairReceipts(source, packet, groups, receiver);
  if (!receipts.acknowledged) throw new HandoffError("unacknowledged", "Receiver has not acknowledged this contract", "Use handoff ack against a fresh contract first; repair only renews an existing receiver acknowledgment");
  const current = new Map<string, HandoffDependencySet>();
  const pending: HandoffRepairGroup[] = [];
  for (const group of groups) {
    const previous = previousCoverage(packet, group, receipts.initial, receipts.records);
    const coverage = dependencySet(group, previous, items); current.set(group.id, coverage);
    const targetItems = coverage.items;
    // Newly reachable evidence requirements become part of this group's existing contract obligations.
    const covered = new Set(targetItems.map(row => row.id));
    const requiredEvidence = packet.contract.requiredEvidence.filter(row => covered.has(row.item));
    const target = groupTarget(packet.digest, group.id, targetItems);
    if (target === groupTarget(packet.digest, group.id, previous)) continue;
    const ids = [...new Set([...previous, ...targetItems].map(row => row.id))].sort();
    const changes = ids.filter(id => previous.find(row => row.id === id)?.revision !== targetItems.find(row => row.id === id)?.revision).map(id => ({ id, from: previous.find(row => row.id === id)?.revision ?? null, to: targetItems.find(row => row.id === id)?.revision ?? null }));
    pending.push({ ...group, requiredEvidence, target, changes, missingEvidence: missingEvidence({ ...group, requiredEvidence }, items) });
  }
  const repair: HandoffRepair = { protocol: "pm-brief.repair/v1", id, digest: packet.digest, receiver, groups: pending, validAcknowledgments: groups.length - pending.length, totalGroups: groups.length, skippedReceipts: receipts.skipped, estimatedTokenCeiling: 0 };
  return { repair: bounded(repair, options), current };
}
/** Read a receiver-specific repair delta without writing or repeating unaffected obligations. */
export async function inspectHandoffRepair(id: string, options: HandoffOptions, receiver = author(options)): Promise<HandoffRepair> {
  return repairSnapshot(key(id, Infinity), await corpus(options), options, key(receiver)).repair;
}
/** Serialize renewal planning through verification and let native ifAbsent perform the atomic append. */
export async function renewHandoff(id: string, input: HandoffRenewal, options: HandoffOptions): Promise<HandoffRepair> {
  key(id, Infinity); const receiver = author(options); const renewal = parseHandoffRenewal(input);
  let release: () => Promise<void>;
  try { release = await acquireLock(options.pmRoot, `brief-renew-${digest(id)}`, 300, receiver, false, true, 1000); }
  catch { throw new HandoffError("tracker", "Another receiver renewal holds the tracker lease", "Retry after the current writer finishes; inspect pm health if lease contention persists"); }
  try {
    const items = await corpus(options); const { repair, current } = repairSnapshot(id, items, options, receiver);
    const { packet, source } = readPacket(id, items); const obligations = obligationGroups(packet);
    const records = repairReceipts(source, packet, obligations, receiver).records;
    if (renewal.digest !== repair.digest) throw new HandoffError("stale", "Renewal belongs to an old contract", "Read handoff repair again and answer against its digest and group targets");
    const storedGroups = renewal.groups.map(group => {
      const obligation = obligations.find(row => row.id === group.id);
      const snapshot = current.get(group.id);
      if (!obligation || !snapshot || group.target !== groupTarget(repair.digest, group.id, snapshot.items)) throw new HandoffError("stale", "Renewal targets an old source revision or unknown group", "Read handoff repair again and use its current target for each affected group");
      const covered = new Set(snapshot.items.map(row => row.id));
      requireResponses({ digest: repair.digest, ...group }, { ...obligation, requiredEvidence: packet.contract.requiredEvidence.filter(row => covered.has(row.item)) });
      const pending = repair.groups.some(row => row.id === group.id);
      const peerSuccess = records.some(record => record.groups.some(row => row.id === group.id && row.target === group.target));
      if (!pending && !peerSuccess) throw new HandoffError("responses", "Renewal includes an unaffected group", "Answer only groups returned by handoff repair; unchanged acknowledgments remain valid");
      return { ...group, ...snapshot };
    });
    const raw: RenewalRecord = { receiver, digest: repair.digest, groups: storedGroups };
    const text = RENEW_PREFIX + canonical(raw);
    // Check the output with the added receipt before any durable write, including foreign disclosures.
    repairSnapshot(id, items.map(row => row.id === id ? { ...row, comments: [...(row.comments ?? []), { author: receiver, text, created_at: new Date().toISOString() }] } : row), options, receiver);
    if (storedGroups.some(group => repair.groups.some(row => row.id === group.id))) {
      try { await retryLocked(() => client(options).comments(id, { add: text, author: receiver, ifAbsent: true })); }
      catch { throw new HandoffError("tracker", "Renewal could not be appended", "Retry the same renewal after the current writer finishes; inspect handoff repair and pm health if contention persists"); }
    }
    const latest = repairSnapshot(id, await corpus(options), options, receiver);
    const after = latest.repair;
    if (renewal.groups.some(group => group.target !== groupTarget(after.digest, group.id, latest.current.get(group.id)!.items))) throw new HandoffError("stale", "Sources changed while renewal was being recorded", "Read handoff repair again; the raced receipt remains historical and cannot validate the new revision");
    return after;
  } finally { await release(); }
}
/** Read a bounded JSON input file; parsing failures give agents a typed remedy. */
async function inputFile(value: unknown): Promise<unknown> {
  try {
    const file = await open(string(value), "r");
    try {
      const buffer = Buffer.alloc(128001); let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size);
        if (bytesRead === 0) break;
        size += bytesRead;
      }
      if (size > 128000) return invalid();
      return JSON.parse(buffer.subarray(0, size).toString("utf8")) as unknown;
    } finally { await file.close(); }
  }
  catch { throw new HandoffError("invalid", "Cannot read handoff JSON input", "Supply --input with a readable UTF-8 JSON contract or response file under 128000 bytes"); }
}
/** Translate CLI globals into the same SDK context without shelling out or invoking git. */
function commandOptions(ctx: CommandHandlerContext): HandoffOptions {
  return { pmRoot: ctx.pm_root, client: ctx.sdk?.client, author: ctx.global.author ?? process.env.PM_AUTHOR, tokenBudget: ctx.options.tokenBudget === undefined ? undefined : Number(ctx.options.tokenBudget) };
}
/** Register native structured TOON/JSON commands; expected refusals carry code and remedy at nonzero exit. */
export function registerHandoffCommands(api: ExtensionApi): void {
  const budget: FlagDefinition = { long: "--token-budget", type: "string", value_name: "n", description: "Conservative output token ceiling (default 4000, maximum 64000); refuses instead of dropping obligations" };
  for (const action of ["create", "show", "ack", "preview", "repair", "renew"] as const) {
    api.registerCommand({
      name: `brief handoff ${action}`,
      description: action === "repair" ? "Read only affected obligations for one acknowledged receiver" : action === "renew" ? "Renew affected obligations against exact current source revisions" : action === "preview" ? "Preview a revision-bound handoff without writing" : action === "create" ? "Create a revision-bound handoff contract" : action === "ack" ? "Record explicit receiver understanding against a handoff digest" : "Inspect current handoff revisions, evidence gaps and receiver receipts",
      read_output: action === "repair" ? { row_keys: ["groups"] } : action === "show" ? { row_keys: ["receipts"] } : action === "preview" ? { row_keys: ["contract.items"] } : undefined,
      flags: [budget, ...((action === "show" || action === "repair") ? [{ long: "--receiver", type: "string" as const, value_name: "id", description: "Show one receiver without omitting that receiver's receipts" }] : [{ long: "--input", type: "string" as const, value_name: "json-file", description: "Contract JSON for create/preview; response JSON for ack; group renewal JSON for renew" }])],
      async run(ctx) {
        try {
          const options = commandOptions(ctx);
          if (action === "repair") return await inspectHandoffRepair(key(ctx.args[0], Infinity), options, ctx.options.receiver === undefined ? author(options) : key(ctx.options.receiver));
          if (action === "renew") return await renewHandoff(key(ctx.args[0], Infinity), parseHandoffRenewal(await inputFile(ctx.options.input)), options);
          if (action === "preview") return await previewHandoff(parseHandoffContract(await inputFile(ctx.options.input)), options);
          if (action === "create") return await createHandoff(parseHandoffContract(await inputFile(ctx.options.input)), options);
          if (action === "ack") return await acknowledgeHandoff(key(ctx.args[0], Infinity), parseHandoffResponse(await inputFile(ctx.options.input)), options);
          return await inspectHandoff(key(ctx.args[0], Infinity), options, ctx.options.receiver === undefined ? undefined : key(ctx.options.receiver));
        } catch (error) {
          const refusal = error instanceof HandoffError ? error : new HandoffError("tracker", "Handoff operation could not complete", "Run pm health and check tracker permissions before retrying");
          throw createPmCliExpectedError(`handoff ${refusal.code}: ${refusal.message}. Remedy: ${refusal.remedy}`, { exitCode: refusal.code === "stale" ? 3 : 2, context: { code: `handoff_${refusal.code}`, required: refusal.remedy } });
        }
      },
    });
  }
}
