import { test } from "bun:test";
// test/install/skills.test.ts — linkSkills (skill symlinks shared by all clients)

import assert from "node:assert";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isFaponySkillLink,
  refreshSkillLinks,
} from "../../src/install/skills.js";
import { INSTALL_ROOT, linkSkills } from "../../src/install.js";
import { skillNames } from "./helpers.js";

test("testLinkSkillsCreatesSymlinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    const results = linkSkills(dir, false);
    const names = skillNames();
    assert.ok(names.length > 0, "repo should ship at least one skill");
    assert.deepStrictEqual(
      results.map((r) => r.name),
      names,
    );
    assert.ok(results.every((r) => r.action === "linked"));
    for (const name of names) {
      const dest = join(dir, name);
      assert.ok(
        lstatSync(dest).isSymbolicLink(),
        `${name} should be a symlink`,
      );
      assert.strictEqual(readlinkSync(dest), join(INSTALL_ROOT, "skill", name));
      // the link must resolve to the real SKILL.md, not just exist
      assert.ok(existsSync(join(dest, "SKILL.md")));
    }
    console.log("  ✓ linkSkills symlinks each skill dir");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsIdempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    linkSkills(dir, false);
    const second = linkSkills(dir, false);
    assert.ok(
      second.every((r) => r.action === "already"),
      "re-linking should report already, not conflict",
    );
    console.log("  ✓ linkSkills is idempotent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsRefusesOverwrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    const victim = skillNames()[0];
    mkdirSync(join(dir, victim), { recursive: true });
    writeFileSync(join(dir, victim, "SKILL.md"), "# not fapony's\n");

    const results = linkSkills(dir, false);
    const hit = results.find((r) => r.name === victim);
    assert.strictEqual(hit?.action, "conflict");
    assert.strictEqual(
      readFileSync(join(dir, victim, "SKILL.md"), "utf-8"),
      "# not fapony's\n",
      "an existing skill must survive untouched",
    );
    assert.ok(
      results.some((r) => r.action === "linked"),
      "one conflict must not block the other skills",
    );
    console.log("  ✓ linkSkills never overwrites an existing skill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsReplacesForeignCheckoutLink", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    const victim = skillNames()[0];
    // a link into another fapony checkout (e.g. bun link → npm switch)
    symlinkSync(join("/tmp/other-fapony", "skill", victim), join(dir, victim));

    const results = linkSkills(dir, false);
    const hit = results.find((r) => r.name === victim);
    assert.strictEqual(hit?.action, "linked");
    assert.strictEqual(
      readlinkSync(join(dir, victim)),
      join(INSTALL_ROOT, "skill", victim),
    );
    console.log("  ✓ linkSkills replaces a link into another fapony checkout");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsKeepsForeignToolLink", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    const victim = skillNames()[0];
    symlinkSync("/tmp/some-other-tool", join(dir, victim));

    const results = linkSkills(dir, false);
    assert.strictEqual(
      results.find((r) => r.name === victim)?.action,
      "conflict",
    );
    assert.strictEqual(readlinkSync(join(dir, victim)), "/tmp/some-other-tool");
    assert.ok(isFaponySkillLink(join("/x", "skill", victim), victim));
    assert.ok(!isFaponySkillLink("/tmp/some-other-tool", victim));
    console.log("  ✓ linkSkills keeps a non-fapony symlink as conflict");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsDryRunNoWrite", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    const results = linkSkills(dir, true);
    assert.ok(results.every((r) => r.action === "linked"));
    for (const r of results) {
      assert.ok(
        !existsSync(join(dir, r.name)),
        `${r.name} must not be created`,
      );
    }
    console.log("  ✓ linkSkills --dry-run creates nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testLinkSkillsPrunesDeadFaponyLinks", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-skills-"));
  try {
    // A skill fapony no longer ships: its link now dangles.
    symlinkSync(
      join(INSTALL_ROOT, "skill", "gone-skill"),
      join(dir, "gone-skill"),
    );
    // Dangling but not fapony's shape, and fapony's shape but resolving: kept.
    symlinkSync("/nonexistent/elsewhere/gone", join(dir, "theirs"));
    const live = mkdtempSync(join(tmpdir(), "fapony-live-"));
    mkdirSync(join(live, "skill", "kept"), { recursive: true });
    symlinkSync(join(live, "skill", "kept"), join(dir, "kept"));

    const dry = linkSkills(dir, true);
    assert.ok(
      dry.some((r) => r.name === "gone-skill" && r.action === "pruned"),
    );
    assert.ok(
      lstatSync(join(dir, "gone-skill")).isSymbolicLink(),
      "dry run keeps it",
    );

    const results = linkSkills(dir, false);
    assert.deepStrictEqual(
      results.filter((r) => r.action === "pruned").map((r) => r.name),
      ["gone-skill"],
    );
    assert.throws(() => lstatSync(join(dir, "gone-skill")));
    assert.ok(lstatSync(join(dir, "theirs")).isSymbolicLink());
    assert.ok(lstatSync(join(dir, "kept")).isSymbolicLink());
    rmSync(live, { recursive: true, force: true });
    console.log("  ✓ linkSkills prunes only dead fapony-shaped links");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("testRefreshSkillLinksOnlyWhereInstalled", () => {
  const home = mkdtempSync(join(tmpdir(), "fapony-home-"));
  try {
    const claude = join(home, ".claude", "skills");
    const agents = join(home, ".agents", "skills");
    mkdirSync(claude, { recursive: true });
    mkdirSync(agents, { recursive: true });
    symlinkSync(
      join(INSTALL_ROOT, "skill", "gone-skill"),
      join(claude, "gone-skill"),
    );

    assert.equal(
      refreshSkillLinks(() => home),
      true,
    );
    assert.throws(() => lstatSync(join(claude, "gone-skill")));
    for (const name of skillNames()) {
      assert.strictEqual(
        readlinkSync(join(claude, name)),
        join(INSTALL_ROOT, "skill", name),
      );
    }
    assert.throws(
      () => lstatSync(join(agents, skillNames()[0])),
      "a dir with no fapony link is never linked into",
    );
    console.log(
      "  ✓ refreshSkillLinks re-links only dirs fapony installed into",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
