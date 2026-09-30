import { test } from "bun:test";
// test/plan-resolve.test.ts — chunk 3 (PLAN-fael-boundary): fapony finds its
// own plan/spec docs — one resolver, --files, spec link — without fael's
// anchor widening.
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePlan } from "../src/plan/resolve.js";
import { initPlanStore } from "../src/plan/store.js";
import { withFakeFael, withTempRepo } from "./helpers.js";

const FAPONY = join(import.meta.dir, "..", "fapony.ts");

const body = (title: string, fm = "", extra = ""): string =>
  `---\nkind: unit\n${fm}---\n\n# ${title}\n\n## TL;DR\n- [ ] chunk 1 — go\n${extra}`;

function fixture(dir: string): void {
  for (const d of ["plan", "done", "spec"])
    mkdirSync(join(dir, ".fapony", d), { recursive: true });
  const f = (p: string, s: string) => writeFileSync(join(dir, ".fapony", p), s);
  f(
    "plan/PLAN-fael-boundary.md",
    body(
      "Boundary",
      "spec: SPEC-fael-boundary.md\n",
      "touches src/plan/sweep.ts\n",
    ),
  );
  f("plan/PLAN-fael-other.md", body("Other"));
  f("plan/PLAN-nospec.md", body("NoSpec", "spec: SPEC-gone.md\n"));
  f(
    "done/PLAN-old.md",
    body("Old", "", "> ✅ **shipped 2026-09-01**\nsrc/plan/sweep.ts\n"),
  );
  f("spec/SPEC-fael-boundary.md", "# SPEC — boundary\nsrc/plan/sweep.ts\n");
}

const cli = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["bun", FAPONY, "plan", ...args], {
    cwd: dir,
    env: process.env, // the fake fael on the live PATH
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: p.exitCode,
    out: p.stdout.toString(),
    err: p.stderr.toString(),
  };
};

test("testResolvePlanSpellings", () => {
  withTempRepo((dir) => {
    fixture(dir);
    initPlanStore(dir);
    const file = (arg: string) => {
      const r = resolvePlan(arg);
      return r.ok ? r.file.slice(r.file.indexOf(".fapony")) : r.candidates;
    };
    const want = ".fapony/plan/PLAN-fael-boundary.md";
    for (const arg of [
      "PLAN-fael-boundary.md",
      "PLAN-fael-boundary",
      "fael-boundary",
      "FAEL-BOUNDARY",
      "plan:fael-boundary",
      ".fapony/plan/PLAN-fael-boundary.md",
      "boundary", // unique substring
    ])
      assert.equal(file(arg), want, arg);
    // done/ is searched too; plan/ wins on an exact name
    assert.equal(file("old"), ".fapony/done/PLAN-old.md");
    const c = resolvePlan("plan:fael-boundary:chunk-3");
    assert.ok(c.ok && c.chunk === "3");
    // ambiguous → candidates, no pick; unknown → empty
    assert.deepEqual(file("fael"), [
      "PLAN-fael-boundary.md",
      "PLAN-fael-other.md",
    ]);
    assert.deepEqual(file("nope"), []);
  });
});

test("testPlanCliAmbiguousExits1AndSpecLink", () => {
  withTempRepo((dir) => {
    fixture(dir);
    const amb = cli(dir, "fael");
    assert.equal(amb.code, 1);
    assert.match(amb.err, /matches 2 plans/);
    assert.match(amb.err, /PLAN-fael-other\.md/);

    const ok = cli(dir, "boundary");
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /spec: \.fapony\/spec\/SPEC-fael-boundary\.md/);

    const gone = cli(dir, "nospec");
    assert.match(
      gone.out,
      /⚠ spec SPEC-gone\.md is named in the frontmatter but not in/,
    );
  });
});

test("testPlanFilesFlag", () => {
  withTempRepo((dir) => {
    fixture(dir);
    const r = cli(dir, "--files", "src/plan/sweep.ts");
    assert.equal(r.code, 0, r.err);
    const order = [
      "plan PLAN-fael-boundary.md",
      "done PLAN-old.md — Old (shipped 2026-09-01)",
      "spec SPEC-fael-boundary.md",
    ];
    let at = -1;
    for (const line of order) {
      const i = r.out.indexOf(line);
      assert.ok(i > at, `${line} in order:\n${r.out}`);
      at = i;
    }
    assert.match(cli(dir, "--files", "src/never.ts").out, /\(none\)/);
  });
});

// The fail example: fael's kickoff widening off ([anchor] prefixes = []) must
// not hide a plan's rows — fapony matches by key/files itself.
test("testPlanRowsSurviveEmptyAnchorPrefixes", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      fixture(dir);
      mkdirSync(join(dir, ".fael"), { recursive: true });
      writeFileSync(
        join(dir, ".fael/config.toml"),
        "[anchor]\nprefixes = []\n",
      );
      setRows([
        {
          id: "n1",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "handoff for boundary",
          files: ["plan:fael-boundary"],
          key: "plan:fael-boundary:chunk-2",
        },
      ]);
      for (const arg of [
        "PLAN-fael-boundary.md",
        "plan:fael-boundary",
        "boundary",
      ])
        assert.match(cli(dir, arg).out, /\[n1\]/, arg);
    }),
  );
});

test("testSweepUsesTheSameResolver", () => {
  withTempRepo((dir) => {
    fixture(dir);
    const amb = cli(dir, "sweep", "fael");
    assert.equal(amb.code, 1);
    assert.match(amb.err, /matches 2 plans/);
    // a bare name resolves (dry run, no header → the "check" message, exit 0)
    const dry = cli(dir, "sweep", "nospec");
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /no ✅ shipped header/);
  });
});
