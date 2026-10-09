import { test } from "bun:test";
// test/cli-help.test.ts — `fapony <cmd> --help` prints help and does nothing
// else. Before the cli.ts guard, `update --help` ran the update, `install
// --help` wired clients and `report-web --help` took --help as its out path.

import assert from "node:assert";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const entry = join(import.meta.dir, "..", "fapony.ts");

test("testSubcommandHelpDoesNotRun", () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-help-"));
  try {
    for (const cmd of ["update", "upgrade", "install", "setup", "report-web"]) {
      for (const flag of ["--help", "-h"]) {
        const r = Bun.spawnSync(["bun", entry, cmd, flag], {
          env: { ...process.env, HOME: home },
          stdin: "ignore",
        });
        const out = r.stdout.toString();
        assert.equal(r.exitCode, 0, `${cmd} ${flag}: ${r.stderr}`);
        assert.ok(out.startsWith(`fapony ${cmd} — `), `${cmd} ${flag}: ${out}`);
      }
    }
    assert.ok(!existsSync(join(home, ".claude")), "install wrote to HOME");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("testOwnHelpCommandsKeepTheirHelp", () => {
  const r = Bun.spawnSync(["bun", entry, "lint-baseline", "--help"], {
    stdin: "ignore",
  });
  assert.ok(!r.stdout.toString().startsWith("fapony lint-baseline — "));
});
