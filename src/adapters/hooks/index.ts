// src/adapters/hooks/index.ts — re-export all hook adapters

// Re-export hint-log for backwards compatibility.
export {
  type HintFireRow,
  type HintImpact,
  hintLogDir,
  hintLogPath,
  recordHintFire,
  worktreeKey,
} from "../../core/hint-log.js";
// Re-export pure helpers from core for backwards compatibility.
export {
  hookTsMs,
  sessionKey,
  utcStamp,
} from "../../core/hook-helpers.js";
export { computeHintImpact } from "./compute-hint-impact.js";
export { cmdHookMvGuard, mvGuardDecision } from "./mv-guard.js";
