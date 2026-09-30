import { test } from "bun:test";
// test/plan-check-sha.test.ts — chunks 8-9 (PLAN-seed-and-surface):
// plan-check verifies the commits ticked chunks cite; kickoff says whether
// the last ticked chunk actually closed. git is the judge in both.

import assert from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPlanNext } from "../src/plan/next.js";
import { initPlanStore } from "../src/plan/store.js";
import {
  checkTickedLine,
  extractShas,
  isOnDefault,
} from "../src/plan/sweep.js";
import { captureLogs, withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");

const git = (dir: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd: dir }).toString().trim();

// A repo with: HEAD commit (good), a commit on a live side branch (held —
// another worktree's work), a commit whose branch was deleted (diverged: no
// ref holds it), and HEAD's tree sha (an object, not a commit).
function repoWithShas(dir: string): {
  good: string;
  held: string;
  diverged: string;
  tree: string;
} {
  const base = git(dir, "branch --show-current");
  writeFileSync(join(dir, "a.txt"), "a\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "base"', { cwd: dir, stdio: "ignore" });
  const good = git(dir, "rev-parse --short=7 HEAD");
  const tree = git(dir, "rev-parse --short=7 HEAD^{tree}");
  execSync("git checkout -b side", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "b.txt"), "b\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "side"', { cwd: dir, stdio: "ignore" });
  const held = git(dir, "rev-parse --short=7 HEAD");
  execSync("git checkout -b lost", { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "c.txt"), "c\n");
  execSync("git add .", { cwd: dir, stdio: "ignore" });
  execSync('git commit -m "lost"', { cwd: dir, stdio: "ignore" });
  const diverged = git(dir, "rev-parse --short=7 HEAD");
  execSync(`git checkout ${base}`, { cwd: dir, stdio: "ignore" });
  execSync("git branch -D lost", { cwd: dir, stdio: "ignore" });
  return { good, held, diverged, tree };
}

test("testExtractShas", () => {
  assert.deepEqual(extractShas("- [x] chunk 1 — thing (abc1234)"), ["abc1234"]);
  assert.deepEqual(extractShas("- [x] chunk 1 — thing (abc1234 + def5678)"), [
    "abc1234",
    "def5678",
  ]);
  assert.deepEqual(extractShas("- [x] chunk 4 — defer, no commit"), []);
  // The regex catches hex words — git decides, not the regex.
  assert.deepEqual(extractShas("see deadbee below"), ["deadbee"]);
  // A 40-char sha never matches on its tail (git resolves leading prefixes).
  const full = "0123456789abcdef0123456789abcdef01234567";
  assert.deepEqual(extractShas(`cite ${full} here`), []);
  console.log("  ✓ extractShas finds standalone short shas only");
});

test("testCheckTickedLine", () => {
  withTempRepo((dir) => {
    const { good, held, diverged, tree } = repoWithShas(dir);
    assert.deepEqual(checkTickedLine(`- [x] chunk 1 — ok (${good})`, dir), {
      missing: [],
      diverged: [],
      cited: 1,
    });
    assert.deepEqual(
      checkTickedLine(`- [x] chunk 1 — tree, not commit (${tree})`, dir),
      { missing: [tree], diverged: [], cited: 1 },
    );
    // Another worktree's branch holds it → verified, not "rebased away".
    assert.deepEqual(
      checkTickedLine(`- [x] chunk 1 — side branch (${held})`, dir),
      { missing: [], diverged: [], cited: 1 },
    );
    // Object exists but no ref holds it (squashed, branch deleted).
    assert.deepEqual(
      checkTickedLine(`- [x] chunk 1 — orphan (${diverged})`, dir),
      { missing: [], diverged: [diverged], cited: 1 },
    );
    // Hex words git never heard of are plain words, never issues.
    assert.deepEqual(
      checkTickedLine("- [x] chunk 4 — defer, see deadbee", dir),
      { missing: [], diverged: [], cited: 0 },
    );
    assert.deepEqual(checkTickedLine("- [x] chunk 4 — defer", dir), {
      missing: [],
      diverged: [],
      cited: 0,
    });
    // …unless cited next to a real sha: (deadbee + <known>) is a citation
    // of a commit git has no record of, not prose.
    assert.deepEqual(
      checkTickedLine(`- [x] chunk 1 — hooks (${good} + deadbee)`, dir),
      { missing: ["deadbee"], diverged: [], cited: 2 },
    );
    // Same line, outside the parens: still prose ("feedbac" in "feedback").
    assert.deepEqual(
      checkTickedLine(`- [x] chunk 1 — feedback on the cutover (${good})`, dir),
      { missing: [], diverged: [], cited: 1 },
    );
  });
  console.log(
    "  ✓ checkTickedLine: ok / held / missing / diverged / plain-word",
  );
});

// A squash-merged PR leaves only "subject (#N)" on the default branch.
test("testCheckTickedLinePrNumber", () => {
  withTempRepo((dir) => {
    repoWithShas(dir);
    const squash = (subject: string) => {
      execSync(`git commit --allow-empty -m "${subject}"`, {
        cwd: dir,
        stdio: "ignore",
      });
    };
    squash("feat: one (#115)");
    squash("feat: two (#116)");
    squash("feat: three (#116)");
    const tick = (pr: number) => `- [x] chunk 1 — shipped (#${pr})`;
    assert.deepEqual(checkTickedLine(tick(115), dir), {
      missing: [],
      diverged: [],
      cited: 1,
    });
    // ≥2 commits share the number → ambiguous, reported.
    assert.deepEqual(checkTickedLine(tick(116), dir), {
      missing: ["#116"],
      diverged: [],
      cited: 1,
    });
    // none → reported.
    assert.deepEqual(checkTickedLine(tick(999), dir), {
      missing: ["#999"],
      diverged: [],
      cited: 1,
    });
    // "issue #115" outside parens is prose, not a citation.
    assert.deepEqual(checkTickedLine("- [x] chunk 1 — see issue #115", dir), {
      missing: [],
      diverged: [],
      cited: 0,
    });
  });
  console.log(
    "  ✓ checkTickedLine: (#N) verifies on exactly one default-branch commit",
  );
});

// A tick that survives a squash: the merge rewrites the cited sha but leaves
// "subject (#N)" on the default branch, so a merged (#N) proves the closure.
test("testCheckTickedLinePrNumberSurvivesSquash", () => {
  withTempRepo((dir) => {
    const { held, diverged } = repoWithShas(dir);
    const squash = (subject: string) =>
      execSync(`git commit --allow-empty -m "${subject}"`, {
        cwd: dir,
        stdio: "ignore",
      });
    squash("feat: one (#120)");
    squash("feat: two (#121)");
    squash("feat: three (#121)");
    const tick = (...cites: string[]) =>
      `- [x] chunk 1 — done (${cites.join(") (")})`;
    // squashed sha + the merged PR number: verified, nothing diverged
    assert.deepEqual(checkTickedLine(tick(diverged, "#120"), dir), {
      missing: [],
      diverged: [],
      cited: 2,
    });
    // …also for the judge that asks "is it on the default branch"
    assert.deepEqual(checkTickedLine(tick(held, "#120"), dir, isOnDefault), {
      missing: [],
      diverged: [],
      cited: 2,
    });
    // PR still open: a branch holds the sha → work in flight, nothing reported
    assert.deepEqual(checkTickedLine(tick(held, "#777"), dir), {
      missing: [],
      diverged: [],
      cited: 2,
    });
    // …but the readiness judge (default branch only) is not satisfied
    assert.deepEqual(checkTickedLine(tick(held, "#777"), dir, isOnDefault), {
      missing: ["#777"],
      diverged: [held],
      cited: 2,
    });
    // sha lost AND the number names nothing → both reported
    assert.deepEqual(checkTickedLine(tick(diverged, "#777"), dir), {
      missing: ["#777"],
      diverged: [diverged],
      cited: 2,
    });
    // ambiguous number is reported even when a branch holds the sha
    assert.deepEqual(checkTickedLine(tick(held, "#121"), dir), {
      missing: ["#121"],
      diverged: [],
      cited: 2,
    });
  });
  console.log("  ✓ checkTickedLine: a merged (#N) clears the squashed sha");
});

// The whole loop through the real CLI: tick with sha + (#N), squash away the
// branch, merge more PRs — plan check stays green and --fix has nothing to do.
test("testPlanCheckStaysCleanAfterSquashWhenTickCitesPr", () => {
  withTempRepo((dir) => {
    const { diverged } = repoWithShas(dir);
    execSync('git commit --allow-empty -m "feat: chunk (#120)"', {
      cwd: dir,
      stdio: "ignore",
    });
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    const planFile = join(dir, ".fapony/plan/PLAN-t.md");
    writeFileSync(
      planFile,
      `# T\n\n## TL;DR\n- [x] chunk 1 — done (${diverged}) (#120)\n- [ ] chunk 2 — next\n`,
    );
    const run = (...args: string[]) =>
      Bun.spawnSync(["bun", FAPONY, "plan", ...args], {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
    const out = (p: ReturnType<typeof run>) =>
      p.stdout.toString() + p.stderr.toString();
    for (const later of [0, 1, 3]) {
      for (let i = 0; i < later; i++)
        execSync(`git commit --allow-empty -m "feat: later ${i} (#13${i})"`, {
          cwd: dir,
          stdio: "ignore",
        });
      const check = run("check");
      assert.equal(
        check.exitCode,
        0,
        `clean after ${later} more:\n${out(check)}`,
      );
      assert.doesNotMatch(out(check), /no branch holds/);
    }
    assert.match(out(run("check", "--fix")), /--fix: nothing to repair/);
  });
  console.log("  ✓ plan-check e2e: sha + (#N) tick stays clean after squash");
});

// End to end through the real CLI: plan/ + done/ are both scanned, bad shas
// are named, hex words are not, and the summary counts the ratio.
test("testPlanCheckShaEndToEnd", () => {
  withTempRepo((dir) => {
    const { good, diverged, tree } = repoWithShas(dir);
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-t.md"),
      `# T\n\n## TL;DR\n- [x] chunk 1 — good (${good})\n- [x] chunk 2 — tree, not commit (${tree})\n- [x] chunk 3 — side branch (${diverged})\n- [x] chunk 4 — defer, no commit\n- [x] chunk 5 — see deadbee\n- [x] chunk 6 — hooks (${good} + deadbee)\n- [x] chunk 7 — feedback on the cutover (${good})\n- [ ] chunk 8 — next\n`,
    );
    writeFileSync(
      join(dir, ".fapony/done/PLAN-old.md"),
      `# OLD\n\n## TL;DR\n- [x] chunk 1 — old but good (${good})\n`,
    );
    const proc = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    const err = proc.stderr.toString();
    assert.equal(proc.exitCode, 1, `plan-check must fail:\n${out}\n${err}`);
    assert.match(err, new RegExp(tree), "names the non-commit object");
    assert.match(err, new RegExp(diverged), "names the diverged sha");
    assert.match(err, /cites deadbee/, "names the group-cited unknown sha");
    assert.equal(
      (err.match(/ticked chunk cites/g) ?? []).length,
      3,
      `exactly the 3 real citations fail, prose deadbee/feedback do not:\n${err}`,
    );
    assert.match(
      out,
      /closed chunks: 8 · citing a commit: 6 · verified: 3/,
      `summary counts the ratio:\n${out}`,
    );
  });
  console.log("  ✓ plan-check e2e: names bad shas, counts the ratio");
});

test("testPlanCheckShaClean", () => {
  withTempRepo((dir) => {
    const { good } = repoWithShas(dir);
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-t.md"),
      `# T\n\n## TL;DR\n- [x] chunk 1 — good (${good})\n- [ ] chunk 2 — next\n`,
    );
    const proc = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    assert.equal(proc.exitCode, 0, `clean plan must pass:\n${out}`);
    assert.match(out, /✅ clean/);
  });
  console.log("  ✓ plan-check e2e: clean plan passes");
});

// Kickoff in-process (no spawn): the planFile branch prints one closure line
// — warn on missing/diverged/absent sha, silent when the sha verifies.
function kickoffOutput(dir: string, planBody: string): string {
  mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
  const plan = join(dir, ".fapony", "plan", "PLAN-t.md");
  writeFileSync(plan, planBody);
  const prev = process.cwd();
  process.chdir(dir);
  try {
    initPlanStore(dir);
    return captureLogs(() => cmdPlanNext([plan]));
  } finally {
    process.chdir(prev);
  }
}

const planWith = (ticked: string): string =>
  `---\nkind: unit\n---\n\n# T\n\n## TL;DR\n${ticked}\n- [ ] chunk 9 — next\n`;

test("testKickoffClosureHint", () => {
  withTempRepo((dir) => {
    const { good, held, diverged, tree } = repoWithShas(dir);
    // Verified sha → silent.
    let out = kickoffOutput(dir, planWith(`- [x] chunk 8 — done (${good})`));
    assert.doesNotMatch(out, /⚠ chunk/, `verified sha stays silent:\n${out}`);
    assert.match(out, /chunk 9 — next/, "next chunk still shown");
    // No sha → warn.
    out = kickoffOutput(dir, planWith("- [x] chunk 8 — done, defer"));
    assert.match(
      out,
      /⚠ chunk 8 is ticked but cites no commit/,
      `sha-less chunk warns:\n${out}`,
    );
    // Non-commit object → warn.
    out = kickoffOutput(dir, planWith(`- [x] chunk 8 — done (${tree})`));
    assert.match(
      out,
      new RegExp(`⚠ chunk 8 is ticked but ${tree} is not in git`),
      `missing sha warns:\n${out}`,
    );
    // Held by another branch (a sibling worktree's tick) → silent.
    out = kickoffOutput(dir, planWith(`- [x] chunk 8 — done (${held})`));
    assert.doesNotMatch(out, /⚠ chunk/, `held sha stays silent:\n${out}`);
    // No ref holds it → warn.
    out = kickoffOutput(dir, planWith(`- [x] chunk 8 — done (${diverged})`));
    assert.match(
      out,
      new RegExp(`⚠ chunk 8 is ticked but ${diverged} is held by no branch`),
      `diverged sha warns:\n${out}`,
    );
    // The squash commit exists, only the tick is stale → the brief names the fix.
    assert.match(
      out,
      /held by no branch \(squashed, branch deleted\?\) — fix: fapony plan check --fix, or append the merged PR's `\(#N\)` to the tick/,
      `diverged warning ends with the command:\n${out}`,
    );
    // A PR number naming no default-branch commit reads as a PR number.
    out = kickoffOutput(dir, planWith("- [x] chunk 8 — done (#999)"));
    assert.match(
      out,
      /⚠ chunk 8 is ticked but \(#999\) names no single default-branch commit/,
      `unmerged PR number warns as a PR number:\n${out}`,
    );
    // …but not while a branch still holds the sha: the PR is just open.
    out = kickoffOutput(dir, planWith(`- [x] chunk 8 — done (${held}) (#999)`));
    assert.doesNotMatch(out, /⚠ chunk/, `open PR stays silent:\n${out}`);
  });
  console.log("  ✓ kickoff: closure hint warns once, silent when verified");
});

// --- Chunk 4: plan-check drift warns (W1 + W2) ---

import { collectDriftWarns } from "../src/plan/sweep.js";

// --- Chunk 3 (PLAN-plan-adopt): unadopted-doc lint ---

import { collectUnadoptedDocWarns } from "../src/plan/sweep.js";

test("testUnadoptedDocWarnFires", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // A stray handoff with no plan:handoff anchor anywhere in its text
    writeFileSync(
      join(dir, ".fapony/plan/handoff.md"),
      `# Handoff\n\nThe ops team wants a replay endpoint.\n`,
    );
    const warns = collectUnadoptedDocWarns([
      join(dir, ".fapony/plan/handoff.md"),
    ]);
    assert.equal(warns.length, 1, `stray doc must warn:\n${warns.join("\n")}`);
    assert.match(warns[0], /doc without adopted anchor/);
    assert.match(warns[0], /fapony plan adopt/);
  });
  console.log("  ✓ unadopted doc without its anchor → warn");
});

test("testUnadoptedDocWarnSlugMatchesAdopt", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // The warn must name the anchor `fapony plan adopt` would actually set —
    // punctuation slugified to `-`, not a bare lowercased basename.
    writeFileSync(
      join(dir, ".fapony/plan/Billing Handoff.md"),
      `# Handoff\n\nno anchor here\n`,
    );
    const warns = collectUnadoptedDocWarns([
      join(dir, ".fapony/plan/Billing Handoff.md"),
    ]);
    assert.equal(warns.length, 1, warns.join("\n"));
    assert.match(warns[0], /plan:billing-handoff\b/);
    assert.ok(!warns[0].includes("plan:billing handoff"));
  });
  console.log("  ✓ warn anchor slug matches adopt's slugify");
});

test("testUnadoptedDocWarnAdoptedSilent", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // The anchor is present — adopted (or at least tagged), no warn
    writeFileSync(
      join(dir, ".fapony/plan/handoff.md"),
      `# Handoff\n\nanchor: plan:handoff\n`,
    );
    // PLAN files never warn, anchor or not — they are already plans
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-x.md"),
      `---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- [ ] chunk 1 — next\n`,
    );
    const warns = collectUnadoptedDocWarns([
      join(dir, ".fapony/plan/handoff.md"),
      join(dir, ".fapony/plan/PLAN-x.md"),
    ]);
    assert.equal(warns.length, 0, `adopted doc must not warn:\n${warns}`);
  });
  console.log("  ✓ adopted doc + PLAN files → no warn");
});

test("testUnadoptedDocWarnE2E", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-clean.md"),
      `---\nkind: unit\n---\n\n# Clean\n\n> **Status:** 🚧 in-progress\n\n## TL;DR\n- [x] chunk 1 — done\n- [ ] chunk 2 — next\n`,
    );
    writeFileSync(
      join(dir, ".fapony/plan/handoff.md"),
      `# Handoff\n\nThe ops team wants a replay endpoint.\n`,
    );
    const proc = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    // Detect-only: warns print, exit stays 0
    const out = proc.stdout.toString();
    assert.equal(proc.exitCode, 0, `unadopted-doc warn must not fail:\n${out}`);
    assert.match(out, /drift warning\(s\)/, "prints in the warns section");
    assert.match(out, /handoff\.md/, "names the stray doc");
    assert.match(out, /fapony plan adopt/, "points at the adopt command");
  });
  console.log("  ✓ plan-check e2e: unadopted doc warns but doesn't block");
});

test("testDriftWarnW1NotStartedWithTicks", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // W1: header says "draft" but chunks are ticked
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-drift.md"),
      `---\nkind: unit\n---\n\n# Drift\n\n> **Status:** 🚧 draft\n\n## TL;DR\n- [x] chunk 1 — done\n- [ ] chunk 2 — next\n`,
    );
    const warns = collectDriftWarns([join(dir, ".fapony/plan/PLAN-drift.md")]);
    assert.equal(warns.length, 1, `W1 must fire:\n${warns.join("\n")}`);
    assert.match(warns[0], /status header says "🚧 draft"/);
    assert.match(warns[0], /1 chunk\(s\) are ticked/);
  });
  console.log("  ✓ W1: not-started header + ticked chunks → warn");
});

test("testDriftWarnW1InProgressNoWarn", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // in-progress with ticks = normal, must NOT warn
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-flight.md"),
      `---\nkind: unit\n---\n\n# Flight\n\n> **Status:** 🚧 in-progress\n\n## TL;DR\n- [x] chunk 1 — done\n- [ ] chunk 2 — next\n`,
    );
    const warns = collectDriftWarns([join(dir, ".fapony/plan/PLAN-flight.md")]);
    assert.equal(
      warns.length,
      0,
      `in-progress must not warn:\n${warns.join("\n")}`,
    );
  });
  console.log("  ✓ W1: in-progress header → no warn (false positive guard)");
});

test("testDriftWarnW2AllTickedNotShipped", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // W2: all chunks ticked but no shipped marker
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-done.md"),
      `---\nkind: unit\n---\n\n# Done\n\n> **Status:** 🚧 in-progress\n\n## TL;DR\n- [x] chunk 1 — done\n- [x] chunk 2 — done\n`,
    );
    const warns = collectDriftWarns([join(dir, ".fapony/plan/PLAN-done.md")]);
    assert.equal(warns.length, 1, `W2 must fire:\n${warns.join("\n")}`);
    assert.match(
      warns[0],
      /all 2 chunk\(s\) ticked but header never marked shipped/,
    );
  });
  console.log("  ✓ W2: all ticked + not shipped → warn");
});

test("testDriftWarnW2ShippedNoWarn", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // All ticked + shipped header = no warn
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-shipped.md"),
      `---\nkind: unit\n---\n\n# Shipped\n\n> ✅ **shipped 2026-09-23**\n\n## TL;DR\n- [x] chunk 1 — done\n- [x] chunk 2 — done\n`,
    );
    const warns = collectDriftWarns([
      join(dir, ".fapony/plan/PLAN-shipped.md"),
    ]);
    assert.equal(
      warns.length,
      0,
      `shipped must not warn:\n${warns.join("\n")}`,
    );
  });
  console.log("  ✓ W2: shipped header → no warn");
});

test("testDriftWarnBlockedSkipped", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    // status:blocked = not a drift target (has its own handling)
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-blocked.md"),
      `---\nkind: unit\nstatus: blocked\nblocked_by: PLAN-other.md\n---\n\n# Blocked\n\n## TL;DR\n- [x] chunk 1 — done\n`,
    );
    const warns = collectDriftWarns([
      join(dir, ".fapony/plan/PLAN-blocked.md"),
    ]);
    assert.equal(
      warns.length,
      0,
      `blocked plans must be skipped:\n${warns.join("\n")}`,
    );
  });
  console.log("  ✓ status:blocked plans are skipped by drift check");
});

test("testDriftWarnE2E", () => {
  withTempRepo((dir) => {
    mkdirSync(join(dir, ".fapony", "plan"), { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    // A plan with W1: draft + ticked
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-w1.md"),
      `---\nkind: unit\n---\n\n# W1\n\n> **Status:** draft\n\n## TL;DR\n- [x] chunk 1 — done\n- [ ] chunk 2 — next\n`,
    );
    // A clean plan
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-clean.md"),
      `---\nkind: unit\n---\n\n# Clean\n\n> **Status:** 🚧 in-progress\n\n## TL;DR\n- [x] chunk 1 — done\n- [ ] chunk 2 — next\n`,
    );
    const proc = Bun.spawnSync(["bun", FAPONY, "plan", "check"], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString();
    assert.equal(proc.exitCode, 0, `drift warns must not fail:\n${out}`);
    assert.match(out, /drift warning\(s\)/, "prints drift section");
    assert.match(out, /PLAN-w1\.md/, "names the drifted plan");
  });
  console.log("  ✓ plan-check e2e: drift warns appear but don't block");
});
