# Changelog

## 0.1.0 (unreleased)

This first release provides n8n nodes for reading and updating SentinelOne alerts, managing alert notes, and running SDL PowerQueries, with triggers for new or updated alerts and for alert activity. Use the `sentinelOnePlatformApi` credential with the SentinelOne Platform and SentinelOne Platform Trigger nodes.

- Alert Get returns common alert fields by default; Additional Alert Fields and Raw Data are opt-in. Alert Get Many supports filters, scope selection, and bounded pagination. Return All is capped at 10,000 alerts.
- Alert Update supports status, analyst verdict, and ticket ID. It submits once, reports rejected updates as errors with their HTTP status when available, and verifies acknowledged changes with bounded readback by default. Unknown or partial results require inspection before retrying.
- Alert Note Get Many and Create operate by alert ID. Note creation returns the observed notes and a best-effort identification of the new note.
- SDL Query Execute runs bounded PowerQueries and emits rows or a table with result metadata. Output size, row count, polling interval, and timeout have configurable limits.
- Alert triggers poll New, Updated, or New or Updated alerts chronologically under the scheduled poll deadline (`getPollBudgetMs`, with a five-minute fallback). Each stream and scope batch resumes through `resumeMs` and `resumeIds`, and lagging streams are read first. Only deadline and page-cap stops emit a completed prefix and cursor; API failures, including 429, do not emit partial output or advance state. A poll with no output or cursor progress fails immediately with its position. Version-2 checkpoints use a fresh baseline when state is missing or unrecognised. Bounded caches evict their oldest entries with a warning and retain cursor IDs.
- Alert Activity > Occurred emits alert-linked activity records with current parent-alert context. It supports recorded-event conditions, current-parent filters, exclusions, raw activity, and optional current-alert enrichment. Scheduled polling uses a five-minute overlap. SDL honours `Retry-After` within its deadline and cancels completed and abandoned queries. Activation baselines remain in memory until committed state is observed. All trigger modes provide top-level `eventId`, `eventType`, and `eventTime` for downstream deduplication; rare duplicates after crashes, restored state, overlapping runs, or overload remain possible.
- The action node is not exposed as an AI tool. OCSF is not included by the trigger; use Alert > Get when alert details are needed.
