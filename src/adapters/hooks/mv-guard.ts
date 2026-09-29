// src/adapters/hooks/mv-guard.ts — PreToolUse Bash guard: deny a raw `mv` /
// `git mv` of a plan file into a done/ directory, point at `fapony plan sweep
// --apply` instead.
//
// Manual `mv` skips the link rewrite plan-sweep does — that produced two
// rounds of dangling links (mem mtjn3ldk, mtl15q4y) and once, a plan moved to
// a path that doesn't exist (.fapony/plan/done/ instead of .fapony/done/).
// Every other fapony hook only annotates; this one denies, because asking
// ("should use plan-sweep") measurably does not change agent behavior —
// only required/reject and Stop-style blocks do (CLAUDE.md rule 9).
//
// Claude-only: OpenCode's tool.execute.after fires after the mv already ran,
// so there is nothing left to deny by the time that hook sees it.

const MV_PATTERN =
  /(?:git\s+)?mv\s+(?:-\S+\s+)*["']?([^"'\s]*\.fapony\/(?:[^/\s]+\/)*plan\/PLAN-[^"'\s]+\.md)["']?\s+["']?([^"'\s]*\bdone\/?)["']?/;

/** Deny reason for a raw `git mv <plan>.md <...done/>` command, or null to allow. */
export function mvGuardDecision(command: unknown): string | null {
  if (typeof command !== "string" || command === "") return null;
  const m = MV_PATTERN.exec(command);
  if (!m) return null;
  const [, src] = m;
  return (
    `fapony: raw \`git mv\` of a plan into done/ skips the link rewrite — ` +
    `run \`fapony plan sweep --apply ${src}\` instead, it moves the file ` +
    `and fixes inbound/outbound links together.`
  );
}

/** Claude Code PreToolUse (matcher Bash): stdin JSON in, deny decision out. */
export async function cmdHookMvGuard(): Promise<void> {
  try {
    const raw = JSON.parse(await Bun.stdin.text()) as {
      tool_input?: { command?: unknown };
    };
    const reason = mvGuardDecision(raw.tool_input?.command);
    if (reason) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
          },
        }),
      );
    }
  } catch {
    // a parse failure must never block a command — silence, not deny
  }
}
