import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { acquireLock, PmClient } from "@unbrained/pm-cli/sdk";
import type { CommentsCommandOptions, PmReadOutputOptions, PmCompleteListOptions } from "@unbrained/pm-cli/sdk";
import { acknowledgeHandoff, createHandoff, HandoffError, inspectHandoffRepair, parseHandoffContract, parseHandoffRenewal, parseHandoffResponse, renewHandoff, previewHandoff } from "../index.ts";
import type { HandoffContract, HandoffOptions, HandoffPacket, HandoffRepair, HandoffRenewal } from "../index.ts";

const root = resolve(import.meta.dirname, "..");
const workspace = await mkdtemp(join(tmpdir(), "brief-repair-"));
const pmRoot = join(workspace, ".agents", "pm");
const client = new PmClient({ pmRoot, author: "fixture", noExtensions: true });
const options: HandoffOptions = { pmRoot, client, author: "receiver", tokenBudget: 64000 };
const cli = join(root, "node_modules/@unbrained/pm-cli/dist/cli.js");

/** Explicit initial receiver understanding, retaining all native contract keys. */
function answers(packet: HandoffPacket) {
  return { digest: packet.digest, questions: Object.fromEntries(packet.contract.questions.map(row => [row.id, "  Public fixture\r\nwith retained whitespace  "])), assumptions: Object.fromEntries(packet.contract.assumptions.map(row => [row.id, "Unverified assumption"])), evidence: Object.fromEntries(packet.contract.requiredEvidence.map(row => [row.id, "Linkage only"])) };
}
/** Construct partial renewal answers from only the affected groups in a repair delta. */
function renewal(repair: HandoffRepair): HandoffRenewal {
  return { digest: repair.digest, groups: repair.groups.map(group => ({ id: group.id, target: group.target, questions: Object.fromEntries(group.questions.map(row => [row.id, "  Renewed\r\nunderstanding  "])), assumptions: Object.fromEntries(group.assumptions.map(row => [row.id, "Still unverified"])), evidence: Object.fromEntries(group.requiredEvidence.map(row => [row.id, "Reference checked"])) })) };
}
/** Match stable SDK refusal codes while requiring a useful recovery instruction. */
function refuses(code: string) { return (error: unknown) => { assert.ok(error instanceof HandoffError); assert.equal(error.code, code); assert.ok(error.remedy.length > 15); return true; }; }
/** Vary JSON transport framing independently of embedded user text. */
function transport(value: unknown, seed: number): unknown { return JSON.parse(JSON.stringify(value, null, seed % 2 ? 2 : undefined).replace(/\n/g, seed % 3 ? "\r\n" : "\n")) as unknown; }
/** Initialize a packet with two independent source groups and all supported obligation kinds. */
async function fixture(native = client, settings = options) {
  const dep = (await native.create({ type: "Task", title: "Public dependency" })).item.id;
  const first = (await native.create({ type: "Task", title: "Affected obligation", blockedBy: dep })).item.id;
  const other = (await native.create({ type: "Task", title: "Unchanged obligation" })).item.id;
  const contract: HandoffContract = { focus: [first, other], questions: [{ id: "q", text: "  Which public scope?\r\n  " }], assumptions: [{ id: "a", text: "The gate remains unresolved" }], requiredEvidence: [{ id: "doc", item: first, kind: "docs", ref: "docs/proof.md" }, { id: "file", item: first, kind: "files", ref: "source.ts" }, { id: "test", item: first, kind: "tests", ref: "node --version" }] };
  const packet = await createHandoff(parseHandoffContract(transport(contract, 1)), { ...settings, author: "sender" });
  const { protocol, sender, createdAt, items, ...roundTripped } = packet.contract;
  assert.deepEqual(roundTripped, contract);
  await acknowledgeHandoff(packet.id, parseHandoffResponse(transport(answers(packet), 2)), settings);
  const stored = (await native.listAllComplete({ includeBody: true })).items.find(row => row.id === packet.id)!;
  const acknowledgment = JSON.parse(stored.comments![0].text.slice("pm-brief.ack/v1 ".length)) as { response: unknown };
  assert.deepEqual(acknowledgment.response, answers(packet));
  assert.deepEqual(JSON.parse(String(stored.body)), { document: packet.contract, digest: packet.digest });
  return { dep, first, other, packet, contract };
}

/** Canonical protocol JSON for deliberately authored native peer receipts, without source normalization. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, row: unknown) => row !== null && typeof row === "object" && !Array.isArray(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : row);
}

before(async () => {
  await client.init("repair", { defaults: true, agentGuidance: "skip", mergeFence: false });
  await mkdir(join(workspace, "bin")); await symlink(process.execPath, join(workspace, "bin", "node"));
  const extensionRoot = join(pmRoot, "extensions", "pm-brief"); await mkdir(extensionRoot, { recursive: true });
  for (const name of ["manifest.json", "package.json"]) await cp(join(root, name), join(extensionRoot, name));
  await cp(join(root, "dist"), join(extensionRoot, "dist"), { recursive: true }); await symlink(join(root, "node_modules"), join(extensionRoot, "node_modules"));
});
after(() => rm(workspace, { recursive: true, force: true }));

test("one changed dependency in 50 source rows yields one group and preserves 24 acknowledgments", async () => {
  const focus: string[] = []; const deps: string[] = [];
  for (let i = 0; i < 25; i++) {
    const dep = (await client.create({ title: `Independent gate ${i}`, type: "Task" })).item.id; deps.push(dep);
    focus.push((await client.create({ title: `Independent obligation ${i}`, type: "Task", blockedBy: dep })).item.id);
  }
  const packet = await createHandoff({ focus, questions: [{ id: "scope", text: "Confirm scope" }], assumptions: [], requiredEvidence: [{ id: "report", item: focus[0], kind: "docs", ref: "docs/report.md" }] }, options);
  assert.equal(packet.contract.items.length, 50);
  await acknowledgeHandoff(packet.id, answers(packet), options);
  await client.update(deps[0], { body: "Changed gate" });
  const repair = await inspectHandoffRepair(packet.id, options);
  assert.equal(repair.groups.length, 1); assert.equal(repair.validAcknowledgments, 24); assert.equal(repair.totalGroups, 25);
  assert.deepEqual(repair.groups[0].changes.map(row => row.id), [deps[0]]);
  assert.deepEqual(repair.groups[0].requiredEvidence.map(row => row.id), ["report"]);
  const saved = renewal(repair); const before = (await client.listAllComplete({ includeBody: true })).items;
  const renewed = await renewHandoff(packet.id, saved, options);
  assert.equal(renewed.groups.length, 0); assert.equal(renewed.validAcknowledgments, 25);
  await renewHandoff(packet.id, saved, options);
  const afterRows = (await client.listAllComplete({ includeBody: true })).items;
  assert.deepEqual(afterRows.filter(row => row.id !== packet.id), before.filter(row => row.id !== packet.id));
  assert.equal(afterRows.find(row => row.id === packet.id)?.comments?.length, 2);
  assert.deepEqual(JSON.parse(String(afterRows.find(row => row.id === packet.id)!.body)), { document: packet.contract, digest: packet.digest });
  await client.update(deps[0], { body: "A newer revision" });
  await assert.rejects(renewHandoff(packet.id, saved, options), refuses("stale"));
});

test("seeded model: 500 random sequences round-trip contracts, acknowledgments and renewals through SDK state", { timeout: 900000 }, async t => {
  const modelRoot = join(workspace, "model");
  const client = new PmClient({ pmRoot: modelRoot, author: "fixture", noExtensions: true });
  await client.init("model", { defaults: true, agentGuidance: "skip", mergeFence: false });
  const options: HandoffOptions = { pmRoot: modelRoot, client, author: "receiver", tokenBudget: 64000 };
  const { dep, first, other, packet } = await fixture(client, options);
  const sourceIds = [dep, first, other];
  let randomState = 0x5eed2025;
  const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
  /** Read full native state instead of duplicating the SDK's whitespace, relationship or field normalization. */
  const sourceState = async () => new Map((await client.listAllComplete({ includeBody: true })).items.filter(row => sourceIds.includes(row.id)).map(row => [row.id, row]));
  let baseline = await sourceState();
  const old: HandoffRenewal[] = [];
  const validTargets = new Map<string, string>();
  let expectedReceiptCount = 1;
  let replayed = 0; let roundTrips = 0;
  for (let sequence = 0; sequence < 500; sequence++) {
    const target = sourceIds[random() % sourceIds.length];
    const text = `  public sequence ${sequence}  \r\nsecond line  `;
    // Native fields touched by handoff storage, plus every observed source field family and relationships.
    switch (random() % 9) {
      case 0: await client.update(target, { body: text, description: text }); break;
      case 1: await client.update(target, { title: text, priority: String(random() % 4 + 1), tags: `public,case-${sequence}` }); break;
      case 2: await client.comments(target, { add: text, author: "fixture", ifAbsent: true }); break;
      case 3: await client.docs(target, { add: [`path=docs/proof-${sequence}.md`] }); break;
      case 4: await client.files(target, { add: [`path=source-${sequence}.ts`] }); break;
      case 5: await client.run("test", { id: target, options: { add: [`command=node --version # ${sequence}`] } }); break;
      case 6: await client.update(target, { dep: [`id=${target === dep ? other : dep},kind=related_to`] }); break;
      case 7: await client.update(target, { status: sequence % 2 ? "blocked" : "open", note: [text] }); break;
      case 8: await client.update(target, { body: "  replayed older content\r\n  " }); break;
    }
    const current = await sourceState();
    const expected = [first, other].filter(id => (id === first ? [first, dep] : [other]).some(source => !isDeepStrictEqual(baseline.get(source), current.get(source))));
    const repair = await inspectHandoffRepair(packet.id, options);
    assert.deepEqual(repair.groups.map(row => row.id).sort(), expected.sort(), `seed 0x5eed2025 sequence ${sequence}`);
    assert.equal(repair.validAcknowledgments, 2 - expected.length);
    // Every sequence replays an older imported input once any renewal exists.
    if (old.length) {
      const input = parseHandoffRenewal(transport(old[random() % old.length], random()));
      const stale = input.groups.some(group => (repair.groups.find(row => row.id === group.id)?.target ?? validTargets.get(group.id)) !== group.target);
      if (stale) await assert.rejects(renewHandoff(packet.id, input, options), refuses("stale"));
      else await renewHandoff(packet.id, input, options);
      replayed++;
    }
    if (repair.groups.length) {
      const expectedInput = renewal(repair);
      const input = parseHandoffRenewal(transport(expectedInput, random()));
      assert.deepEqual(input, expectedInput);
      const result = await renewHandoff(packet.id, input, options);
      assert.equal(result.groups.length, 0); assert.equal(result.validAcknowledgments, 2);
      old.push(input); expectedReceiptCount++;
      for (const group of input.groups) validTargets.set(group.id, group.target);
      const stored = (await client.listAllComplete({ includeBody: true })).items.find(row => row.id === packet.id)!;
      assert.equal(stored.comments?.length, expectedReceiptCount);
      const persisted = JSON.parse(stored.comments!.at(-1)!.text.slice("pm-brief.renew/v1 ".length)) as { groups: unknown[]; receiver: string; digest: string };
      assert.equal(persisted.receiver, "receiver"); assert.equal(persisted.digest, packet.digest);
      assert.deepEqual(parseHandoffRenewal(persisted), expectedInput);
      assert.deepEqual(persisted.groups.map(value => {
        const row = value as Record<string, unknown>;
        return { id: row.id, target: row.target, questions: row.questions, assumptions: row.assumptions, evidence: row.evidence };
      }), expectedInput.groups);
      assert.deepEqual(await sourceState(), current);
      assert.deepEqual(JSON.parse(String(stored.body)), { document: packet.contract, digest: packet.digest });
      assert.equal(stored.type, "Decision"); assert.ok(stored.tags.includes("pm-brief-handoff")); assert.equal(stored.author, "sender");
      roundTrips++;
    }
    // Acknowledgment import replay is a native atomic no-op and never resets renewed state.
    await acknowledgeInitialReplay(packet, expectedReceiptCount, options);
    baseline = current;
  }
  assert.ok(replayed >= 499); assert.ok(roundTrips >= 400);
  t.diagnostic(JSON.stringify({ seed: "0x5eed2025", sequences: 500, olderInputReplays: replayed, changedRevisionRoundTrips: roundTrips, nativeNoOpSequences: 500 - roundTrips }));
});

/** Replay the original input through native ifAbsent without bypassing old-revision refusal. */
async function acknowledgeInitialReplay(packet: HandoffPacket, count: number, options: HandoffOptions): Promise<void> {
  await assert.rejects(acknowledgeHandoff(packet.id, parseHandoffResponse(transport(answers(packet), count)), options), refuses("stale"));
  const persisted = (await options.client!.listAllComplete({ includeBody: true })).items.find(row => row.id === packet.id)!;
  assert.equal(persisted.comments?.length, count);
}

/** Inject a competing real SDK transition around each source-read and append boundary. */
class InterleavedClient extends PmClient {
  steps = 0;
  injectAt = 0;
  effect: () => Promise<void> = async () => {};
  /** Execute the competitor exactly once, preserving the actual SDK storage implementation. */
  async boundary() { if (++this.steps === this.injectAt) await this.effect(); }
  /** Inspect both sides of the source snapshot operation. */
  override async listAllComplete(input?: PmCompleteListOptions) { await this.boundary(); const result = await super.listAllComplete(input); await this.boundary(); return result; }
  /** Inspect both sides of the SDK's atomic ifAbsent append. */
  override async comments<T extends CommentsCommandOptions & PmReadOutputOptions = CommentsCommandOptions>(id: string, input?: T) { await this.boundary(); const result = await super.comments(id, input); await this.boundary(); return result; }
}

test("same non-git tracker interleavings inject source edits and peer appends at every read/write boundary", async () => {
  for (const competitor of ["source", "peer", "foreign"] as const) for (let boundary = 1; boundary <= 6; boundary++) {
    const { dep, first, packet, contract } = await fixture();
    await client.update(dep, { body: "First changed revision" });
    const input = renewal(await inspectHandoffRepair(packet.id, options));
    const live = await previewHandoff(contract, options);
    const raw = { receiver: "receiver", digest: input.digest, groups: input.groups.map(group => ({ ...group, items: live.contract.items.filter(row => row.id === dep || row.id === first) })) };
    const peerText = "pm-brief.renew/v1 " + canonicalJson(raw);
    const interleaved = new InterleavedClient({ pmRoot, noExtensions: true }); interleaved.injectAt = boundary;
    const leaseId = `brief-renew-${createHash("sha256").update(JSON.stringify(packet.id)).digest("hex")}`;
    interleaved.effect = async () => {
      await assert.rejects(acquireLock(pmRoot, leaseId, 300, "peer", false, true, 0));
      if (competitor === "source") await client.update(dep, { body: `Competing source transition ${boundary}` });
      else if (competitor === "foreign") await client.comments(packet.id, { add: 'pm-brief.renew/v1 {"foreign":true}', author: "foreign" });
      else {
        // Simulate the peer winning the exact native append, independently of the caller's pre-read.
        await client.comments(packet.id, { add: peerText, author: "receiver", ifAbsent: true });
      }
    };
    if (competitor === "source" && boundary < 6) await assert.rejects(renewHandoff(packet.id, input, { ...options, client: interleaved }), refuses("stale"));
    else {
      const result = await renewHandoff(packet.id, input, { ...options, client: interleaved });
      assert.equal(result.groups.length, 0);
    }
    assert.equal(interleaved.steps, competitor === "source" && boundary === 1 ? 2 : competitor === "peer" && boundary === 1 ? 4 : 6);
    const released = await acquireLock(pmRoot, leaseId, 300, "peer", false, true, 0); await released();
    const persisted = await inspectHandoffRepair(packet.id, options);
    if (competitor === "source") assert.equal(persisted.groups.length, 1);
    else assert.equal(persisted.groups.length, 0);
    const records = (await client.listAllComplete({ includeBody: true })).items.find(row => row.id === packet.id)!.comments!;
    assert.equal(records.filter(row => row.text.startsWith("pm-brief.renew/v1 ") && row.author === "receiver").length, competitor === "source" && boundary === 1 ? 0 : 1);
  }
});

test("read-only repair, foreign receipt disclosure, scoped evidence and typed refusals", async () => {
  const { dep, first, packet } = await fixture();
  await assert.rejects(inspectHandoffRepair(packet.id, options, "unknown"), refuses("unacknowledged"));
  await client.comments(packet.id, { add: 'pm-brief.ack/v1 {"foreign":true}', author: "foreign" });
  await client.comments(packet.id, { add: 'pm-brief.renew/v1 {"foreign":true}', author: "foreign" });
  const rows = (await client.listAllComplete({ includeBody: true })).items;
  const clean = await inspectHandoffRepair(packet.id, options); assert.equal(clean.groups.length, 0); assert.equal(clean.skippedReceipts.length, 2);
  assert.deepEqual((await client.listAllComplete({ includeBody: true })).items, rows);
  await client.update(dep, { body: "Changed evidence dependency" });
  const repair = await inspectHandoffRepair(packet.id, options);
  assert.deepEqual(repair.groups[0].missingEvidence, ["doc", "file", "test"]);
  await assert.rejects(inspectHandoffRepair(packet.id, { ...options, tokenBudget: 1 }), refuses("budget"));
  const input = renewal(repair);
  await assert.rejects(renewHandoff(packet.id, { ...input, digest: "a".repeat(64) }, options), refuses("stale"));
  await assert.rejects(renewHandoff(packet.id, { ...input, groups: [{ ...input.groups[0], questions: {} }] }, options), refuses("responses"));
  for (const value of [null, {}, { digest: input.digest, groups: [] }, { ...input, groups: [input.groups[0], input.groups[0]] }]) assert.throws(() => parseHandoffRenewal(value), refuses("invalid"));
  await renewHandoff(packet.id, input, options);
  const unaffected = { ...input, groups: [{ ...input.groups[0], id: first, target: input.groups[0].target }] };
  assert.equal((await renewHandoff(packet.id, unaffected, options)).groups.length, 0);
  await client.docs(first, { add: ["path=docs/proof.md"] });
  const next = await inspectHandoffRepair(packet.id, options); assert.deepEqual(next.groups[0].missingEvidence, ["file", "test"]);
});

test("real CLI repair and renew emit bounded JSON and native TOON with no git executable", async () => {
  const { dep, packet } = await fixture(); await client.update(dep, { body: "CLI revision" });
  /** Invoke the installed extension in a plain tracker with no git on PATH. */
  const run = (args: string[]) => spawnSync(process.execPath, [cli, "--pm-path", pmRoot, ...args], { cwd: workspace, env: { ...process.env, PM_AUTHOR: "receiver", PATH: join(workspace, "bin"), GIT_CEILING_DIRECTORIES: dirname(workspace), HOME: join(workspace, "home") }, encoding: "utf8", timeout: 120000 });
  const shown = run(["--json", "brief", "handoff", "repair", packet.id, "--token-budget", "64000"]);
  assert.equal(shown.status, 0, shown.stderr + shown.stdout);
  const repair = JSON.parse(shown.stdout) as HandoffRepair; assert.equal(repair.groups.length, 1);
  const toon = run(["brief", "handoff", "repair", packet.id, "--receiver", "receiver"]); assert.equal(toon.status, 0, toon.stderr + toon.stdout); assert.match(toon.stdout, /validAcknowledgments/);
  const input = join(workspace, "renewal.json"); await writeFile(input, JSON.stringify(renewal(repair), null, 2).replace(/\n/g, "\r\n"));
  const renewed = run(["--json", "brief", "handoff", "renew", packet.id, "--input", input]); assert.equal(renewed.status, 0, renewed.stderr + renewed.stdout); assert.equal((JSON.parse(renewed.stdout) as HandoffRepair).groups.length, 0);
  await client.update(dep, { body: "CLI newer revision" });
  const stale = run(["--json", "brief", "handoff", "renew", packet.id, "--input", input]); assert.equal(stale.status, 3); assert.match(stale.stdout + stale.stderr, /handoff_stale/);
  const bad = run(["--json", "brief", "handoff", "repair", packet.id, "--receiver", "unknown"]); assert.equal(bad.status, 2); assert.match(bad.stdout + bad.stderr, /handoff_unacknowledged/);
});

test("partial renewals, evidence-only roots, new and removed blockers, and foreign native records", async () => {
  const { dep, first, other, packet } = await fixture();
  const extra = (await client.create({ type: "Task", title: "Evidence outside the focus closure" })).item.id;
  const original: HandoffContract = { focus: [first, other], questions: [], assumptions: [], requiredEvidence: [{ id: "outside", item: extra, kind: "files", ref: "outside.ts" }] };
  const standalone = await createHandoff(original, options); await acknowledgeHandoff(standalone.id, answers(standalone), options);
  await client.update(extra, { body: "Changed outside evidence" });
  const evidenceRepair = await inspectHandoffRepair(standalone.id, options);
  assert.equal(evidenceRepair.totalGroups, 3); assert.equal(evidenceRepair.groups[0].id, extra); assert.deepEqual(evidenceRepair.groups[0].questions, []);
  await renewHandoff(standalone.id, renewal(evidenceRepair), options);
  await client.update(first, { dep: [`id=${extra},kind=blocked_by`] });
  await client.update(other, { blockedBy: extra });
  const changed = await inspectHandoffRepair(standalone.id, options); assert.equal(changed.groups.length, 2);
  const input = renewal(changed);
  const partial = await renewHandoff(standalone.id, { ...input, groups: input.groups.slice(0, 1) }, options); assert.equal(partial.groups.length, 1);
  await renewHandoff(standalone.id, { ...input, groups: input.groups.slice(1) }, options);
  await client.update(first, { depRemove: [`id=${extra},kind=blocked_by`] });
  const removed = await inspectHandoffRepair(standalone.id, options); assert.ok(removed.groups[0].changes.some(row => row.id === extra && row.to === null));
  await renewHandoff(standalone.id, renewal(removed), options);
  // An unaffected original group cannot be gratuitously renewed.
  const snapshots = packet.contract.items.filter(row => row.id === dep || row.id === first);
  // A fresh untouched group has no pending response to renew.
  const fresh = await createHandoff({ focus: [dep], questions: [], assumptions: [], requiredEvidence: [] }, options); await acknowledgeHandoff(fresh.id, answers(fresh), options);
  const target = createHash("sha256").update(canonicalJson({ digest: fresh.digest, id: dep, items: fresh.contract.items })).digest("hex");
  await assert.rejects(renewHandoff(fresh.id, { digest: fresh.digest, groups: [{ id: dep, target, questions: {}, assumptions: {}, evidence: {} }] }, options), refuses("responses"));
  await client.update(dep, { body: "Foreign record assessment" });
  const pending = renewal(await inspectHandoffRepair(packet.id, options));
  const validRow = { ...pending.groups[0], items: snapshots };
  for (const raw of [
    { receiver: "imposter", digest: pending.digest, groups: [validRow] },
    { receiver: "foreign", digest: "a".repeat(64), groups: [validRow] },
    { receiver: "foreign", digest: pending.digest, groups: [{ ...validRow, id: "unknown" }] },
    { receiver: "foreign", digest: pending.digest, groups: [{ ...validRow, items: null }] },
    { receiver: "foreign", digest: pending.digest, groups: [{ ...validRow, items: [] }] },
    { receiver: "foreign", digest: pending.digest, groups: [{ ...validRow, items: [{ ...snapshots[0], revision: 4 }] }] },
  ]) await client.comments(packet.id, { add: "pm-brief.renew/v1 " + JSON.stringify(raw), author: "foreign" });
  await client.comments(packet.id, { add: "pm-brief.ack/v1 " + JSON.stringify({ receiver: "foreign", response: { ...answers(packet), digest: "a".repeat(64) } }), author: "foreign" });
  const foreign = await inspectHandoffRepair(packet.id, options); assert.equal(foreign.skippedReceipts.length, 7);
});

test("renewal write failures preserve a typed remedy and release the lease", async () => {
  const { dep, packet } = await fixture(); await client.update(dep, { body: "Before unavailable history" });
  const input = renewal(await inspectHandoffRepair(packet.id, options));
  const history = join(pmRoot, "history"); const saved = join(pmRoot, "saved-history");
  await rename(history, saved);
  try {
    await writeFile(history, "Cannot append a history record to this regular file");
    await assert.rejects(renewHandoff(packet.id, input, options), refuses("tracker"));
  } finally { await rm(history, { force: true }); await rename(saved, history); }
  assert.equal((await renewHandoff(packet.id, input, options)).groups.length, 0);
});

test("two concurrent renewers report the peer's success without duplicating a native receipt", async () => {
  const { dep, packet } = await fixture(); await client.update(dep, { body: "Concurrent receiver revision" });
  const input = renewal(await inspectHandoffRepair(packet.id, options));
  const results = await Promise.all([renewHandoff(packet.id, input, options), renewHandoff(packet.id, input, options)]);
  assert.ok(results.every(row => row.groups.length === 0));
  const row = (await client.listAllComplete({ includeBody: true })).items.find(row => row.id === packet.id)!;
  assert.equal(row.comments?.length, 2);
});

test("an old target refuses even when a peer has already renewed a newer source revision", async () => {
  const { dep, first, packet, contract } = await fixture(); await client.update(dep, { body: "Parent target" });
  const old = renewal(await inspectHandoffRepair(packet.id, options));
  const interleaved = new InterleavedClient({ pmRoot, noExtensions: true }); interleaved.injectAt = 4;
  interleaved.effect = async () => {
    await client.update(dep, { body: "Newer target independently acknowledged by peer" });
    const next = renewal(await inspectHandoffRepair(packet.id, options));
    const live = await previewHandoff(contract, options);
    const raw = { receiver: "receiver", digest: next.digest, groups: next.groups.map(group => ({ ...group, items: live.contract.items.filter(row => row.id === dep || row.id === first) })) };
    await client.comments(packet.id, { add: "pm-brief.renew/v1 " + canonicalJson(raw), author: "receiver", ifAbsent: true });
  };
  await assert.rejects(renewHandoff(packet.id, old, { ...options, client: interleaved }), refuses("stale"));
  assert.equal((await inspectHandoffRepair(packet.id, options)).groups.length, 0);
});
