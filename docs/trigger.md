# Triggers

Alert supports New, Updated, and New or Updated events. Updated emits alerts revised after creation, and New or Updated does not emit the same alert as both event types in one poll. Alert Activity reads individual alert-linked ActivityFeed records through the SDL V2 LOG query API. It requires SDL query access as well as the alert read access needed to validate current scope.

## Alert options

The Alert resource Options include Advanced Filters, Alert Name, Exclude Account Name, Exclude Group Name, Exclude Site Name, Severity, Simplify, and Status. Alert Name is an optional full-text match. Severity and Status accept multiple values and are left empty by default. Simplify defaults to enabled. Scope and name exclusions apply to both Alert and Alert Activity triggers; activity Options also provide Exclude Actor Name and Exclude Actor IDs.

### Advanced filters

Advanced Filters accepts a JSON array of filter objects. Each filter uses a `fieldId`, an optional boolean `isNegated`, and exactly one comparator: `stringIn`, `stringEqual`, or `dateTimeRange`. An array combines filters with AND. The `fieldId` and comparator must be supported by SentinelOne. Common fields include `severity`, `status`, `analystVerdict`, `createdAt`, `externalId`, and `ticketId`. For example, `[ { "fieldId": "severity", "stringIn": { "values": ["HIGH", "CRITICAL"] } } ]` matches either listed severity.

To express OR, provide an object with an `or` array of groups, each containing an `and` array of filters. For example, `{ "or": [ { "and": [ { "fieldId": "severity", "stringIn": { "values": ["HIGH"] } } ] }, { "and": [ { "fieldId": "status", "stringIn": { "values": ["NEW"] } } ] } ] }` matches either group. Each array supports at most 100 filters and an `or` object supports at most 20 groups. The built-in Severity, Status, Alert Name, and time filters still apply alongside these filters.

### Exclusions

Account, Site, Group, and activity actor name exclusions use case-insensitive regular expressions. Enter an empty value to disable the exclusion; missing names are kept. Patterns are limited to 256 characters, at most one simple `*`, `+`, or `?` quantifier, and at most one group. A non-capturing group is supported. Counted repetitions, lookarounds, backreferences, and multiple groups are not supported. Actor ID exclusions are exact IDs, not regular expressions.

## Activity selection

Choose activity types with the Operation multi-select. It offers the same values as the former Trigger On multi-select and defaults to Any (`["any"]`). Any includes unknown alert-linked activity types, whose numeric IDs are preserved without assigning a guessed name. The former single-select Operation offered only Occurred; saved workflows may contain that value, which runtime ignores in favour of the activity-type selection.

| Type ID | Activity                |
| ------- | ----------------------- |
| `16000` | Alert created           |
| `16001` | Status changed          |
| `16002` | Analyst verdict changed |
| `16003` | Severity changed        |
| `16004` | Assignee changed        |
| `16005` | Mitigation activity     |
| `16007` | Note created            |

Mitigation activity describes a recorded action and its supplied status. It does not mean remediation succeeded. In particular, `WORKFLOW` with `RUNNING` is not completion evidence. The trigger delivers once per activity ID within its retained checkpoint state; it does not monitor later revisions or wait for completion.

## Conditions and current alert filters

Add repeatable builder conditions under Recorded Activity Conditions. Match Conditions appears directly after that section even when it currently contains zero or one condition, and defaults to Any. It only affects matching when two or more conditions are configured; a single configured condition still applies. Every condition applies to one activity. Match all never accumulates separate events across polls. There is no JSON condition editor or free-form SDL input.

Status, analyst verdict, and severity conditions offer optional From and To multiselects using the complete shared enum values. Values within a list use OR. From and To use AND on the same recorded change. Both endpoints must exist and differ, even when only one list is selected. Empty lists add no endpoint restriction. For example, Status with To `RESOLVED` accepts a recorded resolution; From `RESOLVED` and To `NEW` or `IN_PROGRESS` accepts reopening.

Missing properties, explicit null, and the literal string `UNDEFINED` remain distinct. Missing endpoints do not match transition conditions. Equal endpoints do not match. The trigger never reconstructs historical values from current alerts, descriptions, or earlier polls.

Assignment conditions match supplied previous/new email values or destination IDs. A previous-email condition requires that field in the event; some events omit it. A destination email or ID condition can match without a previous value. There is no previous-ID selector. Mitigation conditions match action-type and activity-status values from the schema enums; they are value conditions, not completion monitoring.

Options > Scope groups the optional Account, Site, and Group selections that restrict current scope. Empty selections include accessible records. Site lists normally offer a Select an Account First placeholder while account scopes are available but no account is selected; credentials without account-list permission can load accessible sites directly. Group lists offer Select a Site First until a site is selected. Placeholders never become scope selections. Group selections require at least one selected Site; clearing Sites while retaining Groups fails before requests rather than broadening the query. Current parent alert status and severity filters inspect the parent at polling time, separately from recorded transitions. An old resolution can still match after the alert reopens unless a current-parent filter excludes it. Scope/name exclusions remain available alongside separate actor-name regex and exact actor-ID exclusions.

## Output

Simplify is an activity Option that defaults to true. Simplified output is flat and contains `eventId`, `eventType`, `eventTime`, `activityKind`, `actorName`, `alertId`, `alertName`, `alertStatus`, `alertSeverity`, `alertAnalystVerdict`, `accountName`, `siteName`, and `groupName`. `changes` is included only when present. `note` is a string included only for `noteCreated`. The alert summary fields remain present as `null` when the lookup has no value. The activity's external identifier, `activityId`, `activityTypeId`, `eventTimestamp`, nested actor, and full parent object are available in the full output when Simplify is disabled.

Each recognised change appears in `changes[]` as `{field, oldValue?, newValue?}`. One activity can contain several changes. In full output, an empty array means no recognised changes were supplied; simplified output omits that empty array. A missing endpoint stays absent; an explicit null stays null. The full output includes note and mitigation details when supplied. Unknown types retain the generic envelope.

With Simplify disabled, output preserves the existing full activity shape, including fields that are optional, `rawActivity` when Include Raw Activity is enabled, and `currentAlert` when Include Current Alert is enabled. These raw and current objects are available only in full output. They do not replace the event envelope or historical changes. The full activity output uses the same activity selection and current V2 LOG endpoint.

A simplified status change has this shape (all values are synthetic):

```json
{
	"eventId": "tenant.example/alert/alert-123/activity/activity-456",
	"eventType": "alert.activity",
	"eventTime": "2025-02-03T10:00:00Z",
	"activityKind": "statusChanged",
	"changes": [{ "field": "status", "oldValue": "NEW", "newValue": "IN_PROGRESS" }],
	"actorName": "analyst@example.test",
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

With Simplify disabled, the event keeps its full envelope. Optional `note`, `mitigation`, `rawActivity`, and `currentAlert` are present only when their corresponding source data or options provide them; `rawActivity` and `currentAlert` are only available in full output. For example:

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

Alert trigger outputs use the same Simplify option. Simplified alerts rename `name`, `status`, `severity`, and `externalId` to `alertName`, `alertStatus`, `alertSeverity`, and `alertExternalId`, and omit `eventTimestamp`; other common fields, Additional Alert Fields, and `scope` are unchanged. Raw output keeps the original alert object under `alert`. Examples:

```json
{
	"eventId": "tenant.example/alert/alert-123/new",
	"eventType": "alert.new",
	"eventTime": "2025-02-03T09:55:00Z",
	"scope": {
		"type": "ACCOUNT",
		"id": "account-101",
		"name": "Example account",
		"account": { "id": "account-101", "name": "Example account" },
		"site": { "id": "site-202", "name": "London" },
		"group": { "id": "group-303", "name": "Workstations" }
	},
	"alertId": "alert-123",
	"alertExternalId": "source-789",
	"alertName": "Example detection",
	"alertSeverity": "HIGH",
	"alertStatus": "NEW",
	"createdAt": "2025-02-03T09:55:00Z",
	"updatedAt": "2025-02-03T09:55:00Z",
	"detectedAt": "2025-02-03T09:54:50Z",
	"firstSeenAt": "2025-02-03T09:54:50Z",
	"lastSeenAt": "2025-02-03T09:55:00Z",
	"noteExists": false
}
```

With Simplify disabled, the raw alert is nested under `alert`, and the output includes `eventTimestamp`:

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

The activation poll establishes a fresh baseline on first use or after relevant configuration changes and does not replay earlier events. The first following scheduled poll uses that baseline and can emit later matching events. A pending activation baseline is held in memory by workflow, node, and configuration fingerprint until committed state is observed; activation returns no items, so its static data may be discarded. Checkpoint state is version 2. Missing, old, or unrecognised state causes a new baseline rather than migration. Alert activity uses a 300-second overlap. Reads are chronological and budgeted against n8n's scheduled poll deadline (`getPollBudgetMs`, with a five-minute fallback). Each stream and scope batch resumes from its own `resumeMs` and `resumeIds`; New reads `createdAt`, and Updated reads `updatedAt`. A batch resumes from the saved position and IDs.

Requests, retries, and delays are bounded by the remaining deadline. A deadline or page-cap stop can emit the completed prefix and its cursor. API failures, including HTTP 429, fail the poll without emitting partial results or advancing state. If polling emits or advances nothing, it fails immediately with a positioned error. Alert Activity splits SDL ranges and caps its own work while reserving time for parent lookups. A query, lookup, scope, or permission failure remains an error; only this trigger's own deadline or page cap can stop work successfully with a completed prefix. The trigger makes no per-alert detail requests; use Alert > Get for alert fields.

Alert and activity checkpoint caches are bounded: 20,000 New alert IDs, 40,000 alert version entries, and 40,000 activity IDs. When a cache is full, the oldest entry is evicted and a warning is logged. Cursor IDs are never evicted. A resume position with more than 1,000 tied alert IDs fails visibly; it is not split into larger exclusion lists. An SDL result saturated inside one millisecond also fails because its window cannot be split further. Narrow the selected scope or filters for these limits. Rare duplicates can still occur after a crash, state restore, overlapping execution, or overload. Near the threshold of roughly 4,000 alerts per minute, New alerts can be duplicated around the five-minute overlap. Use the top-level `eventId` as the stable deduplication key in every mode. Its slash-separated components are individually encoded with `encodeURIComponent`: host, `alert`, alert ID, then `new`, or `updated` followed by the exact returned `updatedAt`; activity IDs use host, `alert`, alert ID, `activity`, and activity ID. Prefer downstream deduplication or an idempotent destination. In n8n, the Remove Duplicates node can use Node scope to retain several days of events; once its history is full, it errors until history is cleared or enlarged.

Fetch Test Event searches newest windows first, down to the existing January 2020 lower boundary. It returns at most the 10 newest matches from the first nonempty matching window and stops even if only one matches. It never searches older windows just to fill ten. Finite request and query budgets still apply; exhausting them reports an incomplete search rather than claiming no matches.

Scope resolution, SDL launch/poll, and alert lookup errors identify the failed stage without including source records or credentials. Incomplete results, malformed current-scope metadata, conflicting duplicates and saturated windows that cannot be split further fail without advancing scheduled state. A deadline or page-cap stop can save only the already completed prefix. An activity whose parent alert cannot be found also fails while its source timestamp remains inside the overlap retry window. Once older than that window, the trigger skips it and logs a warning with the dropped count, allowing other activities and the checkpoint to proceed. It never emits an activity with unverified scope. This expiry also applies during manual preview; request failures are not treated as deleted alerts.

Delivery depends on source retention, late-arrival timing, and the bounded overlap/checkpoint history. It is not an exactly-once downstream guarantee or a complete historical archive. Use `eventId` for downstream idempotency where needed. Actor exclusions can reduce self-triggering but do not guarantee loop prevention.
