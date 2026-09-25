# Changelog

## Unreleased UI and output

- Include alert name, source ID and explicitly current status, severity and verdict in activity output by default.
- Show the single activity operation as a selectable Occurred operation, and show Match Conditions only when conditions exist.
- Group optional alert scopes under Options > Scope while preserving legacy saved selections.

## Unreleased removals

- Remove the trigger's Include SentinelOne OCSF option and its per-alert detail requests. Saved workflows that set it still load and poll; the option is ignored. Fetch OCSF detail with a downstream Alert > Get node.

## Unreleased fixes

- Defer AI tool exposure: the action node is no longer usable as a tool while its mutation surface is reviewed for agent use.
- Read retry status, Retry-After and network codes through the wrapped error cause, so rate limits and dropped connections retry again.
- Cap the per-attempt read timeout at a share of the 30-second deadline with a 15-second floor, so a timed-out attempt still leaves room to retry without cutting a slow read short.
- Emit Alert Updated only when the alert was revised after creation, instead of suppressing every alert first seen in the poll.
- Retry unavailable activity parents within the overlap window, then skip with a sanitised warning.
- Recover activity backlogs through bounded checkpoint slices.
- Finish scheduled trigger polls within the n8n 2.38.0+ poll time budget: alert polls read oldest first in ascending order with one forward-only cursor per stream and scope batch, a budget stop hands over every page already read and resumes from its last timestamp, activity polls keep the completed feed slices and the activities whose parent lookup finished, and a stream that stops without progress fails visibly. Hosts without a budget now also request ascending order and page to the end of the range instead of splitting at a page cap.
- Reject trigger Group selections when no Site is selected.
- Keep the retained Occurred operation usable after switching the trigger resource back to Alert, instead of failing the poll.
- List Sites and Groups only once their parent scope is selected, so an unfiltered site list is never cached against a later account selection.

## 0.1.0 (unreleased)

- Add SentinelOne icons to the node editor and package README.
- Throw typed errors for rejected Alert Updates, retain status or service codes for uncertain and partial outcomes, and require explicit Status and Analyst Verdict choices.
- Breaking: replace the Alert Note > Created trigger with Alert Activity > Occurred, without a compatibility alias. Note actions and Alert snapshot triggers remain unchanged.
- Support seven verified activity types, unknown alert-linked types, and a builder for recorded transition and value conditions.
- Emit one generic envelope per activity, with optional raw activity and current alert enrichment.
- Deduplicate by activity ID without monitoring later revisions; reset migrated note triggers to a fresh scheduled baseline.
- Preserve long historical test searches, returning up to 10 newest matches from the first matching window and reporting budget exhaustion.

- Introduce SentinelOne Platform action, trigger, and credential identifiers.
- Organize operations into focused modules with shared controls and transport.
- Use common alert defaults and opt-in Additional Alert Fields.
- Remove scope from ID-based operations.
- Separate mutation acknowledgement and bounded readback verification.
- Report service action reasons and provide redacted Debug logs.
- Supply inactive acceptance workflows without credentials.
