import { test } from "bun:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdUpdate,
  formatDirtyBlock,
  isUpToDate,
  parseDirtyLines,
  parseUpdateArgs,
  ROOT,
  readVersion,
  refreshArgv,
  shouldProceedAfterDirty,
  shouldUpgrade,
  type UpdateDeps,
} from "../src/update.js";

// Tripwire for the ROOT=src/ regression (scrutiny finding #1): the fake-git
// seam never runs real execSync, so only a direct fs check catches a wrong
// repo root — version display and the bun.lock pathspec both depend on it.
test("testUpdateRootIsRepoRoot", () => {
  assert.ok(
    existsSync(join(ROOT, "package.json")),
    `ROOT must be the repo root (has package.json), got: ${ROOT}`,
  );
  assert.ok(
    existsSync(join(ROOT, "src", "update.ts")),
    `ROOT must be the repo root (has src/update.ts), got: ${ROOT}`,
  );
  assert.ok(
    !existsSync(join(ROOT, "src", "package.json")),
    `ROOT must not be src/ (src/package.json exists), got: ${ROOT}`,
  );
  console.log("  ✓ update ROOT is repo root");
});

// The spawned refresh must carry --plugins-only: without it the child does a
// full install and rewrites the user's opencode.json (the finding this pins).
test("testUpdateRefreshArgvPluginsOnly", () => {
  const argv = refreshArgv(["fapony-read-hint.ts"]);
  assert.equal(argv[0], join(ROOT, "fapony.ts"), "spawns the pulled checkout");
  assert.deepEqual(
    argv.slice(1, 5),
    ["install", "--platform", "opencode", "--plugins-only"],
    "refresh is plugins-only — never a full install",
  );
  assert.ok(
    !argv.includes("--git-autonomy"),
    "git-autonomy rides along only when the user opted in",
  );
  const withGa = refreshArgv(["fapony-read-hint.ts", "fapony-git-autonomy.ts"]);
  assert.ok(
    withGa.includes("--git-autonomy"),
    "opt-in plugin present → refresh it too, never create it",
  );
  console.log(
    "  ✓ update refresh argv is plugins-only, git-autonomy conditional",
  );
});

// The banner "Updated <version>@<sha>" must carry the real version — proof
// readVersion resolves ROOT/package.json (the old ROOT=src/ bug always said
// "unknown"). Kept separate from the ROOT tripwire because it pins behavior.
test("testUpdateReadVersionResolves", () => {
  const v = readVersion();
  assert.notEqual(v, "unknown", "readVersion must resolve ROOT/package.json");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
    version?: string;
  };
  assert.equal(v, pkg.version, `got ${v}, want ${pkg.version}`);
  console.log("  ✓ update readVersion resolves package.json");
});

test("testParseDirtyLines", () => {
  assert.deepStrictEqual(parseDirtyLines(""), []);
  assert.deepStrictEqual(parseDirtyLines(" M src/a.ts"), [" M src/a.ts"]);
  assert.deepStrictEqual(parseDirtyLines(" M a.ts\n?? b.ts\n"), [
    " M a.ts",
    "?? b.ts",
  ]);
  // blank lines never count as dirty
  assert.deepStrictEqual(parseDirtyLines("\n\n"), []);
  console.log("  ✓ parseDirtyLines");
});

test("testFormatDirtyBlock", () => {
  assert.equal(formatDirtyBlock(""), "");
  assert.equal(formatDirtyBlock(" M a.ts\n?? b.ts"), "    M a.ts\n   ?? b.ts");
  console.log("  ✓ formatDirtyBlock");
});

test("testShouldProceedAfterDirty", () => {
  assert.equal(shouldProceedAfterDirty("y"), true);
  assert.equal(shouldProceedAfterDirty("yes"), true);
  assert.equal(shouldProceedAfterDirty("Y"), true);
  assert.equal(shouldProceedAfterDirty("n"), false);
  assert.equal(shouldProceedAfterDirty("no"), false);
  assert.equal(shouldProceedAfterDirty(""), false);
  console.log("  ✓ shouldProceedAfterDirty");
});

test("testIsUpToDate", () => {
  assert.equal(isUpToDate("abc123", "abc123"), true);
  assert.equal(isUpToDate("abc123", "def456"), false);
  assert.equal(isUpToDate("unknown", "unknown"), true);
  console.log("  ✓ isUpToDate");
});

test("testParseUpdateArgs", () => {
  assert.deepStrictEqual(parseUpdateArgs([]), { dryRun: false, yes: false });
  assert.deepStrictEqual(parseUpdateArgs(["--dry-run"]), {
    dryRun: true,
    yes: false,
  });
  assert.deepStrictEqual(parseUpdateArgs(["--yes"]), {
    dryRun: false,
    yes: true,
  });
  assert.deepStrictEqual(parseUpdateArgs(["-y"]), {
    dryRun: false,
    yes: true,
  });
  console.log("  ✓ parseUpdateArgs");
});

test("testShouldUpgrade", () => {
  assert.equal(shouldUpgrade("y"), true);
  assert.equal(shouldUpgrade("Y"), true);
  assert.equal(shouldUpgrade("n"), false);
  assert.equal(shouldUpgrade(""), false);
  console.log("  ✓ shouldUpgrade");
});

// --- cmdUpdate orchestration (seam-based, no real git/stdin/process) ---

class TestExit extends Error {
  code: number;
  constructor(code: number) {
    super(`exit:${code}`);
    this.code = code;
  }
}

function testExit(code: number): never {
  throw new TestExit(code);
}

/** Map args→result fake git. `shas` feeds the two `rev-parse --short HEAD`
 *  calls (old, new) that share identical args; `log*` matches any log range. */
function mapGit(
  responses: Record<string, string | Error>,
  opts: { shas?: (string | Error)[] } = {},
): { git: (args: string) => string; calls: string[] } {
  const calls: string[] = [];
  let shaCalls = 0;
  const git = (args: string): string => {
    calls.push(args);
    if (args === "rev-parse --short HEAD" && opts.shas) {
      const r = opts.shas[Math.min(shaCalls++, opts.shas.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    }
    if (args.startsWith("log ") && "log*" in responses) {
      const r = responses["log*"];
      if (r instanceof Error) throw r;
      return r as string;
    }
    const r = responses[args];
    if (r === undefined) return "";
    if (r instanceof Error) throw r;
    return r;
  };
  return { git, calls };
}

async function captureOutput(fn: () => Promise<void>): Promise<{
  out: string;
  err: string;
}> {
  const origLog = console.log;
  const origErr = console.error;
  let out = "";
  let err = "";
  console.log = (...a: unknown[]): void => {
    out += `${a.join(" ")}\n`;
  };
  console.error = (...a: unknown[]): void => {
    err += `${a.join(" ")}\n`;
  };
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

test("testCmdUpdateNotARepo", async () => {
  const { git } = mapGit({ "rev-parse --is-inside-work-tree": "false" });
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate({ git, exit: testExit });
    } catch (e) {
      code = (e as TestExit).code;
    }
  });
  assert.equal(code, 1);
  assert.ok(err.includes("not a git repo"), `got: ${err}`);
  console.log("  ✓ cmdUpdate not-a-repo exit");
});

test("testCmdUpdateDirtyDeclined", async () => {
  const { git, calls } = mapGit({
    "rev-parse --is-inside-work-tree": "true",
    "status --porcelain": " M a.ts",
  });
  let prompted = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate({
      git,
      exit: testExit,
      prompt: async () => {
        prompted++;
        return "n";
      },
    });
  });
  assert.equal(prompted, 1);
  assert.ok(out.includes("Update cancelled"), `got: ${out}`);
  assert.ok(!calls.some((c) => c.startsWith("pull")), "pull must not run");
  console.log("  ✓ cmdUpdate dirty declined cancels");
});

test("testCmdUpdateDirtyPullOk", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "pull --ff-only": "",
      "stash pop": "",
      "log*": "bbb111 feat",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  let installCalls = 0;
  let refreshCalls = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate({
      git,
      exit: testExit,
      install: () => {
        installCalls++;
      },
      refresh: () => {
        refreshCalls++;
      },
      prompt: async () => "y",
    });
  });
  assert.equal(installCalls, 0);
  assert.equal(refreshCalls, 1, "a successful pull must refresh plugins once");
  assert.ok(out.includes("Restored your stashed changes"), `got: ${out}`);
  assert.ok(out.includes("aaa111") && out.includes("bbb111"), `got: ${out}`);
  console.log("  ✓ cmdUpdate dirty pull-ok restores stash");
});

test("testCmdUpdatePullFailPopOk", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "pull --ff-only": new Error("non-fast-forward"),
      "stash pop": "",
    },
    { shas: ["aaa111"] },
  );
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate({ git, exit: testExit, prompt: async () => "y" });
    } catch (e) {
      code = (e as TestExit).code;
    }
  });
  assert.equal(code, 1);
  assert.ok(err.includes("restored"), `got: ${err}`);
  console.log("  ✓ cmdUpdate pull-fail pop-ok restores stash");
});

test("testCmdUpdatePullFailPopFail", async () => {
  // Regression guard for c3a45a5 — pop failure must NOT be swallowed.
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "pull --ff-only": new Error("non-fast-forward"),
      "stash pop": new Error("conflict"),
    },
    { shas: ["aaa111"] },
  );
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate({ git, exit: testExit, prompt: async () => "y" });
    } catch (e) {
      code = (e as TestExit).code;
    }
  });
  assert.equal(code, 1);
  assert.ok(err.includes("still stashed"), `got: ${err}`);
  assert.ok(err.includes("do NOT `git stash drop`"), `got: ${err}`);
  console.log("  ✓ cmdUpdate pull-fail pop-fail warns (regression)");
});

test("testCmdUpdateAlreadyUpToDate", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "pull --ff-only": "",
    },
    { shas: ["aaa111", "aaa111"] },
  );
  let prompted = 0;
  let refreshCalls = 0;
  const deps: UpdateDeps = {
    git,
    exit: testExit,
    refresh: () => {
      refreshCalls++;
    },
    prompt: async () => {
      prompted++;
      return "y";
    },
  };
  const { out } = await captureOutput(async () => {
    await cmdUpdate(deps);
  });
  assert.equal(prompted, 0);
  assert.equal(
    refreshCalls,
    1,
    "already-up-to-date still refreshes — the repo being current says nothing about the baked plugin bodies",
  );
  assert.ok(out.includes("Already up to date"), `got: ${out}`);
  console.log("  ✓ cmdUpdate already up to date");
});

test("testCmdUpdateLockfileTriggersInstall", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "pull --ff-only": "",
      "log*": "bbb111 new feature",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "bun.lock",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  let installCalls = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate({
      git,
      exit: testExit,
      install: () => {
        installCalls++;
      },
      refresh: () => {},
      prompt: async () => "y",
    });
  });
  assert.equal(installCalls, 1);
  assert.ok(out.includes("What's new"), `got: ${out}`);
  assert.ok(out.includes("bbb111 new feature"), `got: ${out}`);
  assert.ok(out.includes("Dependencies updated"), `got: ${out}`);
  console.log("  ✓ cmdUpdate lockfile change runs install");
});

test("testCmdUpdateInstallFailureWarns", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "pull --ff-only": "",
      "log*": "",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "bun.lock",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate({
      git,
      exit: testExit,
      install: () => {
        throw new Error("network down");
      },
      refresh: () => {},
      prompt: async () => "y",
    });
  });
  assert.ok(out.includes("bun install failed"), `got: ${out}`);
  console.log("  ✓ cmdUpdate install failure warns");
});

test("testCmdUpdateNoRefreshOnPullFail", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "pull --ff-only": new Error("non-fast-forward"),
    },
    { shas: ["aaa111"] },
  );
  let refreshCalls = 0;
  await captureOutput(async () => {
    try {
      await cmdUpdate({
        git,
        exit: testExit,
        refresh: () => {
          refreshCalls++;
        },
        prompt: async () => "y",
      });
    } catch {
      // expected exit
    }
  });
  assert.equal(refreshCalls, 0, "a failed pull must not refresh plugins");
  console.log("  ✓ cmdUpdate pull-fail → no plugin refresh");
});

test("testCmdUpdateDryRunNoPull", async () => {
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "fetch --quiet": "",
      "log HEAD..@{u} --oneline --no-decorate": "bbb111 incoming",
    },
    { shas: ["aaa111"] },
  );
  let prompted = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate(["--dry-run"], {
      git,
      exit: testExit,
      prompt: async () => {
        prompted++;
        return "y";
      },
    });
  });
  assert.equal(prompted, 0, "dry run must never prompt");
  assert.ok(!calls.some((c) => c.startsWith("pull")), "dry run must not pull");
  assert.ok(out.includes("dry run"), `got: ${out}`);
  assert.ok(out.includes("bbb111 incoming"), `got: ${out}`);
  console.log("  ✓ cmdUpdate dry-run previews without pulling");
});

test("testCmdUpdateConfirmDeclined", async () => {
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain": "",
      "fetch --quiet": "",
      "log HEAD..@{u} --oneline --no-decorate": "bbb111 incoming",
    },
    { shas: ["aaa111"] },
  );
  let prompted = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate({
      git,
      exit: testExit,
      prompt: async () => {
        prompted++;
        return "n";
      },
    });
  });
  assert.equal(prompted, 1, "one confirm prompt for incoming changes");
  assert.ok(!calls.some((c) => c.startsWith("pull")), "declined must not pull");
  assert.ok(out.includes("Upgrade cancelled"), `got: ${out}`);
  console.log("  ✓ cmdUpdate confirm declined cancels");
});
