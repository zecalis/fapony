// src/analyze/rust.ts — Rust import scanning + resolution.
//
// Line-based regex like python.ts: there is no Rust parser here. Edges are
// modules, not items — `mod x;` and the `use` forms that name a path under
// the module tree (`crate::`, `self::`, `super::`) resolve to files; bare
// `use serde::…` goes to external (Cargo.toml deps) or unresolved.
//
// Module path mechanics (edition 2018, no `#[path]`): a file is a module.
// `src/lookup.rs` declares `mod x;` → `src/lookup/x.rs` (or `mod.rs`); a
// `mod.rs` file declares into its own dir. Resolution ladders from the full
// path down — `use crate::a::b::C;` can be an item named C in `a/b.rs` or a
// module `c`, so try `a/b.rs`, `a/b/mod.rs`, `a.rs`, `a/mod.rs` in that order.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
} from "node:path/posix";

export interface RsImport {
  kind: "crate" | "self" | "super" | "extern";
  /**
   * Path segments. `super::super::x` keeps its `super` tokens and climbs
   * one level each; `crate::{a, b}` (brace form) resolves to the crate
   * root — everything named comes from there anyway.
   */
  segs: string[];
  /** `mod x;` — a file-edge to the declared module, anchored at the importer. */
  decl: boolean;
}

// std distribution crates that can be named bare in `use` — external always.
export const RS_STD_CRATES = new Set([
  "std",
  "core",
  "alloc",
  "proc_macro",
  "test",
]);

// Comment mask: `/* */` blocks are neutralized to spaces (padding keeps the
// rest of the line, line structure included) and `//` cuts the line. Strings
// on `use` lines never contain either — attrs like `#[cfg(feature = "x")]`
// are safe to mask because a bare `x` string can't open a comment.
export function maskRsBlocks(content: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of content.split("\n")) {
    if (inBlock) {
      const end = raw.indexOf("*/");
      if (end < 0) {
        out.push("");
        continue;
      }
      inBlock = false;
      out.push(" ".repeat(end + 2) + raw.slice(end + 2));
      continue;
    }
    let line = raw;
    while (line.includes("/*")) {
      const bi = line.indexOf("/*");
      const ci = line.indexOf("//");
      if (ci >= 0 && ci < bi) {
        line = line.slice(0, ci);
        break;
      }
      const ei = line.indexOf("*/", bi + 2);
      if (ei < 0) {
        line = line.slice(0, bi);
        inBlock = true;
        break;
      }
      line = line.slice(0, bi) + " ".repeat(ei + 2 - bi) + line.slice(ei + 2);
    }
    const ci = line.indexOf("//");
    out.push(ci >= 0 ? line.slice(0, ci) : line);
  }
  return out.join("\n");
}

/** Dir the file's own submodules live under: `lookup.rs` → `lookup/`, `mod.rs` → its dir. */
function moduleBase(rel: string): string {
  const dir = posixDirname(rel);
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  // Crate roots (`lib.rs`, `main.rs`) declare their modules in their own
  // dir — only leaf-named modules (`lookup.rs`) get a dir named after them.
  if (name === "mod.rs" || name === "lib.rs" || name === "main.rs") return dir;
  return posixJoin(dir, name.slice(0, name.lastIndexOf(".")));
}

// `use a::b as x;` → segs [a, b] (alias dropped, the module is what matters).
// Brace form cuts at the first `{`: `use a::{b, c}` — the named items may be
// anywhere the `a` module puts them, and the `a` module file is the edge.
export function parseRustUsePath(
  head: string,
): { kind: RsImport["kind"]; segs: string[] } | null {
  let path = head
    .trim()
    .split(/\s+as\s+/)[0]
    .trim();
  const brace = path.indexOf("{");
  if (brace >= 0)
    path = path
      .slice(0, brace)
      .replace(/::\s*$/, "")
      .trim();
  const segs = path
    .split("::")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_]\w*$/.test(s));
  if (segs.length === 0) return null;
  if (segs[0] === "crate") return { kind: "crate", segs: segs.slice(1) };
  if (segs[0] === "self") return { kind: "self", segs: segs.slice(1) };
  return { kind: segs[0] === "super" ? "super" : "extern", segs };
}

export function scanRustImports(content: string): RsImport[] {
  const out: RsImport[] = [];
  const lines = maskRsBlocks(content).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m: RegExpMatchArray | null;
    if (
      (m = line.match(
        /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/,
      ))
    ) {
      out.push({ kind: "self", segs: [m[1]], decl: true });
      continue;
    }
    if ((m = line.match(/^[ \t]*extern\s+crate\s+([A-Za-z_]\w*)\s*;/))) {
      out.push({ kind: "extern", segs: [m[1]], decl: false });
      continue;
    }
    m = line.match(/^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+(.*)/);
    if (!m) continue;
    // `use a::b::{c,` spans lines — join until `;` (cap 20, like python).
    let rest = m[1];
    let j = i;
    while (!rest.includes(";") && j + 1 < lines.length && j - i < 20) {
      j++;
      rest += ` ${lines[j].trim()}`;
    }
    i = j;
    const parsed = parseRustUsePath(rest.split(";")[0]);
    if (parsed) out.push({ ...parsed, decl: false });
  }
  return out;
}

export interface RsCrate {
  /** Rel dir of the package (posix; "" = scan root) — the Cargo.toml anchor. */
  root: string;
  /** Crate tree root (`${root}/src`). */
  src: string;
  /** Dependency crate names (lowercase, `-` → `_`), incl. the crate itself. */
  deps: Set<string>;
  /**
   * Crate-path aliases declared in the crate root (`use fael_core as core`),
   * keyed by alias → target crate name. `crate::core::…` imports read
   * through such an alias must resolve as its target's dependency.
   */
  aliases: Map<string, string>;
}

// Union of [workspace.dependencies] and every [/*-]dependencies table —
// deps inherited from the workspace workspace=true land in the one file
// that owns them without knowing Cargo's inheritance rules. Plus the
// package's own name (integration tests import their crate by name).
function readCargoDeps(absPkg: string): Set<string> {
  const deps = new Set<string>();
  try {
    const toml = Bun.TOML.parse(
      readFileSync(join(absPkg, "Cargo.toml"), "utf-8"),
    ) as Record<string, Record<string, unknown> | undefined>;
    for (const table of Object.keys(toml)) {
      if (!/dependencies$/.test(table)) continue;
      for (const name of Object.keys(toml[table] ?? {}))
        if (/^[A-Za-z0-9_-]+$/.test(name))
          deps.add(name.toLowerCase().replaceAll("-", "_"));
    }
    const self = toml.package?.name;
    if (typeof self === "string")
      deps.add(self.toLowerCase().replaceAll("-", "_"));
  } catch {
    // unreadable manifest: nothing external can be classified here —
    // fail-safe to unresolved, never throw.
  }
  return deps;
}

// Crate-root `use <crate> as <alias>` forms, including inside braces
// (`use fael_core::{self as core, Config}`). Item-level aliases (which also
// shadow a crate name only locally) are out of scope: `use X::y as z;`.
function collectCrateAliases(absPkg: string): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const base of ["lib.rs", "main.rs"]) {
    let masked: string;
    try {
      masked = maskRsBlocks(readFileSync(join(absPkg, "src", base), "utf-8"));
    } catch {
      continue;
    }
    const useRe = /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm;
    let m: RegExpExecArray | null;
    while ((m = useRe.exec(masked))) {
      const body = m[1];
      const rootSeg = body.split("::")[0].trim();
      // Whole-path rename: `use fael_core as core;`
      const bare = body.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/);
      if (bare) {
        if (!["crate", "self", "super"].includes(bare[1])) {
          aliases.set(bare[2], bare[1]);
        }
        continue;
      }
      // Brace form renames the crate itself: `{self as core, …}`.
      if (rootSeg === body) continue; // no path, not a crate rename below
      const brace = body.indexOf("{");
      if (brace < 0) continue;
      for (const part of body.slice(brace).split(",")) {
        const selfAs = part
          .replace(/[{}]/g, "")
          .trim()
          .match(/^self\s+as\s+([A-Za-z_]\w*)$/);
        if (selfAs) aliases.set(selfAs[1], rootSeg);
      }
    }
  }
  return aliases;
}

/**
 * The package a `.rs` file belongs to: the deepest ancestor dir with a
 * Cargo.toml (workspace members each anchor their own crate). Cached per
 * file rel path.
 */
export function rsCrateForFile(
  absDir: string,
  rel: string,
  cache: Map<string, RsCrate | null>,
): RsCrate | null {
  const cached = cache.get(rel);
  if (cached !== undefined) return cached;
  let dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
  for (;;) {
    const abs = dir ? posixJoin(absDir, dir) : absDir;
    if (existsSync(join(abs, "Cargo.toml")) || !dir) {
      const crate: RsCrate | null = existsSync(join(abs, "Cargo.toml"))
        ? {
            root: dir,
            src: posixJoin(dir, "src"),
            deps: readCargoDeps(abs),
            aliases: collectCrateAliases(abs),
          }
        : null;
      cache.set(rel, crate);
      return crate;
    }
    dir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "";
  }
}

// Try the path name for each prefix of `segs`, longest first: `a::b::C` may
// be a module `a::b::c` file or an item named C in module `a::b` — the first
// existing file wins, which also picks re-export surfaces at shorter paths.
function ladder(
  base: string,
  segs: string[],
  filesSet: Set<string>,
): string | null {
  for (let k = segs.length; k >= 1; k--) {
    const rel = posixNormalize(posixJoin(base, ...segs.slice(0, k)));
    for (const c of [`${rel}.rs`, `${rel}/mod.rs`]) {
      if (filesSet.has(c)) return c;
    }
  }
  return null;
}

export function resolveRustImport(
  importerRel: string,
  imp: RsImport,
  crate: RsCrate | null,
  filesSet: Set<string>,
): { hit: string | null; external: boolean } {
  if (imp.kind === "extern") {
    const root = imp.segs[0];
    if (RS_STD_CRATES.has(root)) return { hit: null, external: true };
    // Uniform paths (edition 2018): a bare leading segment is also a
    // crate-root module — `pub use aliases::Aliases;` is a project edge
    // when src/aliases.rs exists, even though the name came out "extern".
    const local = crate ? ladder(crate.src, imp.segs, filesSet) : null;
    if (local) return { hit: local, external: false };
    if (crate?.deps.has(root)) return { hit: null, external: true };
    return { hit: null, external: false };
  }
  let base: string | null = null;
  let segs: string[];
  if (imp.kind === "crate") {
    // A leading segment that is a crate alias (`use fael_core as core;` at
    // the crate root) points at a foreign crate: a dependency edge, not a
    // module file in this crate's tree.
    const aliased = imp.segs[0] ? crate?.aliases.get(imp.segs[0]) : undefined;
    if (aliased)
      return { hit: null, external: crate?.deps.has(aliased) ?? false };
    base = crate?.src ?? null;
    segs = imp.segs;
  } else {
    // self:: / super:: — start at the importer's module dir; each `super`
    // token climbs one level (climbing above the scanned root is a miss).
    let dir = moduleBase(importerRel);
    let i = 0;
    if (imp.kind === "super") {
      while (i < imp.segs.length && imp.segs[i] === "super") {
        dir = posixDirname(dir);
        i++;
        if (dir === "." || dir === "/") return { hit: null, external: false };
      }
    }
    segs = imp.segs.slice(i);
    return { hit: ladder(dir, segs, filesSet), external: false };
  }

  const hit = base ? ladder(base, segs, filesSet) : null;
  // Crate-root brace form: `use crate::{a, b}` — the root's lib.rs.
  if (!hit && imp.kind === "crate" && segs.length === 0) {
    for (const c of [`${crate?.src}/lib.rs`, `${crate?.src}/main.rs`]) {
      if (c && filesSet.has(c)) return { hit: c, external: false };
    }
  }
  return { hit, external: false };
}
