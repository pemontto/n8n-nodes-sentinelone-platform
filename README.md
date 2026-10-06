<p align="center">
  <img src="icons/sentinelone.svg" alt="SentinelOne Logo" width="120" />
</p>

# SentinelOne Platform for n8n

SentinelOne Platform provides n8n nodes to read and update SentinelOne alerts, manage alert notes, run SDL PowerQueries, and start workflows from alert snapshots or alert activities. The credential determines which records and actions are accessible.

![The inactive note test workflow with the Alert Activity trigger filtered to Note Created; only the trigger preview has run](https://raw.githubusercontent.com/pemontto/n8n-nodes-sentinelone-platform/main/docs/images/note-trigger-workflow.png)

Example: a new alert note starts the workflow, then Alert > Get fetches its parent using the event's `alertId`. No account or site selection is required for that lookup.

## Actions

| Resource   | Operations            |
| ---------- | --------------------- |
| Alert      | Get, Get Many, Update |
| Alert Note | Get Many, Create      |
| SDL Query  | Execute               |

Common alert fields are always returned. Options > Additional Alert Fields adds extras; Raw Data is opt-in. ID-based operations need no scope selection. Searches and triggers have optional Account, Site, and Group selections.

Update supports status, analyst verdict, and ticket ID. Verification reads changed fields after the mutation. Failed readback does not turn an acknowledged write into a rejected write. Return All on Alert Get Many is capped at 10,000 alerts.

## Trigger

Add **SentinelOne Platform Trigger** as the first node in a workflow and choose an event:

| Resource       | Events                       |
| -------------- | ---------------------------- |
| Alert          | New, Updated, New or Updated |
| Alert Activity | Occurred                     |

The trigger polls on the schedule you configure and keeps checkpoint and deduplication state. Optional Account, Site, and Group selections under Options > Scope narrow the records it checks; empty selections include accessible records. Site-scoped credentials can list accessible sites without account-list permission. Groups require at least one selected Site. A poll with no qualifying events produces no items.

See [trigger configuration](docs/trigger.md) for activity conditions, current-parent filters, and delivery limits.

Alert Activity supports alert creation, status/verdict/severity/assignee changes, mitigation activity, and note creation. It also accepts unknown alert-linked activity types. The condition builder matches recorded values within one activity. Optional raw activity and current alert fields add to a stable event envelope.

Activity output starts with the alert ID, name and source-provided external ID. Current status, severity and analyst verdict are included by default and clearly separated from recorded changes.

### Known limits

- Alert snapshot overlap exclusions are capped at 1,000 IDs per request.
- On single-batch tenants under sustained load close to per-poll capacity, New alerts that become visible more than roughly 240 seconds after their `createdAt` (close to the 300-second overlap) can be missed.
- These limits depend on SentinelOne behaviour to confirm on a live tenant: the request size limit for excluded IDs, real alert ID length, page latency at 200 rows for large scope batches, alert visibility lag, `updatedAt` ties from bulk actions, and cursor stability. See [delivery limits](docs/trigger.md).

## Documentation

- [Credentials](docs/credentials.md)
- [Actions](docs/actions.md)
- [Triggers](docs/trigger.md)
- [Verification](docs/ticket-update-verification.md)
- [Acceptance workflows](docs/testing.md)
- [Architecture and n8n references](docs/architecture.md)
- [Behavior contract](docs/behavior.md)

## Development

Use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, and `pnpm lint`. Run `pnpm dev` for the normal package-local n8n development process. See [development runtime checks](docs/testing.md#development-runtime) for maintainer-specific runtime checks.

[Source and issues](https://github.com/pemontto/n8n-nodes-sentinelone-platform). MIT licence; see LICENSE.
