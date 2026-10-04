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
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

test("testPickChunksDefaultsToTheFirstOpenChunk", () => {
  // no markers: today's behaviour — first open chunk, nothing alongside
  const p = pickChunks(
    ["- [x] chunk 1 — a (abc1234)", "- [ ] chunk 2 — b", "- [ ] chunk 3 — c"],
    "main",
  );
  assert.deepEqual(p, { next: 1, wip: [], alongside: [], waitsOn: [] });
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

const row = (id: string, key: string): MemRow =>
  ({ id, ts: "2026-10-04T00:00:00Z", kind: "note", text: "t", key }) as MemRow;

test("testMisfiledAndOrphanHandoffKeys", () => {
  const rows = [
    row("a", "vela:registry:handoff"), // the real slip
    row("b", "plan:vela-registry:handoff"), // correct
    row("c", "workflow:chunk-batching"), // a topic, not a chunk key
    row("d", "plan:gone:chunk-3"), // names no plan
  ];
  assert.deepEqual(
    misfiledHandoffs(rows, "vela-registry").map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(orphanHandoffKeys(rows, ["vela-registry"]), [
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
