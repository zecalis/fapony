import { test } from "bun:test";
import assert from "node:assert";
import { join } from "node:path";
import { mvGuardDecision } from "../../src/hook.js";
import { withTempRepo } from "./helpers.js";

test("testMvGuardDeniesPlanIntoDone", () => {
  assert.ok(
    mvGuardDecision("git mv .fapony/plan/PLAN-alerts.md .fapony/plan/done/"),
    "nested plan/done/ mistake is denied",
  );
  assert.ok(
    mvGuardDecision(
      "git mv apps/vela/.fapony/plan/PLAN-x.md apps/vela/.fapony/done/",
    ),
    "correct sibling done/ is still denied — plan-sweep is the required path",
  );
  const reason = mvGuardDecision(
    "git mv .fapony/plan/PLAN-alerts.md .fapony/done/",
  );
  assert.match(
    reason ?? "",
    /plan sweep --apply \.fapony\/plan\/PLAN-alerts\.md/,
  );
  console.log("  ✓ mvGuardDecision denies raw git mv of a plan into done/");
});

test("testMvGuardDeniesPlainMv", () => {
  const reason = mvGuardDecision(
    "mv .fapony/plan/PLAN-alerts.md .fapony/done/",
  );
  assert.ok(reason, "plain mv of a plan into done/ is denied");
  assert.match(
    reason ?? "",
    /plan sweep --apply \.fapony\/plan\/PLAN-alerts\.md/,
  );
  assert.ok(
    mvGuardDecision("mv -f .fapony/plan/PLAN-alerts.md .fapony/done/"),
    "mv flags don't slip past the guard",
  );
  assert.equal(
    mvGuardDecision("mv src/old.ts src/new.ts"),
    null,
    "non-plan plain mv is untouched",
  );
  assert.ok(
    mvGuardDecision("cd repo && git mv .fapony/plan/PLAN-x.md .fapony/done/"),
    "an mv after a shell separator still runs mv and is denied",
  );
  console.log("  ✓ mvGuardDecision denies plain mv of a plan into done/");
});

test("testMvGuardIgnoresProseMentions", () => {
  // Read-only commands that merely spell the pattern out are not mv — an
  // unanchored match used to deny them.
  for (const cmd of [
    "grep -rn 'mv .fapony/plan/PLAN-alerts.md .fapony/done/' docs/",
    "echo 'git mv .fapony/plan/PLAN-x.md .fapony/done/'",
    "git commit -m 'manually mv .fapony/plan/PLAN-x.md .fapony/done/'",
  ])
    assert.equal(mvGuardDecision(cmd), null, `prose mention must pass: ${cmd}`);
  console.log(
    "  ✓ mvGuardDecision ignores prose that only mentions the pattern",
  );
});

test("testMvGuardAllowsEverythingElse", () => {
  assert.equal(mvGuardDecision(undefined), null);
  assert.equal(mvGuardDecision(""), null);
  assert.equal(mvGuardDecision("ls .fapony/plan"), null);
  assert.equal(
    mvGuardDecision("git mv src/old.ts src/new.ts"),
    null,
    "non-plan file mv is untouched",
  );
  assert.equal(
    mvGuardDecision("git mv .fapony/plan/PLAN-x.md .fapony/spec/"),
    null,
    "moving a plan somewhere that isn't done/ is untouched",
  );
  console.log(
    "  ✓ mvGuardDecision allows every command outside its one pattern",
  );
});

test("testMvGuardClaudeOutputShape", () => {
  withTempRepo((dir) => {
    const proc = Bun.spawnSync(
      ["bun", join(import.meta.dir, "..", "..", "fapony.ts"), "hook-mv-guard"],
      {
        cwd: dir,
        stdin: Buffer.from(
          JSON.stringify({
            tool_input: {
              command: "git mv .fapony/plan/PLAN-x.md .fapony/done/",
            },
          }),
        ),
        stdout: "pipe",
      },
    );
    const out = JSON.parse(proc.stdout.toString()) as {
      hookSpecificOutput: Record<string, string>;
    };
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(
      out.hookSpecificOutput.permissionDecisionReason ?? "",
      /plan sweep --apply/,
    );
  });
  console.log("  ✓ mv guard claude output = permissionDecision deny");
});

test("testMvGuardDeniesParkAndUnparkByHand", () => {
  assert.match(
    mvGuardDecision("git mv .fapony/plan/PLAN-x.md .fapony/parked/") ?? "",
    /plan park --apply \.fapony\/plan\/PLAN-x\.md/,
  );
  assert.match(
    mvGuardDecision("mv .fapony/parked/PLAN-x.md .fapony/plan/PLAN-x.md") ?? "",
    /plan unpark --apply \.fapony\/parked\/PLAN-x\.md/,
  );
  assert.equal(
    mvGuardDecision("git mv .fapony/plan/PLAN-a.md .fapony/plan/PLAN-b.md"),
    null,
    "a rename inside plan/ moves no links",
  );
});
