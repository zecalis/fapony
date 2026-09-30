import { test } from "bun:test";
// test/plan-ready.test.ts — fael-boundary chunk 4: move-to-done judges from
// evidence. All chunks ticked + verified on the default branch = ready without
// a ✅ header; --apply stamps it with the default branch's sha, not HEAD.
// A handoff of a shipped chunk is stale (close line, no block); an unticked
// chunk's handoff still blocks.

import assert from "node:assert";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withFakeFael, withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");
const git = (dir: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd: dir }).toString().trim();

const sweep = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(
    ["bun", FAPONY, "plan", "sweep", "PLAN-a.md", ...args],
    {
      cwd: dir,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
};

const plan = (dir: string, ticks: string[], header = "") => {
  mkdirSync(join(dir, ".fapony/plan"), { recursive: true });
  mkdirSync(join(dir, ".fapony/done"), { recursive: true });
  writeFileSync(
    join(dir, ".fapony/plan/PLAN-a.md"),
    `# A\n\n${header || "> **Status:** 🚧 in-progress · **Created:** 2026-09-30"}\n\n## TL;DR\n${ticks.join("\n")}\n`,
  );
};

// main holds `onMain`; HEAD sits on a side branch one commit ahead (`side`).
const repo = (dir: string): { onMain: string; side: string } => {
  const onMain = git(dir, "rev-parse --short=7 HEAD");
  git(dir, "switch -c side");
  writeFileSync(join(dir, "s.txt"), "s\n");
  git(dir, "add s.txt");
  git(dir, 'commit -m "side"');
  return { onMain, side: git(dir, "rev-parse --short=7 HEAD") };
};

test("testReadyByEvidenceStampsDefaultBranchSha", () => {
  withTempRepo((dir) => {
    const { onMain, side } = repo(dir);
    plan(dir, [
      `- [x] chunk 1 — a (${onMain})`,
      `- [x] chunk 2 — b (${onMain})`,
    ]);
    assert.match(sweep(dir).out, /ready to move/);
    const r = sweep(dir, "--apply");
    assert.equal(r.code, 0, r.err);
    const moved = readFileSync(join(dir, ".fapony/done/PLAN-a.md"), "utf8");
    assert.match(
      moved,
      new RegExp(
        `> ✅ \\*\\*shipped \\d{4}-\\d\\d-\\d\\d\\*\\* \\(${onMain}\\) · \\*\\*Created:\\*\\*`,
      ),
    );
    assert.ok(
      !moved.includes(side),
      "stamp is main's sha, not the worktree HEAD",
    );
  });
  console.log(
    "  ✓ ticked + verified on main → ready, --apply stamps main's sha",
  );
});

test("testNotReadyWhenTickOnlyOnSideBranchOrUnticked", () => {
  withTempRepo((dir) => {
    const { onMain, side } = repo(dir);
    plan(dir, [`- [x] chunk 1 — a (${side})`]);
    assert.notEqual(
      sweep(dir, "--apply").code,
      0,
      "side-branch tick is not on main",
    );
    plan(dir, [`- [x] chunk 1 — a (${onMain})`, "- [ ] chunk 2 — b"]);
    assert.notEqual(sweep(dir, "--apply").code, 0, "an unticked chunk blocks");
    plan(dir, ["- [x] chunk 1 — a"]);
    assert.notEqual(
      sweep(dir, "--apply").code,
      0,
      "a tick with no commit proves nothing",
    );
    assert.ok(!existsSync(join(dir, ".fapony/done/PLAN-a.md")));
  });
  console.log("  ✓ side-branch / unticked / uncited → not ready");
});

test("testStaleHandoffPrintsCloseLiveHandoffBlocks", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    const hdr = "> ✅ **shipped 2026-09-30** (abc1234)";
    plan(dir, [`- [x] chunk 1 — a (${onMain})`, "- [ ] chunk 2 — b"], hdr);
    const row = (id: string, n: number) => ({
      id,
      ts: "2026-09-30T00:00:00Z",
      kind: "note",
      text: "handoff",
      key: `plan:a:chunk-${n}`,
    });
    withFakeFael((setRows) => {
      setRows([row("h2", 2)]);
      assert.notEqual(
        sweep(dir, "--apply").code,
        0,
        "chunk 2 unticked → live → block",
      );
      setRows([row("h1", 1)]);
      const r = sweep(dir, "--apply");
      assert.equal(r.code, 0, r.err);
      assert.match(
        r.out,
        new RegExp(`fael close h1 "chunk 1 shipped ${onMain}"`),
      );
    });
  });
  console.log("  ✓ handoff of a ticked chunk → close line; unticked → blocks");
});

test("testStampCitesShippingCommitNotMainTip", () => {
  withTempRepo((dir) => {
    const base = git(dir, "branch --show-current");
    const { onMain } = repo(dir);
    git(dir, `switch ${base}`);
    git(dir, 'commit --allow-empty -m "later, unrelated"');
    const tip = git(dir, "rev-parse --short=7 HEAD");
    git(dir, "switch side");
    plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
    const dry = sweep(dir);
    assert.match(dry.out, /verified on/);
    assert.doesNotMatch(dry.out, /has a ✅ shipped header/);
    const r = sweep(dir, "--apply");
    assert.equal(r.code, 0, r.err);
    assert.match(
      r.out,
      new RegExp(`stamped ✅ shipped header \\(${onMain}\\)`),
    );
    const moved = readFileSync(join(dir, ".fapony/done/PLAN-a.md"), "utf8");
    assert.ok(
      !moved.includes(tip),
      "stamp is the shipping commit, not main's tip",
    );
  });
  console.log(
    "  ✓ stamp + log cite the newest ticked commit, dry run says why",
  );
});

test("testFinalChunkHandoffIsStaleOnceAllTicked", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    const hdr = "> ✅ **shipped 2026-09-30** (abc1234)";
    const row = {
      id: "h3",
      ts: "2026-09-30T00:00:00Z",
      kind: "note",
      text: "handoff",
      key: "plan:a:chunk-3",
    };
    withFakeFael((setRows) => {
      setRows([row]);
      plan(dir, [`- [x] chunk 1 — a (${onMain})`, "- [ ] chunk 2 — b"], hdr);
      assert.notEqual(sweep(dir, "--apply").code, 0, "chunk 2 still open");
      plan(
        dir,
        [`- [x] chunk 1 — a (${onMain})`, `- [x] chunk 2 — b (${onMain})`],
        hdr,
      );
      // listing from a subdirectory reads the plan by absolute path
      mkdirSync(join(dir, "sub"));
      const list = Bun.spawnSync(["bun", FAPONY, "plan", "sweep"], {
        cwd: join(dir, "sub"),
        env: process.env,
        stdout: "pipe",
      }).stdout.toString();
      assert.match(list, /PLAN-a\.md/);
      assert.doesNotMatch(list, /open handoff/);
      const r = sweep(dir, "--apply");
      assert.equal(r.code, 0, r.err);
      assert.match(
        r.out,
        new RegExp(`fael close h3 "chunk 2 shipped ${onMain}"`),
      );
    });
  });
  console.log("  ✓ chunk-<last+1> handoff is stale once every chunk ships");
});
