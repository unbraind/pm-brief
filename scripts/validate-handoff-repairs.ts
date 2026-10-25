/** Measure repair deltas using a read-only public tracker snapshot and disposable derived native state. */
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { certifyCompleteListResult, PmClient } from "@unbrained/pm-cli/sdk";
import { acknowledgeHandoff, createHandoff, inspectHandoffRepair, previewHandoff, renewHandoff } from "../handoff.ts";

/** Preserve source state, seed only disposable derived state, then measure read-only repair selection. */
async function main(args: string[]): Promise<void> {
  if (args.length !== 1) throw new Error("Supply one disposable public tracker snapshot root");
  const source = new PmClient({ pmRoot: args[0], noExtensions: true });
  const before = certifyCompleteListResult(await source.listAllComplete({ includeBody: true })).items;
  const focus = before.filter(row => row.status === "open").slice(0, 3).map(row => row.id);
  assert.ok(focus.length > 0);
  const contract = { focus, questions: [{ id: "scope", text: "Confirm changed public obligations" }], assumptions: [], requiredEvidence: [] };
  const full = await previewHandoff(contract, { pmRoot: args[0], author: "validation", client: source, tokenBudget: 64000 });
  const scratch = await mkdtemp(join(tmpdir(), "brief-public-repair-"));
  try {
    const pmRoot = join(scratch, "tracker"); await cp(args[0]!, pmRoot, { recursive: true });
    const client = new PmClient({ pmRoot, author: "validation", noExtensions: true });
    const options = { pmRoot, client, author: "validation", tokenBudget: 64000 };
    const packet = await createHandoff(contract, options);
    await acknowledgeHandoff(packet.id, { digest: packet.digest, questions: { scope: "Public tracker scope understood" }, assumptions: {}, evidence: {} }, options);
    await client.update(focus[0]!, { body: "Public validation: source revision changed in disposable derived state." });
    const state = certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items;
    const start = performance.now(); const repair = await inspectHandoffRepair(packet.id, options);
    const elapsedMs = Math.round(performance.now() - start);
    assert.equal(repair.groups.length, 1);
    assert.deepEqual(certifyCompleteListResult(await client.listAllComplete({ includeBody: true })).items, state);
    const renewed = await renewHandoff(packet.id, { digest: repair.digest, groups: repair.groups.map(group => ({ id: group.id, target: group.target, questions: { scope: "Changed scope understood" }, assumptions: {}, evidence: {} })) }, options);
    assert.equal(renewed.groups.length, 0);
    assert.deepEqual(certifyCompleteListResult(await source.listAllComplete({ includeBody: true })).items, before);
    console.log(JSON.stringify({ source: "public pm-brief tracker snapshot", sourceItems: before.length, sourceWrites: 0, focusGroups: focus.length, packetRevisionRows: full.contract.items.length, affectedGroups: repair.groups.length, preservedAcknowledgments: repair.validAcknowledgments, renewedAcknowledgments: renewed.validAcknowledgments, repairJsonBytes: Buffer.byteLength(JSON.stringify(repair)), packetJsonBytes: Buffer.byteLength(JSON.stringify(full)), repairTokenCeiling: repair.estimatedTokenCeiling, elapsedMs, measurementWrites: 0, setup: "Separate disposable derived tracker: native contract creation, initial acknowledgment, one source edit; measurement itself is read-only" }, null, 2));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
await main(process.argv.slice(2));
