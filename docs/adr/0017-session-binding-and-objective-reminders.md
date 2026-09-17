# Session binding, optional phases, and Objective reminders

Status: accepted; amends ADR-0016

## Context

Pausing a governing charter allowed sibling charters to take over the same session. After compaction, backlog work could displace the user's Objective while the UI showed a different charter.

## Decision

- A session has at most one active or paused charter. Create requires completing or abandoning that charter first. Pause, resume, complete, and abandon target only the session-bound charter. An unbound session may resume a paused charter by explicit id and adopt its binding. Read-only lookup remains unrestricted.
- New charters have an empty `## Phases` section with a short optional-phase comment, not an Explore scaffold. Authored phases retain the existing status inference. Zero phases means no current phase and does not prevent completion.
- Periodic Objective reminders use the shared pi-extension-utils reminder host. Registration options `reminderToolCalls` (100) and `reminderMinutes` (20) set the thresholds; the first reached wins. Activity excludes time between turns. User messages and emissions reset counters; Ralph turns already carry the Objective and suppress a duplicate. Reminder text contains the charter path, verbatim Objective marked as user-authored data, optional current phase title, and the course-check closing line.

## Consequences

Sub-slices remain phases or tactical pi-dag-tasks, not sibling charters. Pausing preserves the governing binding. The Ralph guard is unchanged.

Configuration follows existing programmatic registration options, not a new file-config system. The shared host queues context announcements as steering for a subsequent turn; it does not insert them into the current provider request. pi-charter does not bypass or modify that host.
