import { test } from "bun:test";
// test/fael.test.ts — the fael row → MemRow boundary.
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { faelLinesToMemRows, readFaelLog } from "../src/fael.js";
import { withFakeFael } from "./helpers.js";

test("testFaelRowsMapToMemRows", () => {
  const lines = [
    JSON.stringify({
      id: "i1",
      ts: "2026-09-01T00:00:00Z",
      by: "ann",
      kind: "issue",
      text: "broken",
      files: ["a.ts"],
      closed: { id: "c1", ts: "2026-09-03T00:00:00Z", by: "bo", text: "fixed" },
    }),
    "not json",
    JSON.stringify({
      id: "c2",
      ts: "2026-09-04T00:00:00Z",
      by: "bo",
      text: "done",
      ref: "d1",
    }),
    JSON.stringify({
      id: "d1",
      ts: "2026-09-02T00:00:00Z",
      by: "ann",
      kind: "decision",
      text: "use x",
      spec: ".fapony/plan/PLAN-x.md",
    }),
  ].join("\n");
  const { rows, skipped } = faelLinesToMemRows(lines);
  assert.equal(skipped, 1);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.id, r.agent, r.ref]),
    [
      ["close", "c2", "bo", "d1"],
      ["close", "c1", "bo", "i1"],
      ["decision", "d1", "ann", undefined],
      ["bug", "i1", "ann", undefined],
    ],
    "issue → bug, both close shapes → close row with ref, newest first",
  );
  assert.deepEqual(rows[3].files, ["a.ts"]);
  assert.equal(rows[2].spec, ".fapony/plan/PLAN-x.md");

  const since = faelLinesToMemRows(lines, "2026-09-02T00:00:00Z").rows;
  assert.deepEqual(
    since.map((r) => r.id),
    ["c2", "c1", "d1"],
  );
});

test("testReadFaelLogUsesPathAndReportsMissing", () => {
  withFakeFael((setRows) => {
    setRows([
      { id: "n1", ts: "2026-09-01T00:00:00Z", kind: "note", text: "x" },
    ]);
    const r = readFaelLog(tmpdir());
    assert.equal(r.ok, true);
    assert.deepEqual(
      r.rows.map((x) => x.id),
      ["n1"],
    );
  });
  const orig = process.env.PATH;
  process.env.PATH = mkdtempSync(join(tmpdir(), "fapony-empty-path-"));
  try {
    assert.deepEqual(readFaelLog(tmpdir()), {
      rows: [],
      ok: false,
      skipped: 0,
    });
  } finally {
    process.env.PATH = orig;
  }
});
