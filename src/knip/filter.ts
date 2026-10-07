// src/knip/filter.ts — intersect knip issues with the seed scope.

import type { KnipEntry, KnipRow } from "./types.js";

function fmtSyms(
  list: { name: string; line: number }[],
  names: string[],
): void {
  const seen = new Set<string>();
  for (const s of list) {
    const label = s.line > 0 ? `${s.name}:${s.line}` : s.name;
    if (!seen.has(label)) {
      seen.add(label);
      names.push(label);
    }
  }
}

/** Keep only entries whose file is in scope; drop empty rows. Deps ride on
 *  the manifest (package.json in scope) — a dep row with no manifest in
 *  scope would blame the wrong file, so it is dropped. */
export function filterKnipByScope(
  issues: KnipEntry[],
  scopePaths: string[],
): KnipRow[] {
  const scope = new Set(scopePaths);
  const rows: KnipRow[] = [];
  for (const e of issues) {
    if (!scope.has(e.file)) continue;
    const row: KnipRow = {
      file: e.file,
      unusedFile: e.files.length > 0,
      exports: [],
      types: [],
      deps: [],
    };
    fmtSyms(e.exports, row.exports);
    fmtSyms(e.enumMembers, row.exports);
    fmtSyms(e.namespaceMembers, row.exports);
    fmtSyms(e.types, row.types);
    for (const d of [...e.dependencies, ...e.devDependencies]) {
      if (!row.deps.includes(d.name)) row.deps.push(d.name);
    }
    if (e.file.endsWith("package.json") === false && row.deps.length > 0) {
      // Deps reported on a manifest entry whose file is not package.json
      // (knip version drift) — keep them only when the manifest is in scope.
      if (!scope.has("package.json")) row.deps = [];
    }
    if (
      row.unusedFile ||
      row.exports.length > 0 ||
      row.types.length > 0 ||
      row.deps.length > 0
    ) {
      rows.push(row);
    }
  }
  rows.sort((a, b) => (a.file < b.file ? -1 : 1));
  return rows;
}
