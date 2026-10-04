import { test } from "bun:test";
// test/plan-park.test.ts — `fapony plan park|unpark` (src/plan/park.ts): a plan
// set aside leaves plan/ for parked/ with every link still true, its spec stays.
import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cmdPlanNext } from "../src/plan/next.js";
import { cmdPlanPark } from "../src/plan/park.js";
import { initPlanStore } from "../src/plan/store.js";
import { collectDepIssues } from "../src/plan/sweep.js";
import { captureLogs, withFakeFael, withTempRepo } from "./helpers.js";

function inRepo(fn: (dir: string, fapony: string) => void): void {
  withFakeFael((setRows) =>
    withTempRepo((dir) => {
      setRows([
        {
          id: "h1",
          ts: "2026-10-04T00:00:00Z",
          kind: "note",
          text: "handoff",
          key: "plan:b:handoff",
          files: ["plan:b"],
        },
      ]);
      const f = join(dir, ".fapony");
      for (const d of ["plan", "spec"])
        mkdirSync(join(f, d), { recursive: true });
      writeFileSync(
        join(f, "plan", "PLAN-a.md"),
        "---\nkind: unit\nstatus: blocked\nblocked_by: PLAN-b.md\n---\n\n# A\n\n## TL;DR\n- [ ] chunk 1 — a\n\nsee [b](PLAN-b.md)\n",
      );
      writeFileSync(
        join(f, "plan", "PLAN-b.md"),
        "---\nkind: unit\nspec: SPEC-b.md\n---\n\n# B\n\n## TL;DR\n- [ ] chunk 1 — b\n\nsee [a](PLAN-a.md) · [spec](../spec/SPEC-b.md)\n",
      );
      writeFileSync(join(f, "spec", "SPEC-b.md"), "# SPEC-b\n");
      const prev = process.cwd();
      process.chdir(dir);
      try {
        initPlanStore(dir);
        fn(dir, f);
      } finally {
        process.chdir(prev);
      }
    }),
  );
}

test("testParkDryRunMovesNothing", () => {
  inRepo((_dir, f) => {
    const out = captureLogs(() => cmdPlanPark(["PLAN-b.md"], false));
    assert.match(
      out,
      /would move \.fapony\/plan\/ → \.fapony\/parked\/ .*add --apply/,
    );
    assert.ok(existsSync(join(f, "plan", "PLAN-b.md")), "still in plan/");
  });
});

test("testParkAndUnparkKeepEveryLinkTrue", () => {
  inRepo((_dir, f) => {
    const out = captureLogs(() => cmdPlanPark(["b", "--apply"], false));
    assert.match(
      out,
      /moved \.fapony\/plan\/PLAN-b\.md → \.fapony\/parked\/PLAN-b\.md/,
    );
    assert.match(out, /fael add decision "parked: .*" --files plan:b/);
    const b = readFileSync(join(f, "parked", "PLAN-b.md"), "utf8");
    assert.ok(b.includes("[a](../plan/PLAN-a.md)"), "own link re-relativized");
    assert.ok(b.includes("[spec](../spec/SPEC-b.md)"), "spec link unchanged");
    assert.ok(
      readFileSync(join(f, "plan", "PLAN-a.md"), "utf8").includes(
        "[b](../parked/PLAN-b.md)",
      ),
      "inbound link repointed",
    );
    assert.ok(existsSync(join(f, "spec", "SPEC-b.md")), "spec stays in spec/");

    // parked: listed once, its handoff key is no orphan, its chunks not offered
    const all = captureLogs(() => cmdPlanNext([]));
    assert.match(all, /## parked \(1\) — PLAN-b\.md/);
    assert.ok(!all.includes("name no plan"), "parked plan's key is known");
    assert.ok(!all.includes("chunk 1 — b"), "a parked plan offers no chunk");
    const one = captureLogs(() => cmdPlanNext(["PLAN-b.md"]));
    assert.match(one, /⚠ parked \(0\/1 chunks\) — set aside/);
    assert.ok(!one.includes("## next"), "a parked plan offers no next chunk");
    // an active plan waiting on a parked one will never unblock
    assert.match(
      collectDepIssues([join(f, "plan", "PLAN-a.md")]).join("\n"),
      /blocker PLAN-b\.md is parked/,
    );

    captureLogs(() => cmdPlanPark(["b", "--apply"], true));
    assert.ok(existsSync(join(f, "plan", "PLAN-b.md")), "back in plan/");
    assert.ok(
      readFileSync(join(f, "plan", "PLAN-a.md"), "utf8").includes(
        "[b](PLAN-b.md)",
      ),
      "inbound link back to the sibling path",
    );
  });
});

test("testParkRefusesAPlanOutsidePlanDir", () => {
  inRepo(() => {
    const err = captureLogs(() => {
      const orig = process.exit;
      const origErr = console.error;
      console.error = console.log;
      process.exit = ((c: number) => {
        throw new Error(`exit ${c}`);
      }) as typeof process.exit;
      try {
        cmdPlanPark(["b", "--apply"], true);
      } catch (e) {
        console.log(String(e));
      } finally {
        process.exit = orig;
        console.error = origErr;
      }
    });
    assert.match(err, /is not in \.fapony\/parked\/ .*exit 1/s);
  });
});

test("testParkWarnsOnAClaimedChunkAndTakesASymlinkedPath", () => {
  inRepo((dir, f) => {
    const p = join(f, "plan", "PLAN-b.md");
    writeFileSync(
      p,
      readFileSync(p, "utf8").replace(
        "chunk 1 — b",
        "chunk 1 — b (wip feat/x)",
      ),
    );
    // the same plan dir reached through another name (a shared .fapony/)
    symlinkSync(f, join(dir, "alias"));
    const out = captureLogs(() => cmdPlanPark(["alias/plan/PLAN-b.md"], false));
    assert.match(out, /⚠ 1 chunk\(s\) still claimed \(wip …\)/);
    assert.match(out, /chunk 1 — b \(wip feat\/x\)/);
    assert.match(out, /would move/, "a symlinked spelling is still plan/");
  });
});

test("testParkSeveralAtOnceRetiresBlockedAndCountsOnlyPathMentions", () => {
  inRepo((_dir, f) => {
    // a bare name points nowhere wrong; only `plan/PLAN-b.md` goes stale
    writeFileSync(
      join(f, "spec", "SPEC-b.md"),
      "# SPEC-b\n\nPLAN-b.md · `PLAN-b` · see .fapony/plan/PLAN-b.md\n",
    );
    const dry = captureLogs(() => cmdPlanPark(["a", "b"], false));
    assert.match(dry, /PLAN-a\.md: would move .*blocked_by → parked_because/);
    assert.match(dry, /PLAN-b\.md: would move/);

    const out = captureLogs(() => cmdPlanPark(["a", "b", "--apply"], false));
    assert.match(out, /PLAN-a\.md .*stale mentions: 0\)/);
    assert.match(out, /PLAN-b\.md .*stale mentions: 1\)/);
    // a's reason is on file, so only b is asked for one
    assert.equal((out.match(/record why/g) ?? []).length, 1, out);
    assert.match(out, /--files plan:b/);
    const a = readFileSync(join(f, "parked", "PLAN-a.md"), "utf8");
    assert.ok(!a.includes("status: blocked"), "status: blocked dropped");
    assert.ok(
      a.startsWith("---\nkind: unit\nparked_because: PLAN-b.md\n---\n"),
    );
    assert.match(
      captureLogs(() => cmdPlanNext(["PLAN-a.md"])),
      /parked_because: PLAN-b\.md/,
    );
  });
});
