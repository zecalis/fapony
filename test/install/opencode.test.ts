import { test } from "bun:test";
// test/install/opencode.test.ts — OpenCode install provider

import assert from "node:assert";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  claudeSkillsDir,
  cmdInstall,
  cmdInstallOpencode,
  opencodePluginFiles,
} from "../../src/install.js";
import {
  captureErrors,
  silentErrors,
  skillNames,
  testExit,
  withTempHome,
} from "./helpers.js";

const pluginsDir = (home: string): string =>
  join(home, ".config", "opencode", "plugins");

test("testInstallOpencodeLinksSkillsAndNeverWritesConfig", () => {
  withTempHome((home) => {
    silentErrors(() =>
      cmdInstallOpencode(false, { exit: testExit, homedir: () => home }),
    );
    const dir = claudeSkillsDir(() => home);
    for (const name of skillNames()) {
      assert.ok(lstatSync(join(dir, name)).isSymbolicLink(), name);
    }
    // MCP moved to fael — no opencode.json write.
    assert.ok(!existsSync(join(home, ".config", "opencode", "opencode.json")));
    // No default plugin since the edit hint was cut.
    assert.deepStrictEqual(
      opencodePluginFiles(() => home),
      [],
    );
  });
});

test("testCmdInstallDispatchesOpencode", () => {
  withTempHome((home) => {
    void silentErrors(() =>
      cmdInstall(["opencode"], { exit: testExit, homedir: () => home }),
    );
    assert.ok(lstatSync(claudeSkillsDir(() => home)).isDirectory());
  });
});

test("testInstallOpencodeRemovesRetiredPlugins", () => {
  withTempHome((home) => {
    const dir = pluginsDir(home);
    mkdirSync(dir, { recursive: true });
    const ours = {
      "fapony-read-hint.ts": "export const FaponyReadHint = 1;\n",
      "fapony-commit-hint.ts": "export const FaponyCommitHint = 1;\n",
      "fapony-session-start.ts": "export const FaponySessionStart = 1;\n",
      "fapony-edit-hint.ts": "export const FaponyEditHint = 1;\n",
    };
    for (const [f, body] of Object.entries(ours)) {
      writeFileSync(join(dir, f), body);
    }
    // Same file name, not ours — never touched.
    writeFileSync(join(dir, "fapony-commit-hint.ts"), "// my own plugin\n");

    silentErrors(() =>
      cmdInstallOpencode(true, { homedir: () => home }, { pluginsOnly: true }),
    );
    assert.ok(existsSync(join(dir, "fapony-read-hint.ts")), "dry run keeps");

    const err = captureErrors(() =>
      cmdInstallOpencode(false, { homedir: () => home }, { pluginsOnly: true }),
    );
    assert.ok(!existsSync(join(dir, "fapony-read-hint.ts")));
    assert.ok(!existsSync(join(dir, "fapony-session-start.ts")));
    assert.ok(!existsSync(join(dir, "fapony-edit-hint.ts")));
    assert.equal(
      readFileSync(join(dir, "fapony-commit-hint.ts"), "utf-8"),
      "// my own plugin\n",
    );
    assert.ok(err.includes("removed"), err);
  });
});

test("testInstallOpencodePluginsOnlySkipsSkills", () => {
  withTempHome((home) => {
    silentErrors(() =>
      cmdInstallOpencode(false, { homedir: () => home }, { pluginsOnly: true }),
    );
    assert.ok(!existsSync(claudeSkillsDir(() => home)));
  });
});

test("testOpencodePluginFiles", () => {
  withTempHome((home) => {
    assert.deepStrictEqual(
      opencodePluginFiles(() => home),
      [],
      "no plugins dir → nothing installed",
    );
    const pluginsDir = join(home, ".config", "opencode", "plugins");
    mkdirSync(pluginsDir, { recursive: true });
    // A foreign plugin must never count — that's what keeps update from
    // touching a file the user owns.
    writeFileSync(join(pluginsDir, "someone-else.ts"), "// x\n");
    assert.deepStrictEqual(
      opencodePluginFiles(() => home),
      [],
      "a foreign plugin is not a fapony install",
    );
    writeFileSync(join(pluginsDir, "fapony-read-hint.ts"), "// ours\n");
    writeFileSync(join(pluginsDir, "fapony-edit-hint.ts"), "// ours\n");
    assert.deepStrictEqual(
      opencodePluginFiles(() => home).sort(),
      ["fapony-edit-hint.ts", "fapony-read-hint.ts"],
      "lists every fapony-*.ts plugin, and only those",
    );
  });
  console.log("  ✓ opencodePluginFiles lists fapony plugins, ignores foreign");
});
