# Implementation status

Version 0.1.0 contains the public Alert, Alert Note, and SDL Query actions and the SentinelOne Platform Trigger. The supported operations and behaviours are documented in [Actions](actions.md), [Triggers](trigger.md), and the [behavior contract](behavior.md).

| Area                    | Current support                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Alert actions           | Get, Get Many, and Update. Common fields are returned by default, optional fields are opt-in, and Return All is capped at 10,000 alerts.       |
| Alert Note actions      | Get Many and Create by alert ID. Create submits once and reports whether the created note could be identified from before-and-after snapshots. |
| SDL Query action        | Execute with tenant or selected-account scope, Rows or Table output, and bounded output, row, polling, and timeout settings.                   |
| Alert snapshot triggers | New, Updated, or New or Updated, with scope, filters, exclusions, and resumable polling state.                                                 |
| Alert Activity trigger  | Occurred, with recorded-event conditions, current-parent filters, exclusions, and optional raw/current-alert output.                           |

Activity delivery depends on source retention and bounded checkpoint state. It does not promise exactly-once downstream processing. Alert Activity establishes a baseline on first scheduled use and does not replay earlier events. Alert Update and Alert Note Create mutations are submitted once; inspect uncertain results before retrying.
