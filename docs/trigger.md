# Triggers

Alert supports New, Updated, and New or Updated. These snapshot triggers remain unchanged. Updated emits an alert whose update time is later than its creation time; an alert already emitted as New in the same poll is not emitted again as Updated. Alert Activity > Occurred reads individual alert-linked ActivityFeed records through the current SDL V2 LOG query API. It requires SDL query access as well as the alert read access needed to validate current scope.

## Activity selection

Choose Any alert activity, named activity types, or advanced custom numeric IDs. Any includes unknown alert-linked activity types and preserves their IDs without assigning a guessed name.

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

Add repeatable builder conditions and choose Match any or Match all. Every condition applies to one activity. Match all never accumulates separate events across polls. There is no JSON condition editor or free-form SDL input.

Status, analyst verdict, and severity conditions offer optional From and To multiselects using the complete shared enum values. Values within a list use OR. From and To use AND on the same recorded change. Both endpoints must exist and differ, even when only one list is selected. Empty lists add no endpoint restriction. For example, Status with To `RESOLVED` accepts a recorded resolution; From `RESOLVED` and To `NEW` or `IN_PROGRESS` accepts reopening.

Missing properties, explicit null, and the literal string `UNDEFINED` remain distinct. Missing endpoints do not match transition conditions. Equal endpoints do not match. The trigger never reconstructs historical values from current alerts, descriptions, or polling snapshots.

Assignment conditions match supplied previous/new email values or destination IDs. A previous-email condition requires that field in the event; some events omit it. A destination email or ID condition can match without a previous value. There is no previous-ID selector. Mitigation conditions match action-type and activity-status values from the schema enums; they are value conditions, not completion monitoring.

Options > Scope groups the optional Account, Site, and Group selections that restrict current scope. Empty selections include accessible records. Site and Group lists offer a Select an Account First or Select a Site First placeholder until their parent is selected, and that placeholder never becomes a scope selection. Group selections require at least one selected Site; clearing Sites while retaining Groups fails before requests rather than broadening the query. Current parent alert status and severity filters inspect the parent at polling time, separately from recorded transitions. An old resolution can still match after the alert reopens unless a current-parent filter excludes it. Scope/name exclusions remain available alongside separate actor-name regex and exact actor-ID exclusions.

## Output

Each activity starts with `alertId`, `alertName` and `alertExternalId`, followed by `eventType: "alert.activity"`, `activityId`, `activityTypeId` as a string, `activityKind`, `eventTimestamp`, `changes` and `actor`. The default summary includes `currentAlertStatus`, `currentAlertSeverity` and `currentAlertAnalystVerdict` from the current parent lookup. These fields never stand in for recorded change endpoints. The external ID is the detection source identifier; it can differ from the unified alert ID. Missing summary fields remain null. Scope resolved from a parent lookup is identified as current scope. An event's `alertId` can feed Alert > Get directly without account or site selection.

Each recognised change appears in `changes[]` as `{field, oldValue?, newValue?}`. One activity can contain several changes. An empty array means no recognised changes were supplied. A missing endpoint stays absent; an explicit null stays null. Note and mitigation details appear when supplied. Unknown types retain the generic envelope.

Include Raw Activity adds `rawActivity` with the original flattened keys and exact large integer values. Include Current Alert adds the full lookup object as `currentAlert`; the compact alert summary is always present. It does not replace the event envelope or historical changes. Raw and normal output use the same activity selection and current V2 LOG endpoint.

## Polling and test events

Scheduled polling establishes a fresh baseline on first use or after relevant configuration changes. It does not replay history at that point. Later polls use bounded overlap and deduplicate by activity ID. After an outage, a poll reads chronological windows, starting with the overlap plus five minutes of new time and widening after completed windows. All windows share one query, time and event budget. If that budget runs out after forward progress, the poll emits only the fully completed prefix and saves its end as the checkpoint. Overlap history is retained relative to that endpoint, so the next poll continues the backlog without repeating delivered activities. Sparse backlogs can reach the current time in one invocation, including with hourly or daily schedules. Duplicate IDs in one batch prefer the newest source timestamp. Conflicting payloads with the same timestamp fail the poll without advancing its checkpoint. Later revisions of an already delivered activity do not trigger another delivery while its ID remains retained.

On n8n 2.38.0 and later the host grants each scheduled poll a time budget, and every request the poll makes is bounded by it: no request starts after it, each attempt's timeout is capped to what remains, and no retry wait runs past it. Alert snapshot polls read each stream (created, updated) for each scope batch oldest first, requesting ascending order and paging until the range ends or the budget stops them; hosts without a budget page to the end of the range. Each stream and batch keeps one forward-only cursor: the last timestamp read and the alert IDs already processed at exactly that timestamp. Every read restarts at the overlap before its cursor, so alerts indexed late are still found, and the seen-ID and version sets deduplicate the re-read; identities retire only once every cursor of their stream has moved past their overlap, and an overlap that needs more identities than the state limit fails visibly. A read the budget cuts short hands over every page already read, emits and remembers those alerts, and moves the cursor to the last timestamp read if that is forward progress; a read cut short inside the overlap resumes there on the next poll, so a dense overlap drains rather than restarting. Alerts sharing the cursor's timestamp are excluded by ID on the next read up to that timestamp only, so a bulk edit larger than one poll can page through drains one poll at a time and a delivered alert revised later is read again through its new timestamp; more than 5,000 alerts sharing one millisecond fail visibly. Cursors follow scope membership: a batch whose membership changes takes the slowest saved cursor of its stream, and the batches furthest behind are read first. The first scheduled poll records its activation time; alerts created or updated before it are recorded, never emitted, even when the budget cuts that first poll short, while an alert created before activation and revised after it is emitted as Updated. Version tracking is the same whether or not the budget stopped the poll: the state delivered as New is recorded as its delivered version, so it is not repeated as Updated, while a later revision still is. Alert Activity keeps ten seconds of the budget for its current alert lookup, one request per 200 parent alerts, and gives the rest to the feed read, whose baseline and catch-up reads both stop at their completed slices; a lookup the budget cuts short delivers every activity before the first one still waiting and ends the poll's window there, and activities sharing one identical nanosecond are not resumable within that tie. A stream that stops without moving its cursor or processing anything new fails the poll visibly without advancing state, naming the stream, the timestamp it could not get past and a rate limit or service failure whose retry no longer fitted; a response out of ascending order also fails. Permission failures surface as permission failures even when they arrive after the budget has passed or alongside a budget stop. The trigger makes no per-alert requests; alert detail such as OCSF belongs in a downstream Alert > Get node.

Fetch Test Event searches newest windows first, down to the existing January 2020 lower boundary. It returns at most the 10 newest matches from the first nonempty matching window and stops even if only one matches. It never searches older windows just to fill ten. Finite request and query budgets still apply; exhausting them reports an incomplete search rather than claiming no matches.

Scope resolution, SDL launch/poll, and alert lookup errors identify the failed stage without including source records or credentials. Incomplete results, malformed current-scope metadata, conflicting duplicates and saturated windows that cannot be split further fail without advancing scheduled state. A budget exhausted before any complete forward window also fails; a later budget stop can save only the already completed prefix. An activity whose parent alert cannot be found also fails while its source timestamp remains inside the overlap retry window. Once older than that window, the trigger skips it and logs a warning with the dropped count, allowing other activities and the checkpoint to proceed. It never emits an activity with unverified scope. This expiry also applies during manual preview; request failures are not treated as deleted alerts.

Delivery depends on source retention, late-arrival timing, and the bounded overlap/checkpoint history. It is not an exactly-once downstream guarantee or a complete historical archive. Use activity IDs for downstream idempotency where needed. Actor exclusions can reduce self-triggering but do not guarantee loop prevention.

## Breaking migration from Alert Note

The trigger resource Alert Note > Created has been removed without an alias. The action node's Alert Note > Get Many/Create operations are unchanged, as are Alert snapshot triggers.

Change each affected trigger to Alert Activity > Occurred and select Note created (`16007`). Preserve credentials, Account/Site/Group selections, current-parent filters, exclusions, node labels, and workflow inactive state. Translate the old note-author exclusion to the actor-name exclusion. Translate simplified output to the generic envelope, or enable Include Raw Activity for the old raw setting. Update dependent expressions to the envelope's note details and `alertId` as needed.

Discard note-only polling state during migration. The activity configuration gets a fresh fingerprint and scheduled baseline, with no historical replay. The inactive [note example](../examples/workflows/03-notes.json) uses the new resource and selection. See [testing guidance](testing.md) before using listener controls.

## Scope control migration

Optional scopes now appear under Options > Scope. Saved top-level scope fields remain effective when that option is absent. Adding Scope replaces the entire legacy selection; an empty Scope explicitly selects all accessible accounts. Move existing selections into `options.scope.selection` together, preserving account/site/group values and any expressions. Do not combine a newly selected account with legacy sites or groups. Existing expressions that refer directly to the old parameter paths need review before those legacy fields are removed.

Alert Activity offers a single Occurred operation, so its dropdown has one choice. The Alert resource still exposes its New, Updated and New or Updated choices. Match Conditions appears only when at least one recorded condition exists.
