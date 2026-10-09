// src/commands.ts — the single source of truth for top-level command names.
//
// Dispatch stays an if-chain in src/adapters/cli.ts (rule 1: this is a data
// table, not a framework — no registry class, no plugin hooks). This table
// owns name + group + one-line summary; `fapony --help` renders from it and
// test/docs.test.ts fails when a name here is missing from the docs, so the
// four copies (if-chain, usage, CLAUDE.md, README) cannot drift silently.
// Zero imports — cli.ts loads this on every startup (≤ ~100ms budget).

export type CommandGroup =
  | "core"
  | "usage"
  | "lookup"
  | "hooks"
  | "setup"
  | "frozen";

export interface CommandInfo {
  name: string;
  group: CommandGroup;
  summary: string;
}

const GROUP_ORDER: CommandGroup[] = [
  "core",
  "usage",
  "lookup",
  "hooks",
  "setup",
  "frozen",
];

export const COMMANDS: CommandInfo[] = [
  {
    name: "plan",
    group: "core",
    summary:
      "where plans stand: next chunk, adopt a foreign doc, sweep shipped, check",
  },
  {
    name: "lint-baseline",
    group: "core",
    summary: 'separate "already red" from "I made it red"',
  },
  {
    name: "digest",
    group: "core",
    summary: "single-page summary from what's on disk",
  },
  {
    name: "usage-scan",
    group: "usage",
    summary: "scan session logs into the cache",
  },
  { name: "usage-web", group: "usage", summary: "usage dashboard from cache" },
  {
    name: "price-scan",
    group: "usage",
    summary: "refresh the model price table",
  },
  {
    name: "analyze",
    group: "lookup",
    summary: "live repo graph: hubs, orphans, cycles",
  },
  {
    name: "review-seed",
    group: "lookup",
    summary: "read-only scope facts for a review",
  },
  {
    name: "plan-seed",
    group: "lookup",
    summary: "write PLAN (+SPEC) with capped sections",
  },
  {
    name: "hook-mv-guard",
    group: "hooks",
    summary: "deny raw git mv of plan files into done/",
  },
  { name: "init", group: "setup", summary: "scaffold .fapony/ in a worktree" },
  {
    name: "install",
    group: "setup",
    summary: "wire skills + plan-mv guard into clients",
  },
  { name: "setup", group: "setup", summary: "interactive wizard" },
  {
    name: "update",
    group: "setup",
    summary:
      "update by install channel (bun/npm global or git), re-link skills [--dry-run|--yes]",
  },
  { name: "upgrade", group: "setup", summary: "alias of update" },
  { name: "telemetry", group: "setup", summary: "opt-in telemetry show/send" },
  {
    name: "stats",
    group: "frozen",
    summary: "frozen-ledger KPIs (reads history only)",
  },
  { name: "report", group: "frozen", summary: "verification report for a run" },
  { name: "report-web", group: "frozen", summary: "static HTML report page" },
];

// Grouped names only — the shape PLAN-seed-and-surface §7 picked. Starts with
// a `usage: fapony` line: scripts/smoke-publish.sh greps for it on a no-arg run.
export const renderUsage = (): string => {
  const lines = [
    "fapony — plan workflow + token-saving lookups for agent-written code",
    "usage: fapony <command> [args]",
    "",
  ];
  for (const g of GROUP_ORDER) {
    const names = COMMANDS.filter((c) => c.group === g).map((c) => c.name);
    lines.push(`  ${g.padEnd(8)}${names.join("  ")}`);
  }
  lines.push(
    "",
    "  memory (decisions, bugs, notes) lives in fael — fael --help",
  );
  return lines.join("\n");
};

// Classic two-row Levenshtein — the did-you-mean behind unknown-command errors.
export const levenshtein = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
};

// Up to 3 suggestions within distance ≤ 2 against top-level names. Sorted
// by distance, then alphabetically — deterministic for tests.
export const suggestCommand = (cmd: string): string[] => {
  const scored: Array<{ text: string; d: number }> = [];
  for (const c of COMMANDS) {
    const d = levenshtein(cmd, c.name);
    if (d <= 2) scored.push({ text: `fapony ${c.name}`, d });
  }
  scored.sort((x, y) => x.d - y.d || (x.text < y.text ? -1 : 1));
  return scored.slice(0, 3).map((s) => s.text);
};
