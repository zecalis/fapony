// src/knip/types.ts — knip JSON shapes (defensive: versions differ).

export interface KnipExportIssue {
  name: string;
  line: number;
}

export interface KnipFileIssue {
  name: string;
}

export interface KnipEntry {
  file: string;
  files: KnipFileIssue[];
  exports: KnipExportIssue[];
  types: KnipExportIssue[];
  enumMembers: KnipExportIssue[];
  namespaceMembers: KnipExportIssue[];
  dependencies: { name: string }[];
  devDependencies: { name: string }[];
}

export interface KnipRun {
  issues: KnipEntry[];
}

export type KnipResult = KnipRun | { skipped: string };

export function isSkipped(r: KnipResult): r is { skipped: string } {
  return "skipped" in r;
}

/** One scope-filtered row: what the seed prints for a file knip flagged. */
export interface KnipRow {
  file: string;
  unusedFile: boolean;
  exports: string[];
  types: string[];
  deps: string[];
}

export const MAX_KNIP_FILES = 10;
export const MAX_KNIP_NAMES = 5;
