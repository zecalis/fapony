import { test } from "bun:test";
// test/knip.test.ts — scope-filtered knip section for `review-seed --knip`.

import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterKnipByScope } from "../src/knip/filter.js";
import { formatKnipRows } from "../src/knip/format.js";
import type { KnipEntry } from "../src/knip/types.js";
import { SeedError } from "../src/seed/primitives.js";
import { renderSeed } from "../src/seed/review-seed.js";

const ISSUES: KnipEntry[] = [
  {
    file: "src/a.ts",
    files: [],
    exports: [{ name: "old", line: 3 }],
    types: [{ name: "OldT", line: 7 }],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [],
    devDependencies: [],
  },
  {
    file: "src/dead.ts",
    files: [{ name: "src/dead.ts" }],
    exports: [],
    types: [],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [],
    devDependencies: [],
  },
  {
    file: "src/other.ts",
    files: [],
    exports: [{ name: "x", line: 1 }],
    types: [],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [],
    devDependencies: [],
  },
];

test("knip filter keeps scope files only, drops empty rows", () => {
  const rows = filterKnipByScope(ISSUES, ["src/a.ts", "src/clean.ts"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, "src/a.ts");
  assert.deepEqual(rows[0].exports, ["old:3"]);
  assert.deepEqual(rows[0].types, ["OldT:7"]);
});

test("knip format caps names and files", () => {
  const rows = filterKnipByScope(ISSUES, ["src/a.ts", "src/dead.ts"]);
  const lines = formatKnipRows(rows);
  assert.match(lines[0], /knip \(unused, scope-filtered\)/);
  assert.match(lines.join("\n"), /src\/a\.ts — unused exports: old:3/);
  assert.match(lines.join("\n"), /src\/dead\.ts — unused file/);
  assert.equal(
    formatKnipRows([])[0],
    "knip: no unused exports/files in this scope",
  );
});

test("knip many names cap at 5 with overflow count", () => {
  const big: KnipEntry = {
    file: "src/big.ts",
    files: [],
    exports: [1, 2, 3, 4, 5, 6, 7].map((n) => ({ name: `e${n}`, line: n })),
    types: [],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [],
    devDependencies: [],
  };
  const lines = formatKnipRows(filterKnipByScope([big], ["src/big.ts"]));
  assert.match(lines.join("\n"), /\(\+2 more\)/);
});

test("review-seed --knip with --body errors instead of mixing outputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-knip-flag-"));
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", {
      cwd: dir,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
    assert.throws(
      () => renderSeed(["--files", "a.ts", "--body", "a", "--knip"], dir),
      (e: unknown) => e instanceof SeedError && /--knip/.test(e.message),
    );
    // --knip alone is accepted as a modifier (knip may skip here — the
    // assertion is only that the flag parses and the seed stays read-only).
    const out = renderSeed(["--files", "a.ts", "--knip"], dir);
    assert.match(out, /knip:|knip \(unused/);
    assert.match(out, /static graph only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("review-seed --knip parses knip's exit-1-with-stdout (findings, not failure)", () => {
  // knip exits 1 when it finds unused exports — stdout IS the result.
  // A seed that treats that as a skip hides the exact rows the flag exists for.
  const dir = mkdtempSync(join(tmpdir(), "fapony-knip-exit-"));
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", {
      cwd: dir,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "package.json"), '{"name":"t","type":"module"}\n');
    writeFileSync(
      join(dir, "dead.ts"),
      "export const stale = 1;\nexport const fresh = 2;\n",
    );
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
    const out = renderSeed(["--files", "dead.ts", "--knip"], dir);
    assert.doesNotMatch(out, /knip exit 1/);
    assert.match(out, /knip \(unused|knip: no unused/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("knip file cap at 10 with overflow count", () => {
  const many: KnipEntry[] = Array.from({ length: 12 }, (_, i) => ({
    file: `src/f${String(i).padStart(2, "0")}.ts`,
    files: [{ name: `src/f${String(i).padStart(2, "0")}.ts` }],
    exports: [],
    types: [],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [],
    devDependencies: [],
  }));
  const scope = many.map((e) => e.file);
  const lines = formatKnipRows(filterKnipByScope(many, scope));
  assert.equal(lines.length, 12); // header + 10 rows + overflow
  assert.match(lines.join("\n"), /\+2 more file\(s\)/);
});

test("knip deps show only when package.json is in scope", () => {
  const drifted: KnipEntry = {
    file: "src/a.ts",
    files: [],
    exports: [{ name: "a", line: 1 }],
    types: [],
    enumMembers: [],
    namespaceMembers: [],
    dependencies: [{ name: "left-pad" }],
    devDependencies: [],
  };
  const dropped = filterKnipByScope([drifted], ["src/a.ts"]);
  assert.equal(dropped.length, 1);
  assert.deepEqual(dropped[0].deps, []);
  const kept = filterKnipByScope([drifted], ["src/a.ts", "package.json"]);
  assert.deepEqual(kept[0].deps, ["left-pad"]);
  assert.match(formatKnipRows(kept).join("\n"), /unused deps: left-pad/);
});

test("knip enum/namespace members fold into unused exports", () => {
  const entry: KnipEntry = {
    file: "src/e.ts",
    files: [],
    exports: [],
    types: [],
    enumMembers: [{ name: "Color", line: 4 }],
    namespaceMembers: [{ name: "NS", line: 9 }],
    dependencies: [],
    devDependencies: [],
  };
  const rows = filterKnipByScope([entry], ["src/e.ts"]);
  assert.deepEqual(rows[0].exports, ["Color:4", "NS:9"]);
});

test("review-seed --knip with --callers errors like --body does", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-knip-callers-"));
  try {
    execSync("git init", { cwd: dir, stdio: "ignore" });
    execSync("git config user.email 'test@test.com'", {
      cwd: dir,
      stdio: "ignore",
    });
    execSync("git config user.name 'Test'", { cwd: dir, stdio: "ignore" });
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    execSync("git add .", { cwd: dir, stdio: "ignore" });
    execSync('git commit -m "init"', { cwd: dir, stdio: "ignore" });
    assert.throws(
      () => renderSeed(["--files", "a.ts", "--callers", "a", "--knip"], dir),
      (e: unknown) => e instanceof SeedError && /--knip/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
