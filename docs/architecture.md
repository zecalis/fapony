# fapony — Architecture (file-by-file)

> **Used by:** the local agent rules (CLAUDE.md, untracked) — ย้ายออกมาเพราะเป็น *lookup* ไม่ใช่ *rule*
> อ่านตอนหาที่วางโค้ดใหม่ ไม่ใช่ทุก session


```
fapony/
  fapony.ts           # 7-line dispatch → src/adapters/cli.ts
  fapony.config.json  # runtime config (worktrees, review.maxRounds, memory, paths, safety) — optional, gitignored
  scripts/
    smoke-publish.sh      # npm publish smoke test
    test-one.ts           # run a single test file
  images/
    logo.png / logo.webp / logo@400.webp  # project logos
    sample.webp / summary.webp            # README screenshots
  skill/                        # <name>/SKILL.md — symlinked into clients by `fapony install`
                                # each SKILL.md is self-contained — the symlink ships only
                                # skill/<name>/, so a link out of that dir is dead on install
    plan-with-pony/             # draft plan + spec จาก conversation (pipe to any agent's stdin)
    review-pony/                # review as verification + scope facts before (review-seed), verdict after
    debug-pony/                 # debug as a ledger: fael before, repro → narrow → disprove, close with what was ruled out
    move-to-done/               # archive PLAN เข้า .fapony/done/ หลัง ship
  templates/
    PLAN.md / SPEC.md              # plan+spec templates for `fapony init`
  src/
    plan/               # fapony plan [<PLAN.md>] | sweep | check — index / store (plan dirs) / next (plan view) / sweep (sweep + check)
    fael.ts             # the one memory reader — `fael find --json` → MemRow; fapony never writes memory
    core/               # pure layer — no imports back to features/adapters/db-store (PLAN-lib-layer)
      config.ts         # Config/Run/Event types + defaults + getters + load (single source; db/* are shims)
      defaults.ts       # DEFAULT_SAFETY_DENY (single source)
      fapony-dir.ts     # faponyDirFrom — nearest .fapony/ up to the git root (plans)
      hint-log.ts       # hint-log pure helpers (hintLogPath)
      hook-helpers.ts   # hook pure helpers
      enums.ts          # REASON_CODES/REGIME_CODES
      types.ts          # ToolResult + usage/result types
      util.ts           # capLines + shared pure utils
      parse.ts / safety.ts / format.ts / pricing.ts
    db/               # SQLite store only — pure parts live in core/config.ts
      store.ts        # openDb + schema/migration (PRAGMA user_version) + CRUD
      index.ts        # barrel re-export (compat — src/ imports core/config or db/store directly)
      defaults.ts / types.ts / getters.ts / load.ts  # shims re-exporting core/config.ts
    adapters/           # I/O boundary — thin framing only, no logic (PLAN-lib-layer chunk 3)
      cli.ts            # fapony.ts dispatch target
      hooks/            # hook-mv-guard / compute-hint-impact (digest reads old fires) · memory hooks moved to fael
      mcp/              # no server (removed 2026-09-25) — collect/check/report engines for `fapony report`
    gates.ts          # per-round gate enrichment — model + session tokens per gate; carries `sessionId` so callers can dedupe
    parse.ts          # parseGateVerdict() + qualityScore()
    gate.ts           # gateOnce() — frozen review-verdict engine (no live callers since verdict_submit left MCP 2026-09)
    memory.ts         # config.memory shell helpers for gate.ts — user-configured commands only, no default wiring
    safety.ts         # assertSafe() deny-list (checked before any config-sourced shell cmd runs)
    session/           # passive usage readers — OpenCode (SQLite), ZCode (SQLite), Claude Code (JSONL), Codex (JSONL)
      activeSession.ts # loadSessionSpans/findSessionAt — which client session was live in a worktree at time T (model attribution without asking the caller)
      index.ts         # re-exports (backward compat)
      types.ts         # ModelBreakdown, SessionDetail, UsageDetail, StepTimingSummary, PassiveUsageResult
      helpers.ts       # buildWhereClause(), aggregateDetail(), readDetailFromDb(), parseTimeMs()/extractPartTiming()/summarizeTiming()/collectTiming()/readTimingFromDb()
      opencode.ts      # readPassiveUsage() — OpenCode session DB
      zcode.ts         # readZcodeUsage() — ZCode session DB
      claude-code.ts   # readClaudeCodeUsage() — Claude Code JSONL files
      codex.ts         # readCodexUsage() — Codex JSONL files
    context/           # project-health context block, keyed by files[] (any caller)
      projectHealth.ts # buildProjectHealthContext() — pure over StatsData, ~15 lines max; computeModelFit() (regime×model right-sizing, min-N=5) read by `fapony stats` — plan-seed stopped citing it 2026-09-22 (frozen ledger; cross-model ranking claims are off the table)
      index.ts         # barrel re-export
    analyze/            # fapony analyze — one file per concern (mirrors install/)
      types.ts          # ImportGraph / Finding / BlastEntry
      criteria.ts       # isTestFile / isBarrelSource / isTestedThroughBarrels
      discover.ts       # SCAN_EXTS / isSkippedDir / collectSourceFiles
      resolve-ts.ts     # require()/import-type + resolveRelative
      python.ts         # .py import scan + resolution
      barrels.ts        # exportsThroughBarrels (star re-exports)
      graph.ts          # buildGraph() — live via Bun.Transpiler.scan(), never persisted
      diagnose.ts       # diagnose() (hub/orphan/cycle/changed-untested)
      blast.ts          # blastRadius() / blastRadiusForWorktree()
      format.ts         # formatAnalyze()
      cli.ts            # cmdAnalyze()
      index.ts          # barrel re-export
    map.ts              # extractExports() — on-demand source index, library only; the `fapony map` command was deleted once plan-seed/review-seed were its only callers (see PLAN-code-map)
    detect.ts           # runtime test runner detection (bun/npm/pnpm/yarn) from package.json + lockfile — test-only caller left (was the Stop hook)
    seed/               # seed commands — plan-seed + review-seed + shared primitives
      primitives.ts     # shared git helpers (execGit/gitOk/gitValue), capLines, SIG_MAX, SeedError
      plan-seed.ts      # fapony plan-seed <name> [--spec] [--scope <path>[,<path>]]... — writes PLAN(+SPEC): frontmatter, 8 empty sections, Context (fapony: fael decisions + existing-in-scope), existing-plans stdout list; SPEC chunks hold signatures, hard caps PLAN ≤ ~60 / SPEC ≤ 200
      review-seed.ts    # fapony review-seed [--staged|--commit|--range|--files|--plan] — read-only scope facts for a review (changed/importers/untested/signatures/cross-check)
    price/              # model pricing data — fetch + resolve
      fetch.ts          # fetchPricing() — HTTP fetch from upstream price table
      resolve.ts        # resolvePrice() — lookup per-model cost from cached data
      index.ts          # barrel re-export
    hook.ts             # shim re-exporting adapters/hooks/* (see adapters/ above)
    init.ts            # fapony init — scaffold .fapony/{plan,done,spec,evidence.json} + plan-loop rules into AGENTS.md
    digest/               # fapony digest — merges fael rows + plans + usage cache + verdicts into one page
    stats/                # fapony stats — KPI across runs
      data.ts             # getStatsData() + StatsData type + computeEfficiency() + reason_code/plan/escalation/best-passing queries
      format.ts           # formatStatsText() — CLI + MCP text mode
      cli.ts              # cmdStats()
      index.ts            # barrel re-export
    web/                  # shared HTML helpers (report-web + usage-web)
      html.ts             # esc(), DARK_THEME_CSS, TABLE_CSS
      index.ts            # barrel re-export
    report/               # fapony report / report-web — verification report
      cli.ts              # cmdReport (per-run), cmdReportWeb (aggregate HTML)
      render.ts           # renderReportHtml(stats, generated_at) — renders from StatsData
      format.ts           # fmtRate, fmtUsd, fmtMinutes, insufficientData
      index.ts            # barrel re-export
    usage/                # fapony usage-web — live usage comparison dashboard
      cli.ts              # cmdUsageWeb + Bun.serve routes (/, /data, /favicon.ico)
      render.ts           # renderUsageHtml() — HTML with summary cards + per-client tables
      format.ts           # fmtTokens(), fmtCost(), fmtDelta(), shortModel() — re-exports esc() from web/
      index.ts            # barrel re-export
    telemetry.ts        # opt-in payload (runs/events allowlist เท่านั้น)
    setup.ts            # fapony setup — interactive wizard: config + scaffold ในขั้นเดียว
    install.ts          # barrel — re-exports src/install/ (fapony install --platform …)
    install/            # one file per client + shared pieces
      claude.ts         # ~/.claude/settings.json hooks (mv-guard) + removes retired fapony hooks
      opencode.ts       # ~/.config/opencode/plugins: removes retired plugins
      zcode.ts / codex.ts / antigravity.ts  # detect + skills symlink only
      detect.ts         # which clients exist on this machine
      skills.ts         # linkSkills() — symlinks skill/<name>/ into ~/.claude/skills, never overwrites
      types.ts          # InstallDeps / defaultExit / INSTALL_ROOT
    update.ts            # fapony update — by channel: git (fetch, preview, confirm, `merge --ff-only`; tripwire test คุม ROOT) or bun/npm global (`@latest` when newer); then re-link skills (prune dead links) + spawn a fresh install to refresh opencode's baked plugins
    util.ts               # templateArgs / fillPrompt / isAffirmative / minutesBetween / avg
    test.ts               # self-check ตัวเอง (thin wrapper → test/index.ts)
  test/
    *.test.ts              # one file per src module
    mcp/                   # ledger report/check/collect engine tests
    install/               # install provider tests (one file per src/install module)
    telemetry/             # telemetry tests
  docs/
    architecture.md        # this file — file-by-file layout
    edge-cases.md          # edge cases ที่จัดการแล้ว — lookup ตอนเจอพฤติกรรมแปลก
```

