# Alert Activity verification

The Alert Activity trigger reads alert-linked activity through SDL V2 LOG and validates each candidate against its current parent alert. Normal and raw modes use the same feed selection. The output keeps recorded changes separate from current alert state.

The automated suite covers the eight named activity types, unknown types, transition and assignee conditions, mitigation values, missing and null endpoints, baseline changes, overlap, late arrivals, unavailable parent alerts, duplicate conflicts, scope validation, query saturation, and budget exhaustion. It also checks parity between normal and raw output.

In the editor, Alert Activity selects activity types with the Operation multi-select. Accounts, Sites, and Groups are top-level scope controls; Sites appear when Accounts has a value, and Groups appear when Sites has a value. Activity Conditions add repeatable event conditions, and Match Conditions stays visible after them even when no condition is configured. Activity Options include Alert Severity and Alert Status for current alert filters, account/site/group exclusions, Exclude User Name and Exclude User IDs, Include Raw Activity, and Include Current Alert.

## Delivery limits

The scheduled trigger records a baseline on first use or after a relevant configuration change; it does not replay history from before that baseline. Later polling deduplicates by activity ID within retained checkpoint and overlap state, but source retention, late arrivals, and bounded state mean downstream delivery is not guaranteed exactly once. Later revisions of delivered activity IDs are not monitored, and mitigation activity does not prove that remediation completed.

An unavailable parent alert is retried while its activity timestamp is within the overlap window. Older unresolved activities are skipped with a sanitised warning; recent lookup failures and malformed scope metadata fail the poll without advancing state. A finite poll budget can advance only through a fully completed prefix. See [trigger polling](trigger.md#polling-and-test-events) for checkpoint, capacity, and preview limits.
