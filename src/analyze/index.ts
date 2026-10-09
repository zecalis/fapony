// src/analyze/index.ts — barrel for `fapony analyze`: structural health
// diagnosis for a TS/JS project.
//
// Layout mirrors src/install/: types + one file per concern, CLI entry in
// cli.ts. Callers import this barrel directly.

export * from "./barrels.js";
export * from "./blast.js";
export * from "./cli.js";
export * from "./criteria.js";
export * from "./diagnose.js";
export * from "./discover.js";
export * from "./format.js";
export * from "./graph.js";
export * from "./python.js";
export * from "./resolve-ts.js";
export * from "./types.js";
