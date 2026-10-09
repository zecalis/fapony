import { test } from "bun:test";
// test/plan-parallel.test.ts — one plan, several worktrees (src/plan/parallel.ts)
import assert from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemRow } from "../src/fael.js";
import { cmdPlanNext } from "../src/plan/next.js";
import {
  misfiledHandoffs,
  orphanHandoffKeys,
  pickChunks,
} from "../src/plan/parallel.js";
import { initPlanStore } from "../src/plan/store.js";
import { splitWarns, tldrWarns } from "../src/plan/sweep.js";
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

test("testPickChunksDefaultsToTheFirstOpenChunk", () => {
  // no markers: today's behaviour — first open chunk, nothing alongside
  const p = pickChunks(
    ["- [x] chunk 1 — a (abc1234)", "- [ ] chunk 2 — b", "- [ ] chunk 3 — c"],
    "main",
  );
  assert.deepEqual(p, {
    next: 1,
    wip: [],
    waiting: [],
    alongside: [],
    waitsOn: [],
  });
});

test("testPickChunksSkipsAnotherWorktreesClaim", () => {
  const items = [
    "- [x] chunk 1 — a (abc1234)",
    "- [ ] chunk 2 — edit `src/a.ts` (wip feat/two)",
    "- [ ] chunk 3 — c",
    "- [ ] chunk 4 — d (after 1)",
    "- [ ] chunk 5 — touches src/a.ts (after —)",
  ];
  const other = pickChunks(items, "feat/other");
  assert.equal(other.next, 3, "chunk 3 waits on wip 2; chunk 4 only needs 1");
  assert.deepEqual(other.wip, [{ at: 1, branch: "feat/two" }]);
  assert.deepEqual(other.alongside, [{ at: 4, shared: ["src/a.ts"] }]);
  // the claiming worktree keeps its own chunk as next
  assert.equal(pickChunks(items, "feat/two").next, 1);
});

test("testPickChunksSaysWhatTheFirstOpenChunkWaitsOn", () => {
  const p = pickChunks(
    ["- [ ] chunk 1 — a (wip feat/one)", "- [ ] chunk 2 — b"],
    "feat/two",
  );
  assert.equal(p.next, -1);
  assert.deepEqual(p.waitsOn, ["1"]);
});

test("testPickChunksNeverOffersAChunkWaitingOnAPerson", () => {
  const items = [
    "- [x] chunk 1 — a (abc1234)",
    "- [ ] chunk 2 — settings page (wait page approved)",
    "- [ ] chunk 3 — c",
    "- [ ] chunk 4 — d (after 1)",
  ];
  const p = pickChunks(items, "main");
  assert.deepEqual(p.waiting, [{ at: 1, why: "page approved" }]);
  assert.equal(p.next, 3, "3 waits on 2 by default; 4 only needs 1");
  assert.deepEqual(p.alongside, []);
  const none = pickChunks(items.slice(0, 3), "main");
  assert.equal(none.next, -1);
  // 2 waits on its own reason, not on a chunk — `waiting` says why
  assert.deepEqual(none.waitsOn, []);
});

test("testAfterAnotherPlansChunkWaitsUntilThatPlanTicksIt", () => {
  // vela: j2b (after 7a) looked 7a up in its own plan and never ran
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    const jobs = (tick: string) =>
      writeFileSync(
        join(p, "PLAN-vela-jobs.md"),
        `---\nkind: unit\n---\n\n# J\n\n## TL;DR\n- [${tick}] j4 — dirty keys\n`,
      );
    jobs(" ");
    const x = join(p, "PLAN-x.md");
    writeFileSync(
      x,
      "---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- [ ] m3 — fifo (after vela-jobs:j4)\n- [ ] m4 — b (after 7a)\n- [ ] m5 — c (after gone:j1)\n",
    );
    const prev = process.cwd();
    process.chdir(dir);
    try {
      initPlanStore(dir);
      const items = ["- [ ] m3 — fifo (after vela-jobs:j4)"];
      assert.equal(pickChunks(items, "main").next, -1);
      assert.deepEqual(pickChunks(items, "main").waitsOn, ["vela-jobs:j4"]);
      jobs("x");
      assert.equal(pickChunks(items, "main").next, 0);
      // an (after …) nothing can meet is said, not left to stall
      const w = tldrWarns(x).join("\n");
      assert.match(w, /open chunk m4: \(after 7a\) names no chunk/);
      assert.match(w, /open chunk m5: \(after gone:j1\)/);
      assert.doesNotMatch(w, /m3/);
    } finally {
      process.chdir(prev);
    }
  });
});

const row = (id: string, key: string): MemRow =>
  ({ id, ts: "2026-10-04T00:00:00Z", kind: "note", text: "t", key }) as MemRow;

test("testMisfiledAndOrphanHandoffKeys", () => {
  const rows = [
    row("a", "vela:registry:handoff"), // the real slip
    row("b", "plan:vela-registry:handoff"), // correct
    row("c", "workflow:chunk-batching"), // a topic, not a chunk key
    row("d", "plan:gone:chunk-3"), // names no plan
    { ...row("e", "plan:handoff"), kind: "decision" }, // a record, not a handoff
    { ...row("f", "vela:registry:chunk-2"), kind: "decision" },
    row("g", "vela-print:chunk-pr2a"), // 2-letter label, misfiled
  ];
  assert.deepEqual(
    misfiledHandoffs(rows, "vela-registry").map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    misfiledHandoffs(rows, "vela-print").map((r) => r.id),
    ["g"],
  );
  assert.deepEqual(orphanHandoffKeys(rows, ["vela-registry", "vela-print"]), [
    "plan:gone:chunk-3",
  ]);
});

test("testPlanShowsClaimsAlongsideAndMisfiledHandoff", () => {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        "---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- [ ] chunk 1 — a (wip feat/one)\n- [ ] chunk 2 — b\n- [ ] chunk 3 — c (after —)\n",
      );
      setRows([
        {
          id: "m1",
          ts: "2026-10-04T00:00:00Z",
          kind: "note",
          text: "handoff",
          key: "x:handoff",
          files: ["src/a.ts"],
        },
        {
          id: "o1",
          ts: "2026-10-04T00:00:00Z",
          kind: "note",
          text: "left behind",
          key: "plan:gone:handoff",
          files: ["src/a.ts"],
        },
      ]);
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const out = captureLogs(() => cmdPlanNext(["PLAN-x.md"]));
        assert.match(out, /## next\n- \[ \] chunk 3 — c \(after —\)/, out);
        assert.match(
          out,
          /## in progress in another worktree\n- chunk 1 — a … — feat\/one/,
        );
        assert.match(out, /## later \(1\)\n- chunk 2 — b/);
        assert.match(
          out,
          /⚠ handoff under a key fapony plan never reads: \[m1\] x:handoff — re-file it: .*--key plan:x:handoff --supersedes m1/,
        );
        const all = captureLogs(() => cmdPlanNext([]));
        assert.match(all, /in progress elsewhere: 1 \(feat\/one\)/);
        assert.match(all, /next: chunk 3 — c/);
        // x:handoff is misfiled (plan x exists) — only plan:gone is an orphan
        assert.match(
          all,
          /⚠ 1 open handoff key\(s\) name no plan .*: plan:gone:handoff/,
        );
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testSplitWarnsOnNestedDuplicateAndUmbrellaChunks", () => {
  const flat = [
    "  - [x] pr2a — a (abc1234)",
    "  - [ ] pr2b — b",
    "  - [x] pr0 — c (def5678)",
    "  - [ ] pr0c — d",
  ];
  assert.deepEqual(splitWarns(flat), [], "a closed pr0 beside pr0c is fine");
  assert.deepEqual(splitWarns([]), []);
  const w = splitWarns([
    "  - [x] chunk 3a — a (abc1234)",
    "    - [ ] 3a+ UI — b",
    "  - [ ] pr2 (closes when pr2a–pr2b are done) — engine",
    "  - [x] pr2a — x (abc1234)",
  ]).join("\n");
  assert.match(w, /1 nested checkbox/);
  assert.match(w, /open chunk pr2 is kept beside its parts pr2a — /);
});

test("testPlanListsWaitingChunksApart", () => {
  withFakeFael(() =>
    withTempRepo((dir) => {
      const p = join(dir, ".fapony", "plan");
      mkdirSync(p, { recursive: true });
      writeFileSync(
        join(p, "PLAN-x.md"),
        "---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- [ ] chunk 1 — page (wait brief approved)\n- [ ] chunk 2 — b (after —)\n",
      );
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        const out = captureLogs(() => cmdPlanNext(["PLAN-x.md"]));
        assert.match(out, /## next\n- \[ \] chunk 2 — b/, out);
        assert.match(
          out,
          /## waiting \(not offered\)\n- chunk 1 — page … — wait: brief approved/,
          out,
        );
        assert.doesNotMatch(out, /## later/);
        const all = captureLogs(() => cmdPlanNext([]));
        assert.match(all, /waiting: 1/);
        // only the waiting chunk left: it waits on its reason, not on itself,
        // and nothing to close → one pointer line instead of the rules
        writeFileSync(
          join(p, "PLAN-x.md"),
          "---\nkind: unit\n---\n\n# X\n\n## TL;DR\n- [ ] chunk 4 — page (wait ≥30 samples)\n",
        );
        const none = captureLogs(() => cmdPlanNext(["PLAN-x.md"]));
        assert.match(
          none,
          /## next\n\(none ready — chunk 4 waits: ≥30 samples\)/,
        );
        assert.doesNotMatch(none, /## closing/);
        assert.match(none, /\nrules: fapony plan PLAN-x\.md --rules$/m);
        assert.match(
          captureLogs(() => cmdPlanNext(["PLAN-x.md", "--rules"])),
          /## closing\n- batching:/,
        );
        assert.match(
          captureLogs(() => cmdPlanNext([])),
          /next: none ready — chunk 4 waits: ≥30 samples/,
        );
      } finally {
        process.chdir(prev);
      }
    }),
  );
});

test("testSplitChunkClosesWhenAllPartsDo", () => {
  // chunk 2 split into 2a/2b: (after 2) and (after x:2) meet once both close;
  // with a `2` line, a `2b` beside it is a leftover and does not hold it
  const items = (b: string) => [
    "- [x] chunk 2a — a",
    `- [${b}] chunk 2b — b`,
    "- [ ] chunk 3 — c (after 2)",
  ];
  assert.deepEqual(pickChunks(items(" "), "main").next, 1);
  assert.equal(pickChunks(items("x"), "main").next, 2);
  assert.equal(
    pickChunks(
      ["- [x] m2 — a", "- [ ] m2b — left from m2", "- [ ] m3 — c (after m2)"],
      "main",
    ).next,
    1,
    "m2b and m3 both ready — m2 is closed",
  );
  withTempRepo((dir) => {
    const p = join(dir, ".fapony", "plan");
    mkdirSync(p, { recursive: true });
    writeFileSync(
      join(p, "PLAN-v.md"),
      "---\nkind: unit\n---\n\n# V\n\n## TL;DR\n- [x] chunk 2a — a\n- [x] chunk 2b — b\n",
    );
    const w = join(p, "PLAN-w.md");
    writeFileSync(
      w,
      "---\nkind: unit\n---\n\n# W\n\n## TL;DR\n- [ ] chunk 1 — w (after v:2)\n- [x] chunk 4a — x\n- [ ] chunk 5 — y (after 4)\n",
    );
    const prev = process.cwd();
    process.chdir(dir);
    try {
      initPlanStore(dir);
      assert.equal(
        pickChunks(["- [ ] chunk 1 — w (after v:2)"], "main").next,
        0,
      );
      // (after 4) names split part 4a — a chunk, not "names no chunk"
      assert.doesNotMatch(tldrWarns(w).join("\n"), /names no chunk/);
    } finally {
      process.chdir(prev);
    }
  });
});
