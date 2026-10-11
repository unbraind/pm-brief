import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { assertToolchainPins } from "./version-contract.ts";

/** Mutable package fields for disposable metadata corruption fixtures. */
interface Metadata {
  version?: string;
  devDependencies?: Record<string, string>;
  packages?: Record<string, Metadata>;
}

const root = resolve(import.meta.dirname, "..");
const names = ["@unbrained/pm-cli", "pm-changelog", "pm-ops"];

/** Write metadata to a disposable checkout, creating scoped package directories. */
function writeMetadata(root: string, path: string, metadata: Metadata): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify(metadata));
}

/** Load real package metadata as the starting point for a negative control. */
function readMetadata(path: string): Metadata {
  return JSON.parse(readFileSync(path, "utf8")) as Metadata;
}

/** Run a fixture derived from real manifests and installed metadata, then clean it. */
function fixture(run: (directory: string, manifest: Metadata, lock: Metadata) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "brief-toolchain-"));
  try {
    const manifest = readMetadata(join(root, "package.json"));
    const lock = readMetadata(join(root, "package-lock.json"));
    writeMetadata(directory, "package.json", manifest);
    writeMetadata(directory, "package-lock.json", lock);
    for (const name of names) {
      // These are metadata copies, never SDK implementations or mock exports.
      writeMetadata(directory, `node_modules/${name}/package.json`, readMetadata(join(root, "node_modules", name, "package.json")));
    }
    run(directory, manifest, lock);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a coherent later toolchain update requires no approved version edit", () => {
  fixture((directory, manifest, lock) => {
    assertToolchainPins(directory);
    for (const name of names) {
      manifest.devDependencies![name] = "9999.1.1";
      lock.packages![""]!.devDependencies![name] = "9999.1.1";
      lock.packages![`node_modules/${name}`]!.version = "9999.1.1";
      const installed = readMetadata(join(root, "node_modules", name, "package.json"));
      installed.version = "9999.1.1";
      writeMetadata(directory, `node_modules/${name}/package.json`, installed);
    }
    writeMetadata(directory, "package.json", manifest);
    writeMetadata(directory, "package-lock.json", lock);
    assertToolchainPins(directory);
  });
});

for (const name of names) {
  test(`${name}: even mutually consistent ranges are rejected`, () => {
    fixture((directory, manifest, lock) => {
      const range = `^${manifest.devDependencies![name]}`;
      manifest.devDependencies![name] = range;
      lock.packages![""]!.devDependencies![name] = range;
      lock.packages![`node_modules/${name}`]!.version = range;
      writeMetadata(directory, "package.json", manifest);
      writeMetadata(directory, "package-lock.json", lock);
      writeMetadata(directory, `node_modules/${name}/package.json`, { version: range });
      assert.throws(() => assertToolchainPins(directory), /exact development pin/);
    });
  });

  for (const entry of ["root", "resolution", "missing-resolution"] as const) {
    test(`${name}: rejects ${entry} lockfile inconsistency`, () => {
      fixture((directory, _manifest, lock) => {
        if (entry === "root") lock.packages![""]!.devDependencies![name] = "9999.1.1";
        else if (entry === "resolution") lock.packages![`node_modules/${name}`]!.version = "9999.1.1";
        else delete lock.packages![`node_modules/${name}`];
        writeMetadata(directory, "package-lock.json", lock);
        assert.throws(() => assertToolchainPins(directory), /lockfile (root pin|resolution) must match/);
      });
    });
  }

  test(`${name}: rejects installed metadata inconsistent with coherent manifest and lock`, () => {
    fixture((directory) => {
      writeMetadata(directory, `node_modules/${name}/package.json`, { version: "9999.1.1" });
      assert.throws(() => assertToolchainPins(directory), /installed metadata must match/);
    });
  });
}
