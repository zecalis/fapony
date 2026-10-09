// src/adapters/cli.ts — CLI dispatch: parse argv and route to feature modules
//
// Extracted from fapony.ts (PLAN-lib-layer chunk 3). The entry point
// (fapony.ts) calls cliMain(); this file owns all feature imports and the
// argv routing.

import { cmdAnalyze } from "../analyze/index.js";
import { renderUsage, suggestCommand } from "../commands.js";
import { cmdDigest } from "../digest/cli.js";
import { cmdInit } from "../init.js";
import { cmdInstall } from "../install.js";
import { cmdLintBaseline } from "../lint-baseline.js";
import { cmdPlan } from "../plan/index.js";
import { cmdPriceScan } from "../price/index.js";
import { cmdReport, cmdReportWeb } from "../report/index.js";
import { cmdPlanSeed } from "../seed/plan-seed.js";
import { cmdReviewSeed } from "../seed/review-seed.js";
import { cmdSetup } from "../setup.js";
import { cmdStats } from "../stats/index.js";
import { cmdTelemetry } from "../telemetry.js";
import { cmdUpdate, readVersion } from "../update.js";
import { cmdUsageScan, cmdUsageWeb } from "../usage/index.js";
import { cmdHookMvGuard } from "./hooks/index.js";

export async function cliMain(): Promise<void> {
  const [cmd, ...a] = process.argv.slice(2);

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(renderUsage());
    return;
  }

  if (cmd === "--version" || cmd === "-v") {
    console.log(readVersion());
    return;
  }

  if (cmd === "analyze") {
    cmdAnalyze(a);
  } else if (cmd === "lint-baseline") {
    cmdLintBaseline(a);
  } else if (cmd === "plan-seed") {
    cmdPlanSeed(a);
  } else if (cmd === "review-seed") {
    cmdReviewSeed(a);
  } else if (cmd === "digest") {
    await cmdDigest(a);
  } else if (cmd === "stats") {
    cmdStats(a);
  } else if (cmd === "telemetry") {
    await cmdTelemetry(a);
  } else if (cmd === "plan") {
    cmdPlan(a);
  } else if (cmd === "mem" || cmd === "mcp" || cmd === "init-mem") {
    // Memory moved to fael (2026-09-25) — say where, don't just "unknown".
    console.error(
      `fapony: memory moved to fael (npm i -g @zecalis/fael) — "fapony mem <sub>" → "fael <sub>", plans → "fapony plan [sweep|check]"`,
    );
    process.exit(1);
  } else if (cmd === "init") {
    await cmdInit(a);
  } else if (cmd === "install") {
    await cmdInstall(a);
  } else if (cmd === "setup") {
    await cmdSetup();
  } else if (cmd === "update" || cmd === "upgrade") {
    await cmdUpdate(a);
  } else if (cmd === "hook-mv-guard") {
    await cmdHookMvGuard();
  } else if (cmd === "report") {
    cmdReport(a);
  } else if (cmd === "report-web") {
    cmdReportWeb(a);
  } else if (cmd === "usage-scan") {
    cmdUsageScan(a);
  } else if (cmd === "price-scan") {
    await cmdPriceScan(a);
  } else if (cmd === "usage-web") {
    cmdUsageWeb(a);
  } else {
    console.error(`fapony: unknown command "${cmd ?? ""}"`);
    const hints = suggestCommand(cmd ?? "");
    if (hints.length > 0) {
      console.error(`did you mean ${hints.map((h) => `"${h}"`).join(" or ")}?`);
    }
    console.error(`usage: fapony <command> [args] — see "fapony --help"`);
    process.exit(1);
  }
}
