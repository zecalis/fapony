import { test } from "bun:test";
// test/plan-ready.test.ts — fael-boundary chunk 4: move-to-done judges from
// evidence. All chunks ticked + verified on the default branch = ready without
// a ✅ header; --apply stamps it with the default branch's sha, not HEAD.
// A handoff of a shipped chunk is stale (close line, no block); an unticked
// chunk's handoff still blocks.

import assert from "node:assert";
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

test("testHandoffKeyIsStaleOnceAllTicked", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    const hdr = "> ✅ **shipped 2026-09-30** (abc1234)";
    const row = {
      id: "h9",
      ts: "2026-09-30T00:00:00Z",
      kind: "note",
      text: "handoff",
      key: "plan:a:handoff",
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
      const r = sweep(dir, "--apply");
      assert.equal(r.code, 0, r.err);
      assert.match(
        r.out,
        new RegExp(`fael close h9 "chunk 2 shipped ${onMain}"`),
      );
    });
  });
  console.log("  ✓ plan:<name>:handoff is live until every chunk ships");
});

test("testHandoffKeyIsStaleWithNonNumericLabels", () => {
  // F1 / u0 / m1 carry no number: "last" is the last chunk in file order
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    const hdr = "> ✅ **shipped 2026-09-30** (abc1234)";
    const row = (id: string, key: string) => ({
      id,
      ts: "2026-09-30T00:00:00Z",
      kind: "note",
      text: "handoff",
      key,
    });
    withFakeFael((setRows) => {
      setRows([row("hk", "plan:a:handoff"), row("hc", "plan:a:chunk-m2")]);
      plan(dir, [`- [x] chunk F1 — a (${onMain})`, "- [ ] chunk u0 — b"], hdr);
      assert.notEqual(sweep(dir, "--apply").code, 0, "chunk u0 still open");
      plan(
        dir,
        [`- [x] chunk F1 — a (${onMain})`, `- [x] chunk m1 — b (${onMain})`],
        hdr,
      );
      const r = sweep(dir, "--apply");
      assert.equal(r.code, 0, r.err);
      assert.match(
        r.out,
        new RegExp(`fael close hk "chunk m1 shipped ${onMain}"`),
      );
      assert.match(
        r.out,
        new RegExp(`fael close hc "chunk m1 shipped ${onMain}"`),
      );
    });
  });
  console.log("  ✓ handoff of a plan labelled F1/u0/m1 is stale once all ship");
});

const run = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["bun", FAPONY, "plan", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
};

test("testApplyMovesSymlinkedIgnoredFaponyAndStampsAfter", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    // this repo's own layout: .fapony/ gitignored + a symlink out of the repo
    const store = mkdtempSync(join(tmpdir(), "fapony-store-"));
    try {
      writeFileSync(join(dir, ".gitignore"), ".fapony\n");
      symlinkSync(store, join(dir, ".fapony"));
      plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
      const r = sweep(dir, "--apply");
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /plain rename/);
      assert.ok(!existsSync(join(store, "plan/PLAN-a.md")));
      assert.match(
        readFileSync(join(store, "done/PLAN-a.md"), "utf8"),
        new RegExp(`✅ \\*\\*shipped [^*]+\\*\\* \\(${onMain}\\)`),
      );
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  });
  console.log(
    "  ✓ symlinked + gitignored .fapony/ → plain rename, stamp on done/",
  );
});

test("testApplyPathFormRewritesInboundLinks", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
    writeFileSync(
      join(dir, ".fapony/plan/PLAN-b.md"),
      "# B\n\n[a](PLAN-a.md)\n",
    );
    const r = run(dir, "sweep", ".fapony/plan/PLAN-a.md", "--apply");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /links rewritten: \d+ own, 1 inbound/);
    assert.match(
      readFileSync(join(dir, ".fapony/plan/PLAN-b.md"), "utf8"),
      /\[a\]\(\.\.\/done\/PLAN-a\.md\)/,
    );
  });
  console.log("  ✓ a path-form target rewrites inbound links too");
});

test("testTemplateCommentsDoNotHideBlockedOrTracker", () => {
  withTempRepo((dir) => {
    const { onMain } = repo(dir);
    for (const fm of [
      "status: blocked   # active | blocked | superseded",
      "kind: tracker     # `tracker` for a checklist that never finishes",
    ]) {
      plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
      const f = join(dir, ".fapony/plan/PLAN-a.md");
      writeFileSync(f, `---\n${fm}\n---\n${readFileSync(f, "utf8")}`);
      assert.doesNotMatch(sweep(dir).out, /ready to move/, fm);
    }
  });
  console.log(
    "  ✓ inline # comments in frontmatter keep blocked/tracker plans put",
  );
});

test("testStampIgnoresTickOrderAcrossMerges", () => {
  withTempRepo((dir) => {
    const base = git(dir, "branch --show-current");
    const branch = (name: string): string => {
      git(dir, `switch -c ${name} ${base}`);
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
      git(dir, `add ${name}.txt`);
      git(dir, `commit -m "${name}"`);
      return git(dir, "rev-parse --short=7 HEAD");
    };
    const x = branch("x");
    const y = branch("y");
    git(dir, `switch ${base}`);
    git(dir, 'merge --no-ff x -m "merge x"');
    git(dir, 'merge --no-ff y -m "merge y"');
    const stamps = [
      [x, y],
      [y, x],
    ].map(([a, b]) => {
      plan(dir, [`- [x] chunk 1 — a (${a})`, `- [x] chunk 2 — b (${b})`]);
      return /stamps ✅ shipped (\w+)/.exec(sweep(dir).out)?.[1];
    });
    assert.ok(stamps[0]);
    assert.equal(stamps[0], stamps[1]);
  });
  console.log("  ✓ stamp sha does not depend on tick order in merge history");
});

test("testDefaultBranchNamedLikeAFile", () => {
  withTempRepo((dir) => {
    const base = git(dir, "branch --show-current");
    const onMain = git(dir, "rev-parse --short=7 HEAD");
    writeFileSync(join(dir, base), "a file named like the branch\n");
    plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
    assert.match(sweep(dir).out, /ready to move/);
  });
  console.log("  ✓ a root file named main/master does not break evidence");
});

test("testUnbornHeadStillSeesBranches", () => {
  withTempRepo((dir) => {
    const onMain = git(dir, "rev-parse --short=7 HEAD");
    git(dir, "switch --orphan fresh");
    plan(dir, [`- [x] chunk 1 — a (${onMain})`]);
    assert.doesNotMatch(run(dir, "check").out, /no branch holds/);
  });
  console.log("  ✓ an unborn HEAD still sees ticks other branches hold");
});
