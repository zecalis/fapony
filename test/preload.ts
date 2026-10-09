// test/preload.ts — bunfig.toml [test] preload. Runs before any *.test.ts loads.
// Pins passive-usage readers off the developer's real session logs (~1GB) so
// no test scans live data mid-run. Individual tests (e.g. digest.test.ts) that
// need real fixtures set + restore their own path around the call.
process.env.FAPONY_OPENCODE_DB = "/nonexistent/fapony-test/opencode.db";
process.env.FAPONY_ZCODE_DB = "/nonexistent/fapony-test/zcode.db";
process.env.FAPONY_CLAUDE_PROJECTS_DIR = "/nonexistent/fapony-test/claude";
process.env.FAPONY_CODEX_SESSIONS_DIR = "/nonexistent/fapony-test/codex";

// An empty fael (no rows, exit 0) first on PATH: plan sweep fails closed when
// fael is unreadable, and CI has no fael — tests must not depend on the
// developer's install either. withFakeFael prepends its own and still wins.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const emptyFael = mkdtempSync(join(tmpdir(), "fapony-empty-fael-"));
writeFileSync(join(emptyFael, "fael"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
process.env.PATH = `${emptyFael}:${process.env.PATH ?? ""}`;
