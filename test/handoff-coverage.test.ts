import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { after, before, test } from "node:test";
import { PmClient } from "@unbrained/pm-cli/sdk";
import type { ListedItem } from "@unbrained/pm-cli/sdk";
import { acknowledgeHandoff, createHandoff, HandoffError, inspectHandoffRepair, renewHandoff } from "../index.ts";
import type { HandoffAcknowledgedGroup, HandoffContract, HandoffEvidence, HandoffOptions, HandoffPacket, HandoffRepair, HandoffRenewal } from "../index.ts";

const workspace = await mkdtemp(join(tmpdir(), "brief-recorded-coverage-"));
const pmRoot = join(workspace, "tracker");
const client = new PmClient({ pmRoot, author: "coverage-model", noExtensions: true });
const options: HandoffOptions = { pmRoot, client, author: "receiver", tokenBudget: 64000 };
const savedCeiling = process.env.GIT_CEILING_DIRECTORIES;
before(async () => { process.env.GIT_CEILING_DIRECTORIES = dirname(workspace); await client.init("coverage", { defaults: true, agentGuidance: "skip", mergeFence: false }); });
after(async () => { if (savedCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES; else process.env.GIT_CEILING_DIRECTORIES = savedCeiling; await rm(workspace, { recursive: true, force: true }); });

/** Return native source rows through the complete SDK reader, never an alternate parser or normalizer. */
async function rows(): Promise<Map<string, ListedItem>> { return new Map((await client.listAllComplete({ includeBody: true })).items.map(row => [row.id, row])); }
/** Explicit initial responses preserve the contract's exact obligation identifiers. */
function answers(packet: HandoffPacket) { return { digest: packet.digest, questions: {}, assumptions: {}, evidence: Object.fromEntries(packet.contract.requiredEvidence.map(row => [row.id, "  Recorded reference\r\ncontents need review  "])) }; }
/** Answer only selected affected groups, using their current revision targets. */
function response(repair: HandoffRepair, ids = repair.groups.map(row => row.id)): HandoffRenewal {
  return { digest: repair.digest, groups: repair.groups.filter(row => ids.includes(row.id)).map(row => ({ id: row.id, target: row.target, questions: {}, assumptions: {}, evidence: Object.fromEntries(row.requiredEvidence.map(link => [link.id, "  Renewed reference\r\nno approval implied  "])) })) };
}
/** Assert typed stale and acknowledgment refusals without matching implementation prose. */
function refuses(code: string) { return (error: unknown) => { assert.ok(error instanceof HandoffError); assert.equal(error.code, code); assert.ok(error.remedy.length > 10); return true; }; }
/** Mutate real native links for each supported evidence collection. */
async function link(id: string, kind: HandoffEvidence["kind"], ref: string, add: boolean): Promise<void> {
  if (kind === "tests") await client.run("test", { id, options: add ? { add: [`command=${ref}`] } : { remove: [`command=${ref}`] } });
  else if (kind === "docs") await client.docs(id, add ? { add: [`path=${ref}`] } : { remove: [ref] });
  else await client.files(id, add ? { add: [`path=${ref}`] } : { remove: [ref] });
}
/** Follow the reference graph by fixed-point expansion over actual SDK state, including missing targets. */
function reach(seeds: Iterable<string>, state: Map<string, ListedItem>): Set<string> {
  const covered = new Set(seeds);
  for (let changed = true; changed;) {
    const size = covered.size;
    for (const row of state.values()) {
      if (covered.has(row.id)) {
        for (const edge of row.dependencies ?? []) if (edge.kind === "blocked_by") covered.add(edge.id);
        if (row.blocked_by && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(row.blocked_by)) covered.add(row.blocked_by);
      }
      for (const edge of row.dependencies ?? []) if (edge.kind === "blocks" && covered.has(edge.id)) covered.add(row.id);
    }
    changed = size !== covered.size;
  }
  return covered;
}
/** Acknowledgment validity is plain structural equality over its recorded SDK source set plus live requirements. */
function expected(root: string, recorded: Map<string, ListedItem | undefined>, state: Map<string, ListedItem>, requirements: HandoffEvidence[]) {
  const ids = reach([root, ...recorded.keys()], state);
  const refs = requirements.filter(row => ids.has(row.item));
  const missing = refs.filter(row => !(state.get(row.item)?.[row.kind] ?? []).some(link => ("command" in link && link.command === row.ref) || link.path === row.ref)).map(row => row.id);
  const changes = [...ids].filter(id => !recorded.has(id) || !isDeepStrictEqual(recorded.get(id), state.get(id))).sort();
  const newlyMissing = refs.some(row => !recorded.has(row.item) && missing.includes(row.id));
  return { ids, missing, changes, invalid: changes.length > 0 || newlyMissing };
}
/** Read persisted receipt coverage through the SDK and compare every covered identity, edge and native link coordinate. */
function assertCoverage(snapshot: HandoffAcknowledgedGroup, ids: Set<string>, state: Map<string, ListedItem>) {
  assert.deepEqual(snapshot.items.map(row => row.id).sort(), [...ids].sort());
  for (const row of snapshot.items) if (state.has(row.id)) assert.match(row.revision!, /^[a-f0-9]{64}$/); else assert.equal(row.revision, null);
  const edges = [...ids].flatMap(id => {
    const row = state.get(id);
    return [...(row?.dependencies ?? []).map(edge => ({ from: id, to: edge.id, kind: edge.kind })), ...(row?.blocked_by ? [{ from: id, to: row.blocked_by, kind: "blocked_by" }] : [])];
  });
  assert.deepEqual(snapshot.edges.map(({ revision, ...edge }) => edge).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const links = [...ids].flatMap(id => (["docs", "files", "tests"] as const).flatMap(kind => (state.get(id)?.[kind] ?? []).map(link => ({ item: id, kind, ref: "command" in link && typeof link.command === "string" ? link.command : link.path }))));
  assert.deepEqual(snapshot.evidenceLinks.map(({ revision, ...link }) => link).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), links.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  for (const row of [...snapshot.edges, ...snapshot.evidenceLinks]) assert.match(row.revision, /^[a-f0-9]{64}$/);
}

test("recorded dependency regression: removed blocker cannot drop still-required evidence after renewal", async () => {
  for (const kind of ["docs", "files", "tests"] as const) {
    const evidence = (await client.create({ type: "Task", title: `Required ${kind} source` })).item.id;
    const focus = (await client.create({ type: "Task", title: `Focus with ${kind} blocker`, dep: [`id=${evidence},kind=blocked_by`] })).item.id;
    const ref = kind === "tests" ? "node --version" : `proof.${kind}`;
    await link(evidence, kind, ref, true);
    const packet = await createHandoff({ focus: [focus], questions: [], assumptions: [], requiredEvidence: [{ id: "proof", item: evidence, kind, ref }] }, options);
    const initial = await acknowledgeHandoff(packet.id, answers(packet), options);
    assert.equal(initial.receipts[0].dependencies?.length, 1);
    assertCoverage(initial.receipts[0].dependencies![0], new Set([focus, evidence]), await rows());
    await client.update(focus, { depRemove: [`id=${evidence},kind=blocked_by`] });
    const afterRemoval = await rows(); assert.ok(!reach([focus], afterRemoval).has(evidence));
    const edgeRepair = await inspectHandoffRepair(packet.id, options);
    await renewHandoff(packet.id, response(edgeRepair), options);
    const artifact = (await rows()).get(packet.id)!;
    const stored = JSON.parse(artifact.comments!.at(-1)!.text.slice("pm-brief.renew/v1 ".length)) as { groups: HandoffAcknowledgedGroup[] };
    assertCoverage(stored.groups[0], new Set([focus, evidence]), await rows());
    await link(evidence, kind, ref, false);
    const repair = await inspectHandoffRepair(packet.id, options);
    assert.equal(repair.groups.length, 1); assert.equal(repair.validAcknowledgments, 0);
    assert.deepEqual(repair.groups[0].changes.map(row => row.id), [evidence]);
    assert.deepEqual(repair.groups[0].missingEvidence, ["proof"]);
    await renewHandoff(packet.id, response(repair), options);
    await client.update(evidence, { body: "Evidence still belongs to the recorded coverage" });
    assert.equal((await inspectHandoffRepair(packet.id, options)).groups.length, 1);
    await client.delete(evidence);
    const deleted = await inspectHandoffRepair(packet.id, options);
    assert.ok(deleted.groups[0].changes.some(row => row.id === evidence && row.to === null));
  }
});

test("recorded dependency model: 500 seeded random sequences cover acknowledgments, graph edits, evidence edits and deletion", { timeout: 900000 }, async t => {
  // Each independent sequence has bounded live state, so long receipt streams cannot hide state-model mistakes.
  for (const item of (await rows()).values()) await client.delete(item.id);
  const seeds = [0xdecafbad, 0x1052026];
  const counts = { acknowledge: 0, renew: 0, addBlocker: 0, removeBlocker: 0, addEvidence: 0, removeEvidence: 0, editEvidence: 0, editFocus: 0, deleteItem: 0 };
  for (const seed of seeds) {
    let randomState = seed;
    const random = () => { randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5; return randomState >>> 0; };
    for (let sequence = 0; sequence < 250; sequence++) {
      const ids: string[] = [];
      for (const label of ["focus", "blocker", "outside-evidence", "unrelated-focus"]) ids.push((await client.create({ type: "Task", title: `${label} ${seed} ${sequence}` })).item.id);
      const [focus, blocker, outside, unrelated] = ids;
      const kind = (["docs", "files", "tests"] as const)[sequence % 3]; const ref = kind === "tests" ? "node --version" : "proof.md";
      await client.update(focus, { dep: [`id=${blocker},kind=blocked_by`] });
      await link(blocker, kind, ref, true); await link(outside, kind, ref, true);
      const contract: HandoffContract = { focus: [focus, unrelated], questions: [], assumptions: [], requiredEvidence: [{ id: "blocker-proof", item: blocker, kind, ref }, { id: "outside-proof", item: outside, kind, ref }] };
      const packet = await createHandoff(contract, options);
      const initialState = await rows(); const roots = [focus, unrelated, outside];
      const model = new Map(roots.map(root => [root, new Map([...reach([root], initialState)].map(id => [id, initialState.get(id)]))]));
      const ack = await acknowledgeHandoff(packet.id, answers(packet), options); counts.acknowledge++;
      for (const snapshot of ack.receipts[0].dependencies!) assertCoverage(snapshot, new Set(model.get(snapshot.id)!.keys()), initialState);
      /** Compare pending groups, per-item changes, missing requirements and all validity counts after every operation. */
      const check = async () => {
        const state = await rows(); const repair = await inspectHandoffRepair(packet.id, options);
        const expectations = new Map(roots.map(root => [root, expected(root, model.get(root)!, state, contract.requiredEvidence)]));
        const invalid = roots.filter(root => expectations.get(root)!.invalid).sort();
        assert.deepEqual(repair.groups.map(row => row.id).sort(), invalid, `seed ${seed} sequence ${sequence}`);
        assert.equal(repair.validAcknowledgments, roots.length - invalid.length); assert.equal(repair.totalGroups, roots.length);
        for (const group of repair.groups) {
          assert.deepEqual(group.changes.map(row => row.id), expectations.get(group.id)!.changes);
          assert.deepEqual(group.missingEvidence, expectations.get(group.id)!.missing);
        }
        return { state, repair, expectations };
      };
      await check();
      for (let step = 0, length = 6 + random() % 6; step < length; step++) {
        const before = await check(); const operation = random() % 9; const target = [blocker, outside][random() % 2];
        switch (operation) {
          case 0: {
            const same = ids.every(id => isDeepStrictEqual(initialState.get(id), before.state.get(id)));
            if (same) await acknowledgeHandoff(packet.id, answers(packet), options);
            else await assert.rejects(acknowledgeHandoff(packet.id, answers(packet), options), refuses("stale"));
            counts.acknowledge++; break;
          }
          case 1: {
            if (before.repair.groups.length) {
              const selected = before.repair.groups[random() % before.repair.groups.length].id;
              const request = response(before.repair, [selected]);
              await renewHandoff(packet.id, request, options);
              const recorded = before.expectations.get(selected)!.ids;
              model.set(selected, new Map([...recorded].map(id => [id, before.state.get(id)])));
              const source = (await rows()).get(packet.id)!;
              const stored = JSON.parse(source.comments!.at(-1)!.text.slice("pm-brief.renew/v1 ".length)) as { groups: HandoffAcknowledgedGroup[] };
              assertCoverage(stored.groups[0], recorded, before.state);
            }
            counts.renew++; break;
          }
          case 2: if (before.state.has(focus)) await client.update(focus, { dep: [`id=${target},kind=blocked_by`], allowUnresolvedDeps: true }); counts.addBlocker++; break;
          case 3: if (before.state.get(focus)?.dependencies?.some(edge => edge.id === target && edge.kind === "blocked_by")) { await client.update(focus, { depRemove: [`id=${target},kind=blocked_by`] }); counts.removeBlocker++; } break;
          case 4: if (before.state.has(target)) await link(target, kind, ref, true); counts.addEvidence++; break;
          case 5: if (before.state.get(target)?.[kind]?.some(link => ("command" in link && link.command === ref) || link.path === ref)) { await link(target, kind, ref, false); counts.removeEvidence++; } break;
          case 6: if (before.state.has(target)) await client.update(target, { body: `  evidence ${sequence} ${step}\r\n  ` }); counts.editEvidence++; break;
          case 7: if (before.state.has(focus)) await client.update(focus, { body: `  focus ${sequence} ${step}\r\n  ` }); counts.editFocus++; break;
          case 8: {
            const victim = ids[random() % ids.length]; if (before.state.has(victim)) await client.delete(victim);
            counts.deleteItem++; break;
          }
        }
        await check();
      }
      const pending = await check();
      if (pending.repair.groups.length) {
        await renewHandoff(packet.id, response(pending.repair), options); counts.renew++;
        for (const group of pending.repair.groups) model.set(group.id, new Map([...pending.expectations.get(group.id)!.ids].map(id => [id, pending.state.get(id)])));
        await check();
      }
      for (const id of [...ids, packet.id]) if ((await rows()).has(id)) await client.delete(id);
    }
  }
  for (const count of Object.values(counts)) assert.ok(count > 0);
  t.diagnostic(JSON.stringify({ seeds: seeds.map(seed => `0x${seed.toString(16)}`), sequences: 500, operations: counts }));
});

test("recorded coverage keeps legacy acknowledgments readable and skips malformed foreign inventories", async () => {
  const source = (await client.create({ type: "Task", title: "Legacy recorded dependency source" })).item.id;
  const focus = (await client.create({ type: "Task", title: "Legacy covered focus", dep: [`id=${source},kind=blocked_by`] })).item.id;
  await client.docs(source, { add: ["path=proof.md"] });
  const packet = await createHandoff({ focus: [focus], questions: [], assumptions: [], requiredEvidence: [{ id: "proof", item: source, kind: "docs", ref: "proof.md" }] }, options);
  const initial = await acknowledgeHandoff(packet.id, answers(packet), options);
  const saved = initial.receipts[0].dependencies![0];
  await client.comments(packet.id, { add: "pm-brief.ack/v1 " + JSON.stringify({ receiver: "legacy", response: answers(packet) }), author: "legacy" });
  assert.equal((await inspectHandoffRepair(packet.id, options, "legacy")).validAcknowledgments, 1);
  const foreign = (dependencies: unknown) => ({ receiver: "foreign", response: answers(packet), dependencies });
  const inventories: unknown[] = [
    null, [], [saved, saved], [{ ...saved, id: "unknown" }],
    [{ ...saved, edges: null }], [{ ...saved, evidenceLinks: null }],
    [{ ...saved, edges: undefined, evidenceLinks: undefined }],
    [{ ...saved, edges: [{ from: "unknown", to: source, kind: "blocked_by", revision: "a".repeat(64) }] }],
    [{ ...saved, edges: [{ from: focus, to: source, kind: "blocked_by", revision: "bad" }] }],
    [{ ...saved, evidenceLinks: [{ item: "unknown", kind: "docs", ref: "proof.md", revision: "a".repeat(64) }] }],
    [{ ...saved, evidenceLinks: [{ item: source, kind: "unknown", ref: "proof.md", revision: "a".repeat(64) }] }],
  ];
  for (const inventory of inventories) await client.comments(packet.id, { add: "pm-brief.ack/v1 " + JSON.stringify(foreign(inventory)), author: "foreign" });
  const inspected = await inspectHandoffRepair(packet.id, options); assert.equal(inspected.skippedReceipts.length, inventories.length);
  const legacyOptions = { ...options, author: "legacy" };
  await client.update(focus, { depRemove: [`id=${source},kind=blocked_by`] });
  await renewHandoff(packet.id, response(await inspectHandoffRepair(packet.id, legacyOptions)), legacyOptions);
  const upgraded = (await rows()).get(packet.id)!;
  const stored = JSON.parse(upgraded.comments!.at(-1)!.text.slice("pm-brief.renew/v1 ".length)) as { groups: HandoffAcknowledgedGroup[] };
  assertCoverage(stored.groups[0], new Set([focus, source]), await rows());
  await client.docs(source, { remove: ["proof.md"] });
  assert.equal((await inspectHandoffRepair(packet.id, legacyOptions)).validAcknowledgments, 0);
});

test("recorded transitive coverage retains non-evidence dependencies and their native edges", async () => {
  const leaf = (await client.create({ type: "Task", title: "Previously covered leaf" })).item.id;
  const middle = (await client.create({ type: "Task", title: "Previously covered middle", dep: [`id=${leaf},kind=blocked_by`] })).item.id;
  const focus = (await client.create({ type: "Task", title: "Transitive focus", dep: [`id=${middle},kind=blocked_by`] })).item.id;
  await client.docs(leaf, { add: ["path=incidental.md"] });
  const packet = await createHandoff({ focus: [focus], questions: [], assumptions: [], requiredEvidence: [] }, options);
  await acknowledgeHandoff(packet.id, answers(packet), options);
  await client.update(focus, { depRemove: [`id=${middle},kind=blocked_by`] });
  await renewHandoff(packet.id, response(await inspectHandoffRepair(packet.id, options)), options);
  await client.update(leaf, { body: "Leaf remains part of the acknowledged dependency set" });
  let repair = await inspectHandoffRepair(packet.id, options);
  assert.deepEqual(repair.groups[0].changes.map(row => row.id), [leaf]);
  await renewHandoff(packet.id, response(repair), options);
  await client.update(middle, { depRemove: [`id=${leaf},kind=blocked_by`] });
  repair = await inspectHandoffRepair(packet.id, options); assert.deepEqual(repair.groups[0].changes.map(row => row.id), [middle]);
  await renewHandoff(packet.id, response(repair), options);
  await client.docs(leaf, { remove: ["incidental.md"] });
  assert.deepEqual((await inspectHandoffRepair(packet.id, options)).groups[0].changes.map(row => row.id), [leaf]);
});
