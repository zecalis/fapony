// src/analyze/graph.ts — `buildGraph()`: file-level import graph, computed
// live with Bun.Transpiler.scan() — no new table. Read-only: never writes
// into the analyzed directory.
//
// Same module also serves handoff_check / verification_report: blastRadius()
// (see blast.ts) turns facts.files[] into per-file { dependents, tested } facts.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { isBarrelSource } from "./criteria.js";
import { collectSourceFiles } from "./discover.js";
import {
  buildPyModuleIndex,
  PY_STDLIB,
  pyRootSegment,
  resolvePythonImport,
  scanPythonImports,
} from "./python.js";
import { IMPORT_TYPE_RE, REQUIRE_RE, resolveRelative } from "./resolve-ts.js";
import type { RsCrate } from "./rust.js";
import { resolveRustImport, rsCrateForFile, scanRustImports } from "./rust.js";
import type { ImportGraph } from "./types.js";

// Root pyproject.toml only: declared deps (normalized to import-name guesses)
// and `[project.scripts]` targets. A dist whose import name differs
// (scikit-learn → sklearn) stays unresolved — fail-safe toward "don't know".
function readPyproject(absDir: string): {
  deps: Set<string>;
  scripts: string[];
} {
  const deps = new Set<string>();
  const scripts: string[] = [];
  const path = join(absDir, "pyproject.toml");
  if (!existsSync(path)) return { deps, scripts };
  let project: {
    dependencies?: unknown;
    "optional-dependencies"?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
  try {
    project =
      (
        Bun.TOML.parse(readFileSync(path, "utf-8")) as {
          project?: typeof project;
        }
      ).project ?? {};
  } catch {
    return { deps, scripts };
  }
  const specs = [
    project.dependencies,
    ...Object.values(project["optional-dependencies"] ?? {}),
  ].flatMap((v) => (Array.isArray(v) ? v : []));
  for (const spec of specs) {
    const name =
      typeof spec === "string" && spec.match(/^\s*([A-Za-z0-9._-]+)/)?.[1];
    if (name) deps.add(name.toLowerCase().replace(/[-.]/g, "_"));
  }
  for (const target of Object.values(project.scripts ?? {})) {
    if (typeof target === "string") scripts.push(target.split(":")[0].trim());
  }
  return { deps, scripts };
}

const PY_MAIN_RE = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m;

export function buildGraph(dir: string): ImportGraph {
  const absDir = resolve(dir);
  const files = collectSourceFiles(absDir);
  const filesSet = new Set(files);
  const deps = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const f of files) dependents.set(f, new Set());
  const barrels = new Set<string>();
  let unresolved = 0;
  let external = 0;
  // Built lazily — a TS-only repo never pays for it.
  let pyIndex: Map<string, string> | null = null;
  let pyproject: ReturnType<typeof readPyproject> | null = null;
  const rsCrates = new Map<string, RsCrate | null>();
  const entries = new Set<string>();

  const transpiler = new Bun.Transpiler({ loader: "ts" });

  for (const rel of files) {
    let content: string;
    try {
      content = readFileSync(join(absDir, rel), "utf-8");
    } catch {
      unresolved++;
      continue;
    }
    if (isBarrelSource(content, rel)) barrels.add(rel);
    if (rel.endsWith(".py") || rel.endsWith(".pyi")) {
      // No Transpiler here — it can't parse Python. Relative imports resolve
      // against the importer's package; same-repo absolute imports resolve
      // against the module index. An absolute miss whose root is in PY_STDLIB
      // is external; a third-party package or a real miss stays unresolved.
      pyIndex ??= buildPyModuleIndex(filesSet);
      pyproject ??= readPyproject(absDir);
      if (PY_MAIN_RE.test(content)) entries.add(rel);
      const pyEdges = new Set<string>();
      for (const imp of scanPythonImports(content)) {
        const hits = resolvePythonImport(rel, imp, filesSet, pyIndex);
        if (hits.size > 0) for (const h of hits) pyEdges.add(h);
        else if (
          !imp.dots &&
          imp.mod &&
          (PY_STDLIB.has(pyRootSegment(imp.mod)) ||
            pyproject.deps.has(pyRootSegment(imp.mod).toLowerCase()))
        )
          external++;
        else unresolved++;
      }
      deps.set(rel, pyEdges);
      continue;
    }
    if (rel.endsWith(".rs")) {
      // No Transpiler either — same one-crates-per-package anchoring as
      // Python: crate root = the deepest Cargo.toml above the file, its
      // `src/` is the module tree that `crate::` paths start from.
      const crate = rsCrateForFile(absDir, rel, rsCrates);
      const rsEdges = new Set<string>();
      for (const imp of scanRustImports(content)) {
        const r = resolveRustImport(rel, imp, crate, filesSet);
        if (r.hit) rsEdges.add(r.hit);
        else if (r.external) external++;
        else unresolved++;
      }
      deps.set(rel, rsEdges);
      // Anything cargo runs on its own is an entry: crate roots, extra
      // bins (src/bin/), integration tests, examples, benches — the same
      // rule `[project.scripts]` gets for Python.
      if (
        /^(?:main|lib)\.rs$/.test(rel.slice(rel.lastIndexOf("/") + 1)) ||
        /(?:^|\/)(?:tests|examples|benches)\/[^/]+\.rs$/.test(rel) ||
        /(?:^|\/)src\/bin\//.test(rel)
      )
        entries.add(rel);
      continue;
    }
    const raws: string[] = [];
    try {
      const scanned = transpiler.scan(content) as {
        imports: { path: string }[];
      };
      for (const imp of scanned.imports) raws.push(imp.path);
    } catch {
      // Syntax-broken file: skip it, count once — never fail the whole run.
      unresolved++;
      continue;
    }
    // Transpiler.scan blind spots: require() and `import type` are real edges
    // (changing a type still shakes dependents), so pick them up by regex.
    // No overlap with scan output above — scan reports neither form.
    REQUIRE_RE.lastIndex = 0;
    IMPORT_TYPE_RE.lastIndex = 0;
    for (const m of content.matchAll(REQUIRE_RE)) raws.push(m[1]);
    for (const m of content.matchAll(IMPORT_TYPE_RE)) raws.push(m[1]);

    const edges = new Set<string>();
    for (const raw of raws) {
      if (raw.startsWith(".")) {
        const hit = resolveRelative(rel, raw, filesSet);
        if (hit) edges.add(hit);
        else unresolved++;
      } else if (raw.startsWith("node:") || raw.startsWith("bun:")) {
        // A builtin is never an edge between two project files, so it can
        // never be the reason a dependent count came out low. Lumping it in
        // made the warning fire on every repo — 311 of this one's 312 were
        // builtins — and a warning that always fires is not read.
        external++;
      } else {
        // Package name or path alias — out of scope in v1, and unlike a
        // builtin this one CAN be a project edge (`@app/core` in a monorepo).
        unresolved++;
      }
    }
    deps.set(rel, edges);
  }

  for (const [file, edgeSet] of deps) {
    for (const dep of edgeSet) {
      dependents.get(dep)?.add(file);
    }
  }

  if (pyIndex && pyproject) {
    for (const mod of pyproject.scripts) {
      const hit = pyIndex.get(mod);
      if (hit) entries.add(hit);
    }
  }

  return { files, deps, dependents, unresolved, external, barrels, entries };
}
