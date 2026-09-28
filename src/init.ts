// src/init.ts — scaffold fapony project structure at a target path.
// Creates .fapony/plan/, .fapony/done/, .fapony/spec/ + evidence.json. Memory
// (decisions, bugs, notes) is fael's — `fael install`, not scaffolded here.
// state.db stays in ~/.config/fapony/ by design (security boundary — see db.ts),
// never inside the worktree where agents have full write access.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { seedConventionsFile } from "./conventions-seed.js";
import {
  type Config,
  doneDir,
  evidenceFile,
  FAPONY_DIR,
  planDir,
  specDir,
} from "./core/config.js";
import { isAffirmative } from "./util.js";

const FAPONY_README = `# .fapony/ — fapony project dir (plans, specs, conventions)
# plan/ holds live plans, done/ the shipped ones, spec/ every spec (specs are a
# reference library — they are not archived). done/ sits beside plan/ rather
# than inside it so archiving never changes a file's depth, and the relative
# links inside it keep working.
# memory (decisions, bugs, notes) lives in fael; the evidence allowlist is
# .fapony/evidence.json.
#
# evidence.json SHOULD be committed — it is the shared allowlist that decides
# which commands 'fapony report' may run, and the team must run the same
# set. If your .gitignore ignores .fapony/ wholesale, re-include it:
#   **/.fapony/*
#   !**/.fapony/evidence.json
# (dir before file — git cannot re-include a file inside an excluded dir;
# patterns with a mid-string slash anchor at the repo root, so keep the **/).
#
# state.db is NOT here by design — it lives in ~/.config/fapony/ where agents
# running in this worktree cannot rewrite run state / audit trail.
#
# Ask your agent for the plan picture instead of listing these by hand:
#   run "fapony plan" — every active plan, its progress and next chunk
`;

// Static template — deliberately NOT derived from the repo (reading package.json
// etc. to guess commands would produce a fake allowlist, which is worse than none).
// `fapony report` only runs commands listed here; agent-proposed commands
// outside the allowlist are reported, never executed.
const EVIDENCE_JSON = `{
  "commands": [
    { "name": "test", "cmd": "echo 'edit me: the real test command'", "timeout_ms": 30000 },
    { "name": "typecheck", "cmd": "echo 'edit me: the real typecheck command'", "timeout_ms": 30000 }
  ]
}
`;

// Rules snippet for the user's own agent-rules file: how to run a plan chunk
// by chunk. The file is the user's, so init asks before writing it (rule 6c)
// and never writes it twice (RULES_MARKER). Memory rules are fael's own skill.
const RULES_MARKER = "## Plans: .fapony/plan (fapony)";
const RULES_SNIPPET = () => `${RULES_MARKER}

Plans live in .fapony/plan/ (shipped ones in .fapony/done/). Memory — decisions,
bugs, notes — lives in fael (\`fael add\` / \`fael find\`), not in .fapony/.

A long plan run in one unbroken session accumulates context with nothing to shrink
it — token cost and coherence both degrade with session length, not with amount of
work done. Cut at chunk boundaries instead:

Finish a chunk, before starting the next:
1. Tick its checkbox + stamp the TL;DR, citing the commit sha
2. Commit — separate from other chunks
3. \`fael add note "what the next chunk needs" --files f1,f2,plan:x --key plan:x:chunk-<N+1>\`
   — \`plan:x\` (for PLAN-x.md, lowercase) is what finds the note again; not the
   plan path, which moves when the plan is archived into done/
4. Stop. Do not continue to the next chunk in the same session unless told to.

Next chunk, new session — open with \`fapony plan PLAN-x.md\` (unchecked chunks +
the notes left for it) instead of carrying the old transcript forward.
\`fapony plan\` alone lists every active plan; ship one with
\`fapony plan sweep PLAN-x.md --apply\` (moves it to done/, fixes the links).`;

export function initProject(targetPath: string, config?: Config): void {
  // Create target root
  mkdirSync(targetPath, { recursive: true });

  // --- .fapony/ marker ---
  const faponyDir = join(targetPath, FAPONY_DIR);
  if (existsSync(faponyDir)) {
    throw new Error(
      `${faponyDir} already exists — delete it first if you want a fresh scaffold.`,
    );
  }
  mkdirSync(faponyDir, { recursive: true });
  writeFileSync(join(faponyDir, "README"), FAPONY_README);

  // --- evidence.json (verification_report allowlist — see src/mcp/evidence.ts) ---
  const evidencePath = join(targetPath, evidenceFile(config));
  if (existsSync(evidencePath)) {
    throw new Error(`${evidencePath} already exists — not overwriting.`);
  }
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, EVIDENCE_JSON);

  // --- plan/ spec/ — all under .fapony/ ---
  const planDirAbs = join(targetPath, planDir());
  if (existsSync(planDirAbs)) {
    throw new Error(`${planDirAbs} already exists — not overwriting.`);
  }
  mkdirSync(planDirAbs, { recursive: true });

  // --- done/ (archive, sibling of plan/) ---
  const doneDirAbs = join(targetPath, doneDir(config));
  if (existsSync(doneDirAbs)) {
    throw new Error(`${doneDirAbs} already exists — not overwriting.`);
  }
  mkdirSync(doneDirAbs, { recursive: true });

  // --- spec/ ---
  const specDirAbs = join(targetPath, specDir());
  if (existsSync(specDirAbs)) {
    throw new Error(`${specDirAbs} already exists — not overwriting.`);
  }
  mkdirSync(specDirAbs, { recursive: true });

  console.log(`scaffolded ${targetPath}/`);
  console.log(`  .fapony/         — project dir (plans, specs, evidence)`);
  console.log(`  ${planDir()}/    — live plan files`);
  console.log(`  ${doneDir(config)}/    — shipped plans (archive)`);
  console.log(`  ${specDir()}/    — spec files`);
  console.log(
    `  ${evidenceFile(config)}    — allowlist for 'fapony report' (edit the cmds!)`,
  );
  console.log(`\nNext: add "${targetPath}" to fapony.config.json worktrees`);
  console.log(
    `\nPlans are only run chunk by chunk if the rules your agent already reads say\nso — these go into CLAUDE.md / AGENTS.md next:\n`,
  );
  console.log(RULES_SNIPPET());
}

const AGENT_RULE_FILES = ["CLAUDE.md", "AGENTS.md"];

/** Which rules files init would touch: existing ones lacking the rules, or create. */
export function rulesTargets(targetPath: string): {
  create: boolean;
  append: string[];
} {
  // one real file per entry: AGENTS.md -> CLAUDE.md symlinks are common, and
  // appending through both names wrote the rules twice (wt-falsify 2026-09-24)
  const seen = new Set<string>();
  const found = AGENT_RULE_FILES.map((f) => join(targetPath, f)).filter((f) => {
    if (!existsSync(f)) return false;
    const real = realpathSync(f);
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
  const has = (f: string) => readFileSync(f, "utf-8").includes(RULES_MARKER);
  const agents = join(targetPath, "AGENTS.md");
  // a CLAUDE.md that imports a rules-carrying AGENTS.md already has them
  const covered = (f: string) =>
    has(f) ||
    (/^@AGENTS\.md\s*$/m.test(readFileSync(f, "utf-8")) &&
      existsSync(agents) &&
      has(agents));
  return {
    create: found.length === 0,
    append: found.filter((f) => !covered(f)),
  };
}

/**
 * Write the plan rules into the agent-rules files. No file yet = AGENTS.md
 * (read by OpenCode/Codex/Cursor) + a CLAUDE.md that imports it, so the rules
 * exist once. Files that already carry the rules are left alone.
 */
export function writeRules(targetPath: string): void {
  const { create, append } = rulesTargets(targetPath);
  if (create) {
    writeFileSync(join(targetPath, "AGENTS.md"), `${RULES_SNIPPET()}\n`);
    writeFileSync(join(targetPath, "CLAUDE.md"), "@AGENTS.md\n");
    console.log("  + AGENTS.md (plan rules) · CLAUDE.md → @AGENTS.md");
    return;
  }
  for (const f of append) {
    const body = readFileSync(f, "utf-8");
    appendFileSync(
      f,
      `${body.endsWith("\n") ? "\n" : "\n\n"}${RULES_SNIPPET()}\n`,
    );
    console.log(`  appended plan rules to ${relative(targetPath, f)}`);
  }
}

export async function cmdInit(args: string[]): Promise<void> {
  const rulesOnly = args.includes("--rules");
  const yes = args.includes("--yes");
  const targetPath = args.find((a) => !a.startsWith("--"));
  if (!targetPath) {
    console.error("usage: fapony init <path> [--rules] [--yes]");
    console.error(
      "  --rules  only write the plan rules into CLAUDE.md / AGENTS.md (repo already set up)",
    );
    console.error("  --yes    write them without asking");
    process.exit(1);
  }
  if (!rulesOnly) {
    try {
      initProject(targetPath);
    } catch (e) {
      console.error((e as Error).message);
      process.exit(1);
    }

    // --- conventions.json fill-signal (PLAN-convention-debt chunk 2) ---
    // eslint no-restricted-* rows carry their checker; the wrapper detector adds
    // live-migration candidates. Nothing derivable = empty file, never an error.
    const seed = await seedConventionsFile(targetPath);
    if (seed.kept) {
      console.log(
        `  ${relative(targetPath, seed.file)} — already exists, left untouched`,
      );
    } else {
      console.log(
        `  ${relative(targetPath, seed.file)} — ${seed.eslintRows} from eslint, ${seed.wrapperRows} from wrappers`,
      );
      console.log(
        `    'fapony debt' reads it; commit it (!**/.fapony/conventions.json in .gitignore)`,
      );
    }
    for (const s of seed.skipped) console.log(`    ⚠ eslint config ${s}`);
  }

  const { create, append } = rulesTargets(targetPath);
  if (!create && append.length === 0) {
    console.log("  plan rules already in the agent-rules file");
    return;
  }
  if (!yes) {
    const what = create
      ? "Create AGENTS.md with the plan rules (+ CLAUDE.md → @AGENTS.md)"
      : `Append the plan rules to ${append.map((f) => relative(targetPath, f)).join(" and ")}`;
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const answer = await new Promise<string>((resolve) => {
      rl.question(`\n${what}? [y/N] `, (a) => {
        rl.close();
        resolve(a.trim());
      });
    });
    if (!isAffirmative(answer)) return;
  }
  writeRules(targetPath);
}
