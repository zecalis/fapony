// src/digest/collect.ts — merge data from 4 sources into a single DigestData
//
// Renders nothing — just reads + shapes into structs

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_FILENAME,
  doneDir,
  type Event,
  loadConfig,
  planDir,
  type Run,
} from "../core/config.js";
import { type HintImpact, hintLogPath } from "../core/hint-log.js";
import { parseSince } from "../core/since.js";
import { openDb } from "../db/store.js";
import { type MemRow, readFaelLog } from "../fael.js";
import { computeHintImpact } from "../hook.js";
import { isPassFamily, VERDICT_GRADES } from "../parse.js";
import { imputeResult, loadPrices } from "../price/index.js";
import { EMPTY_RESULT, type PassiveUsageResult } from "../session/types.js";
import { type CacheEntry, readCache } from "../usage/cache.js";

// --- types ---

export type { MemRow };

export interface SourceStatus {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PlanRow {
  file: string;
  status?: string;
  done: number;
  total: number;
}

export interface Tally {
  key: string;
  count: number;
}

export interface CostRow {
  model: string;
  provider: string;
  sessions: number;
  input: number;
  output: number;
  cost: number;
  imputed: number;
}

export interface RegimeModelRow {
  regime: string;
  model: string;
  gates: number;
  fails: number;
}

export interface DigestData {
  generated_at: string;
  since: string;
  worktree: string;
  scope_note: string;
  sources: SourceStatus[];
  decisions: MemRow[];
  bugs: { open: MemRow[]; closed: MemRow[] };
  notes: MemRow[];
  plans: { pending: PlanRow[]; shipped: PlanRow[] };
  cost: {
    by_model: CostRow[];
    total_usd: number;
    imputed_usd: number;
    unpriced_sessions: number;
  };
  verdicts: {
    by_grade: Tally[];
    by_regime_model: RegimeModelRow[];
    by_reason_code: Tally[];
    /** runs with ≥1 gate verdict in period — the "units" the headline counts. */
    units_graded: number;
    /** % of those whose earliest in-period gate passed at round ≤ 1. */
    round1_pct: number;
  };
  /** Hint-fire log counts for this worktree — null when no log exists. */
  impact: HintImpact | null;
  skipped_malformed: number;
}

export interface CollectOpts {
  since?: string; // "7d" or "YYYY-MM-DD"
  worktree?: string; // override — auto-detect from cwd when omitted
  /** @internal now override for deterministic testing */
  _now?: number;
}

// --- helpers ---

function resolveWorktree(override?: string): string {
  if (override) return override;
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

// --- plans ---

function parseFrontmatter(text: string): { status?: string; kind?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const front: { status?: string; kind?: string } = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^\s*([a-z_]+)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    const value = kv[2].replace(/\s+#.*$/, "").trim();
    if (!value) continue;
    if (kv[1] === "status") front.status = value;
    else if (kv[1] === "kind") front.kind = value;
  }
  return front;
}

function countCheckboxes(text: string): { done: number; total: number } {
  // Count checkboxes in the first ## section only (same logic as plans.ts)
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const start = body.search(/^##\s+/m);
  if (start < 0) return { done: 0, total: 0 };
  const rest = body.slice(start);
  const next = rest.slice(3).search(/^##\s+/m);
  const block = next < 0 ? rest : rest.slice(0, next + 3);
  const total = block.match(/^\s*[-*]\s+\[[ xX]\]/gm)?.length ?? 0;
  const done = block.match(/^\s*[-*]\s+\[[xX]\]/gm)?.length ?? 0;
  return { done, total };
}

function readPlans(worktree: string): {
  pending: PlanRow[];
  shipped: PlanRow[];
  ok: boolean;
  detail: string;
} {
  const config = loadConfig(join(worktree, CONFIG_FILENAME));
  const pDir = join(worktree, planDir());
  const dDir = join(worktree, doneDir(config));

  if (!existsSync(pDir)) {
    return {
      pending: [],
      shipped: [],
      ok: false,
      detail: `no plan dir — run: fapony init ${worktree}`,
    };
  }

  const readPlanFile = (file: string): PlanRow => {
    let text: string;
    try {
      text = readFileSync(join(pDir, file), "utf8");
    } catch {
      return { file, done: 0, total: 0 };
    }
    const { status, kind } = parseFrontmatter(text);
    const { done, total } = countCheckboxes(text);
    if (kind === "tracker") return { file, status, done: 0, total: 0 };
    return { file, status, done, total };
  };

  const pending = readdirSync(pDir)
    .filter((f) => f.endsWith(".md"))
    .map(readPlanFile);

  let shipped: PlanRow[] = [];
  if (existsSync(dDir)) {
    shipped = readdirSync(dDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => ({ file: f, status: "shipped", done: 0, total: 0 }));
  }

  return {
    pending,
    shipped,
    ok: true,
    detail: `${pending.length} pending / ${shipped.length} shipped`,
  };
}

// --- usage + cost ---

function readUsageAndCost(_worktree: string): {
  usage: PassiveUsageResult;
  cost: DigestData["cost"];
  ok: boolean;
  detail: string;
} {
  const cache = readCache();
  // Find a global entry (worktree=null), otherwise merge every entry
  const globalEntries = cache.filter((e) => !e.worktree);
  if (globalEntries.length === 0 && cache.length === 0) {
    return {
      usage: EMPTY_RESULT,
      cost: {
        by_model: [],
        total_usd: 0,
        imputed_usd: 0,
        unpriced_sessions: 0,
      },
      ok: false,
      detail: "no usage cache — run: fapony usage-scan",
    };
  }

  // Use global entries if present, otherwise merge every entry
  const entries = globalEntries.length > 0 ? globalEntries : cache;
  const usage = entriesToUsage(entries);

  // Compute the price
  const prices = loadPrices();
  if (!prices) {
    return {
      usage,
      cost: {
        by_model: usage.by_model.map((m) => ({
          model: m.model,
          provider: m.provider,
          sessions: m.session_count,
          input: m.tokens_input,
          output: m.tokens_output,
          cost: m.cost,
          imputed: 0,
        })),
        total_usd: usage.total_cost,
        imputed_usd: 0,
        unpriced_sessions: usage.session_count,
      },
      ok: true,
      detail: `cache ${entries[0]?.scanned_at ?? "unknown"} — no prices`,
    };
  }

  const imp = imputeResult(usage, prices);
  const by_model = imp.by_model.map((m) => ({
    model: m.model,
    provider: m.provider,
    sessions: m.session_count,
    input: m.tokens_input,
    output: m.tokens_output,
    cost: 0, // recorded cost from cache (separate from imputed)
    imputed: m.imputed_cost,
  }));

  // Attach the real cost from the cache
  const cacheByKey = new Map(
    entries.flatMap((e) =>
      e.by_model.map((m) => [`${m.provider}\0${m.model}`, m]),
    ),
  );
  for (const cm of by_model) {
    const real = cacheByKey.get(`${cm.provider}\0${cm.model}`);
    if (real) cm.cost = real.cost;
  }

  return {
    usage,
    cost: {
      by_model,
      total_usd: usage.total_cost,
      imputed_usd: imp.total_imputed,
      unpriced_sessions: imp.unpriced_sessions,
    },
    ok: true,
    detail: `cache ${entries[0]?.scanned_at ?? "unknown"} · prices ${prices.fetched_at.slice(0, 10)}`,
  };
}

function entriesToUsage(entries: CacheEntry[]): PassiveUsageResult {
  const r: PassiveUsageResult = {
    total_tokens_input: 0,
    total_tokens_output: 0,
    total_tokens_reasoning: 0,
    total_tokens_cache_read: 0,
    total_tokens_cache_write: 0,
    total_cost: 0,
    session_count: 0,
    by_model: [],
  };
  const modelMap = new Map<
    string,
    {
      provider: string;
      model: string;
      session_count: number;
      tokens_input: number;
      tokens_output: number;
      tokens_reasoning: number;
      tokens_cache_read: number;
      tokens_cache_write: number;
      cost: number;
    }
  >();

  for (const e of entries) {
    r.total_tokens_input += e.total_tokens_input;
    r.total_tokens_output += e.total_tokens_output;
    r.total_tokens_reasoning += e.total_tokens_reasoning;
    r.total_tokens_cache_read += e.total_tokens_cache_read;
    r.total_tokens_cache_write += e.total_tokens_cache_write;
    r.total_cost += e.total_cost;
    r.session_count += e.session_count;

    for (const m of e.by_model) {
      const key = `${m.provider}\0${m.model}`;
      let bucket = modelMap.get(key);
      if (!bucket) {
        bucket = {
          provider: m.provider,
          model: m.model,
          session_count: 0,
          tokens_input: 0,
          tokens_output: 0,
          tokens_reasoning: 0,
          tokens_cache_read: 0,
          tokens_cache_write: 0,
          cost: 0,
        };
        modelMap.set(key, bucket);
      }
      bucket.session_count += m.session_count;
      bucket.tokens_input += m.tokens_input;
      bucket.tokens_output += m.tokens_output;
      bucket.tokens_reasoning += m.tokens_reasoning;
      bucket.tokens_cache_read += m.tokens_cache_read;
      bucket.tokens_cache_write += m.tokens_cache_write;
      bucket.cost += m.cost;
    }
  }

  r.by_model = [...modelMap.values()].sort(
    (a, b) =>
      b.tokens_input + b.tokens_output - (a.tokens_input + a.tokens_output),
  );
  return r;
}

// --- verdicts ---

function readVerdicts(
  worktree: string,
  sinceIso: string,
): {
  ok: boolean;
  detail: string;
  by_grade: Tally[];
  by_regime_model: RegimeModelRow[];
  by_reason_code: Tally[];
  units_graded: number;
  round1_pct: number;
} {
  const empty = {
    ok: false,
    detail: "no graded runs yet for this worktree",
    by_grade: [],
    by_regime_model: [],
    by_reason_code: [],
    units_graded: 0,
    round1_pct: 0,
  };
  let db: ReturnType<typeof openDb>;
  try {
    db = openDb();
  } catch {
    return empty;
  }

  try {
    const runs = db
      .prepare("SELECT * FROM runs WHERE worktree = ? ORDER BY id")
      .all(worktree) as Run[];
    const runIds = new Set(runs.map((r) => r.id));
    const allEvents = db
      .prepare("SELECT * FROM events ORDER BY run_id, id")
      .all() as Event[];
    const events = allEvents.filter(
      (e) => runIds.has(e.run_id) && e.ts >= sinceIso,
    );

    if (events.length === 0) {
      return empty;
    }

    // by_grade: count gate verdicts
    const gradeMap = new Map<string, number>();
    // by_regime_model: regime × model
    const regimeModelMap = new Map<string, RegimeModelRow>();
    // by_reason_code: non-pass gates
    const reasonMap = new Map<string, number>();

    // regime per run
    const regimeByRun = new Map<number, string>();
    for (const e of events) {
      if (e.kind !== "gate" || !e.data) continue;
      if (regimeByRun.has(e.run_id)) continue;
      try {
        const d = JSON.parse(e.data) as { regime?: unknown };
        if (typeof d.regime === "string") regimeByRun.set(e.run_id, d.regime);
      } catch {
        // skip
      }
    }

    // Per-run verdicts: one run routinely spans several gates (fail → fix →
    // pass), so gate counts are not work units. events arrive ordered by
    // (run_id, id) and ids are time-ordered, so first-seen per run is the
    // earliest gate in the period.
    const firstGateByRun = new Map<
      number,
      { verdict: string; round: number }
    >();
    const hasVerdictByRun = new Set<number>();
    for (const e of events) {
      if (e.kind !== "gate" || !e.data) continue;
      let verdict: string | null = null;
      let reasonCode: string | null = null;
      let model: string | null = null;
      // gateOnce always writes round (src/gate.ts); older rows may lack it —
      // same default as the stats enrichment (src/gates.ts).
      let round = 1;
      try {
        const d = JSON.parse(e.data) as {
          verdict?: unknown;
          reason_code?: unknown;
          note?: unknown;
          model?: unknown;
          round?: unknown;
        };
        if (typeof d.verdict === "string" && VERDICT_GRADES.has(d.verdict))
          verdict = d.verdict;
        if (typeof d.reason_code === "string") reasonCode = d.reason_code;
        else if (typeof d.note === "string") {
          const m = /^\[([a-z_]+)\]/.exec(d.note);
          if (m) reasonCode = m[1];
        }
        if (typeof d.model === "string") model = d.model;
        if (typeof d.round === "number") round = d.round;
      } catch {
        // skip
      }

      if (verdict) {
        gradeMap.set(verdict, (gradeMap.get(verdict) ?? 0) + 1);
        hasVerdictByRun.add(e.run_id);
        if (!firstGateByRun.has(e.run_id))
          firstGateByRun.set(e.run_id, { verdict, round });
      }

      // regime × model
      const regime = regimeByRun.get(e.run_id) ?? "—";
      const modelKey = model ?? "—";
      const rmKey = `${regime}\0${modelKey}`;
      let rmRow = regimeModelMap.get(rmKey);
      if (!rmRow) {
        rmRow = { regime, model: modelKey, gates: 0, fails: 0 };
        regimeModelMap.set(rmKey, rmRow);
      }
      rmRow.gates++;
      if (verdict && !isPassFamily(verdict)) rmRow.fails++;

      // reason_code (non-pass only)
      if (verdict && !isPassFamily(verdict) && reasonCode) {
        reasonMap.set(reasonCode, (reasonMap.get(reasonCode) ?? 0) + 1);
      }
    }

    const by_grade = [...gradeMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);

    const by_regime_model = [...regimeModelMap.values()].sort(
      (a, b) => b.gates - a.gates,
    );

    const by_reason_code = [...reasonMap.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count);

    const units_graded = hasVerdictByRun.size;
    const round1 = [...firstGateByRun.values()].filter(
      (v) => isPassFamily(v.verdict) && v.round <= 1,
    ).length;
    const round1_pct = units_graded
      ? Math.round((round1 / units_graded) * 100)
      : 0;

    return {
      ok: true,
      detail: `${runs.length} runs`,
      by_grade,
      by_regime_model,
      by_reason_code,
      units_graded,
      round1_pct,
    };
  } finally {
    db.close();
  }
}

// --- main ---

export async function collectDigest(
  opts: CollectOpts = {},
): Promise<DigestData> {
  const { iso: sinceIso } = parseSince(opts.since, opts._now);
  const worktree = resolveWorktree(opts.worktree);
  const scopeNote =
    "this machine only — mem log is not shared via git in this repo";

  const sources: SourceStatus[] = [];
  let skippedMalformed = 0;

  // 1. memory log
  const mem = readFaelLog(worktree, sinceIso);
  skippedMalformed += mem.skipped;
  sources.push({
    name: "memory",
    ok: mem.ok,
    detail: mem.ok
      ? `${mem.rows.length} rows from fael`
      : "fael not found — memory lives in fael (npm i -g @zecalis/fael)",
  });

  // 2. plans
  const planResult = readPlans(worktree);
  sources.push({
    name: "plans",
    ok: planResult.ok,
    detail: planResult.detail,
  });

  // 3. usage
  const usageResult = readUsageAndCost(worktree);
  sources.push({
    name: "usage",
    ok: usageResult.ok,
    detail: usageResult.detail,
  });

  // 4. prices
  const prices = loadPrices();
  sources.push({
    name: "prices",
    ok: prices !== null,
    detail: prices
      ? `table ${prices.fetched_at.slice(0, 10)}`
      : "no price table — run: fapony price-scan",
  });

  // 5. verdicts
  const verdictResult = readVerdicts(worktree, sinceIso);
  sources.push({
    name: "verdicts",
    ok: verdictResult.ok,
    detail: verdictResult.detail,
  });

  // 6. hint-fire log — annotate surface, this worktree only. A log that
  // exists but fired 0 in the window is "0", not "no data" (done criteria 6).
  const hasHintLog = existsSync(hintLogPath(worktree));
  const impact = hasHintLog ? computeHintImpact(sinceIso, worktree) : null;
  sources.push({
    name: "hint-log",
    ok: hasHintLog,
    detail: impact ? `${impact.fired} fired this window` : "no hints recorded",
  });

  // classify mem rows
  const decisions = mem.rows.filter((r) => r.kind === "decision");
  const notes = mem.rows.filter((r) => r.kind === "note");

  // bug = open, close = closed — find open bugs by tracking closed refs
  // close rows have `ref` pointing to the bug's `id`
  const closedRefs = new Set(
    mem.rows.filter((r) => r.kind === "close").map((r) => r.ref ?? ""),
  );
  const allBugs = mem.rows.filter((r) => r.kind === "bug");
  const bugsOpen = allBugs.filter((r) => !closedRefs.has(r.id ?? ""));
  const bugsClosed = mem.rows.filter((r) => r.kind === "close");

  return {
    generated_at: new Date().toISOString(),
    since: sinceIso,
    worktree,
    scope_note: scopeNote,
    sources,
    decisions,
    bugs: { open: bugsOpen, closed: bugsClosed },
    notes,
    plans: {
      pending: planResult.pending,
      shipped: planResult.shipped,
    },
    cost: usageResult.cost,
    verdicts: {
      by_grade: verdictResult.by_grade,
      by_regime_model: verdictResult.by_regime_model,
      by_reason_code: verdictResult.by_reason_code,
      units_graded: verdictResult.units_graded,
      round1_pct: verdictResult.round1_pct,
    },
    impact,
    skipped_malformed: skippedMalformed,
  };
}
