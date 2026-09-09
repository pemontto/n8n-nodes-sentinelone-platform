# Alert activity and timeline triggers

Research date: 2026-09-09. This note uses the repository's sanitised schema snapshots, public primary sources, and sanitised findings from an authenticated read-only activity-catalogue check. It does not contain customer records or a claim that any proposed trigger has been implemented.

Historical research: compatibility and implementation recommendations in this file are superseded by the accepted decisions in [the proposal update](alert-activity-trigger-proposal.md#accepted-decisions-supersede-the-proposal-below) and [the current trigger contract](../trigger.md).

Update: subsequent direct V2 LOG searches verified additional numeric mappings and populated change fields. See [observed ActivityFeed schema](activityfeed-observed-schema.md). The earlier unknowns below describe the evidence available before those searches.

## Findings

The Platform GraphQL schema enumerates alert timeline categories and activity subtypes. It includes status changes, analyst verdict changes, mitigation results, and mitigation actions. Numeric management activity IDs have a separate discovery command. The inspected evidence does not establish a complete mapping between these two systems and SDL `ActivityFeed` IDs.

Both saved schema files are byte-for-byte identical, so the line references below apply to [console-a.graphql](../../tests/fixtures/schema/console-a.graphql) and [console-b.graphql](../../tests/fixtures/schema/console-b.graphql). They describe those snapshots, not a compatibility promise for every console version.

## GraphQL enumeration

| Schema type                 | Values                                                                                                                                                                                      | Snapshot lines |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `AlertTimelineEventType`    | `ACTIVITY`, `ASSET_OPERATION`, `ENRICHMENT`, `INDICATOR`, `MITIGATION`, `NOTE`, `RELATED_ALERT`                                                                                             | 1145-1153      |
| `AlertTimelineActivityType` | `ANALYST_VERDICT`, `BLOCKLIST`, `CONFIDENCE_LEVEL`, `DETECTION_CLOUD_DETAILS`, `EXCLUSION`, `MAINTENANCE_DELETE`, `MITIGATION_RESULT`, `SEVERITY`, `STATUS`, `TICKET_ID`, `USER_ASSIGNMENT` | 1129-1141      |
| `NoteTimelineActionSubType` | `CREATE`, `DELETE`, `UPDATE`                                                                                                                                                                | 7979-7983      |
| `MitigationActionType`      | `BLOCKLIST_ADD`, `EXCLUSION_ADD`, `IDENTITY`, `KILL`, `PARTNER`, `QUARANTINE`, `REMEDIATE`, `REMOVE_MACROS`, `RESTORE_MACROS`, `ROLLBACK`, `UNQUARANTINE`, `WORKFLOW`                       | 7193-7206      |
| `MitigationActionStatus`    | `ADDED`, `CANCELLED`, `FAILED`, `PARTIAL`, `PENDING`, `PENDING_REBOOT`, `RUNNING`, `SENT`, `SUCCESS`                                                                                        | 7146-7156      |
| `MitigationResult`          | `BENIGN`, `MITIGATED`, `UNMITIGATED`                                                                                                                                                        | 7246-7250      |
| `Status`                    | `IN_PROGRESS`, `NEW`, `RESOLVED`                                                                                                                                                            | 11127-11131    |

These are string enum values. The schema does not assign numeric activity IDs to them. GraphQL introspection can request each enum's values with `__type(name: "AlertTimelineActivityType") { enumValues { name description } }`, subject to the console's introspection access.

`alertTimeline` requires one `alertId` and supports `after`, `before`, `first`, `last`, and `filter` (lines 9423-9453). `AlertTimelineFilterInput` supports `itemTypes` and text search; it has no structured activity-subtype or creation-time filter (lines 1158-1168). The connection provides edges, cursors, page information, and a total count (lines 1203-1229).

Each timeline item exposes `createdAt`, `eventText`, `eventType`, creator, and typed data (lines 1173-1198). `ActivityTimelineItemData` exposes only `activityType` and `downloadUrl` (lines 233-243). It does not expose structured old/new status or verdict values. `MitigationActionTimelineItemData` exposes an optional result ID, details, message, action type, and status (lines 7161-7182). Note data carries an action subtype and optional note ID (lines 7988-8015).

## What this supports, and what it does not establish

| Desired event                       | Evidence                                        | Remaining question                                                                                          |
| ----------------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Any alert activity                  | Timeline `ACTIVITY` with enumerated subtype     | Efficient discovery across all alerts is not supplied by the per-alert timeline query.                      |
| Verdict or status changed           | `ANALYST_VERDICT` and `STATUS` subtypes         | Structured before/after values are absent from activity timeline data.                                      |
| Alert resolved                      | `Status.RESOLVED` exists                        | No dedicated `RESOLVED` timeline subtype exists; a status event alone does not prove its destination value. |
| Mitigation result changed           | `MITIGATION_RESULT` subtype                     | The activity payload does not expose the new result as a typed field.                                       |
| Mitigation action updated/completed | `MITIGATION` event and typed action/status data | Event emission timing and whether a result updates an existing timeline item need verification.             |
| Note created, edited, or deleted    | `NOTE` with `CREATE`, `UPDATE`, `DELETE`        | Current note-created polling covers only its existing SDL event type.                                       |

These are schema observations and implementation possibilities. A generic trigger would still need verified event discovery, scope checks, pagination, ordering, and deduplication. `AlertTimelineItem` has no common event ID. An edge cursor identifies a position, but the snapshot does not promise it remains stable across changing timelines. Optional note/result IDs must not be assumed to identify every event.

## Numeric activity ID discovery

SentinelOne's own _SentinelOne for QRadar v3.5.x_ guide, section 6.2, PDF pages 40-41 (printed pages 37-38), directs readers to the Management Console's API reference and the **Activities > Get activities types** command to retrieve event names and ID numbers. Its example identifies ID `48` as Agent Recommissioned. This is vendor-authored evidence for discovery, but the guide concerns the older management integration and does not establish newer Platform alert mappings. [SentinelOne guide hosted by IBM](https://apps.xforce.ibmcloud.com/api/hub/extensionsNew/7c786be7852adb6fb8a4abeb397ce56e/SentinelOne_for_QRadar_v_3_5_x-GA.pdf)

The published `PS-SentinelOne` implementation invokes `GET /web/api/v2.1/activities/types` and returns `Response.data`. This is primary evidence of that client's implementation, not vendor documentation or proof of the response currently available from a particular tenant. [Get-S1ActivityType.ps1, version 2.1.2](https://www.powershellgallery.com/packages/PS-SentinelOne/2.1.2/Content/Public%5CGet-S1ActivityType.ps1)

Elastic's SentinelOne ingest pipeline preserves `activityType` as a numeric `sentinel_one.activity.type` and retains a separate activity ID. It does not provide the Platform timeline-to-SDL mapping sought here. Treat consumer parsers as evidence of their own mappings, not as a complete vendor enumeration. [Elastic activity pipeline](https://github.com/elastic/integrations/blob/main/packages/sentinel_one/data_stream/activity/elasticsearch/ingest_pipeline/default.yml)

The repository's existing note trigger filters SDL on `activity_type='16007'` and requires `data.alert.id` ([ActivityFeed.ts](../../nodes/SentinelOnePlatformTrigger/ActivityFeed.ts), lines 7-10). That establishes the implemented note event filter. It does not establish adjacent numeric IDs or prove that `/activities/types` enumerates all SDL Platform events.

## Verification still needed

- Establish names for the unnamed Platform alert IDs in the management catalogue. The authenticated check below confirms that their labels are missing.
- Compare the returned type catalog with aggregate SDL event types for records carrying `data.alert.id`. An aggregate shows observed types in the selected period, not all possible types.
- Verify structured payload fields for status/verdict transitions and mitigation outcomes before promising a resolved-only trigger or transition output.
- Determine whether mitigation events represent requested actions, progress updates, completed actions, or all of these.
- Check duplicate/repeated event behavior, time ordering, retention, permissions, and alert enrichment after the alert changes or disappears.

No verified numeric IDs for Platform status, verdict, or mitigation events were established by this public-source and snapshot review. Do not infer them from enum order, numerical proximity to `16007`, or legacy threat activity mappings.

## Authenticated catalogue observation

On 2026-09-09, an authenticated read-only request through the local n8n request helper successfully called `GET /web/api/v2.1/activities/types`. It returned 766 entries with `id`, `action`, and `descriptionTemplate` fields. This is a sanitised account of that observation; no raw response or customer values are retained here.

| Catalogue IDs                      | Observed metadata                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `16000` through `16007`, inclusive | `action` was the empty string and `descriptionTemplate` was `null` for every entry.                                    |
| `16008`                            | `action` was `Agentic investigation triggered`; the generic template referenced alert-name and user-name placeholders. |

The catalogue enumerates these IDs but does not name the core unified-alert event types. In particular, it cannot independently label `16007`, despite the existing note trigger's use of that ID. The response also contains legacy threat actions and incident actions. Catalogue membership alone does not establish that an SDL event has `data.alert.id`, or that a type belongs in an alert-only trigger.

The mapping for `16008` is catalogue metadata, not an observed SDL payload mapping. No status, verdict, or mitigation mapping is inferred for `16000` through `16006`.

## SDL field-existence syntax

The existing note query uses `data.alert.id=*` as its field-existence condition ([ActivityFeed.ts](../../nodes/SentinelOnePlatformTrigger/ActivityFeed.ts), lines 7-10). SentinelOne's own `ai-siem` repository also uses `event.type=*` in SDL query examples. That supports the wildcard form in the initial SDL search expression; there is no evidence here that it must be replaced by `exists(data.alert.id)`. [SentinelOne SDL query examples](https://github.com/Sentinel-One/ai-siem/blob/main/plugins/s1-secops-skills/skills/sdl-api/references/lrq-api.md)

This syntax observation does not establish identical behaviour for a function named `exists` inside every PowerQuery pipeline stage.

## Live aggregation limits

A 30-day aggregate using `data.alert.id != ''` did not complete within the configured 100-second query deadline. The SDL action reported that query cleanup was accepted. This result does not validate that filter or establish which activity types were present.

Subsequent narrower existence-filter probes stalled at the local editor login endpoint before query submission could be confirmed. The temporary clients were stopped. No numeric-to-event mapping is claimed from those attempts. The existing note-trigger checks and official examples support `data.alert.id=*`; the proposed broader aggregate still needs a completed run.

## User-provided transition evidence

Screenshots supplied on 2026-09-09 show structured SDL change fields for status and analyst verdict:

| Normalised field | Previous-value path                        | New-value path                             | Observed example                       |
| ---------------- | ------------------------------------------ | ------------------------------------------ | -------------------------------------- |
| `status`         | `data.payload.changes.old_status`          | `data.payload.changes.new_status`          | `NEW` to `RESOLVED`                    |
| `analystVerdict` | `data.payload.changes.old_analyst_verdict` | `data.payload.changes.new_analyst_verdict` | `UNDEFINED` to `FALSE_POSITIVE_BENIGN` |

This is direct evidence that these fields occur in the shown SDL records. It does not establish their numeric activity types, availability from every event producer, or mappings for other fields. `UNDEFINED` is a literal source value, not a missing JSON property. The GraphQL activity timeline's limited typed fields do not imply that SDL lacks these richer payloads.

## Proposed trigger organisation

Keep `Alert` for new or updated alert records. Add an `Alert Activity` resource for events attached to an alert, with an activity-type selection and an option for any alert-linked activity. Treat note creation as one activity type, while retaining the existing `Alert Note > Created` behaviour for compatibility. The action node's `Alert Note > Get Many/Create` operations still operate on notes and do not need renaming.

Start with verified activity IDs and preserve the original numeric type on output. Do not hardcode unnamed catalogue IDs as status, verdict, or mitigation events. A resolved-only option needs a verified destination-status field; reading an alert's current status later is not evidence of its status when the activity occurred. Mitigation action requests and successful completions must remain distinct events.

This is a design proposal, not a change to the node or a commitment to implement every timeline category. SDL coverage of the GraphQL timeline categories remains unverified.

## Discovering change fields and observed values

SentinelOne's published SDL guidance explicitly recommends sampling V1 `query` events and enumerating `matches[].attributes` to discover populated source fields. Omit the `columns` allow-list for discovery. Preserve flattened dotted attribute names exactly. [Official schema-discovery guidance](https://github.com/Sentinel-One/ai-siem/blob/main/plugins/s1-secops-skills/skills/sdl-api/SKILL.md#schema-discovery-the-right-way)

The method is `POST /sdl/api/query` on the console host. It accepts a search filter, time bounds, `maxCount`, and continuation tokens. Pin absolute time bounds when paging. The same reference marks V1 deprecated, with a planned sunset on 2027-02-15, and recommends V2 LRQ `LOG` for new code. V1 is a possible temporary discovery tool, not a new production dependency. [Official method reference](https://github.com/Sentinel-One/ai-siem/blob/main/plugins/s1-secops-skills/skills/sdl-api/references/methods.md#query-cqueryfilter--citer_query-cli-query)

For each sampled activity, enumerate keys matching `data.payload.changes.old_*` and `data.payload.changes.new_*`. Group by the exact suffix and original activity type. Collect observed JSON types, endpoint presence, distinct old/new values and observed transition pairs. Union keys across all sampled events rather than reading only the first event. Stratify samples by activity type and time window so frequent note events do not hide rare field changes.

This inventory describes observed data, not the complete allowed domain or every permitted transition. Status/verdict dropdowns should use verified API enums where available; observations establish payload mappings and examples. Assignees are identities, not a static enum. Do not publish their IDs or names in repository fixtures.

The user-provided screenshots establish `old_status`/`new_status` and `old_analyst_verdict`/`new_analyst_verdict`. The later proposed names `old_verdict`/`new_verdict` and `old_assignee`/`new_assignee` remain discovery candidates. Do not alias or normalise these candidates until actual source records establish their meaning and value types.

A follow-up live sampling attempt did not reach query execution because the local editor's temporary-workflow creation request timed out. No additional payload keys or values were verified by that attempt.
