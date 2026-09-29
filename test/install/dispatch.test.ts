import { test } from "bun:test";
// test/install/dispatch.test.ts — cmdInstall routing for the no-platform path
// (detect → prompt / --all / non-TTY) and the unknown-platform guard.

import assert from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdInstall, type InstallDeps } from "../../src/install.js";
import { type TestExit, testExit } from "./helpers.js";

test("testCmdInstallRejectsUnknownPlatform", async () => {
  let code: number | null = null;
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  };
  try {
    await cmdInstall(["windows"], { exit: testExit });
  } catch (e) {
    code = (e as TestExit).code;
  } finally {
    console.error = orig;
  }
  const err = lines.join("\n");
  assert.equal(code, 1);
  assert.ok(err.includes("opencode|claude"), `got: ${err}`);
  assert.ok(!err.includes("cursor"), `cursor support is gone: ${err}`);
  console.log("  ✓ install rejects unknown platform");
});

test("testCmdInstallNoPlatformPromptsDetected", async () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-install-prompt-"));
  try {
    // Set up opencode config so it's detected
    const ocDir = join(home, ".config", "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "opencode.json"), "{}");

    const asked: string[] = [];
    const deps: InstallDeps = {
      homedir: () => home,
      checkCmd: () => false, // claude not found
      ask: async (q: string) => {
        asked.push(q);
        return "n"; // decline all
      },
    };

    // Mock stdin.isTTY — but we can't easily mock that.
    // Instead, just test that without --all and with ask returning "n",
    // no install function is called (opencode config unchanged).
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      await cmdInstall([], deps);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }

    // ask was called for opencode (only detected client)
    assert.ok(
      asked.length >= 1,
      `should have asked at least once, got ${asked.length}`,
    );
    assert.ok(
      asked.some((q) => q.includes("opencode")),
      "should ask about opencode",
    );
    // Config should still be empty (not modified) since we answered "n"
    const cfg = JSON.parse(readFileSync(join(ocDir, "opencode.json"), "utf-8"));
    assert.deepStrictEqual(
      cfg,
      {},
      "opencode config should not be modified when declined",
    );
    console.log(
      "  ✓ install no platform → prompts detected, declines no install",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("testCmdInstallNonTtyNoAllSkipsInstall", async () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-install-nontty-"));
  try {
    const ocDir = join(home, ".config", "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "opencode.json"), "{}");

    const lines: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    const deps: InstallDeps = {
      homedir: () => home,
      checkCmd: () => false,
    };
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    try {
      await cmdInstall([], deps);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
      console.error = origError;
    }

    const output = lines.join("\n");
    assert.ok(
      output.includes("not a terminal"),
      `should mention non-terminal: ${output}`,
    );
    // Config must remain untouched — no install happened.
    const cfg = JSON.parse(readFileSync(join(ocDir, "opencode.json"), "utf-8"));
    assert.deepStrictEqual(
      cfg,
      {},
      "non-TTY without --all must not modify config",
    );
    console.log(
      "  ✓ install non-TTY without --all → skips install, hints --all",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("testCmdInstallNoPlatformAllFlag", async () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-install-all-"));
  try {
    // Set up opencode config
    const ocDir = join(home, ".config", "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "opencode.json"), "{}");

    const deps: InstallDeps = {
      homedir: () => home,
      checkCmd: () => false, // claude not found
    };

    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      await cmdInstall(["--all"], deps);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }

    assert.ok(
      existsSync(join(home, ".claude", "skills")),
      "detected opencode gets installed without a prompt",
    );
    console.log("  ✓ install --all → installs all detected without prompting");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("testCmdInstallNoClientsFoundPrintsHelp", () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-install-noclients-"));
  try {
    const lines: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    const deps: InstallDeps = {
      homedir: () => home,
      checkCmd: () => false,
    };
    try {
      cmdInstall([], deps);
    } finally {
      console.error = orig;
    }

    const output = lines.join("\n");
    assert.ok(
      output.includes("no agent client found"),
      `should say no client found: ${output}`,
    );
    assert.ok(
      output.includes("--platform"),
      `should hint --platform: ${output}`,
    );
    console.log("  ✓ install no clients → prints help message");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("testCmdInstallNoPlatformDryRunNoWrite", async () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-install-dry-"));
  try {
    // Set up opencode config
    const ocDir = join(home, ".config", "opencode");
    mkdirSync(ocDir, { recursive: true });
    writeFileSync(join(ocDir, "opencode.json"), "{}");

    const deps: InstallDeps = {
      homedir: () => home,
      checkCmd: () => false,
      ask: async () => {
        throw new Error("dry run must never prompt");
      },
    };

    const lines: string[] = [];
    const origError = console.error;
    console.error = (...a: unknown[]) => {
      lines.push(a.map(String).join(" "));
    };
    const origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
    try {
      await cmdInstall(["--dry-run"], deps);
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
      console.error = origError;
    }

    const output = lines.join("\n");
    assert.ok(
      output.includes("✓ opencode"),
      `lists detected client: ${output}`,
    );
    assert.ok(
      output.includes("dry run — nothing is written"),
      `dry-run header: ${output}`,
    );
    // Config should NOT be modified (dry run)
    const cfg = JSON.parse(readFileSync(join(ocDir, "opencode.json"), "utf-8"));
    assert.deepStrictEqual(cfg, {}, "dry-run should not write opencode config");
    console.log("  ✓ install --dry-run → list only, no prompt, no writes");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
