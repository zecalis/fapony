import { test } from "bun:test";
// test/plan-next.test.ts — `fapony plan [<PLAN.md>]`
import assert from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdPlanNext } from "../src/plan/next.js";
import { initPlanStore } from "../src/plan/store.js";
import { chunkLabel, openRowsFor } from "../src/plan/sweep.js";
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

const plan = (title: string, fm: string, ticks: string): string =>
  `---\nkind: unit\n${fm}---\n\n# ${title}\n\n## TL;DR\n${ticks}\n`;

function run(dir: string, args: string[]): string {
  const prev = process.cwd();
  process.chdir(dir);
  try {
    initPlanStore(dir);
    return captureLogs(() => cmdPlanNext(args));
  } finally {
    process.chdir(prev);
  }
}

test("testPlanListsActivePlansPriorityFirst", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-a.md"),
      plan("A", "", "- [x] chunk 1 — x\n- [ ] chunk 2 — do a"),
    );
    writeFileSync(
      join(p, "PLAN-b.md"),
      plan("B", "priority: high\n", "- [ ] chunk 1 — do b"),
    );
    writeFileSync(join(p, "PLAN-c.md"), "# C\n> ✅ **shipped 2026-09-01**\n");
    const out = run(dir, []);
    assert.ok(out.indexOf("PLAN-b.md") < out.indexOf("PLAN-a.md"), out);
    assert.match(out, /PLAN-a\.md — 1\/2 chunks\n {2}next: chunk 2 — do a/);
    assert.match(
      out,
      /shipped but not archived into done\/ \(1\)\n- PLAN-c\.md/,
    );
  });
});

test("testPlanShowsFaelHandoffRows", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "PLAN-x.md"), plan("X", "", "- [ ] chunk 1 — go"));
      setRows([
        {
          id: "h1",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "chunk 1 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:handoff",
        },
        {
          id: "n1",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "a plain note about the plan",
          files: ["src/a.ts", ".fapony/plan/PLAN-x.md"],
        },
        // imported rows carry the plan as spec only
        {
          id: "n2",
          ts: "2026-09-24T00:00:00Z",
          kind: "decision",
          text: "old spec-only row",
          spec: ".fapony/plan/PLAN-x.md",
        },
        {
          id: "n3",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "other plan",
          files: [".fapony/plan/PLAN-y.md"],
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.match(out, /## next\n- \[ \] chunk 1 — go/);
      // only the handoff is printed; the rest is a count that points at fael
      assert.match(
        out,
        /## handoff\n- \S+ note \[h1\] plan:x:handoff chunk 1 must know Y\n\(\+2 open rows about this plan — fael kickoff plan:x\)/,
      );
      assert.ok(!out.includes("plain note"), out);
      assert.ok(!out.includes("old spec-only row"), out);
      assert.ok(!out.includes("other plan"), out);
    }),
  );
});

test("testOpenRowsForMatchesPathAnchorAndKey", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-Cal.md"),
        plan("Cal", "", "- [ ] chunk 1 — go"),
      );
      setRows([
        {
          id: "a",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by path",
          files: ["src/a.ts", ".fapony/plan/PLAN-Cal.md"],
        },
        {
          id: "b",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by anchor",
          files: ["src/a.ts", "plan:cal"],
        },
        {
          id: "c",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "by key",
          files: ["src/b.ts"],
          key: "plan:cal:chunk-2",
        },
        {
          id: "d",
          ts: "2026-09-25T00:00:00Z",
          kind: "decision",
          text: "bare key",
          key: "plan:cal",
        },
        // near misses: another plan whose name shares a prefix
        {
          id: "e",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "not mine anchor",
          files: ["plan:calendar"],
        },
        {
          id: "f",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "not mine key",
          key: "plan:calendar:chunk-1",
        },
      ]);
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const ids = openRowsFor(join(p, "PLAN-Cal.md")).map((r) => r.id);
        assert.deepStrictEqual(ids.sort(), ["a", "b", "c", "d"]);
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testOpenRowsForSurvivesMoveToDone", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const d = join(dir, ".fapony", "done");
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "PLAN-x.md"), "# X\n> ✅ **shipped 2026-09-01**\n");
      setRows([
        // written while the plan still lived in plan/
        {
          id: "a",
          ts: "2026-09-25T00:00:00Z",
          kind: "issue",
          text: "old path",
          files: [".fapony/plan/PLAN-x.md"],
        },
        {
          id: "b",
          ts: "2026-09-25T00:00:00Z",
          kind: "issue",
          text: "anchor",
          files: ["plan:x"],
        },
        {
          id: "c",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "key",
          key: "plan:x:chunk-3",
        },
      ]);
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const ids = openRowsFor(join(d, "PLAN-x.md")).map((r) => r.id);
        assert.deepStrictEqual(ids.sort(), ["a", "b", "c"]);
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testPlanShowsNextChunkRowsFirst", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan(
          "X",
          "",
          "- [x] chunk 1 — done\n- [ ] chunk 2 — next\n- [ ] chunk 3 — later",
        ),
      );
      setRows([
        {
          id: "new",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "newest, other chunk",
          files: ["plan:x"],
          key: "plan:x:chunk-3",
        },
        {
          id: "hand",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "chunk 2 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:chunk-2",
        },
        {
          id: "old",
          ts: "2026-09-25T00:00:00Z",
          kind: "note",
          text: "path row",
          files: [".fapony/plan/PLAN-x.md"],
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      // legacy chunk-N rows are handoffs, the next chunk's leads; the path row
      // is only counted
      assert.match(
        out,
        /## handoff\n- \S+ note \[hand\] plan:x:chunk-2 chunk 2 must know Y\n- \S+ note \[new\] plan:x:chunk-3 [^\n]*\n\(\+1 open rows about this plan/,
      );
      assert.ok(!out.includes("[old]"), out);
    }),
  );
});

test("testPlanHandoffKeyLeads", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan("X", "", "- [x] chunk 1 — done\n- [ ] chunk 2 — next"),
      );
      setRows([
        {
          id: "new",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "newest, not a handoff",
          files: ["plan:x"],
        },
        {
          id: "hand",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "chunk 2 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:handoff",
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.match(
        out,
        /## handoff\n- \S+ note \[hand\] plan:x:handoff chunk 2 must know Y\n\(\+1 open rows about this plan/,
      );
      assert.ok(!out.includes("[new]"), out);
    }),
  );
});

test("testPlanNextChunkLeadsWhenTheLabelIsBold", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan("X", "", "- [x] **chunk 1** — done\n- [ ] **chunk 2** — next"),
      );
      setRows([
        {
          id: "new",
          ts: "2026-09-26T00:00:00Z",
          kind: "note",
          text: "newest, another chunk",
          files: ["plan:x"],
          key: "plan:x:chunk-3",
        },
        {
          id: "hand",
          ts: "2026-09-24T00:00:00Z",
          kind: "note",
          text: "chunk 2 must know Y",
          files: ["src/a.ts", "plan:x"],
          key: "plan:x:chunk-2",
        },
      ]);
      const out = run(dir, ["PLAN-x"]);
      assert.ok(out.indexOf("[hand]") < out.indexOf("[new]"), out);
    }),
  );
});

test("testPlanCountsRowsBeyondTheHandoffLimitAndPointsAtKickoff", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, "PLAN-x.md"), plan("X", "", "- [ ] chunk 1 — go"));
      setRows(
        [1, 2, 3, 4, 5, 6].map((i) => ({
          id: `r${i}`,
          ts: `2026-09-2${i}T00:00:00Z`,
          kind: "note",
          text: `row ${i}`,
          files: ["src/a.ts"],
          key: `plan:x:chunk-${i}`,
        })),
      );
      const out = run(dir, ["PLAN-x"]);
      assert.equal((out.match(/^- \S+ note \[r/gm) ?? []).length, 5, out);
      assert.match(
        out,
        /\(\+1 open rows about this plan — fael kickoff plan:x\)/,
      );
    }),
  );
});

// The brief is sized for one chunk: next in full, the rest clipped, the rules
// printed live — a PLAN file never has to carry them.
test("testPlanBriefNextInFullLaterClippedRulesPrinted", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    const long = `${"word ".repeat(80)}END`;
    writeFileSync(
      join(p, "PLAN-x.md"),
      plan(
        "X",
        "",
        `- [ ] chunk 1 — first ${long}\n- [ ] chunk 2 — second ${long}\n- [ ] chunk 3 — third ${long}`,
      ),
    );
    const out = run(dir, ["PLAN-x"]);
    assert.match(
      out,
      new RegExp(`## next\\n- \\[ \\] chunk 1 — first ${long}\\n`),
    );
    assert.match(
      out,
      /## later \(2\)\n- chunk 2 — second [^\n]*…\n- chunk 3 — third [^\n]*…\n/,
    );
    const later = out.split("## later (2)\n")[1].split("\n");
    assert.ok(
      later[0].length <= 122 && later[1].length <= 122,
      later.join("|"),
    );
    assert.ok(
      !out.includes(`chunk 2 — second ${long}`),
      "later is not in full",
    );
    // rules come from the command, anchored to this plan
    assert.match(
      out,
      /## closing\n- batching: one session = one branch = one squash-merged PR, one commit per chunk · add the next chunk only while the PR stays reviewable/,
    );
    assert.match(out, /--files <f1,f2>,plan:x --key plan:x:handoff/);
    // nothing left to do → no rules to print
    writeFileSync(
      join(p, "PLAN-y.md"),
      plan("Y", "", "- [x] chunk 1 — done (abc1234)"),
    );
    assert.doesNotMatch(run(dir, ["PLAN-y"]), /## closing/);
  });
});

test("testPlanBriefLaterChunksAreHeadlines", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-x.md"),
      plan(
        "X",
        "",
        [
          "- [ ] chunk 1 — go: all of this stays (in full) · every word",
          "- [ ] **chunk 2 — LINE webhook**: login via LIFF · more",
          "- [ ] chunk 3 — receipts (substitute) + sign",
          "- [ ] chunk 4 — short",
        ].join("\n"),
      ),
    );
    const out = run(dir, ["PLAN-x"]);
    assert.match(
      out,
      /## next\n- \[ \] chunk 1 — go: all of this stays \(in full\) · every word\n/,
    );
    assert.match(
      out,
      /## later \(3\)\n- chunk 2 — LINE webhook …\n- chunk 3 — receipts …\n- chunk 4 — short\n/,
    );
  });
});

test("testPlanBriefPicksAnotherChunkByLabel", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-x.md"),
      plan(
        "X",
        "",
        "- [ ] **chunk F3 — base**\n- [ ] chunk 3b — line\n- [ ] u0 — spike",
      ),
    );
    assert.match(
      run(dir, ["plan:x:chunk-3b"]),
      /## next\n- \[ \] chunk 3b — line\n\n## later \(2\)\n- chunk F3 — base\n- u0 — spike/,
    );
    assert.match(run(dir, ["plan:x:chunk-U0"]), /## next\n- \[ \] u0 — spike/);
    // unknown label → the first unchecked chunk, as without a label
    assert.match(run(dir, ["plan:x:chunk-9"]), /## next\n- \[ \] \*\*chunk F3/);
  });
});

test("testChunkLabelReadsRealLabels", () => {
  const cases: [string, string | null][] = [
    ["- [ ] chunk 2 — x", "2"],
    ["- [ ] **chunk 2** — x", "2"],
    ["chunk-2", "2"],
    ["- [ ] **chunk F3 — base**: x", "F3"],
    ["- [x] chunk 3b — line", "3b"],
    ["- [ ] F3 — base", "F3"],
    ["u0 — spike", "u0"],
    ["- [x] m1 — money (abc1234)", "m1"],
    ["- [ ] D2 – en dash", "D2"],
    ["- [ ] chunk ten — prose, no label", null],
    ["- [x] done, defer", null],
    ["- [ ] handoff: the mem note — this box", null],
  ];
  for (const [line, want] of cases) assert.equal(chunkLabel(line), want, line);
});

test("testClosureHintNeverSaysChunkLatest", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    for (const tick of ["- [x] F3 — done", "- [x] u0 — done", "- [x] did it"]) {
      writeFileSync(
        join(p, "PLAN-x.md"),
        plan("X", "", `${tick}\n- [ ] F4 — next`),
      );
      const out = run(dir, ["PLAN-x"]);
      assert.doesNotMatch(out, /latest/, out);
      assert.match(
        out,
        /⚠ (chunk (F3|u0) is ticked but |last tick: )cites no commit/,
        out,
      );
    }
  });
});

// One owner for the rule text: seed, adopt and init point at `fapony plan`.
test("testChunkRulesTextLivesInOneSourceFile", () => {
  const src = join(import.meta.dir, "..", "src");
  const hits = [...new Bun.Glob("**/*.ts").scanSync(src)].filter((f) =>
    readFileSync(join(src, f), "utf8").includes("one squash-merged PR"),
  );
  assert.deepStrictEqual(hits, ["plan/next.ts"]);
});

test("testPlanBriefPointsAtTheSpecSectionsTheChunkCites", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    mkdirSync(join(dir, ".fapony", "spec"), { recursive: true });
    const spec = [
      "# SPEC-x",
      "## §1 One",
      "a",
      "### §1.1 Sub",
      "b",
      "```",
      "## §9 inside a fence",
      "```",
      "## 2. Two",
      "c",
      "d",
      "",
      "## 3.1 Three-one",
      "e",
      "## §12 Twelve",
      "f",
      "",
    ];
    writeFileSync(join(dir, ".fapony/spec/SPEC-x.md"), spec.join("\n"));
    const at = (h: string) => spec.indexOf(h) + 1;
    writeFileSync(
      join(p, "PLAN-x.md"),
      plan(
        "X",
        "spec: SPEC-x.md\n",
        "- [ ] chunk 1 — do it (SPEC §2, §1.1, §3, §9; ARCHITECTURE §1; SPEC-other §12)",
      ),
    );
    const out = run(dir, ["PLAN-x.md"]);
    assert.ok(
      out.includes(`§2 → SPEC-x.md:${at("## 2. Two")}-${at("d")} Two\n`),
      out,
    );
    assert.ok(
      out.includes(
        `§1.1 → SPEC-x.md:${at("### §1.1 Sub")}-${at("## 2. Two") - 1} Sub\n`,
      ),
      out,
    );
    // `§3` has no heading (only 3.1), `§9` sits in a fence, the other two belong to other documents
    assert.equal(out.match(/^§/gm)?.length, 2, out);
    assert.ok(
      out.indexOf("§2 →") < out.indexOf("## next"),
      "refs sit under the spec line",
    );

    // no `spec:` → nothing to point at
    writeFileSync(
      join(p, "PLAN-y.md"),
      plan("Y", "", "- [ ] chunk 1 — do it (§2)"),
    );
    assert.ok(!/^§/m.test(run(dir, ["PLAN-y.md"])));
  });
});

test("testPlanBriefFindsASpecThatMovedToDone", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    mkdirSync(join(dir, ".fapony", "done"), { recursive: true });
    writeFileSync(join(dir, ".fapony/done/SPEC-x.md"), "## §1 One\nbody\n");
    writeFileSync(
      join(p, "PLAN-x.md"),
      plan("X", "spec: SPEC-x.md\n", "- [ ] chunk 1 — go (§1)"),
    );
    const out = run(dir, ["PLAN-x.md"]);
    assert.match(out, /^spec: \.fapony\/done\/SPEC-x\.md$/m);
    assert.match(out, /^§1 → SPEC-x\.md:1-2 One$/m);
  });
});

// A criterion still marked (guess) when its chunk starts gets measured against
// itself — the rule lived only in the plan-with-pony skill.
test("testPlanWarnsOnOpenGuesses", () => {
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-g.md"),
      `${plan("G", "", "- [x] chunk 1 — x\n- [ ] chunk 4 — measure")}\n## 3. Done criteria\n- hit rate ≥ 40% (guess)\n`,
    );
    assert.match(
      run(dir, ["PLAN-g.md"]),
      /⚠ 1 \(guess\) mark\(s\) still in the plan \(line 12\)/,
    );
    writeFileSync(
      join(p, "PLAN-h.md"),
      plan("H", "", "- [x] chunk 1 — x\n- [ ] chunk 2 — y"),
    );
    assert.ok(
      !run(dir, ["PLAN-h.md"]).includes("(guess)"),
      "no guess, no warn",
    );
  });
});
