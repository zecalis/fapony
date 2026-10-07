// src/knip/index.ts — barrel re-export.

export { filterKnipByScope } from "./filter.js";
export { formatKnipRows } from "./format.js";
export {
  interpretKnipSpawn,
  KNIP_TIMEOUT_MS,
  type KnipSpawnResult,
  runKnip,
} from "./run.js";
export {
  isSkipped,
  type KnipEntry,
  type KnipResult,
  type KnipRow,
  MAX_KNIP_FILES,
  MAX_KNIP_NAMES,
} from "./types.js";
