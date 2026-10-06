<p align="center">
  <img src="icons/sentinelone.svg" alt="SentinelOne Logo" width="120" />
</p>

# SentinelOne Platform for n8n

SentinelOne Platform provides n8n nodes to read and update SentinelOne alerts, manage alert notes, and run SDL PowerQueries. Triggers fire on new or updated alerts and on alert activity.

![Two flows: High and Critical alerts open a ServiceNow incident and save its number as the alert's ticket ID; new analyst notes are added as comments on the alert's linked Jira issue](https://raw.githubusercontent.com/pemontto/n8n-nodes-sentinelone-platform/main/docs/images/alert-escalation-workflow.png)

For example, escalate High and Critical alerts to ServiceNow and write the incident number back to the alert, or copy analyst notes to the linked Jira issue as comments.

## Actions

| Resource   | Operations                                                 |
| ---------- | ---------------------------------------------------------- |
| Alert      | Get, Get Many, Update (status, analyst verdict, ticket ID) |
| Alert Note | Get Many, Create                                           |
| SDL Query  | Execute                                                    |

Common alert fields are always returned. Options > Additional Alert Fields adds extras; Raw Data is opt-in. ID-based operations need no scope selection. Searches and triggers have optional Account, Site, and Group selections.

## Trigger

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
