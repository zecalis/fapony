import { test } from "bun:test";
// test/session/claude-code.test.ts — Claude Code session usage tests

import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeCodeUsage } from "../../src/session/index.js";
import { withClaudeCodeFixture, withEnv } from "./helpers.js";

test("testReadClaudeCodeUsageNoDir", () => {
  withEnv("FAPONY_CLAUDE_PROJECTS_DIR", "/nonexistent/claude/projects", () => {
    const result = readClaudeCodeUsage();
    assert.equal(result.session_count, 0);
    assert.equal(result.total_tokens_input, 0);
    console.log("  ✓ readClaudeCodeUsage no dir → empty result");
  });
});

test("testReadClaudeCodeUsagePrimaryPath", () => {
  withClaudeCodeFixture((dir) => {
    withEnv("FAPONY_CLAUDE_PROJECTS_DIR", join(dir, "projects"), () => {
      const result = readClaudeCodeUsage("/tmp/test-worktree");
      assert.equal(
        result.session_count,
        2,
        `got ${result.session_count} sessions`,
      );
      assert.equal(result.total_tokens_input, 450);
      assert.equal(result.total_tokens_output, 190);
      assert.equal(result.total_tokens_reasoning, 40);
      assert.equal(result.total_tokens_cache_read, 25);
      assert.equal(result.total_tokens_cache_write, 50);
      assert.equal(result.total_cost, 0, "Claude Code has no cost");
      assert.ok(result.by_model.length >= 1);
      const sonnet = result.by_model.find((m) => m.model === "claude-sonnet-5");
      assert.ok(sonnet, "claude-sonnet-5 found");
      assert.equal(sonnet!.tokens_input, 250);
      console.log("  ✓ readClaudeCodeUsage primary path → reads JSONL files");
    });
  });
});

test("testReadClaudeCodeUsageStaleReads", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-claude-code-stale-"));
  const projectDir = join(dir, "projects", "-tmp-test-worktree");
  mkdirSync(projectDir, { recursive: true });

  const toolUseLine = (
    model: string,
    ts: string,
    tool: "Read" | "Edit",
    file: string,
  ) =>
    JSON.stringify({
      message: {
        model,
        content: [
          {
            type: "tool_use",
            id: `u-${ts}`,
            name: tool,
            input: { file_path: file },
          },
        ],
      },
      timestamp: ts,
      cwd: "/tmp/test-worktree",
    });
  const usageLine = (model: string, ts: string) =>
    JSON.stringify({
      message: { model, usage: { input_tokens: 10, output_tokens: 5 } },
      timestamp: ts,
      cwd: "/tmp/test-worktree",
    });

  const session1 = [
    toolUseLine(
      "claude-sonnet-5",
      "2026-09-09T03:00:00.000Z",
      "Read",
      "/repo/CLAUDE.md",
    ),
    usageLine("claude-sonnet-5", "2026-09-09T03:00:01.000Z"),
  ].join("\n");
  const session2 = [
    toolUseLine(
      "claude-sonnet-5",
      "2026-09-09T04:00:00.000Z",
      "Read",
      "/repo/CLAUDE.md",
    ),
    toolUseLine(
      "claude-sonnet-5",
      "2026-09-09T04:00:01.000Z",
      "Read",
      "/repo/scratch.ts",
    ),
    toolUseLine(
      "claude-sonnet-5",
      "2026-09-09T04:00:02.000Z",
      "Edit",
      "/repo/scratch.ts",
    ),
    usageLine("claude-sonnet-5", "2026-09-09T04:00:03.000Z"),
  ].join("\n");

  writeFileSync(join(projectDir, "session-1.jsonl"), session1);
  writeFileSync(join(projectDir, "session-2.jsonl"), session2);

  withEnv("FAPONY_CLAUDE_PROJECTS_DIR", join(dir, "projects"), () => {
    const result = readClaudeCodeUsage(
      "/tmp/test-worktree",
      undefined,
      undefined,
      true,
    );
    assert.ok(result.detail, "detail:true must include detail");
    const stale = result.detail!.stale_reads ?? [];
    const claudeMd = stale.find((s) => s.file === "/repo/CLAUDE.md");
    assert.ok(claudeMd, "CLAUDE.md flagged as stale");
    assert.equal(claudeMd!.sessions, 2);
    assert.equal(claudeMd!.reads, 2);
    assert.ok(
      !stale.find((s) => s.file === "/repo/scratch.ts"),
      "edited file is never flagged as stale",
    );
    console.log(
      "  ✓ readClaudeCodeUsage detail → stale_reads flags multi-session reads that are never edited",
    );
  });
  rmSync(dir, { recursive: true, force: true });
});

test("testReadClaudeCodeUsageFilterByWorktree", () => {
  withClaudeCodeFixture((dir) => {
    withEnv("FAPONY_CLAUDE_PROJECTS_DIR", join(dir, "projects"), () => {
      const result = readClaudeCodeUsage("/tmp/test-worktree");
      assert.equal(result.session_count, 2);
      const empty = readClaudeCodeUsage("/nonexistent/wt");
      assert.equal(empty.session_count, 0);
      console.log("  ✓ readClaudeCodeUsage filter by worktree");
    });
  });
});

test("testReadClaudeCodeUsageSkipsMalformedLines", () => {
  const dir = mkdtempSync(join(tmpdir(), "fapony-claude-malformed-"));
  const projectDir = join(dir, "projects", "-tmp-test-worktree");
  mkdirSync(projectDir, { recursive: true });

  const content = [
    "not valid json at all",
    JSON.stringify({
      message: {
        model: "claude-sonnet-5",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
      timestamp: "2026-09-09T03:00:00.000Z",
      cwd: "/tmp/test-worktree",
    }),
    "{ broken json",
    JSON.stringify({ type: "queue-operation" }),
  ].join("\n");

  writeFileSync(join(projectDir, "session-1.jsonl"), content);

  withEnv("FAPONY_CLAUDE_PROJECTS_DIR", join(dir, "projects"), () => {
    const result = readClaudeCodeUsage("/tmp/test-worktree");
    assert.equal(result.session_count, 1, "skips malformed lines");
    assert.equal(result.total_tokens_input, 100);
    console.log("  ✓ readClaudeCodeUsage skips malformed lines");
  });
  rmSync(dir, { recursive: true, force: true });
});

test("testReadClaudeCodeUsageDedupesMessageIdAcrossBlockLines", () => {
  // Claude Code writes one line per content block; each repeats the
  // message's id + usage snapshot. Count it once (#157).
  const dir = mkdtempSync(join(tmpdir(), "fapony-claude-code-dedupe-"));
  const projectDir = join(dir, "projects", "-tmp-test-worktree");
  mkdirSync(projectDir, { recursive: true });
  const line = (id: string, block: object) =>
    JSON.stringify({
      type: "assistant",
      message: {
        id,
        model: "claude-sonnet-5",
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          cache_read_input_tokens: 500,
        },
        content: [block],
      },
      timestamp: "2026-09-09T03:00:00.000Z",
    });
  writeFileSync(
    join(projectDir, "s1.jsonl"),
    [
      line("msg_a", { type: "text", text: "hi" }),
      line("msg_a", { type: "tool_use", id: "t1", name: "Read", input: {} }),
      line("msg_a", { type: "tool_use", id: "t2", name: "Bash", input: {} }),
      line("msg_b", { type: "text", text: "done" }),
    ].join("\n"),
  );
  withEnv("FAPONY_CLAUDE_PROJECTS_DIR", join(dir, "projects"), () => {
    const r = readClaudeCodeUsage(
      "/tmp/test-worktree",
      undefined,
      undefined,
      true,
    );
    assert.equal(r.total_tokens_input, 2000);
    assert.equal(r.total_tokens_output, 100);
    assert.equal(r.total_tokens_cache_read, 1000);
    assert.equal(r.detail?.steps, 2);
    assert.equal(r.detail?.tool_breakdown.Read, 1);
    assert.equal(r.detail?.tool_breakdown.Bash, 1);
    console.log("  ✓ readClaudeCodeUsage counts each message id once");
  });
  rmSync(dir, { recursive: true, force: true });
});
