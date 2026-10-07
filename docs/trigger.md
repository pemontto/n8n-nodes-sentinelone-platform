# Triggers

Alert supports New, Updated, and New or Updated events. Updated emits alerts revised after creation, and New or Updated does not emit the same alert as both event types in one poll. Alert Activity reads individual alert-linked ActivityFeed records through the SDL V2 LOG query API. It requires SDL query access as well as the alert read access needed to validate current scope.

## Alert options

The Alert resource Options include Advanced Filters, Alert Name, Exclude Account Name, Exclude Group Name, Exclude Site Name, Alert Severity, Simplify, and Alert Status. Alert Name is an optional full-text match. Alert Severity and Alert Status accept multiple values and are left empty by default. Simplify defaults to enabled. Scope is its own section straight after Credential and Poll Times, shared by both trigger resources, containing Accounts, Sites, and Groups. Sites are hidden until Accounts has a value, and Groups are hidden until Sites has a value. Site options can still load accessible sites when account-list permission is unavailable. Alert Get Many keeps its scope selections under Options > Scope. Scope and name exclusions apply to both Alert and Alert Activity triggers; activity Options also provide Exclude User Name and Exclude User IDs.

### Advanced filters

Advanced Filters accepts a JSON array of filter objects. Each filter uses a `fieldId`, an optional boolean `isNegated`, and exactly one comparator: `stringIn`, `stringEqual`, or `dateTimeRange`. An array combines filters with AND. The `fieldId` and comparator must be supported by SentinelOne. Common fields include `severity`, `status`, `analystVerdict`, `createdAt`, `externalId`, and `ticketId`. For example, `[ { "fieldId": "severity", "stringIn": { "values": ["HIGH", "CRITICAL"] } } ]` matches either listed severity.

To express OR, provide an object with an `or` array of groups, each containing an `and` array of filters. For example, `{ "or": [ { "and": [ { "fieldId": "severity", "stringIn": { "values": ["HIGH"] } } ] }, { "and": [ { "fieldId": "status", "stringIn": { "values": ["NEW"] } } ] } ] }` matches either group. Each array supports at most 100 filters and an `or` object supports at most 20 groups. The built-in Severity, Status, Alert Name, and time filters still apply alongside these filters.

### Exclusions

Account, Site, Group, and activity user-name exclusions use case-insensitive regular expressions. Enter an empty value to disable the exclusion; missing names are kept. Patterns are limited to 256 characters, at most one simple `*`, `+`, or `?` quantifier, and at most one group. A non-capturing group is supported. Counted repetitions, lookarounds, backreferences, and multiple groups are not supported. User ID exclusions are exact IDs, not regular expressions.

## Activity selection

Choose activity types with the Operation multi-select. It retains the values from the former Trigger On multi-select and defaults to Any (`["any"]`). Any includes unknown alert-linked activity types, whose numeric IDs are preserved without assigning a guessed name. The former single-select Operation offered only Occurred; saved workflows may contain that value, which runtime ignores in favour of the activity-type selection. The removed custom activity type ID option is ignored when it appears in saved workflows.

| Type ID   | Activity                        |
| --------- | ------------------------------- |
| `16000`   | Alert created                   |
| `16001`   | Status changed                  |
| `16002`   | Analyst verdict changed         |
| `16003`   | Severity changed                |
| `16004`   | Assignee changed                |
| `16005`   | Mitigation activity             |
| `16007`   | Note created                    |
| `16008`   | Agentic investigation triggered |
| `unknown` | Other (Unrecognised Types)      |

Agentic Investigation Triggered means a management user or auto-investigation criteria triggered an agentic investigation for an alert. No change data is expected, so simplified output omits `change` and `changes`, as for Alert Created.

Other (Unrecognised Types) matches alert-linked activities outside the named IDs above, including `16006`, which has no catalogue description. These events have `activityKind: "unknown"` and retain `activityTypeId` in simplified output. Selected IDs and Other combine with OR; Any applies no type filter. The SDL LOG filter uses `!(...)` to negate the OR of named IDs, while retaining the existing equality and OR style. The parenthesised negation follows [SentinelOne's syntax reference](https://github.com/Sentinel-One/ai-siem/blob/main/plugins/s1-secops-skills/skills/powerquery/references/syntax-and-operators.md#1-boolean-and-arithmetic-operators). This exact LOG query has mock coverage but has not been verified against a live console.

Mitigation activity describes a recorded action and its supplied status. It does not mean remediation succeeded. In particular, `WORKFLOW` with `RUNNING` is not completion evidence. The trigger delivers once per activity ID within its retained checkpoint state; it does not monitor later revisions or wait for completion.

## Conditions and current alert filters

Add repeatable builder conditions under Activity Conditions. Match Conditions appears directly after that section even when it currently contains zero or one condition, and defaults to Any. It only affects matching when two or more conditions are configured; a single configured condition still applies. Every condition applies to one activity. Match all never accumulates separate events across polls. There is no JSON condition editor or free-form SDL input.

Status, analyst verdict, and severity conditions offer optional Previous Value and New Value multiselects using the complete shared enum values. Values within a list use OR. Previous Value and New Value use AND on the same recorded change. Both endpoints must exist and differ, even when only one list is selected. Empty lists add no endpoint restriction. For example, Status with New Value `RESOLVED` accepts a recorded resolution; Previous Value `RESOLVED` and New Value `NEW` or `IN_PROGRESS` accepts reopening.

Missing properties, explicit null, and the literal string `UNDEFINED` remain distinct. Missing endpoints do not match transition conditions. Equal endpoints do not match. The trigger never reconstructs historical values from current alerts, descriptions, or earlier polls.

Assignee conditions match supplied previous/new email values or destination IDs. Previous Assignee Email requires that field in the event; some events omit it. New Assignee Email or New Assignee ID can match without a previous value. There is no previous-ID selector. Mitigation conditions use Mitigation Action and Mitigation Status selectors whose title case labels map to SentinelOne enum values; for example, Add to Blocklist selects `BLOCKLIST_ADD` and Remove from Quarantine selects `UNQUARANTINE`. Status labels include Pending Reboot and Cancelled. These are value conditions, not completion monitoring.

Accounts, Sites, and Groups are saved under `scope.selection` in the trigger Scope section. Empty selections include accessible records. Site lists normally offer a Select an Account First placeholder while account scopes are available but no account is selected; credentials without account-list permission can load accessible sites directly. Group lists offer Select a Site First until a site is selected, and label each group by name. Placeholders never become scope selections. Saved Group selections require at least one selected Site. Clearing Accounts in the editor removes hidden Sites and Groups values and includes everything the credential can see; saved parameters that retain Groups without Sites fail before requests. Alert Severity and Alert Status inspect the parent at polling time, separately from recorded transitions. An old resolution can still match after the alert reopens unless a current-parent filter excludes it. Scope/name exclusions remain available alongside separate user-name regex and exact user-ID exclusions.

## Output

Simplify is an activity Option that defaults to true. Simplified output is flat and contains `eventId`, `eventType`, `eventTime`, `activityKind`, `actor` (`id`, `name`), `alertId`, `alertName`, `alertStatus`, `alertSeverity`, `alertAnalystVerdict`, `alertExternalId`, `accountId`, `accountName`, `siteId`, `siteName`, `groupId`, and `groupName`, plus `activityTypeId` when `activityKind` is `unknown`. For status (`16001`), analyst verdict (`16002`), severity (`16003`), and assignee (`16004`) events, a supplied change is returned as `change: { field, from?, to? }`; the assignee field is `assignee`, `from` and `to` are email addresses, and `toId` is the new assignee's id. If an old value was not supplied, `from` is omitted. Other activity types use `changes` with `oldValue` and `newValue` when supplied. `change` and `changes` are omitted when there is no change. `note` is a string included only for `noteCreated`, and mitigation details appear when supplied. Alert summary fields remain present as `null` when the lookup has no value. Include Raw Activity and Include Current Alert can add `rawActivity` and `currentAlert` in either output mode. The activity's external identifier, `activityId`, `activityTypeId`, `eventTimestamp`, nested actor, and full parent object are available in the full output when Simplify is disabled.

In full output, each recognised change appears in `changes[]` as `{field, oldValue?, newValue?}`. One activity can contain several changes. An empty array means no recognised changes were supplied; simplified output omits it. A missing endpoint stays absent; an explicit null stays null. Unknown types retain the generic envelope.

With Simplify disabled, output preserves the full activity shape, including fields that are optional. Include Raw Activity adds `rawActivity`; Include Current Alert adds `currentAlert`. Both options also work with Simplify enabled. These objects do not replace the event envelope or recorded changes. SDL LOG returns complete source records; Include Raw Activity controls whether those records appear in your workflow items. The full activity output uses the same activity selection and current V2 LOG endpoint.

A simplified status change has this shape (all values are synthetic):

```json
{
	"eventId": "tenant.example/alert/alert-123/activity/activity-456",
	"eventType": "alert.activity",
	"eventTime": "2025-02-03T10:00:00Z",
	"activityKind": "statusChanged",
	"change": { "field": "status", "from": "NEW", "to": "IN_PROGRESS" },
	"actor": { "id": "1234567890", "name": "analyst@example.test" },
	"alertId": "alert-123",
	"alertName": "Example detection",
	"alertStatus": "IN_PROGRESS",
	"alertSeverity": "HIGH",
	"alertAnalystVerdict": "UNDEFINED",
	"accountName": "Example account",
	"siteName": "London",
	"groupName": "Workstations"
}
```

With Simplify disabled, the event keeps its full envelope. Optional `note`, `mitigation`, `rawActivity`, and `currentAlert` are present only when their corresponding source data or options provide them. For example:

```json
{
	"alertId": "alert-123",
	"alertName": "Example detection",
	"alertExternalId": "source-789",
	"eventType": "alert.activity",
	"eventId": "tenant.example/alert/alert-123/activity/activity-456",
	"eventTime": "2025-02-03T10:00:00Z",
	"activityId": "activity-456",
	"activityTypeId": "16001",
	"activityKind": "statusChanged",
	"eventTimestamp": "2025-02-03T10:00:00Z",
	"changes": [
		{
			"field": "status",
			"oldValue": "NEW",
			"newValue": "IN_PROGRESS"
		}
	],
	"currentAlertStatus": "IN_PROGRESS",
	"currentAlertSeverity": "HIGH",
	"currentAlertAnalystVerdict": "UNDEFINED",
	"actor": {
		"id": "user-234",
		"name": "analyst@example.test"
	},
	"scope": {
		"account": {
			"id": "account-101",
			"name": "Example account"
		},
		"site": {
			"id": "site-202",
			"name": "London"
		},
		"group": {
			"id": "group-303",
			"name": "Workstations"
		},
		"source": "current",
		"type": "ACCOUNT",
		"id": "account-101",
		"name": "Example account"
	},
	"rawActivity": {
		"timestamp": "1738576800000000000",
		"values": {
			"activity_id": "activity-456",
			"activity_type": "16001",
			"created_at": "2025-02-03T10:00:00Z",
			"data.alert.id": "alert-123",
			"data.user.id": "user-234",
			"data.user.enriched_name": "analyst@example.test",
			"data.payload.changes.old_status": "NEW",
			"data.payload.changes.new_status": "IN_PROGRESS"
		}
	},
	"currentAlert": {
		"id": "alert-123",
		"name": "Example detection",
		"externalId": "source-789",
		"status": "IN_PROGRESS",
		"severity": "HIGH",
		"analystVerdict": "UNDEFINED",
		"realTime": {
			"scope": {
				"account": {
					"id": "account-101",
					"name": "Example account"
				},
				"site": {
					"id": "site-202",
					"name": "London"
				},
				"group": {
					"id": "group-303",
					"name": "Workstations"
				}
			}
		}
	}
}
```

Alert trigger outputs use the same Simplify option. Simplified alerts use SentinelOne's filter field IDs, so output names line up with Advanced Filters: `id`, `externalId`, `alertName`, `status`, `severity`, `ticketId`, `analystVerdict`, `alertNoteExists` and so on. The raw alert object calls the title `name`; the filter field, and so simplified output, calls it `alertName`. Scope is flattened into `accountId`, `accountName`, `siteId`, `siteName`, `groupId`, and `groupName`; `scope` and `eventTimestamp` are omitted. Additional Alert Fields are unprefixed, such as `ticketId` and `analystVerdict`. Raw output keeps the original alert object under `alert`. Examples:

```json
{
	"eventId": "tenant.example/alert/alert-123/new",
	"eventType": "alert.new",
	"eventTime": "2025-02-03T09:55:00Z",
	"id": "alert-123",
	"externalId": "source-789",
	"alertName": "Example detection",
	"severity": "HIGH",
	"status": "NEW",
	"analystVerdict": "UNDEFINED",
	"accountName": "Example account",
	"siteName": "London",
	"groupName": "Workstations",
	"createdAt": "2025-02-03T09:55:00Z",
	"updatedAt": "2025-02-03T09:55:00Z",
	"detectedAt": "2025-02-03T09:54:50Z",
	"firstSeenAt": "2025-02-03T09:54:50Z",
	"lastSeenAt": "2025-02-03T09:55:00Z",
	"alertNoteExists": false
}
```

With Simplify disabled, the raw alert is nested under `alert`, and the output includes `eventTimestamp` and the scope object:

```json
{
	"eventId": "tenant.example/alert/alert-123/new",
	"eventType": "alert.new",
	"eventTime": "2025-02-03T09:55:00Z",
	"eventTimestamp": "2025-02-03T09:55:00Z",
	"scope": {
		"type": "ACCOUNT",
		"id": "account-101",
		"name": "Example account",
		"account": { "id": "account-101", "name": "Example account" },
		"site": { "id": "site-202", "name": "London" },
		"group": { "id": "group-303", "name": "Workstations" }
	},
	"alert": {
		"id": "alert-123",
		"externalId": "source-789",
		"name": "Example detection",
		"severity": "HIGH",
		"status": "NEW",
		"createdAt": "2025-02-03T09:55:00Z",
		"updatedAt": "2025-02-03T09:55:00Z",
		"detectedAt": "2025-02-03T09:54:50Z",
		"firstSeenAt": "2025-02-03T09:54:50Z",
		"lastSeenAt": "2025-02-03T09:55:00Z",
		"noteExists": false
	}
}
```

## Polling and test events

The activation poll establishes a fresh baseline on first use or after relevant configuration changes and does not replay earlier events. The first following scheduled poll uses that baseline and can emit later matching events. Updated events can arrive before New events because the streams progress independently. A pending activation baseline is held in memory by workflow and node with its configuration fingerprint. n8n 2.38.1 can discard static data when a poll returns no items. A configuration change resets the pending baseline, including a change from A to B and back to A; it expires after one hour, and only empty scheduled polls refresh it. Checkpoint state is version 2. Missing, old, or unrecognised state causes a new baseline rather than migration. Alert activity uses a 300-second overlap. Reads are chronological and budgeted against n8n's scheduled poll deadline (`getPollBudgetMs`, with a five-minute fallback). Each stream and scope batch resumes from its own `resumeMs` and `resumeIds`; New reads `createdAt`, and Updated reads `updatedAt`. An interrupted New read retains its overlap so late arrivals can still be found.

Requests, retries, and delays are bounded by the remaining deadline. A request timeout caused by the poll deadline is treated as a deadline stop. A deadline or page-cap stop can emit the completed prefix and its cursor. If a retryable 429 or 5xx cannot be retried before the deadline, the trigger returns the completed prefix and hands the unfinished range to the next poll when progress has been made; it logs the response status. Without progress, the HTTP error is returned. Other API failures, including 401, 403, and 404, fail the poll without emitting partial results or advancing state. If polling emits or advances nothing, it fails immediately with a positioned error. Alert Activity splits SDL ranges and caps its own work while reserving time for parent lookups. A query, lookup, scope, or permission failure remains an error; only this trigger's own deadline or page cap can stop work successfully with a completed prefix. The trigger makes no per-alert detail requests; use Alert > Get for alert fields.

Alert and activity checkpoint caches are bounded: 20,000 New alert IDs, 40,000 alert version entries, and 40,000 activity IDs. When a cache is full, the oldest entry is evicted and a warning is logged. Cursor IDs are never evicted. A resume position with more than 1,000 tied alert IDs fails visibly; it is not split into larger exclusion lists. An SDL result saturated inside one millisecond also fails because its window cannot be split further. Narrow the selected scope or filters for these limits. Rare duplicates can still occur after a crash, state restore, overlapping execution, or overload. Near the threshold of roughly 4,000 alerts per minute, New alerts can be duplicated around the five-minute overlap. Use the top-level `eventId` as the stable deduplication key in every mode. Its slash-separated components are individually encoded with `encodeURIComponent`: host, `alert`, alert ID, then `new`, or `updated` followed by the exact returned `updatedAt`; activity IDs use host, `alert`, alert ID, `activity`, and activity ID. Prefer downstream deduplication or an idempotent destination. In n8n, the Remove Duplicates node can use Node scope to retain several days of events; once its history is full, it errors until history is cleared or enlarged.

Fetch Test Event searches newest windows first, down to the existing January 2020 lower boundary. It returns at most the 10 newest matches from the first nonempty matching window and stops even if only one matches. It never searches older windows just to fill ten. If a dense window exceeds the configured page cap, the preview reports the limit instead of splitting the window to try to fill the result. Finite request and query budgets still apply; exhausting them reports an incomplete search rather than claiming no matches.

Scope resolution, SDL launch/poll, and alert lookup errors identify the failed stage without including source records or credentials. Incomplete results, malformed current-scope metadata, conflicting duplicates and saturated windows that cannot be split further fail without advancing scheduled state. A deadline or page-cap stop can save only the already completed prefix. An activity whose parent alert cannot be found also fails while its source timestamp remains inside the overlap retry window. Once older than that window, the trigger skips it and logs a warning with the dropped count, allowing other activities and the checkpoint to proceed. It never emits an activity with unverified scope. This expiry also applies during manual preview; request failures are not treated as deleted alerts.

Delivery depends on source retention, late-arrival timing, and the bounded overlap/checkpoint history. It is not an exactly-once downstream guarantee or a complete historical archive. Use `eventId` for downstream idempotency where needed. Actor exclusions can reduce self-triggering but do not guarantee loop prevention.

Severity options use Critical, High, Medium, Low, Info, Unknown order. Status options use New, In Progress, Resolved order.
