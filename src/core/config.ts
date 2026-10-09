// src/core/config.ts — pure config single source (PLAN-lib-layer chunk 4).
// Merged from db/{defaults,types,getters,load} (shims removed — 0 importers).
// db/ keeps only store.ts (bun:sqlite).
// Pure = node builtins only, no imports back to features/adapters/db-store.

export { DEFAULT_SAFETY_DENY } from "./defaults.js";

// --- Types (ex db/types.ts — ledger frozen, types only, no logic change) ---

export type RunStatus =
  | "running"
  | "awaiting_review"
  | "fixing"
  | "passed"
  | "stopped"
  | "stalled";

export interface Run {
  id: number;
  worktree: string;
  plan: string | null;
  mem_id: string | null;
  status: RunStatus;
  base_sha: string;
  round: number;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: number;
  run_id: number;
  ts: string;
  kind: string;
  data: string | null;
}

export interface Config {
  worktrees: Record<string, string>;
  review: {
    maxRounds: number;
  };
  memory: {
    claim: string[];
    close: string[];
    add: string[];
    kickoff?: string[];
  } | null;
  // opt-in only — omit or leave null to keep everything local. See TELEMETRY.md
  // for the exact payload shape (KPI numbers + event kind/timestamp, no
  // plan/commit/gate-note content, ever).
  telemetry?: {
    enabled: boolean;
    endpoint: string;
    /** Self-reported metadata — advisory, not machine-observed. */
    metadata?: {
      task_category?: string;
      stack?: string;
      notes?: string;
    };
  } | null;
  // --- Flexible paths / limits (all optional, defaults = old hardcodes) ---
  paths?: {
    // state dir override (default: $XDG_CONFIG_HOME/fapony or ~/.config/fapony).
    // $FAPONY_STATE_DIR env wins over this when set.
    stateDir?: string;
    // plan/spec live in .fapony/{plan,spec} — not configurable (gitignored = private).
    doneDir?: string;
    evidenceFile?: string;
  } | null;
  safety?: {
    // regex sources tested against the joined argv; default = the 4 git patterns.
    deny?: string[];
  } | null;
  usageWeb?: {
    port?: number;
    hostname?: string;
    ownerName?: string;
  } | null;
}

export interface RolePricing {
  inputPer1k: number;
  outputPer1k: number;
}

// --- Defaults (ex db/defaults.ts) ---

// --- .fapony/ layout (single source of truth — do not hardcode ".fapony" elsewhere) ---
// plan/spec live in .fapony/ — not configurable (gitignored = private).
export const FAPONY_DIR = ".fapony";
export const CONFIG_FILENAME = "fapony.config.json";
export const EVIDENCE_FILENAME = "evidence.json";
// plan/spec live in .fapony/ — not configurable (gitignored = private).
export const PLAN_DIR = `${FAPONY_DIR}/plan`;
export const SPEC_DIR = `${FAPONY_DIR}/spec`;
export const PARKED_DIR = `${FAPONY_DIR}/parked`;
// Archive sits beside plan/, not inside it, so archiving never changes a file's
// depth and its relative links survive the move untouched.
export const DEFAULT_DONE_DIR = `${FAPONY_DIR}/done`;
export const DEFAULT_EVIDENCE_FILE = `${FAPONY_DIR}/${EVIDENCE_FILENAME}`;

export const DEFAULT_CONFIG: Config = {
  worktrees: {},
  review: {
    maxRounds: 2,
  },
  memory: null,
  telemetry: null,
  paths: null,
  safety: null,
};

// --- Getters (ex db/getters.ts — centralized, no hardcode at call site) ---

import { DEFAULT_SAFETY_DENY } from "./defaults.js";

export function safetyDeny(config?: Config): string[] {
  return config?.safety?.deny ?? DEFAULT_SAFETY_DENY;
}

/** Hardcoded — plan/spec live in .fapony/ (gitignored = private). */
export function planDir(): string {
  return PLAN_DIR;
}

/** Hardcoded — plan/spec live in .fapony/ (gitignored = private). */
export function specDir(): string {
  return SPEC_DIR;
}

export function doneDir(config?: Config): string {
  return config?.paths?.doneDir ?? DEFAULT_DONE_DIR;
}

export function evidenceFile(config?: Config): string {
  return config?.paths?.evidenceFile ?? DEFAULT_EVIDENCE_FILE;
}

// --- Load (ex db/load.ts — fs/env only, no sqlite) ---

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// XDG Base Directory convention (macOS ignores Apple's ~/Library/Application Support
// for CLI tools by common practice — gh, ripgrep-adjacent tools, etc. use ~/.config too)
// Override order: $FAPONY_STATE_DIR > config.paths.stateDir > $XDG_CONFIG_HOME > ~/.config
export function faponyDir(config?: Config): string {
  if (process.env.FAPONY_STATE_DIR) return process.env.FAPONY_STATE_DIR;
  if (config?.paths?.stateDir) return config.paths.stateDir;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "fapony");
}

export function configFilePath(): string {
  if (process.env.FAPONY_CONFIG) return process.env.FAPONY_CONFIG;
  return join(process.cwd(), CONFIG_FILENAME);
}

function freshDefaultConfig(): Config {
  return {
    ...DEFAULT_CONFIG,
    worktrees: { ...DEFAULT_CONFIG.worktrees },
    review: {
      ...DEFAULT_CONFIG.review,
    },
  };
}

export function loadConfig(configPath?: string): Config {
  const resolved = configPath ?? configFilePath();
  if (!existsSync(resolved)) return freshDefaultConfig();

  try {
    const raw = readFileSync(resolved, "utf-8");
    const file = JSON.parse(raw) as Partial<Config>;

    return {
      ...DEFAULT_CONFIG,
      ...file,
      review: {
        ...DEFAULT_CONFIG.review,
        ...file.review,
      },
      paths: file.paths ? { ...file.paths } : DEFAULT_CONFIG.paths,
      safety: file.safety ? { ...file.safety } : DEFAULT_CONFIG.safety,
    };
  } catch {
    return freshDefaultConfig();
  }
}
