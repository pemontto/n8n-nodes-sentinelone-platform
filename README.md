# SentinelOne Platform for n8n

Two n8n nodes for SentinelOne: **SentinelOne Platform** reads and updates alerts, manages notes, and runs SDL queries. **SentinelOne Platform Trigger** starts workflows when alerts are created or updated, or when someone adds an alert note. The credential determines which records and actions are accessible.

![An n8n workflow connecting the SentinelOne Platform note-created trigger to a Get parent alert action](https://raw.githubusercontent.com/pemontto/n8n-nodes-sentinelone-platform/main/docs/images/note-trigger-workflow.png)

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

| Resource   | Events                       |
| ---------- | ---------------------------- |
| Alert      | New, Updated, New or Updated |
| Alert Note | Created                      |

The trigger polls on the schedule you configure and keeps checkpoint and deduplication state. Optional Account, Site, and Group selections narrow the records it checks; empty selections include accessible records. A poll with no qualifying events produces no items.

See [trigger configuration](docs/trigger.md) for fields, note filters, and testing guidance.

## Documentation

- [Credentials](docs/credentials.md)
- [Actions](docs/actions.md)
- [Triggers](docs/trigger.md)
- [Verification](docs/ticket-update-verification.md)
- [Acceptance workflows](docs/testing.md)
- [Architecture and n8n references](docs/architecture.md)
- [Behavior contract](docs/behavior.md)

## Development

Use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm dev`. This foundation targets 0.1.0; live acceptance testing and npm publication are separate steps. New node and credential identifiers do not automatically migrate existing workflows.

[Source and issues](https://github.com/pemontto/n8n-nodes-sentinelone-platform). MIT licence; see LICENSE.
