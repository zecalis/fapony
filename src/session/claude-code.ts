// src/session/claude-code.ts — Claude Code passive usage reader
//
// Reads ~/.claude/projects/<encoded-cwd>/*.jsonl (one file per session).
// Each line is a JSON object; usage data lives in message.usage on
// assistant-response lines. No cost field — total_cost is always 0.
//
// No detail (tool/step breakdown) in v1 — JSONL has no part-table equivalent.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTimeMs, summarizeTiming, type TimingInput } from "./helpers.js";
import {
  EMPTY_RESULT,
  type ModelBreakdown,
  type PassiveUsageResult,
  type SessionDetail,
  type UsageDetail,
} from "./types.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

function resolveProjectsDir(optDir?: string): string {
  return optDir ?? process.env.FAPONY_CLAUDE_PROJECTS_DIR ?? PROJECTS_DIR;
}

/** Encode a file path the same way Claude Code does: `/` → `-`. */
function encodePath(p: string): string {
  return p.replace(/\//g, "-");
}

interface UsageLine {
  message?: {
    id?: string;
    model?: string;
    content?: Array<{
      type?: string;
      id?: string;
      name?: string;
      tool_use_id?: string;
      input?: { file_path?: string };
    }>;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens_details?: {
        thinking_tokens?: number;
      };
    };
  };
  timestamp?: string;
}

interface ModelAcc {
  provider: string;
  session_count: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  cost: number;
}

/**
 * Read passive usage from Claude Code JSONL session files.
 * Returns EMPTY_RESULT when the projects dir or matching project subdir doesn't exist.
 *
 * detail:true adds a UsageDetail: tool_breakdown from tool_use blocks,
 * steps = usage-line count, per-file by_session, plus timing (turn gaps as
 * step durations, tool_use→tool_result latency matched by tool_use_id,
 * per-turn usage as per-step tokens). Averages only — never summed.
 */
export function readClaudeCodeUsage(
  worktree?: string,
  since?: number,
  until?: number,
  detail?: boolean,
): PassiveUsageResult {
  const projectsDir = resolveProjectsDir();

  // Determine which project dirs to scan.
  let projectDirs: string[];
  if (worktree) {
    const encoded = encodePath(worktree);
    const dir = join(projectsDir, encoded);
    try {
      if (!statSync(dir).isDirectory()) return EMPTY_RESULT;
    } catch {
      return EMPTY_RESULT;
    }
    projectDirs = [dir];
  } else {
    // Scan all project subdirectories.
    try {
      projectDirs = readdirSync(projectsDir)
        .map((name) => join(projectsDir, name))
        .filter((p) => {
          try {
            return statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
    } catch {
      return EMPTY_RESULT;
    }
  }

  if (projectDirs.length === 0) return EMPTY_RESULT;

  // Aggregate across all project dirs and session files.
  const models = new Map<string, ModelAcc>();
  let totalSessions = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalReasoning = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  // Detail accumulators (only filled when detail:true).
  const toolBreakdown: Record<string, number> = {};
  const bytesByTool: Record<string, number> = {};
  const bySession: SessionDetail[] = [];
  // file -> {reads, sessions that read it} — for stale_reads (PLAN-loop-and-savings step 10).
  const fileReads = new Map<string, { reads: number; sessions: Set<string> }>();
  const filesEverEdited = new Set<string>();
  const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
  const timingInput: TimingInput = {
    durationsMs: [],
    stepTokens: [],
    toolLatencies: [],
    steps: 0,
  };

  /** Same since/until gate as the main loop — detail must match totals. */
  function inRange(ts: number | null): boolean {
    if (ts === null) return true;
    const s = ts / 1000;
    if (since !== undefined && s < since) return false;
    if (until !== undefined && s > until) return false;
    return true;
  }

  for (const projectDir of projectDirs) {
    let files: string[];
    try {
      files = readdirSync(projectDir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => join(projectDir, f));
    } catch {
      continue;
    }

    for (const filePath of files) {
      // ponytail: skip files untouched since `since` before reading them —
      // a JSONL session file is append-only, so mtime < since means every
      // line in it is out of range. Avoids paying full-file read+parse cost
      // (the real bottleneck) on old history when a time window is given.
      if (since !== undefined) {
        try {
          if (statSync(filePath).mtimeMs / 1000 < since) continue;
        } catch {
          continue;
        }
      }
      let content: string;
      try {
        content = readFileSync(filePath, "utf-8");
      } catch {
        continue;
      }

      let fileSessions = 0;
      // Claude Code writes one line per content block, each repeating the
      // message's id and usage snapshot — count each message id once (#157).
      const seenIds = new Set<string>();
      const lines = content.split("\n");
      for (const line of lines) {
        if (!line?.includes("input_tokens")) continue;

        let parsed: UsageLine;
        try {
          parsed = JSON.parse(line) as UsageLine;
        } catch {
          continue; // malformed line — skip, don't abort
        }

        const usage = parsed.message?.usage;
        if (!usage) continue;
        const msgId = parsed.message?.id;
        if (msgId) {
          if (seenIds.has(msgId)) continue;
          seenIds.add(msgId);
        }

        // Timestamp filtering.
        if (parsed.timestamp) {
          const ts = new Date(parsed.timestamp).getTime() / 1000;
          if (since !== undefined && ts < since) continue;
          if (until !== undefined && ts > until) continue;
        }

        const model = parsed.message?.model ?? "(unknown)";
        const input = usage.input_tokens ?? 0;
        const output = usage.output_tokens ?? 0;
        const reasoning = usage.output_tokens_details?.thinking_tokens ?? 0;
        const cacheRead = usage.cache_read_input_tokens ?? 0;
        const cacheWrite = usage.cache_creation_input_tokens ?? 0;

        // Only count the first usage line per file as a session.
        fileSessions++;

        let acc = models.get(model);
        if (!acc) {
          acc = {
            provider: "anthropic",
            session_count: 0,
            tokens_input: 0,
            tokens_output: 0,
            tokens_reasoning: 0,
            tokens_cache_read: 0,
            tokens_cache_write: 0,
            cost: 0,
          };
          models.set(model, acc);
        }
        acc.tokens_input += input;
        acc.tokens_output += output;
        acc.tokens_reasoning += reasoning;
        acc.tokens_cache_read += cacheRead;
        acc.tokens_cache_write += cacheWrite;

        totalInput += input;
        totalOutput += output;
        totalReasoning += reasoning;
        totalCacheRead += cacheRead;
        totalCacheWrite += cacheWrite;
      }

      if (fileSessions > 0) {
        totalSessions++;
        // Attribute 1 session to each model that appeared in this file.
        const seenModels = new Set<string>();
        for (const line of lines) {
          if (!line.includes("input_tokens")) continue;
          try {
            const parsed = JSON.parse(line) as UsageLine;
            const m = parsed.message?.model;
            if (m && !seenModels.has(m)) {
              seenModels.add(m);
              const acc = models.get(m);
              if (acc) acc.session_count++;
            }
          } catch {
            /* skip malformed */
          }
        }
      }

      // Detail pass: tool_use blocks, per-turn usage, tool_use→tool_result
      // latency (matched by tool_use_id), turn gaps as step durations.
      if (detail && fileSessions > 0) {
        const fileTools: Record<string, number> = {};
        const fileBytesByTool: Record<string, number> = {};
        const turnTs: Array<number | null> = [];
        const useTs = new Map<string, { name: string; ts: number | null }>();
        let fileSteps = 0;
        let fileModel: string | null = null;
        const stepIds = new Set<string>();
        for (const line of lines) {
          if (!line) continue;
          let parsed: UsageLine;
          try {
            parsed = JSON.parse(line) as UsageLine;
          } catch {
            continue;
          }
          const ts = parseTimeMs(parsed.timestamp ?? null);
          if (!inRange(ts)) continue;
          const blocks = parsed.message?.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks) {
              if (b?.type === "tool_use" && typeof b.id === "string") {
                const name =
                  typeof b.name === "string" && b.name ? b.name : "(unknown)";
                useTs.set(b.id, { name, ts });
                fileTools[name] = (fileTools[name] ?? 0) + 1;
                toolBreakdown[name] = (toolBreakdown[name] ?? 0) + 1;
                const fp = b.input?.file_path;
                if (typeof fp === "string" && fp) {
                  if (name === "Read") {
                    let acc = fileReads.get(fp);
                    if (!acc) {
                      acc = { reads: 0, sessions: new Set() };
                      fileReads.set(fp, acc);
                    }
                    acc.reads++;
                    acc.sessions.add(filePath);
                  } else if (EDIT_TOOLS.has(name)) {
                    filesEverEdited.add(fp);
                  }
                }
              } else if (
                b?.type === "tool_result" &&
                typeof b.tool_use_id === "string"
              ) {
                const use = useTs.get(b.tool_use_id);
                if (use && use.ts !== null && ts !== null && ts >= use.ts)
                  timingInput.toolLatencies.push({
                    tool: use.name,
                    ms: ts - use.ts,
                  });
                // Measure context bytes consumed by this tool_result.
                // JSON.stringify length is a proxy for token count — ratio
                // error cancels when comparing tool-to-tool (same encoding).
                if (use) {
                  const bytes = JSON.stringify(b).length;
                  fileBytesByTool[use.name] =
                    (fileBytesByTool[use.name] ?? 0) + bytes;
                  bytesByTool[use.name] = (bytesByTool[use.name] ?? 0) + bytes;
                }
              }
            }
          }
          const usage = parsed.message?.usage;
          const stepId = parsed.message?.id;
          const repeat = !!stepId && stepIds.has(stepId);
          if (stepId) stepIds.add(stepId);
          if (usage && !repeat) {
            fileSteps++;
            turnTs.push(ts);
            timingInput.steps++;
            timingInput.stepTokens.push({
              input:
                typeof usage.input_tokens === "number"
                  ? usage.input_tokens
                  : null,
              output:
                typeof usage.output_tokens === "number"
                  ? usage.output_tokens
                  : null,
              cost: null, // Claude Code JSONL has no cost field
            });
            if (!fileModel && typeof parsed.message?.model === "string")
              fileModel = parsed.message.model;
          }
        }
        // Turn gaps within this file only (cross-file gaps are meaningless).
        for (let i = 1; i < turnTs.length; i++) {
          const a = turnTs[i - 1];
          const b = turnTs[i];
          timingInput.durationsMs.push(
            a !== null && b !== null && b >= a ? b - a : null,
          );
        }
        if (fileSteps > 0) {
          bySession.push({
            // Use project-relative path as session_id to avoid collisions
            // across project directories with same-named files.
            session_id: filePath.slice(projectDir.length + 1),
            model: fileModel ?? "(unknown)",
            steps: fileSteps,
            tools: fileTools,
          });
        }
      }
    }
  }

  if (totalSessions === 0) return EMPTY_RESULT;

  // Files read in 2+ sessions and never edited in this window — candidates
  // for CLAUDE.md instead of a Read every session.
  const staleReads = [...fileReads.entries()]
    .filter(([fp, acc]) => acc.sessions.size >= 2 && !filesEverEdited.has(fp))
    .map(([file, acc]) => ({
      file,
      sessions: acc.sessions.size,
      reads: acc.reads,
    }))
    .sort((a, b) => b.sessions - a.sessions)
    .slice(0, 20);

  const by_model: ModelBreakdown[] = [...models.entries()]
    .map(([model, acc]) => ({
      provider: acc.provider,
      model,
      session_count: acc.session_count,
      tokens_input: acc.tokens_input,
      tokens_output: acc.tokens_output,
      tokens_reasoning: acc.tokens_reasoning,
      tokens_cache_read: acc.tokens_cache_read,
      tokens_cache_write: acc.tokens_cache_write,
      cost: acc.cost,
    }))
    .sort((a, b) => b.cost - a.cost || b.tokens_input - a.tokens_input);

  return {
    total_tokens_input: totalInput,
    total_tokens_output: totalOutput,
    total_tokens_reasoning: totalReasoning,
    total_tokens_cache_read: totalCacheRead,
    total_tokens_cache_write: totalCacheWrite,
    total_cost: 0, // Claude Code JSONL has no cost field
    session_count: totalSessions,
    by_model,
    ...(detail
      ? {
          detail: {
            tool_breakdown: toolBreakdown,
            bytes_by_tool:
              Object.keys(bytesByTool).length > 0 ? bytesByTool : undefined,
            steps: timingInput.steps,
            by_session: bySession.sort((a, b) => b.steps - a.steps),
            stale_reads: staleReads.length > 0 ? staleReads : undefined,
            note: "per-turn usage overlaps like per-step tokens — steps is a count only",
            timing: summarizeTiming(timingInput),
          } satisfies UsageDetail,
        }
      : {}),
  };
}
