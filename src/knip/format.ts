// src/knip/format.ts — capped knip section lines for the seed.

import { type KnipRow, MAX_KNIP_FILES, MAX_KNIP_NAMES } from "./types.js";

function joinNames(names: string[]): string {
  const shown = names.slice(0, MAX_KNIP_NAMES).join(", ");
  return names.length > MAX_KNIP_NAMES
    ? `${shown} (+${names.length - MAX_KNIP_NAMES} more)`
    : shown;
}

export function formatKnipRows(rows: KnipRow[]): string[] {
  if (rows.length === 0) {
    return ["knip: no unused exports/files in this scope"];
  }
  const lines = ["knip (unused, scope-filtered):"];
  const shown = rows.slice(0, MAX_KNIP_FILES);
  for (const r of shown) {
    const parts: string[] = [];
    if (r.unusedFile) parts.push("unused file");
    if (r.exports.length > 0)
      parts.push(`unused exports: ${joinNames(r.exports)}`);
    if (r.types.length > 0) parts.push(`unused types: ${joinNames(r.types)}`);
    if (r.deps.length > 0) parts.push(`unused deps: ${joinNames(r.deps)}`);
    lines.push(`  ${r.file} — ${parts.join("; ")}`);
  }
  if (rows.length > shown.length) {
    lines.push(`  … +${rows.length - shown.length} more file(s)`);
  }
  return lines;
}
