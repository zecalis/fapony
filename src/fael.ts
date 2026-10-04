// src/fael.ts — read the repo's memory from fael (`fael find --json --all`).
//
// Memory moved to fael 2026-09-25; .fapony/.memory is frozen (imported into
// .fael/). fapony only reads, never writes, and speaks MemRow internally, so
// the fael row shape is translated here and nowhere else:
//   by → agent · kind "issue" → "bug" · a close — inline `closed` (compacted
//   rows) or a kindless row with `ref` (close file) — → a kind:"close" row
//   with ref = the closed row's id (the old tombstone shape).
// Close-file rows reach here from fael 0.0.5 on; 0.0.4 printed only inline
// `closed`, so a native `fael close` read as open.

/** fapony's internal row shape — what every reader downstream consumes. */
export interface MemRow {
  ts: string;
  agent: string;
  kind: string;
  text: string;
  spec?: string;
  id?: string;
  /** On a kind:"close" row: the id of the row it closes. */
  ref?: string;
  files?: string[];
  key?: string;
}

interface FaelRow {
  id: string;
  ts: string;
  by: string;
  kind: string;
  text: string;
  files?: string[];
  spec?: string;
  key?: string;
  ref?: string;
  closed?: { id: string; ts: string; by: string; text: string };
}

export interface FaelRead {
  rows: MemRow[];
  /** false = fael missing or failed — "no memory", not "no match". */
  ok: boolean;
  skipped: number;
}

/** fael `--json` lines → MemRows (+ close rows), newest first, ts ≥ sinceIso. */
export function faelLinesToMemRows(
  stdout: string,
  sinceIso?: string,
): { rows: MemRow[]; skipped: number } {
  const rows: MemRow[] = [];
  let skipped = 0;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let r: FaelRow;
    try {
      r = JSON.parse(line) as FaelRow;
    } catch {
      skipped++;
      continue;
    }
    // Close row (docs/format.md: no kind, `ref` names the closed row).
    if (!r.kind && r.ref) {
      rows.push({
        ts: r.ts,
        agent: r.by,
        kind: "close",
        text: r.text,
        id: r.id,
        ref: r.ref,
      });
      continue;
    }
    rows.push({
      ts: r.ts,
      agent: r.by,
      kind: r.kind === "issue" ? "bug" : r.kind,
      text: r.text,
      id: r.id,
      ...(r.files ? { files: r.files } : {}),
      ...(r.spec ? { spec: r.spec } : {}),
      ...(r.key ? { key: r.key } : {}),
    });
    if (r.closed) {
      rows.push({
        ts: r.closed.ts,
        agent: r.closed.by,
        kind: "close",
        text: r.closed.text,
        id: r.closed.id,
        ref: r.id,
      });
    }
  }
  const kept = sinceIso ? rows.filter((r) => r.ts >= sinceIso) : rows;
  kept.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  return { rows: kept, skipped };
}

/** Every row fael sees from `worktree` — or, with `openOnly`, only the rows
 *  fael itself counts as open (not closed, not superseded). Never throws. */
export function readFaelLog(
  worktree: string,
  sinceIso?: string,
  openOnly = false,
): FaelRead {
  const argv = ["fael", "find", "--json", ...(openOnly ? [] : ["--all"])];
  try {
    const p = Bun.spawnSync(argv, {
      cwd: worktree,
      env: process.env, // resolve `fael` on the live PATH, not the startup one
      stdout: "pipe",
      stderr: "pipe",
    });
    if (p.exitCode !== 0) return { rows: [], ok: false, skipped: 0 };
    return { ...faelLinesToMemRows(p.stdout.toString(), sinceIso), ok: true };
  } catch {
    // fael not on PATH
    return { rows: [], ok: false, skipped: 0 };
  }
}
