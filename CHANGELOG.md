# Changelog

## 0.1.0 (unreleased)

This first release provides n8n nodes for reading and updating SentinelOne alerts, managing alert notes, running SDL PowerQueries, and starting workflows from alert snapshots or alert activities. Use the `sentinelOnePlatformApi` credential with the new SentinelOne Platform and SentinelOne Platform Trigger nodes; saved workflows using the earlier package need migration.

- Alert Get returns common alert fields by default; Additional Alert Fields and Raw Data are opt-in. Alert Get Many supports filters, scope selection, and bounded pagination. Return All is capped at 10,000 alerts.
- Alert Update supports status, analyst verdict, and ticket ID. It submits once, reports rejected updates as errors with their HTTP status when available, and verifies acknowledged changes with bounded readback by default. Unknown or partial results require inspection before retrying.
- Alert Note Get Many and Create operate by alert ID. Note creation returns the observed notes and a best-effort identification of the new note.
- SDL Query Execute runs bounded PowerQueries and emits rows or a table with result metadata. Output size, row count, polling interval, and timeout have configurable limits.
- Alert snapshot triggers poll New, Updated, or New or Updated alerts. On hosts that provide a poll time budget, each stream and scope batch resumes from its own forward cursor. Updated reads follow New, and overlap is re-read only after a complete read. Hosts without a poll budget read descending and split ranges at the 25-page cap.
- Alert Activity > Occurred emits alert-linked activity records with current parent-alert context. It supports recorded-event conditions, current-parent filters, exclusions, raw activity, and optional current-alert enrichment. First scheduled use establishes a baseline; bounded overlap and retained state do not guarantee exactly-once downstream delivery.
- Alert Activity > Occurred replaces the earlier Alert Note > Created trigger without an alias. Use the Note created activity type (`16007`) for note events. Alert Note actions remain available.
- The action node is not exposed as an AI tool. OCSF is not included by the trigger; use Alert > Get when alert details are needed.
