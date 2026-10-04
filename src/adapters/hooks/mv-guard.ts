// src/adapters/hooks/mv-guard.ts — PreToolUse Bash guard: deny a raw `mv` /
// `git mv` of a plan file between plan/, parked/ and done/, point at
// `fapony plan sweep|park|unpark --apply` instead.
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

// Anchored to the start of the command or a shell segment (`; & |` newline):
// an unanchored `mv` also matched grep/echo/commit-message prose that merely
// spelled the pattern out, denying read-only commands. Only a command that
// actually runs `mv`/`git mv` is denied.
// Source: a plan in plan/ or parked/. Target: the next token, read by
// `targetDir` — a rename inside the same dir passes.
const MV_PATTERN =
  /(?:^|[;&|\n])\s*(?:git\s+)?mv\s+(?:-\S+\s+)*["']?([^"'\s]*\.fapony\/(?:[^/\s]+\/)*(plan|parked)\/PLAN-[^"'\s]+\.md)["']?\s+["']?([^"'\s;&|]+)/;

// done/ anywhere (paths.doneDir may sit outside .fapony/; `plan/done/` is the
// legacy layout); plan/ and parked/ only under .fapony/ — ~/archive/plan/ is
// the user's own dir, not a plan dir.
const targetDir = (token: string): string | null => {
  const dir = token.replace(/\/(?:PLAN-[^/]*\.md)?$/, "");
  if (/(?:^|\/)done$/.test(dir)) return "done";
  return /\.fapony\/(?:[^/]+\/)*(parked|plan)$/.exec(dir)?.[1] ?? null;
};

const FIX: Record<string, string> = {
  done: "fapony plan sweep",
  parked: "fapony plan park",
  plan: "fapony plan unpark",
};

/** Deny reason for a raw `mv` of a plan between plan/, parked/ and done/, or null to allow. */
export function mvGuardDecision(command: unknown): string | null {
  if (typeof command !== "string" || command === "") return null;
  const m = MV_PATTERN.exec(command);
  if (!m) return null;
  const [, src, from, token] = m;
  const to = targetDir(token);
  if (!to || from === to) return null; // a rename inside one dir moves no links
  return (
    `fapony: raw \`git mv\` of a plan into ${to}/ skips the link rewrite — ` +
    `run \`${FIX[to]} --apply ${src}\` instead, it moves the file ` +
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
