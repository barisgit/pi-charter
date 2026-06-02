# Charter records evidence; it does not run verification

Status: accepted; supersedes the command-verifier execution stance of ADR-0011 and ADR-0012, and the "command exit code is best" VAL doctrine in `skills/pi-charter/SKILL.md`.

Confirmed scope decisions (from review): charter executes nothing, including
subagent-verifier dispatch (1); `requireReviewSubagent` is dropped to a
display-only attribute, not a gate (2); `requireFreshEvidence` survives as a hard
completion gate (3).

## Context

pi-charter's purpose is to keep an agent **aligned to its objective** across many
turns: hold the goal in view, track real progress, and make skipping steps
mildly effortful. It is a steering instrument, not a fraud-prevention boundary.
If an agent chooses to cheat, that is on the agent and is caught by the human
reviewing the work — not by charter machinery.

The current design drifted toward the fraud-prevention framing:

- `charter_record action=verify` executes verification itself —
  `spawn("/bin/sh", ["-c", command])` at `record-service.ts:1203` for `command`
  verifiers, subagent dispatch for `subagent` verifiers, and an evidence scan for
  `evidence-exists`. SKILL.md elevates this: *"Best: a real observable command
  whose exit code proves the behavior."*
- In practice (sampled across the `pi-subagents` charters) the command verifiers
  were never hollow — but they were **circular**: the same agent authored the
  VAL, authored a unit test, and ran it in one session. A green
  `'reopen from disk'` test proves the code matches a test the author just wrote;
  it does not prove the objective was met. "20/20 VAL pass" reads as strong
  verification while mostly asserting self-consistency plus "it compiles."
- The `requireReviewSubagent` gate hard-blocks completion unless an evidence row
  carries a `source: subagent`, session-disjoint `recordedBy`. That is an
  anti-self-fabrication control. `recordedBy` is a caller-supplied string
  (`record-service.ts:369`), so the control is forgeable anyway — it spends
  complexity defending against a threat charter has decided is out of scope.

The theater is the problem: tool-blessed, self-graded green checks manufacture
false confidence and let an honest agent *believe* it is done when it has only
proven self-consistency. That breaks alignment, which is the one thing charter
exists to protect.

## Decision

1. **Charter executes nothing.** Remove `charter_record action=verify` and its
   entire execution surface: the `/bin/sh` command spawn, the subagent-verifier
   dispatch, and the `evidence-exists` scan. Delete the child-process machinery
   (`runCommand`, `verifyCriterion`, the verify branch in `registration.ts`,
   timeout/output-cap plumbing).

2. **All evidence arrives through `charter_record action=evidence`.** Whoever did
   the work — the main agent inline, or a subagent the agent chose to spawn —
   records the outcome, a summary, and (for non-command outcomes) a `because`.
   The agent runs commands itself and pastes the command string + real output
   into the evidence `details`; charter stores it, it does not run it.

3. **`Verifier:` / `Command:` in `criteria.md` become descriptive, not
   executable.** They document *how a VAL is expected to be checked* (a command
   to run, a behavior to review) so a reader knows what good evidence looks like.
   Charter parses and displays them; it never runs them. The
   `weak-verifier-phrase-coupled` parse warning is retained as authoring advice.

4. **A VAL passes on recorded evidence regardless of who produced it.** An
   implementer recording its own command result satisfies a VAL. There is no
   independence requirement to *pass*.

5. **Independence becomes a displayed attribute, not a gate.** Drop the
   `requireReviewSubagent` hard blockers (`requires-subagent-review`,
   `implementer-only-reviewer`) and the session-disjointness check. `source` and
   `recordedBy` are still recorded and surfaced in `charter_status` so a human
   sees "self-verified" vs "independently reviewed" confidence — as information,
   not a barrier.

6. **Alignment gates stay.** These keep an honest agent honest *with itself* and
   are cheap, so they remain hard completion gates:
   - every in-scope VAL needs pass evidence to complete;
   - `because` required on `source: manual` evidence;
   - `requireFreshEvidence` (pass evidence newer than the last `src/` change);
   - `REPORT.md` non-empty under every heading.

7. **Objectives are outcomes; specification moves down.** The objective is the
   user-visible change in ≈1–2 sentences. Internal symbols, defect lists, and
   file paths belong in `criteria.md` / mission boundaries, not the objective.
   SKILL.md adds this authoring rule; it does not become a runtime gate.

8. **Zero bundled personas (ratified).** ADR-0012 already removed bundled
   personas and made trust gates name-agnostic; this ADR confirms the rule as
   permanent and removes the remaining stale references that still name
   `charter-verifier` / `charter-reviewer` (`codemap.md:75`,
   `docs/implementation/evaluator-and-verifiers.md`,
   `docs/implementation/filesystem-layout.md`).

## Rationale

- Charter's job is alignment, not policing. A control that is both forgeable and
  defends an out-of-scope threat (self-fabrication) is pure cost; removing it
  shrinks the tool to what it is actually good at.
- A self-authored, self-run, tool-blessed green check is the highest-confidence-
  looking, lowest-confidence-meaning signal charter can emit. Removing
  charter-run verification forces evidence to describe *the objective being met*,
  not *a self-written test passing*.
- Pulling execution out of charter also resolves the "let the agent decide
  inline vs subagent" friction: the agent owns how verification happens; charter
  owns whether the contract is honestly satisfied and reflected.
- The unfakeable facts (tsc clean, suite green) are not lost — they are recorded
  as evidence content with command + output attached. They simply lose the
  "the tool ran it" halo and, alone, no longer stand in for "the objective is
  met."

## Consequences

- `charter_record` becomes a single-action tool (`evidence`); `action=verify`,
  `timeoutMs`, and the `command|subagent|hook|prompt|evidence-exists` executable
  verifier union collapse to a descriptive `Verifier:` annotation. The tool
  surface count is unchanged (still three tools); one action is removed.
- Tests asserting command execution, exit-code capture, subagent-verifier
  dispatch, and the two review-gate blockers are removed or rewritten.
- `charter_status` no longer emits `requires-subagent-review` /
  `implementer-only-reviewer` blockers; it gains a per-VAL evidence-source
  display.
- SKILL.md VAL doctrine is rewritten: from "best is a command exit code" to "best
  is evidence that demonstrates the objective; attach command output as support."
- Existing charters keep working — their command verifiers become descriptive;
  recorded evidence is unaffected.
- The `recordedBy` field stays for display; it is explicitly *not* a trust
  boundary.

## Out of scope

- Restoring milestone/stage rendering to the glance widget (regressed in
  `16cab0f`). Tracked separately; independent of the verification model.
- Any unforgeable-identity / cryptographic attribution for `recordedBy`
  (explicitly rejected: charter is not anti-cheat).
- Auto-spawn scheduling or charter-initiated subagent dispatch of any kind.
- Re-introducing a features/plan DAG (cut in ADR-0012, stays cut).
