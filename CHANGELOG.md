# Changelog

## 0.2.0 (unreleased)

- Simplified Alert trigger output now uses SentinelOne's filter field IDs, so names line up with Advanced Filters: `alertName`, `ticketId`, `status`, `severity`, `id`, `alertNoteExists`. Alert Activity prefixes and raw output are unchanged.
- Severity lists use Critical, High, Medium, Low, Info, Unknown order; status lists use New, In Progress, Resolved order.

## 0.1.0 (2026-10-07)

This first release adds n8n nodes for working with SentinelOne alerts, alert notes, and SDL PowerQueries, plus triggers for new and updated alerts and alert activity.

- GraphQL errors now show SentinelOne's own error message instead of a generic failure; submitted note text is masked if echoed.
- Alert Get, Get Many, and Update support common alert fields, filtering, optional scope selection, status and analyst verdict changes, and ticket IDs. Additional alert fields and raw data are optional.
- Alert Get and Update report missing or inaccessible alerts as HTTP 404, including during discovery and verification.
- Alert Update checks acknowledged changes by default. If SentinelOne returns an uncertain or partial result, inspect the alert before trying the update again.
- Alert Note Get Many and Create work with an alert ID. Note Create reports the observed notes and whether it could identify the newly added note.
- SDL Query Execute returns query rows or a table with result metadata. Output size, row count, polling interval, and timeout are configurable.
- Alert triggers support New, Updated, and New or Updated. They establish a baseline when first activated, deliver later matching alerts, and can resume unfinished reads after a deadline or page limit. Updated events can arrive before New events. Retryable service errors may be handed to the next poll after progress; permission, validation, and other API errors fail the poll.
- Trigger Scope is now its own section straight after Credential and Poll Times for both resources, containing Accounts, Sites, and Groups saved under `scope.selection`. Its empty default allows n8n to open new nodes and workflows with legacy top-level scope IDs. Clearing Accounts removes hidden Sites and Groups values and includes everything the credential can see. This changes the saved workflow parameter shape; recreate or reselect trigger scopes after upgrading. The former custom activity type ID option has been removed, and saved values for it are ignored.
- Trigger controls now use Accounts, Sites, Groups, Alert Severity, Alert Status, Previous Value, New Value, Assignee, mitigation enum labels, and user exclusion labels. Site and Group controls appear when their parent selections have values.
- Alert Activity adds Agentic Investigation Triggered (`16008`) and Other (Unrecognised Types). Other selects alert-linked types outside the named IDs, including `16006`, and combines with selected IDs using OR. Simplified agentic investigation events omit changes when none are supplied; unknown events retain `activityTypeId`.
- Alert Activity supports activity types, activity conditions, current-alert filters, exclusions, mitigation details, and optional raw activity and current-alert data. The trigger uses a five-minute overlap for late arrivals.
- Simplified alert items use flat `accountName`, `siteName`, and `groupName` fields, and prefix Additional Alert Fields with `alert`. Simplified activity items use `change` with `field`, `from`, and `to` for status, verdict, severity, and assignee events, and `changes` for other event types. Simplify is enabled by default; disabling it returns the full activity or alert record.
- Trigger events include `eventId`, `eventType`, and `eventTime` for downstream routing and deduplication. Rare duplicates can occur after crashes, restored workflow state, overlapping runs, or overload.
- Interrupted New alert reads retain their overlap, so late-visible alerts behind a page limit can still be delivered after polling catches up. Warnings identify any stopped stream and its position.
- Empty activation polls retain their baseline. Changing the trigger configuration starts a fresh baseline; a pending baseline expires after an hour without an empty poll to renew it.
- Alert Activity retries brief query-indexing delays. Query cleanup failures log a warning and allow completed events to be delivered.
- Include Raw Activity and Include Current Alert work with Simplify enabled. Missing previous values are omitted from simplified changes, and activities without changes omit both `change` and `changes`.
- Fetch Test Event reports the page limit when a dense alert search cannot finish within it.
