# Positioning — rules against getting torn apart at launch

Read this before writing README, launch posts, or marketing copy. Not needed for a normal coding session.

> **Status 2026-09-25:** the memory pitch below ("fapony remembers instead") moved with the mem log to
> [fael](https://github.com/zecalis/fael); fapony is now the owner's plan/usage tool, not a launch
> product. Kept as the reasoning record — apply it to fael's copy, not fapony's.
>
> **2026-09-26:** fapony is active again as the owner's dev workflow (plans, chunks, lookups),
> never memory. Its README now leads with that workflow and puts usage second — rule 3 no longer
> binds fapony's README.

1. **Never headline with "verifies".** fapony never runs tests itself, never judges itself.
   It's **the memory, not the judge.** HN readers open the source for real — one overclaiming word burns the
   whole post's credit.
2. **Never claim fapony says which model is better.** Self-grading bias differs per model
   (see the "why the core moved" mem decision). · What can be said is **tokens per task**, measured from logs.
3. **Lead with day-1 value, always.** `usage-scan` / `usage-web` (CLI) work the moment they're installed because
   they read logs already there, while mem + debt are **retention, not acquisition** (worthless until accumulated). ·
   **Don't reorder the README to lead with mem/debt until moved% exists at two points in time** — anyone who installs
   and meets "not enough history yet" as the first thing = walks away (that's what killed `project_health_context`).
4. **Declare limits yourself before anyone else catches them.** The "What fapony is not" section in the README
   must never be deleted.
5. **Never sell "fapony finds your dead code / duplication".** knip / madge / jscpd are free and better.
   The first reader replies "so, knip?" · The sentence that sells: **"agents can't remember pain, so they never
   build abstractions — fapony remembers instead, and reports how far the move has gone."**
6. **Cross-client is the differentiator, not the dashboard.** Plenty of tools read Claude Code usage already;
   almost none read 4 clients on one yardstick.

**The audience is people paying for their own plan.** Devs on a company Max plan don't hurt, so they're not
customers. Every message speaks to someone managing tokens.

**Launch-ready criterion:** someone who isn't the owner installs and sees something useful within 60 seconds —
not a feature count. · Channel order: awesome-mcp-servers PR → r/ClaudeAI + Thai communities →
the essay *"I built the agent loop everyone builds first, then deleted it"* → Show HN.
**One shot — don't burn it.**
