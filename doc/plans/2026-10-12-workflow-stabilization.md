# Workflow stabilization (Option A), 2026-10-12

Status: in progress. Branch `fix/stabilize-a`, based on `deploy/2026.1005.0`.

## Why

A read-only diagnosis of production on 2026-10-12 found the instance stalled
since 2026-10-11 04:04Z. Every issue-bound run failed or never started:

- One Claude setup token served 13 agents in three companies and hit its weekly
  limit. Provider-quota failures burned two blind 30-second retries, then the
  provider-quota issue monitor fired every hour without starting a run
  (`retry_exhausted` was treated as triggered) and re-armed forever. 23 issues
  sat `in_progress` with no way to resume after the reset.
- Only the "resets 4pm (UTC)" reset form parsed; "resets Oct 15, 6am (UTC)"
  did not. ACP runs lost the provider text, and limit-caused ACP compaction
  failures put agents into `error`.
- A question answer on ACM-7 was redelivered more than 16,000 times because its
  issue was dependency-blocked and delivery retried without bound.
- Wakes skipped by `maxDailyRuns` were dropped, quota failures counted against
  the cap, and stranded-todo recovery reasoned from another agent's run.
- Cancelled blockers never unblocked their dependents, and the blockers
  backstop only scanned `blocked` dependents.
- `skip_if_active` routines counted only live runs, so an hourly routine opened
  a new issue every hour while its previous one was parked.

v2026.1005.0 also stops @-mentions from waking agents (upstream #14577), so the
per-agent instruction files that hand work back with a mention must change in
the same deploy.

## Scope

Code (one commit series per item, no migrations):

1. Quota recovery: a due provider-quota monitor starts a fresh attempt outside
   the transient retry budget; the monitor is bounded, backs off when the reset
   time is unknown, and escalates to the board when exhausted; date-form reset
   texts parse; provider-quota failures skip the transient retries.
2. ACP limit classification: limit-caused ACP failures (including compaction)
   are `provider_quota`, keep the agent idle, and carry the reset text when the
   stream has it.
3. Question delivery: a dependency-blocked delivery parks and resumes when the
   blockers resolve, without a skipped wake row per attempt.
4. Wake obligations: issue-bound wakes skipped by `maxDailyRuns` are deferred
   to the next window; quota failures and never-started runs do not count
   against the cap; stranded-todo recovery uses the assignee's latest run.
5. Blockers: port upstream `fix/cancelled-blockers-unblock`; the backstop also
   wakes `todo` and `in_progress` dependents once when all blockers are closed.
6. Routines: `skip_if_active` treats the routine's previous open execution
   issue as active.

Operations, applied together with the deploy:

- Rewrite the per-agent AGENTS.md hand-off rules for ACM, INI and GLO: hand
  back with one `PATCH {status: "todo", assigneeAgentId: <PM>, comment}` as the
  run's last call; never rely on mentions or agent-addressed confirmations.
- Prepare the prod host for a 1005-based patched image (versioned build
  script, base image by digest, disk cleanup).
- Move ACM TrelloIntake to Sonnet with a 3-hour cadence.

## Deferred

- Trello intake as a plugin job (cursor-based, no LLM polling).
- Typed unblock conditions for `blocked` and recovery `outcome=blocked`
  (Option C).
- Account-aware capacity: credential registry, admission gate, board banner
  (Option B).
- Rebase onto the next upstream stable (heartbeat split).

## Verification

- Server, shared, db and UI typecheck; targeted tests per item; full server
  vitest run with failures classified against the base branch.
- Three-lens review of the combined diff (correctness, deploy-time behaviour on
  the real prod state, DB load), each finding verified adversarially.
- After deploy: health, migrations, the quota-loop issues re-armed to the
  parsed reset time, the ACM-7 delivery parked, no run bursts.
