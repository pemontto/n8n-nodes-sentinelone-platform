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

See [trigger configuration](docs/trigger.md) for activity conditions, current-parent filters, delivery limits, and migration guidance.

Alert Activity supports alert creation, status/verdict/severity/assignee changes, mitigation activity, and note creation. It also accepts unknown alert-linked activity types. The condition builder matches recorded values within one activity. Optional raw activity and current alert fields add to a stable event envelope.

Alert Activity > Occurred replaces the earlier trigger's Alert Note > Created resource without an alias. To keep note-only delivery, select Note created (`16007`) and start with fresh trigger state. Alert Note actions and Alert snapshot triggers are available. See [migration steps](docs/trigger.md#breaking-migration-from-alert-note).

Activity output starts with the alert ID, name and source-provided external ID. Current status, severity and analyst verdict are included by default and clearly separated from recorded changes.

## Migrating from n8n-nodes-sentinelone-alerts

This package supersedes `n8n-nodes-sentinelone-alerts`. Install the new package and migrate workflows deliberately: its credential type is `sentinelOnePlatformApi` instead of `sentinelOneAlertsApi`, its action node type is `sentinelOnePlatform` instead of `sentinelOneAlerts`, and its trigger type is `sentinelOnePlatformTrigger` instead of `sentinelOneAlertsTrigger`. n8n can have both packages installed side by side while workflows are migrated.

| Earlier package setting                     | New package setting                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SentinelOne Alerts node, Alert > Get        | SentinelOne Platform, Alert > Get; keep `alertId`                                                                                                                         |
| SentinelOne Alerts node, Alert > Get Many   | SentinelOne Platform, Alert > Get Many; move `accountIds`, `siteIds`, and `groupIds` into Options > Scope, retain filters, and review pagination                          |
| SentinelOne Alerts node, Alert > Update     | SentinelOne Platform, Alert > Update; keep `alertId`, map status, analyst verdict, and ticket ID into Update Fields, and review Advanced Update Payload and Verify Update |
| Alert Note > Get Many/Create                | Alert Note > Get Many/Create; keep `alertId`, text, content format, and limit/Return All settings                                                                         |
| SDL Query > Execute                         | SDL Query > Execute; review query scope, output mode, and the new output and lifecycle limits                                                                             |
| Trigger, Alert > New/Updated/New or Updated | SentinelOne Platform Trigger, Alert with the same event; move scopes into Options > Scope and review trigger filters and output                                           |
| Trigger, Alert Note > Created               | SentinelOne Platform Trigger, Alert Activity > Occurred; select Note created (`16007`) and review conditions, exclusions, and output expressions                          |
| Include SentinelOne OCSF                    | Removed from the trigger; use Alert > Get for alert fields. This package does not expose an OCSF operation.                                                               |
| Use as AI tool                              | Removed; the action node is not exposed as an AI tool.                                                                                                                    |

The old and new node identifiers and credentials are distinct, so existing workflows continue to need their old package and credential until migrated. For trigger cutover, run the old and new triggers in parallel for at least one poll interval plus the configured overlap, then de-duplicate downstream by `alertId` and disable the old trigger. The first scheduled poll of the new trigger records a baseline and does not emit historical events; the overlap provides time to compare current delivery while that baseline is established.

## Documentation

- [Credentials](docs/credentials.md)
- [Actions](docs/actions.md)
- [Triggers](docs/trigger.md)
- [Verification](docs/ticket-update-verification.md)
- [Acceptance workflows](docs/testing.md)
- [Architecture and n8n references](docs/architecture.md)
- [Behavior contract](docs/behavior.md)

## Development

Use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, and `pnpm lint`. Run `pnpm dev` for the normal package-local n8n development process. See [development runtime checks](docs/testing.md#development-runtime) for maintainer-specific runtime checks. This is the 0.1.0 release; new node and credential identifiers do not automatically migrate existing workflows.

[Source and issues](https://github.com/pemontto/n8n-nodes-sentinelone-platform). MIT licence; see LICENSE.
