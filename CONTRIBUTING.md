# Contributing to fapony

Thanks for your interest in contributing!

## Development Setup

```bash
# clone the repo
git clone https://github.com/zecalis/fapony.git
cd fapony

# install dependencies
bun install

# run all checks (lint + typecheck + test)
bun run check
```

## Before Submitting

1. **Run checks** — `bun run check` must pass (lint, typecheck, test)
2. **Commit conventions** — use conventional commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`
3. **One concern per commit** — keep commits focused

## Project Rules

- **Dependencies are allowed — but they must not reach hook startup** — `fapony hook-edit-hint`
  spawns on every Edit, and `fapony.ts` static-imports every module, so anything new is
  `await import()`ed on the CLI path that needs it. Budget: startup stays under ~100ms
- **No abstraction for abstraction's sake** — don't scaffold for a future that may not come
- **Push only the branch you are working on** — never `main`, never `--force` or
  `--force-with-lease`. Opening a PR is fine (`gh pr create` needs the branch on the remote first);
  merging it is the maintainer's call
- **Runtime state never lives in a worktree** — the ledger DB is `~/.config/fapony/` only, and its
  path must never come from an argument or config field pointing at a worktree. fapony *may* write
  into a target worktree when the user asks for it (`init`, `setup`, `plan-seed`, `plan sweep --apply`
  all do), under two limits: a command that reads code writes only to a path the user named (`--out`,
  a filename in argv), and anything that would overwrite an existing file asks first or refuses
- **assertSafe() must be called on every command** before spawn, including config-sourced ones

## Running Tests

```bash
bun run test            # full suite (parallel, ~17s)
bun run test:changed    # only test files affected by your diff — use while iterating
```

## Code Style

- Biome for linting and formatting (`bun run lint`)
- TypeScript strict mode
- No comments unless asked
