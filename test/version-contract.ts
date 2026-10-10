/** Bind compatibility declarations to the public metadata of the installed SDK. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/** Oldest pm CLI/SDK release whose runtime can load and execute pm-brief's
 * canonical complete-corpus reader contract. */
export const REQUIRED_MINIMUM_VERSION = "2026.8.20";

/** Public package metadata resolved from the SDK that actually runs the tests. */
const installed = JSON.parse(readFileSync(
  createRequire(import.meta.url).resolve("@unbrained/pm-cli/package.json"), "utf8",
)) as { readonly version?: unknown };
if (typeof installed.version !== "string" || !/^\d+\.\d+\.\d+$/.test(installed.version)) {
  throw new Error("The installed pm CLI/SDK must expose an exact release version");
}

/** Exact installed SDK release; future automated upgrades retain the same check. */
export const REQUIRED_DEVELOPMENT_VERSION = installed.version;
