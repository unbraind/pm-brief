/** Bind compatibility declarations to the public metadata of the installed SDK. */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { join } from "node:path";

/** Manifest fields used to validate independently resolved toolchain metadata. */
interface ToolchainMetadata {
  readonly version?: string;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly packages?: Readonly<Record<string, ToolchainMetadata>>;
}

/** Read package metadata without executing package code or mocking the SDK. */
function readMetadata(path: string): ToolchainMetadata {
  return JSON.parse(readFileSync(path, "utf8")) as ToolchainMetadata;
}

/** Reject ranges, stale lock entries, and installed toolchain skew for a checkout.
 * Each dependency's exact manifest pin must agree with both lockfile entries
 * and independently resolved installed metadata; no approved release is copied
 * into this contract. Compatibility floors are checked separately.
 */
export function assertToolchainPins(root: string): void {
  const manifest = readMetadata(join(root, "package.json"));
  const lock = readMetadata(join(root, "package-lock.json"));
  for (const name of ["@unbrained/pm-cli", "pm-changelog", "pm-ops"]) {
    const pin = manifest.devDependencies?.[name];
    assert.ok(pin, `${name} must be a development dependency`);
    assert.match(pin, /^\d+\.\d+\.\d+$/, `${name} must have an exact development pin`);
    assert.equal(lock.packages?.[""]?.devDependencies?.[name], pin, `${name} lockfile root pin must match package.json`);
    assert.equal(lock.packages?.[`node_modules/${name}`]?.version, pin, `${name} lockfile resolution must match package.json`);
    assert.equal(readMetadata(join(root, "node_modules", name, "package.json")).version, pin, `${name} installed metadata must match package.json`);
  }
}

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
