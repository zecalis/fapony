# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in fapony, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, use GitHub's private vulnerability reporting: [Report a vulnerability](https://github.com/zecalis/fapony/security/advisories/new).

## Scope

fapony is an MCP server plus CLI that runs locally. It does not expose network services. The primary security concerns are:

- **Command injection** — fapony spawns shell commands from config (memory adapter, `install`, and the evidence collector's `.fapony/evidence.json` allowlist). `assertSafe()` deny-lists dangerous git commands (`reset --hard`, `clean -f`, `checkout --`, `git stash`), but always verify before running untrusted configs.
- **Path traversal / worktree writes** — fapony writes into a target worktree only on the owner's order, under three limits: runtime state never lives in a worktree (DB is `~/.config/fapony/` only, its path never comes from an arg/config pointing at a worktree); a command that reads code writes only to a user-named path (`--out`, a filename in argv); overwriting an existing file asks first or refuses.
- **Memory claims** — memory commands are executed via shell adapter. Ensure memory scripts are trusted.
- **Evidence collector** — only runs commands listed in `.fapony/evidence.json`; commands an agent proposes outside that allowlist are reported as *proposed — not executed*, never run.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.3.x   | Yes       |

## Best Practices

- Keep `fapony.config.json` out of version control (it is per-machine and gitignored) and never commit secrets
- Review `.fapony/evidence.json` before trusting a report from a repo you did not write — it is the only list of commands fapony will execute
