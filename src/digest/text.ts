// src/digest/text.ts — render digest as terminal text
//
// Section order per SPEC §3 (tells a story, not a dashboard)

import type { CostRow, DigestData, MemRow, PlanRow } from "./collect.js";

function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

function fmtTime(iso: string): string {
  return iso.slice(5, 10); // MM-DD
}

function section(name: string, lines: string[]): string {
  return `${name}\n${lines.map((l) => `  ${l}`).join("\n")}`;
}

function memLine(r: MemRow): string {
  const date = fmtTime(r.ts);
  return `${date}  ${r.agent}  ${r.text.replace(/\n/g, " ").slice(0, 80)}`;
}

function planLine(p: PlanRow): string {
  const name = p.file.replace(/\.md$/, "");
  const status = p.status ?? "active";
  const progress = p.total > 0 ? `${p.done}/${p.total}` : "—";
  return `${name.padEnd(30)} ${status.padEnd(12)} ${progress}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}

function impactLines(i: NonNullable<DigestData["impact"]>): string[] {
  const b = i.by_surface;
  const out = [
    `hints fired: ${i.fired} (read ${b.read} · debt ${b.debt} · mem ${b.mem} · commit ${b.commit})`,
  ];
  out.push(
    "note: counts what fapony showed, not proof the agent acted because of the hint",
  );
  return out;
}

function costLine(c: CostRow): string {
  const name = c.provider ? `${c.provider}/${c.model}` : c.model;
  const costStr =
    c.imputed > 0
      ? `$${c.imputed.toFixed(4)} imputed`
      : c.cost > 0
        ? `$${c.cost.toFixed(4)} recorded`
        : "unpriced";
  return `${name.padEnd(45)} ${String(c.sessions).padStart(5)} sessions  ${fmtTokens(c.input).padStart(7)} in  ${fmtTokens(c.output).padStart(7)} out  ${costStr}`;
}

export function renderDigestText(d: DigestData): string {
  const lines: string[] = [];

  // 1. Header
  lines.push(
    `fapony digest — ${fmtDate(d.since)} → ${fmtDate(d.generated_at)}`,
  );
  lines.push(`  ${d.worktree}`);
  lines.push(`  scope: ${d.scope_note}`);
  lines.push("");

  // 2. Headline — run-based counts from collect (gate tallies are not units)
  const units = d.verdicts.units_graded;
  const costBits: string[] = [];
  if (d.cost.imputed_usd > 0)
    costBits.push(`$${d.cost.imputed_usd.toFixed(4)} (imputed)`);
  if (d.cost.total_usd > 0)
    costBits.push(`$${d.cost.total_usd.toFixed(4)} (recorded)`);
  const costLabel = costBits.length > 0 ? costBits.join(" · ") : "$0";

  lines.push(
    `  ${units} unit${units === 1 ? "" : "s"} graded · ${d.verdicts.round1_pct}% passed round 1 · ${costLabel}`,
  );
  lines.push("");

  // 2b. fapony impact — what the annotate surfaces showed, not proof of use
  lines.push(
    section("FAPONY IMPACT", [
      ...(d.impact ? impactLines(d.impact) : ["(no hints recorded)"]),
    ]),
  );
  lines.push("");

  // 3. Decisions
  lines.push(
    section(`DECISIONS (${d.decisions.length})`, [
      ...d.decisions.map(memLine),
      ...(d.decisions.length === 0 ? ["(none this period)"] : []),
    ]),
  );
  lines.push("");

  // 3b. Notes — mem rows like decisions; the sync payload must stay visible
  lines.push(
    section(`NOTES (${d.notes.length})`, [
      ...d.notes.map(memLine),
      ...(d.notes.length === 0 ? ["(none this period)"] : []),
    ]),
  );
  lines.push("");

  // 4. Open bugs
  const openBugLines = d.bugs.open.map(memLine);
  const closedCount = d.bugs.closed.length;
  lines.push(
    section(`OPEN BUGS (${d.bugs.open.length})`, [
      ...openBugLines,
      ...(d.bugs.open.length === 0 ? ["(none)"] : []),
      ...(closedCount > 0 ? [`(${closedCount} closed this period)`] : []),
    ]),
  );
  lines.push("");

  // 5. In flight
  const inFlight = d.plans.pending.filter(
    (p) => p.status === "active" || !p.status,
  );
  const shipped = d.plans.shipped;
  lines.push(
    section(`IN FLIGHT (${inFlight.length})`, [
      ...inFlight.map(planLine),
      ...(inFlight.length === 0 ? ["(none)"] : []),
      ...(shipped.length > 0 ? [`${shipped.length} shipped this period`] : []),
    ]),
  );
  lines.push("");

  // 6. Cost
  if (d.cost.by_model.length > 0) {
    lines.push(
      section("COST", [
        "model".padEnd(45) +
          "sessions".padStart(5) +
          "     in".padStart(9) +
          "    out".padStart(9) +
          "  cost",
        ...d.cost.by_model.map(costLine),
        ...(d.cost.unpriced_sessions > 0
          ? [
              `${d.cost.unpriced_sessions} sessions unpriced (no rate found — not counted as free)`,
            ]
          : []),
      ]),
    );
  } else {
    lines.push(section("COST", ["(no usage data)"]));
  }
  lines.push("");

  // 7. How work failed — by_grade first (every payload field needs a place)
  if (d.verdicts.by_grade.length > 0) {
    lines.push(
      section("BY GRADE", [
        ...d.verdicts.by_grade.map((t) => `${t.key.padEnd(20)} ${t.count}`),
      ]),
    );
    lines.push("");
  }

  if (d.verdicts.by_reason_code.length > 0) {
    lines.push(
      section("HOW WORK FAILED", [
        ...d.verdicts.by_reason_code.map(
          (t) => `${t.key.padEnd(20)} ${t.count}`,
        ),
      ]),
    );
  } else {
    lines.push(section("HOW WORK FAILED", ["no graded fails in this period"]));
  }

  if (d.verdicts.by_regime_model.length > 0) {
    lines.push("");
    lines.push(
      section("BY REGIME × MODEL", [
        `${"regime".padEnd(10)}${"model".padEnd(40)}gates  fails`,
        ...d.verdicts.by_regime_model.map(
          (r) =>
            `${r.regime.padEnd(10)}${r.model.padEnd(40)}${String(r.gates).padStart(5)}  ${String(r.fails).padStart(5)}`,
        ),
      ]),
    );
  }
  lines.push("");

  // 8. Sources
  lines.push(
    section(
      "SOURCES",
      d.sources.map(
        (s) => `${s.name.padEnd(10)} ${s.ok ? "ok" : "!!"}    ${s.detail}`,
      ),
    ),
  );

  if (d.skipped_malformed > 0) {
    lines.push("");
    lines.push(`  (${d.skipped_malformed} malformed log lines skipped)`);
  }

  return lines.join("\n");
}
