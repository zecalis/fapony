import { test } from "bun:test";
import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cmdUpdate,
  formatDirtyBlock,
  parseDirtyLines,
  parseUpdateArgs,
  ROOT,
  readVersion,
  refreshArgv,
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
      await cmdUpdate([], { git, exit: testExit });
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
    "status --porcelain --untracked-files=no": " M a.ts",
    "log*": "bbb111 incoming",
  });
  const answers = ["y", "n"]; // yes to the upgrade, no to stashing
  let prompted = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      isTTY: true,
      prompt: async () => answers[prompted++] ?? "n",
    });
  });
  assert.equal(prompted, 2);
  assert.ok(out.includes("Update cancelled"), `got: ${out}`);
  assert.ok(!calls.some((c) => c.startsWith("merge")), "pull must not run");
  assert.ok(
    !calls.some((c) => c.startsWith("stash push")),
    "declined dirty prompt must not stash",
  );
  console.log("  ✓ cmdUpdate dirty declined cancels");
});

test("testCmdUpdateDirtyPullOk", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "merge --ff-only @{u}": "",
      "stash pop": "",
      "log*": "bbb111 feat",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  let installCalls = 0;
  let refreshCalls = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      isTTY: true,
      install: () => {
        installCalls++;
      },
      refresh: () => {
        refreshCalls++;
        return true;
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
      "log*": "bbb111 incoming",
      "status --porcelain --untracked-files=no": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "merge --ff-only @{u}": new Error("non-fast-forward"),
      "stash pop": "",
    },
    { shas: ["aaa111"] },
  );
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate([], {
        git,
        exit: testExit,
        isTTY: true,
        prompt: async () => "y",
      });
    } catch (e) {
      code = (e as TestExit).code;
    }
  });
  assert.equal(code, 1);
  assert.ok(err.includes("restored"), `got: ${err}`);
  console.log("  ✓ cmdUpdate pull-fail pop-ok restores stash");
});

test("testCmdUpdateNonTTYDirtyFailsFast", async () => {
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "log*": "bbb111 incoming",
      "status --porcelain --untracked-files=no": " M a.ts",
      "merge --ff-only @{u}": "",
    },
    { shas: ["aaa111"] },
  );
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate([], {
        git,
        exit: testExit,
        isTTY: false,
        prompt: async () => {
          throw new Error("must not prompt on a non-TTY");
        },
      });
    } catch (e) {
      code = (e as TestExit).code;
    }
  });
  assert.equal(code, 1);
  assert.ok(err.includes("no terminal"), `got: ${err}`);
  assert.ok(!calls.some((c) => c.startsWith("merge")), "must not pull");
  console.log("  ✓ cmdUpdate non-TTY + dirty → fail fast, no hang, no pull");
});

test("testCmdUpdateYesAutoStashes", async () => {
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": " M a.ts",
      "log HEAD..@{u} --oneline --no-decorate": "bbb111 incoming",
      "stash push -m 'fapony auto-stash before update'": "",
      "merge --ff-only @{u}": "",
      "stash pop": "",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate(["--yes"], {
      git,
      exit: testExit,
      isTTY: false,
      refresh: () => true,
      prompt: async () => {
        throw new Error("--yes must not prompt");
      },
    });
  });
  assert.ok(
    calls.includes("stash push -m 'fapony auto-stash before update'"),
    "clean script run should auto-stash",
  );
  assert.ok(
    calls.some((c) => c.startsWith("merge")),
    "should pull",
  );
  assert.ok(out.includes("stashed (--yes)"), `got: ${out}`);
  console.log("  ✓ cmdUpdate --yes → no prompts, auto-stash, pull");
});

test("testCmdUpdateDeclineConfirmLeavesTreeUntouched", async () => {
  // The regression this guards: stash used to run before the confirm, so a
  // "no" to the upgrade left the working tree reverted and changes stranded.
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": " M a.ts",
      "log HEAD..@{u} --oneline --no-decorate": "bbb111 incoming",
    },
    { shas: ["aaa111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      isTTY: true,
      prompt: async () => "n",
    });
  });
  assert.ok(out.includes("Upgrade cancelled"), `got: ${out}`);
  assert.ok(
    !calls.some((c) => c.startsWith("stash push")),
    "confirm declined before stash — nothing stranded",
  );
  assert.ok(!calls.some((c) => c.startsWith("merge")), "must not pull");
  console.log("  ✓ cmdUpdate declining confirm never stashes");
});

test("testCmdUpdateDetachedUpstreamFallback", async () => {
  // `@{u}` errors on a detached HEAD (this repo's own worktree topology);
  // the preview must fall back to origin/main rather than read it as empty.
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": "",
      "log HEAD..@{u} --oneline --no-decorate": new Error(
        "no upstream configured",
      ),
      "log HEAD..origin/main --oneline --no-decorate":
        "ccc333 detached fallback",
    },
    { shas: ["aaa111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate(["--dry-run"], {
      git,
      exit: testExit,
      isTTY: false,
    });
  });
  assert.ok(out.includes("ccc333 detached fallback"), `got: ${out}`);
  assert.ok(
    !out.includes("Already up to date"),
    `must not claim up to date: ${out}`,
  );
  console.log("  ✓ cmdUpdate detached HEAD falls back to origin/main");
});

test("testCmdUpdateNoUpstreamDryRunSaysSo", async () => {
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": "",
      "log*": new Error("no ref"),
    },
    { shas: ["aaa111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate(["--dry-run"], { git, exit: testExit, isTTY: false });
  });
  assert.ok(out.includes("No upstream ref"), `got: ${out}`);
  console.log("  ✓ cmdUpdate no upstream → honest dry-run message");
});

test("testCmdUpdatePullFailPopFail", async () => {
  // Regression guard for c3a45a5 — pop failure must NOT be swallowed.
  const { git } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "log*": "bbb111 incoming",
      "status --porcelain --untracked-files=no": " M a.ts",
      "stash push -m 'fapony auto-stash before update'": "",
      "merge --ff-only @{u}": new Error("non-fast-forward"),
      "stash pop": new Error("conflict"),
    },
    { shas: ["aaa111"] },
  );
  let code: number | null = null;
  const { err } = await captureOutput(async () => {
    try {
      await cmdUpdate([], {
        git,
        exit: testExit,
        isTTY: true,
        prompt: async () => "y",
      });
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
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": "",
    },
    { shas: ["aaa111"] },
  );
  let prompted = 0;
  let refreshCalls = 0;
  const deps: UpdateDeps = {
    git,
    exit: testExit,
    refresh: () => {
      refreshCalls++;
      return true;
    },
    prompt: async () => {
      prompted++;
      return "y";
    },
  };
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], deps);
  });
  assert.equal(prompted, 0);
  assert.ok(!calls.some((c) => c.startsWith("merge")), "nothing to merge");
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
      "status --porcelain --untracked-files=no": "",
      "merge --ff-only @{u}": "",
      "log*": "bbb111 new feature",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "bun.lock",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  let installCalls = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      install: () => {
        installCalls++;
      },
      refresh: () => true,
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
      "status --porcelain --untracked-files=no": "",
      "merge --ff-only @{u}": "",
      "log*": "bbb111 incoming",
      "diff --name-only HEAD@{1} HEAD -- bun.lock": "bun.lock",
    },
    { shas: ["aaa111", "bbb111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      install: () => {
        throw new Error("network down");
      },
      refresh: () => true,
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
      "log*": "bbb111 incoming",
      "status --porcelain --untracked-files=no": "",
      "merge --ff-only @{u}": new Error("non-fast-forward"),
    },
    { shas: ["aaa111"] },
  );
  let refreshCalls = 0;
  await captureOutput(async () => {
    try {
      await cmdUpdate([], {
        git,
        exit: testExit,
        refresh: () => {
          refreshCalls++;
          return true;
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
      "status --porcelain --untracked-files=no": "",
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
  assert.ok(!calls.some((c) => c.startsWith("merge")), "dry run must not pull");
  assert.ok(out.includes("checkout is untouched"), `got: ${out}`);
  assert.ok(out.includes("bbb111 incoming"), `got: ${out}`);
  console.log("  ✓ cmdUpdate dry-run previews without pulling");
});

test("testCmdUpdateConfirmDeclined", async () => {
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": "",
      "fetch --quiet": "",
      "log HEAD..@{u} --oneline --no-decorate": "bbb111 incoming",
    },
    { shas: ["aaa111"] },
  );
  let prompted = 0;
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      isTTY: true,
      prompt: async () => {
        prompted++;
        return "n";
      },
    });
  });
  assert.equal(prompted, 1, "one confirm prompt for incoming changes");
  assert.ok(
    !calls.some((c) => c.startsWith("merge")),
    "declined must not pull",
  );
  assert.ok(out.includes("Upgrade cancelled"), `got: ${out}`);
  console.log("  ✓ cmdUpdate confirm declined cancels");
});

test("testCmdUpdateDetachedMergesPreviewedRef", async () => {
  // `pull` fails on a detached HEAD; the update must fast-forward to the
  // exact ref the preview showed, with no second fetch.
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": "",
      "log HEAD..@{u} --oneline --no-decorate": new Error("no upstream"),
      "log HEAD..origin/main --oneline --no-decorate": "ccc333 fallback",
      "log aaa111..HEAD --oneline --no-decorate": "ccc333 fallback",
    },
    { shas: ["aaa111", "ccc333"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate(["--yes"], { git, exit: testExit, refresh: () => false });
  });
  assert.ok(calls.includes("merge --ff-only origin/main"), `calls: ${calls}`);
  assert.ok(!calls.some((c) => c.startsWith("pull")), "never pull");
  assert.equal(calls.filter((c) => c.startsWith("fetch")).length, 1);
  assert.ok(out.includes("Updated"), `got: ${out}`);
  console.log("  ✓ cmdUpdate detached HEAD merges the previewed ref");
});

test("testCmdUpdateNonTTYDirtyNothingIncoming", async () => {
  // cron on a current checkout with local edits: a no-op, not an exit 1.
  const { git, calls } = mapGit(
    {
      "rev-parse --is-inside-work-tree": "true",
      "status --porcelain --untracked-files=no": " M a.ts",
    },
    { shas: ["aaa111"] },
  );
  const { out } = await captureOutput(async () => {
    await cmdUpdate([], {
      git,
      exit: testExit,
      isTTY: false,
      refresh: () => false,
      prompt: async () => {
        throw new Error("must not prompt");
      },
    });
  });
  assert.ok(out.includes("Already up to date"), `got: ${out}`);
  assert.ok(!calls.some((c) => c.startsWith("stash")), "nothing to stash for");
  console.log("  ✓ cmdUpdate non-TTY + dirty + nothing incoming → no-op");
});

test("testCmdUpdateFetchFailExits", async () => {
  // Stale refs would preview "up to date" and skip the confirm.
  for (const argv of [[], ["--dry-run"]]) {
    const { git, calls } = mapGit(
      {
        "rev-parse --is-inside-work-tree": "true",
        "fetch --quiet": new Error("offline"),
      },
      { shas: ["aaa111"] },
    );
    let code: number | null = null;
    const { out, err } = await captureOutput(async () => {
      try {
        await cmdUpdate(argv, { git, exit: testExit });
      } catch (e) {
        code = (e as TestExit).code;
      }
    });
    assert.equal(code, 1, `argv ${argv}`);
    assert.ok(err.includes("fetch failed"), `got: ${err}`);
    assert.ok(!out.includes("Already up to date"), `got: ${out}`);
    assert.ok(!calls.some((c) => c.startsWith("merge")), "must not merge");
  }
  console.log("  ✓ cmdUpdate fetch failure exits before previewing");
});

test("testCmdUpdateSummaryReflectsRefresh", async () => {
  for (const refreshed of [true, false]) {
    const { git } = mapGit(
      {
        "rev-parse --is-inside-work-tree": "true",
        "log*": "bbb111 incoming",
      },
      { shas: ["aaa111", "bbb111"] },
    );
    const { out } = await captureOutput(async () => {
      await cmdUpdate(["--yes"], {
        git,
        exit: testExit,
        refresh: () => refreshed,
      });
    });
    assert.equal(out.includes("client plugins refreshed"), refreshed, out);
  }
  console.log("  ✓ cmdUpdate summary only claims a refresh that happened");
});
