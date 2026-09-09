# SentinelOne Platform for n8n

Two n8n nodes for SentinelOne: **SentinelOne Platform** reads and updates alerts, manages notes, and runs SDL queries. **SentinelOne Platform Trigger** starts workflows when alerts are created or updated, or when an alert activity occurs. The credential determines which records and actions are accessible.

![The inactive note test workflow with the Alert Activity trigger filtered to Note Created; only the trigger preview has run](https://raw.githubusercontent.com/pemontto/n8n-nodes-sentinelone-platform/main/docs/images/note-trigger-workflow.png)

Example: a new alert note starts the workflow, then Alert > Get fetches its parent using the event's `alertId`. No account or site selection is required for that lookup.

## Actions

| Resource   | Operations            |
| ---------- | --------------------- |
| Alert      | Get, Get Many, Update |
| Alert Note | Get Many, Create      |
| SDL Query  | Execute               |

Common alert fields are always returned. Options > Additional Alert Fields adds extras; Raw Data is opt-in. ID-based operations need no scope selection. Searches and triggers have optional Account, Site, and Group selections.

Update supports status, analyst verdict, and ticket ID. Verification reads changed fields after the mutation. Failed readback does not turn an acknowledged write into a rejected write.

## Trigger

Add **SentinelOne Platform Trigger** as the first node in a workflow and choose an event:

| Resource       | Events                       |
| -------------- | ---------------------------- |
| Alert          | New, Updated, New or Updated |
| Alert Activity | Occurred                     |

The trigger polls on the schedule you configure and keeps checkpoint and deduplication state. Optional Account, Site, and Group selections narrow the records it checks; empty selections include accessible records. A poll with no qualifying events produces no items.

See [trigger configuration](docs/trigger.md) for activity conditions, current-parent filters, delivery limits, and migration guidance.

Alert Activity supports alert creation, status/verdict/severity/assignee changes, mitigation activity, and note creation. It also accepts unknown alert-linked activity types. The condition builder matches recorded values within one activity. Optional raw activity and current alert fields add to a stable event envelope.

Breaking change: Alert Activity > Occurred replaces the trigger's Alert Note > Created resource without an alias. To keep note-only delivery, select Note created (`16007`) and start with fresh trigger state. Alert Note actions and Alert snapshot triggers are unchanged. See [migration steps](docs/trigger.md#breaking-migration-from-alert-note).

## Documentation

- [Credentials](docs/credentials.md)
- [Actions](docs/actions.md)
- [Triggers](docs/trigger.md)
- [Verification](docs/ticket-update-verification.md)
- [Acceptance workflows](docs/testing.md)
- [Architecture and n8n references](docs/architecture.md)
- [Behavior contract](docs/behavior.md)

## Development

Use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, and `pnpm lint`. For a shared development server, use `pnpm build:watch` and coordinate its restart after compilation; do not run `pnpm dev`. See [development runtime checks](docs/testing.md#development-runtime). This foundation targets 0.1.0; live acceptance testing and npm publication are separate steps. New node and credential identifiers do not automatically migrate existing workflows.

[Source and issues](https://github.com/pemontto/n8n-nodes-sentinelone-platform). MIT licence; see LICENSE.
