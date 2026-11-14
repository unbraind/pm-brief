# pm-cli 2026.11.14 option migration

GH-1665 (CHANGELOG 2026.11.8) normalizes declared string flags for direct
callers as it does for the CLI. Numeric `tokenBudget: 4000` therefore succeeds;
`tokenBudget: 1` reaches the output-budget refusal. Invalid integer spelling,
malformed request JSON, request schema violations and oversized requests still
refuse before writes. Raw string-type checks that the CLI cannot reach were
removed from the action and follow-through command adapters. The public request
parsers retain their strict data schemas.

## Upstream candidate: file receipts validated as row payloads

The following minimal extension reproduces an undocumented difference with
`@unbrained/pm-cli` **2026.11.14**. No upstream issue was filed.

```ts
import { defineExtension } from "@unbrained/pm-cli/sdk/authoring";
import { createExtensionTestHarness } from "@unbrained/pm-cli/sdk/testing";

const extension = defineExtension({
  name: "receipt-repro",
  activate(api) {
    api.registerCommand({
      name: "receipt-repro",
      read_output: { row_keys: ["rows"] },
      flags: [{ long: "--output", type: "string" }],
      run() { return { ok: true, output: "receipt.md" }; },
    });
    api.registerService("output_format", () =>
      JSON.stringify({ ok: true, output: "receipt.md" }));
  },
});
const harness = await createExtensionTestHarness(extension, {
  name: "receipt-repro", capabilities: ["commands", "schema", "services"],
});
try {
  await harness.runCommand({
    command: "receipt-repro", options: { output: "receipt.md" },
    global: { json: true },
  });
} finally { await harness.deactivate(); }
```

Observed harness result: `{ ok: true, output: "receipt.md" }`. Installing the
same extension into a synthetic non-git tracker and running
`pm --json receipt-repro --output receipt.md` instead exits 2 with
`extension_read_output_invalid`: “Read-only extension result is missing declared
row collection rows.” Expected: the same bounded file receipt from the owned
output formatter, with no row payload on stdout. The 2026.11.8 through
2026.11.14 changelog does not announce this file-receipt change; GH-1678 describes
budget enforcement for custom renderers.

The package now retains its structured rows internally until host validation,
then emits only the separate file summary. This preserves the original file
receipt under both host behaviors. Tests require a nonempty output file, no
internal markers and no row collections in the emitted receipt. Reverting this
adapter change reproduces the native document-file failure.

Compatibility acceptance also passed with the published CLI 2026.11.7 in an
independent synthetic tracker: native JSON and TOON both wrote nonempty files
and emitted compact receipts without row collections or internal markers.
The older host's TOON receipt was 106 bytes. CLI 2026.11.14 acceptance is covered
by the linked native document-file test.
