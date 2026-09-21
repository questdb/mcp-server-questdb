---
name: review-pr
description: Review a code change against the QuestDB MCP Bridge coding standards
argument-hint: "[PR number or URL | commit hash | staged | unstaged] [--level=0..3]"
allowed-tools: Bash, Read, Write, Grep, Glob, Agent
---

# Review a QuestDB MCP Bridge change

**Usage:** `/review-pr [PR number or URL | commit hash | staged | unstaged] [--level=0..3]`

Parse exactly one review target from `$ARGUMENTS`: a PR number/URL, a commit hash, `staged`, or `unstaged`. If none is supplied, ask for one.

**Tools this skill uses:** `Bash` for read-only `gh`/Git queries and the quality gates, `Read`, `Grep`, `Glob`, `Write` only for scratch tests, and fresh-context agents through the Agent tool. Do not edit project files or push.

## Review mindset

You are a senior backend engineer performing a blocking code review on the QuestDB MCP Bridge — a long-lived Node.js process that brokers tool calls between an untrusted MCP client over stdio and a paired QuestDB Web Console over a local WebSocket, plus a setup wizard that writes the bridge into users' agent config files. A bug here can run a data-modifying SQL statement twice, report a false error for work that committed, leak a pairing secret, wedge the process, or corrupt a config file the user did not ask us to touch. Be critical, thorough, and opinionated. Catch problems that would hurt a user before they ship — not to be nice, and not to demonstrate thoroughness by volume.

**A review that blocks on everything blocks on nothing.** Every finding costs the author a round-trip, and an inflated one costs the report its credibility. Reserve blocking severity for defects with a real user consequence. "Approve" is the normal outcome of reviewing competent work; a review with zero findings is a successful review.

- **Assume nothing is correct until you've verified it.** Read surrounding code; don't judge the diff in isolation.
- **The diff is a hint, not the boundary.** The highest-value bugs live at callers, message handlers, and lifecycle edges outside the diff that depend on a contract the diff quietly changed.
- **Discovery is not a finding.** Every concern is an untrusted hypothesis until it passes the Step 3b admission gate. Report admitted issues at the severity their evidence earns; omit everything else.
- **Falsify before you explain.** Search for the missing producer, the existing guard, the cleanup that already runs, the validation that already rejects the input, downstream recovery, and merge-base behavior before building a narrative. Failure to disprove is not evidence.
- **Keep the blast radius small.** The change should fix what it set out to fix plus anything it demonstrably breaks. Pre-existing bugs are adjacent findings for the tracker, never change requests — unless this change moves one onto a live path.
- **Urgency is neither evidence nor an exemption.** "Urgent", "simple", and "hard to test" are conclusions to prove.
- **Do not praise the code.** Focus entirely on problems and risks.
- **Think adversarially** about disconnects, reconnects, late or duplicate messages, timer expiry racing a result, aborts, shutdown mid-work, malformed or hostile input at each trust boundary, and unexpected on-disk config state.
- **Verify every claim.** Treat the PR description as an unverified hypothesis. A "fix" must have had a bug; an "improvement" must not regress an ordering or timing guarantee.
- **Assess reachability before reporting.** Trace which message, timer, signal, CLI/env input, or file state triggers it. If the protocol cannot produce the message or the state machine cannot reach the state, drop it.

## Where the risk is

Weight effort toward these areas, in this order; do not spend equal effort everywhere.

1. **Session lifecycle** — the pairing state machine, the handshake, supersede by a second browser, and the in-flight call table with its timers. The dominant defect class is a promise that settles twice or never, and a timer left uncleared on one exit path.
2. **Disconnect and reconnect semantics** — in-flight calls deliberately survive a browser drop for a grace window so the console can finish and flush the result; failing early invites a duplicate data-modifying retry. Any change here must preserve "do not retry unverified data-modifying calls".
3. **Trust boundaries** — the WebSocket upgrade (origin allowlist, constant-time token compare, payload and buffer caps) and tool-argument validation against the schema the console advertised. Secrets must reach the user but never the logs.
4. **MCP server contract** — the tool-result shape, the structured error-text prefixes clients match on, and the vendored shared tool definitions, which CI requires to byte-match the upstream console repo.
5. **Setup, upgrade, and distribution** — writers of the user's agent config files (comment-preserving JSON/JSONC edits; Codex delegated to its own CLI), recognition of entries older releases wrote, and the npm-vs-standalone launch command baked into configs.
6. **Process lifecycle** — port binding and retry, shutdown budgets, signal and stdin handling, exit codes, and timers that must not keep the process alive.

## Review level

Parse `$ARGUMENTS` for `--level=N` or `-lN`, `N` in `0`-`3`. A bare digit is a PR number, never a level. **Default to 0.** Strip the level token before passing the target to `gh`/`git`.

Lower levels keep the same spirit — adversarial, evidence-gated, no praise — but cut breadth. Reserve level 3 for the session lifecycle, disconnect semantics, either trust boundary, or the config writers. Agent count is never evidence; roles whose domain the diff does not touch are skipped at every level.

| Level | What runs |
|-------|-----------|
| **0 (default)** | Steps 1, 2, 2.6, 3c, 4. Skip Step 2.5 and agent fanout. Review the diff inline; build the coverage map inline. Every candidate still passes the Step 3b admission gate inline from a blank evidence form. Quality gate: `typecheck` and `lint` only. |
| **1** | Adds Step 2.5a. Run Agent 1 plus at most **two** applicable roles from Agents 2-6. Full quality gate. Admission inline. |
| **2** | Full Step 2.5. Run Agent 1 plus at most **four** change-relevant roles from Agents 2-7. Full quality gate. One batched blinded falsifier for all candidates. |
| **3** | Full Step 2.5 and the complete admission protocol. At most **six** roles from Agents 1-8; Agent 8 only when a distinct adversarial pass is warranted. One fresh-context falsifier per atomic candidate and the full evidence ladder. |

State the chosen level in one line at the start of the review. If it was defaulted, mention that level 3 exists for high-stakes changes.

## Spawning review agents

Steps 3 and 3b use fresh-context, read-only agents, one task per role or per falsification candidate. Discovery tasks receive the diff, the Step 2.5 map, the Step 2.6 coverage map, the role text, and the candidate contract; write large payloads to a scratch file and point tasks at it. Agent 8 receives only the diff and changed-file names. Falsifiers receive only the neutral proposition, revision identities, relevant files, and raw artifact paths — never the discovery narrative, proposed severity, fix, or other agents' votes. The parent owns role selection, the private ledger, admission, severity, and output; children return candidates or evidence only.

## Step 1: Gather context

Every mode must end with **`$BASE`** set — the revision the change is measured against.

- **PR** — in one bash call: `gh pr view` (metadata), `gh pr diff`, `gh pr view --comments`, and `BASE=$(gh pr view "$PR" --json baseRefOid --jq .baseRefOid)`.
- **Commit hash** — `git diff <hash>~1..<hash>`; `BASE=<hash>~1`.
- **`staged` / `unstaged`** — `git diff --staged` / `git diff`; `BASE=HEAD`. List untracked files with `git status --porcelain` and read any that belong to the change.

For non-PR targets skip Step 2 and say so.

## Step 2: PR title and description

- Title follows Conventional Commits: `type: description`.
- Description states behavior and user impact, not "refactored X". A claimed fix names the failure mode.

## Step 2.5: Map the change surface

Mandatory at levels 2-3 (level 1 runs 2.5a only). Use Grep/Glob; never reason about consumers from memory. The map is private working evidence, not report content.

- **2.5a Semantic delta** — per changed symbol: before, after, and a one-line delta covering signature, return/resolve shape, state read or written, timers set or cleared, in-flight entries touched, side effects (sends, closes, exits, log and file writes), settlement guarantees (0, 1, or >1 times), and messages accepted or emitted. "Refactored" is not a delta.
- **2.5b Callsite inventory** — for every cross-file symbol, message type, close code, or config field, record every consumer outside the diff, grouped by file, including tests. A cross-file symbol with no recorded search is a skill violation.
- **2.5c Implicit contracts** — per symbol, before vs after: settlement count, timer cleanup on every exit path, state-machine ordering, validation at the trust boundary, abort/cancel re-entrancy, disconnect-grace survival, secrets in logs, resource release on shutdown, and what `setup` writes vs what `upgrade` recognizes.
- **2.5d Cross-context exposure** — the places this change is visible from but the diff does not touch. Every entry must be reviewed in Step 3.

## Step 2.6: Test coverage map (every level)

One private row per behavioral change: the exercising test found by a recorded search over `src/test`, the failure link (what the assertion observes and why it fails on regression — "the test constructs a session" is not one), the reachable population, the credible regression consequence, and the least fragile meaningful test if uncovered. Disposition: **COVERED / CRITICAL GAP / MODERATE GAP / ACCEPTED GAP / EXEMPT**. Missing tests alone never make a row Critical; a fix without a regression test defaults to Moderate. Gaps needing a real browser console are accepted by policy — the fake browser socket, fake timers, the real-socket roundtrip harness, and the bundle end-to-end harness are the supported seams. Publish only admitted gaps.

## Step 3: Candidate discovery

Select only roles whose domain the diff materially touches, within the level's cap.

### Candidate-discovery directive (all agents)

- You are a **hypothesis generator**, not an authority to publish. Output atomic propositions; no severity, fix, persuasive title, or "verified"/"confirmed".
- Cite the exact changed hunk, or the unchanged consumer plus the 2.5c contract allegedly broken. Out-of-diff breakage outranks in-diff nits.
- Name the **producer**: the exact MCP call, browser message, timer expiry, OS event, CLI/env input, or on-disk state that creates every trigger condition, or write `producer: unknown`.
- Record the strongest counterevidence found. Universal claims (never, only, exactly one) require an exhaustive inventory.
- A proposition with no independent consequence supports its parent; it is not a candidate. Pre-existing bugs unchanged from `$BASE` are never candidates against this change.
- Two agents repeating the same reasoning are one hypothesis. Returning no candidate is valid and preferred to a speculative one.

### Agents

**Agent 1 — Correctness & protocol:** logic errors, state-machine ordering, handshake and message validation, result-shape and error-prefix contracts, every changed symbol checked at every callsite from 2.5b.

**Agent 2 — Async lifecycle & races:** promise settlement, timer cleanup on every exit path, abort/cancel re-entrancy, disconnect/reconnect/grace interleavings, supersede mid-call, shutdown ordering. A race is a candidate only with the concrete message/timer sequence that produces it.

**Agent 3 — Trust boundaries & security:** upgrade-time origin and token checks, payload and buffer caps, argument validation before forwarding, secrets in logs or files, shell quoting on the wizard path.

**Agent 4 — Config writers & distribution:** comment-preserving edits, invalid files left untouched and reported truthfully, `upgrade` recognizing what earlier releases wrote, the launch command matching the running channel, side-effect-free `--version`/`--help`, stable exit codes.

**Agent 5 — Tests & coverage:** consume and re-verify the Step 2.6 map; run a mutation spot-check on the 3-5 most dangerous changed lines and add `UNTESTED` rows where no assertion would catch an inverted condition. For a claimed fix, reason about reverting the production hunk and confirm the new test would fail.

**Agent 6 — Code quality & standards:** readability, naming, dead code, unnecessary non-null assertions or optional chains, overly broad types, duplicated helpers, local edits to the vendored shared definitions.

**Agent 7 — Cross-context caller impact:** walk 2.5b; per callsite, read the consumer and its callers up two levels and return SAFE / CANDIDATE / INSUFFICIENT_EVIDENCE. Select whenever changed symbols have meaningful out-of-diff consumers.

**Agent 8 — Fresh-context adversarial (level 3):** receives only the diff and changed-file names, no map or checklist. Sole instruction: "generate a small set of falsifiable ways this code could be wrong, and try to disprove each before returning it." Output follows the candidate contract. A unique hypothesis is not high signal by itself.

Combine outputs into a private **candidate ledger**: split compound narratives into atomic propositions, deduplicate, record dependencies. No prose, severity, or fix yet.

## Step 3b: Falsify, prove, and admit

`HYPOTHESIS → FALSIFYING → PROVEN → ADMITTED`. Anything missing proof, contradicted, unreproduced, or dependent on an omitted premise ends `OMITTED`. "Could not disprove" never means proven.

The falsifier first constructs the strongest disproof — missing producer, unreachable order, existing guard or cleanup, validation that already rejects, downstream recovery, identical base behavior — and only then assembles proof. A behavioral candidate is admitted only when every field is backed by cited evidence:

- **Attribution** — changed hunk, or unchanged consumer plus the broken 2.5c contract.
- **Producer** and **Reachability** — the complete trigger-to-symptom path, including guards, timers already cleared, validation, and recovery.
- **Head observation** and **Base observation** — the same trigger executed at head and at `$BASE`, or `N/A — new surface` with proof.
- **User symptom** — independently observable.
- **Counterevidence search** — strongest disproof attempted and why it does not apply.
- **Artifact** — exact command/test, output, and revision. Settlement, timer, race, ordering, disconnect, shutdown, and config-write claims always need an executed artifact; static reading cannot admit them. Static findings fully proved by source mark runtime fields `N/A — static`.

**Evidence ladder** (cheapest sufficient rung, named in the finding): (1) quality-gate output; (2) scratch vitest on pure logic, written under `src/test` with a scratch name, run with `yarn vitest run <file>`, deleted afterwards — a regression-test claim needs green at head and red against the reverted hunk; (3) scratch vitest driving a session with a fake browser socket and fake timers to force the claimed ordering; (4) level 3 only: the real-socket roundtrip harness or the bundle end-to-end harness, one bundle build per review. A runtime claim below level 3 that only rung 4 can execute is omitted with the limitation recorded privately; if its static skeleton is itself a defect, file that at the severity static evidence earns.

After admission: read the cited lines yourself; verify the conjunction of a multi-step claim by falsifying its load-bearing step first; admit enumerated candidates per item; derive the fix only after admission and confirm it closes every admitted path. Then determine **net user impact** — population, delta vs base, magnitude and frequency, offsets that recover it first, and a net of negative/neutral/positive — and classify: **ADMITTED in-diff**, **ADMITTED out-of-diff**, **OMITTED pre-existing** (leaves as an adjacent draft only when fully proved), **OMITTED false**, **OMITTED unverified**. Only net-negative candidates admit. The ledger, disproofs, and counts stay private.

## Step 3c: Quality gate

Run `yarn typecheck`, `yarn lint`, `yarn build`, `yarn test` (levels 1-3; level 0 runs the first two). Also check whether the diff edits the vendored shared definitions, which CI rejects on any drift from upstream. Gate failures are executed artifacts: they admit without a falsifier, one row each, **always Critical** — the gates are the project's committed standard and a red one blocks the merge for everyone.

## Step 4: Output

Present only **ADMITTED** findings. Omitted candidates, disproofs, retractions, agent and candidate counts never appear. Do not publish a hypothesis and retract it. Zero findings is valid. If a normal-sized change yields more than about seven findings, re-run admission and drop dependent, duplicate, and not-attributed items (the last move to Adjacent findings).

Every finding opens with three one-line summaries, written last from the admission form: **Problem** (≤ 12 words), **Net impact** (population and magnitude, ≤ 12 words), **Evidence** (decisive artifact or static proof with revision). Then, for every finding at every severity:

- **Location:** file path and line numbers, and in-diff or out-of-diff (for out-of-diff, the consumer and the 2.5c contract broken).
- **Description:** the user impact in a short paragraph, with the base comparison.
- **Steps to reproduce:** an ordered list — the concrete tool calls, messages, timer expiries, signals, CLI/env inputs, or on-disk config states that trigger it, from the admitted producer to the observed symptom. For a static finding, cite the lines instead. You should be
a very concise and use a plain language without advanced terms here.
- **Suggested fix:** written to be applied in this change, derived only after admission, and confirmed to close every admitted path.

### Severity (impact-first)

Severity is what the user loses, not which role found it. **"The user" is the person driving a coding agent paired to their console** — and, by extension, the agent acting for them and the console session holding their data — never CI, the release process, or a contributor. Do not classify up to be safe.

**Critical** only if you can complete *"Because of this, the user sees ___"* with a named trigger and one of: a data-modifying call run more than once or reported failed after committing; a false result (wrong error, wrong success, result matched to the wrong call, result dropped); a wedged or dead bridge (unsettled call, unreachable exit, crash, leak growing per call); a security failure (unauthenticated peer, leaked secret, unvalidated forwarding, shell-quoting hole); a corrupted or wrongly written agent config; a silent or non-actionable failure; an admitted Critical coverage gap; or a failing quality gate.

**Moderate:** admitted, attributable defects with bounded or developer-facing impact — a static standards violation, a weak test, a Moderate coverage gap, a harmless-but-untidy timer, the static skeleton of an unexecutable runtime claim. An unreachable runtime theory is omitted, not Moderate.

**Minor:** cosmetics.

**Out of scope:** merge mechanics; tautologies that would appear on every change of this shape; documented project decisions (in-flight calls surviving a disconnect, fail-open validation for one unvalidatable tool, delegating Codex config to its CLI) unless you have evidence the decision is wrong.

### Sections

- **Critical**, **Moderate**, **Minor** — admitted findings, worst user impact first.
- **Adjacent findings (not blocking — file as issues)** — proved pre-existing bugs on `$BASE` in visited code, as ready-to-file drafts: Problem, Net impact, Location, Symptom, Reachability, Suggested fix, Severity if filed standalone. Offer to file; never affect the verdict. One that this change moves onto a live path is out-of-diff breakage, not adjacent.
- **Coverage map** — test-gate result and admitted gap rows with their search and failure link only.
- **Summary** — verdict, exactly one of **approve** (no open admitted Critical and the test gate passes; withholding approval then is a review failure), **approve with comments** (name the Moderate items), **request changes** (an admitted Critical is open or the test gate fails), **needs discussion**. Before finalizing, re-audit from evidence fields: strongest disproof per behavioral finding, producer confirmed, falsifier independence, executed artifact with same-trigger base result for every dynamic claim, dependents of omitted premises removed. State the in-diff/out-of-diff split (at levels 0-1, describe the limited callsite analysis instead of implying a clean bill), the severity distribution, and any tradeoff to the disconnect-grace contract or to what the wizard writes. Never condition the verdict on splitting the PR. Never state agent, candidate, or false-positive counts.
