# Actions

## Alert

Get requires an Alert ID. Get and Update report a missing or inaccessible alert as HTTP 404, including during Update discovery and verification. Common alert fields are always returned; Options > Additional Alert Fields adds supported fields, while Raw Data and large enrichments are opt-in. Additional GraphQL Fields accepts a field selection, including nested selections, without a query wrapper; arguments, aliases, and directives are not accepted.

Get Many supports optional Account, Site, and Group selections under Options > Scope, filters for analyst verdict, creation time, external ID, severity, status, and ticket ID, and pagination. Empty scope selections include accessible records. Groups require a selected Site. Get Many keeps the first occurrence of each alert ID, and Limit counts unique alerts. Return All stops with an error above 10,000 unique alerts; add filters or use a bounded Limit instead.

Update supports status, analyst verdict, and ticket ID. Choose a Status or Analyst Verdict explicitly; neither has an implicit selection. Strings are preserved and objects or arrays are serialised once. Ticket updates replace the entire value; merge existing JSON explicitly if other metadata must survive. Advanced Update Payload is additive to Update Fields, accepts the same fields, and rejects duplicate keys. Severity changes and clearing fields are unsupported.

The normal output item includes `alertId`, `requested`, `outcome`, `mutationAcknowledged`, `verification`, and `verificationStatus`, plus fields for scheduled execution IDs, immediate action results, or safe error codes as applicable. Immediate action results have an `actionId`, a `status` of `success`, `skipped`, or `failed`, and sanitised `detail`. Scheduled and partial outcomes remain items. Rejected updates throw `NodeApiError` with the real HTTP status when available, otherwise the service error code when present. The error carries `alertId`, `requested`, `errors`, and `mutationAcknowledged: false`; it works with Continue On Fail and Continue (using error output). Unknown outcomes include `httpCode` for an HTTP failure or `errorCode` for a statusless network failure. Check the alert before retrying an uncertain or partial update. See [Update verification](ticket-update-verification.md).

GraphQL errors return SentinelOne's own message text (up to five messages, each bounded) plus any error codes, so a failure says what went wrong. Values submitted by a mutation, such as note text, are masked if SentinelOne echoes them back. A missing alert is reported as `Alert <id> not found.` with HTTP 404.

### Get Many filters

The legacy Filters collection is unchanged. Its analyst verdict, created time, external ID, severity, status, and ticket ID conditions remain ANDed with each other and with the newer filter controls. Alert Filters and Match Filters are top-level parameters, and Advanced Filters is in Options. The shared controls use the same fields, comparators and row validation as the Alert trigger; see [Alert filter fields](reference/alert-filter-fields.md). Match All requires every row; Match Any requires at least one row. Get Many accepts only the saved values `all` and `any` for Match Filters.

Advanced Filters accepts either a JSON list of filter objects, where every filter must match, or one JSON object with an `or` array of groups containing `and` arrays. Get Many combines its existing Filters collection, Alert Filters, and Advanced Filters with AND. With Match Any, each row is combined with every Advanced Filters OR group; legacy conditions remain in every resulting group. The final combined expression is limited to 20 groups and 100 filters in each group. Invalid row fields and comparators are checked against SentinelOne alert-column metadata. If that lookup fails in a non-manual execution, Get Many logs a warning and proceeds without metadata validation; manual executions and HTTP 401 or 403 still fail. SentinelOne still validates the alert query.

For example, Match Filters set to All can select statuses `NEW` and `IN_PROGRESS`, while two Alert Filters rows exclude ticket IDs containing `automation_marker` and `triage_result`. These filters are combined and evaluated by SentinelOne as part of the Get Many request; no client-side filtering is applied.

## Alert Note

Get Many takes an Alert ID and a Limit or Return All. Create takes an Alert ID, text, and Plain Text or Markdown format. Neither operation needs scope.

Create returns `outcome: "acknowledged"`, `mutationAcknowledged: true`, `alertId`, `contentType`, `identification`, and `notes` containing the observed note records. `identification.status` is `inferred` only when a complete before/after snapshot reveals one matching new note; otherwise it is `ambiguous` with a reason and candidates. The write is submitted once. If the result is uncertain, inspect existing notes before another attempt.

## SDL Query

Execute accepts a query, start and end times, and Query Scope: Entire Tenant or Selected Accounts. Output Mode defaults to Rows, one item per row, or Table, one item containing `queryId`, `columns`, `values`, and `metadata`. Each Rows item contains the query columns and `_query` metadata; an empty result emits one metadata-only item. Metadata includes partial-result reasons, warnings, counts, cleanup status, and other query metrics.

Options and defaults are Maximum Output Size (MiB), 10 (range 1 to 50); Maximum Rows, 5,000 (range 1 to 100,000); Poll Interval (Milliseconds), 1,500 (range 1,000 to 10,000); and Timeout (Seconds), 100 (range 10 to 300). The timeout applies to the query lifecycle before final cleanup. Oversized received responses fail; output may be truncated to meet the configured row and output-size limits, with partial-result reasons recorded in metadata.

## Debug

Settings > Debug logs redacted GraphQL structure, variables, attempts, timing, and outcomes to the n8n server log at Info level. It excludes credentials and full write payloads and does not change normal output.
