# Behavior contract

## Scope and fields

Alert Get and Update and Alert Note Get Many and Create target IDs and need no scope selection. Alert Get Many and triggers accept optional Account, Site, and Group selections. Groups require at least one selected Site. Blank IDs are rejected, including values supplied through expressions and legacy top-level scope fields. Site-scoped credentials can resolve accessible sites even when account-list access is unavailable. An expression that resolves to an empty selection means all records accessible to the credential. A parent alert's current scope must still be validated before an activity is emitted.

When a scope is selected, omitted child selections mean all accessible children beneath it. Hidden child selections are retained and validated by Get Many and triggers, including legacy saved fields. A Groups selection without Sites is rejected rather than widened. Common alert fields remain present; Additional Alert Fields and Raw Data are opt-in. The common response intentionally exceeds the n8n ten-field simplification recommendation.

## Requests and outcomes

Authenticated n8n request helpers handle network access. Shared read transport retries transient network errors and selected server responses with bounded deadlines and backoff. Mutations are submitted once. Whole-node Retry On Fail is rejected for mutation operations because it can repeat writes. Debug uses redacted request details and cannot affect execution.

Alert Update supports status, analyst verdict, and ticket ID. Rejected updates throw `NodeApiError`; an available HTTP response status is retained, otherwise the service error code is used when present. n8n Continue On Fail and Continue (using error output) handle the thrown error, with the originating item pairing preserved. Error details include `alertId`, `requested`, `errors`, and `mutationAcknowledged: false`. Unknown or partial mutation outcomes are returned as items with `outcome: "unknown"` or `outcome: "partial"` and acknowledgement fields; individual action results include a `status`. Do not retry until the alert has been checked.

Alert Note Create submits once. It compares note snapshots before and after the write to identify a unique matching new note; if the snapshot is incomplete or identification is ambiguous, it returns that status and candidates rather than claiming a particular note was created. An uncertain write must be inspected before another attempt.

## Update verification

Verify Update is enabled by default and reads only changed fields after the mutation. Verification uses a bounded read budget and does not repeat the write. Each output includes `alertId`, `requested`, `outcome`, and `mutationAcknowledged`, with `verification` and `verificationStatus` when verification applies. Scheduled action results remain items; `pending` means SentinelOne acknowledged a scheduled action but readback has not observed the requested values. See [Update verification](ticket-update-verification.md) for status definitions and comparison rules.

## SDL query output

SDL Query Execute accepts a PowerQuery, start/end times, and either Entire Tenant or selected accounts. Output Mode defaults to Rows, emitting one item per row, or Table, emitting one item with `queryId`, `columns`, `values`, and `metadata`. Rows place result columns directly on each item and include `_query` metadata; an empty result still emits one metadata-only item. Metadata reports partial-result reasons, warnings, matching and omitted counts, CPU usage, row counts, and cleanup status.

Options default to a 10 MiB maximum output size, 5,000 maximum rows, 1,500 ms poll interval, and 100 second timeout. Output rows can be truncated to fit byte and row limits, with the partial result described in metadata. An oversized received response fails. SDL cleanup runs after a launched query, including when query execution fails.

## Alert activity delivery

Alert Activity > Occurred uses SDL V2 LOG queries in both normal and raw modes. Recorded activity conditions inspect one event; current-parent filters inspect lookup state. Output has a stable event envelope with unified/source alert identifiers, alert name, current status/severity/verdict, recognised changes, and optional raw/current-alert data. Activity IDs are deduplicated within bounded checkpoint and overlap history; later revisions are not monitored. See [the trigger contract](trigger.md) for filters, cursor behavior, baseline, and delivery limits.
