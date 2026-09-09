# Alert activity trigger proposal

Status: proposal, not implemented. Prepared on 2026-09-09 after independent practical and critical reviews. Evidence and API references are in [the activity research](alert-activity-triggers.md).

Subsequent [direct V2 observations](activityfeed-observed-schema.md) also confirm severity old/new fields and destination-assignee fields. Severity can join the initial typed transition candidates; assignment needs a destination-only event filter unless a previous assignee is supplied. The earlier two-field recommendation below predates these results. The observed mitigation status was `RUNNING`, not success.

## Accepted decisions supersede the proposal below

The implementation request replaces Alert Note > Created with Alert Activity > Occurred without a compatibility alias. It includes all seven directly verified types, the complete shared status/verdict/severity enums, repeatable builder conditions only, and advanced custom numeric IDs. It excludes a JSON editor, free-form SDL, previous-assignee-ID matching, revision delivery, and mitigation completion monitoring. Assignment supports previous/new email and destination-ID value matching; mitigation supports action/status value matching.

Manual searches retain the January 2020 lower boundary and existing finite budgets. They return at most 10 newest matches from the first nonempty matching window, never searching further to fill ten. Migrations preserve configuration and inactive state but start a fresh fingerprint and scheduled baseline. The current [trigger contract](../trigger.md) is authoritative for the implementation. The original proposal below is historical; its compatibility adapter, two-field initial scope, optional JSON editor, and bounded-lookback recommendations were rejected or superseded.

## Recommendation

Add `Alert Activity > Occurred` to the existing trigger node. An alert activity is an SDL ActivityFeed record linked to an alert. It is not necessarily every entry in the GraphQL alert timeline. Keep `Alert > New/Updated/New or Updated` and `Alert Note > Created` unchanged. Note read/create operations in the action node remain separate.

The first implementation should support any alert-linked activity, note creation, and verified status/verdict transitions. Status and verdict predicates should recognise the evidenced payload fields without assigning guessed names to numeric activity IDs. Named mitigation completion events and other fields need additional source evidence.

## Normal controls

| Control                      | Proposed behaviour                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Activity                     | Any alert activity, Note created, Status changed, Analyst verdict changed, or Field changes.                    |
| From value                   | Optional selection from the field's supported values. No selection adds no previous-value constraint.           |
| To value                     | Optional selection from the field's supported values. No selection adds no destination-value constraint.        |
| Account, Site, Group         | Retain existing selection and scope validation. Empty selections include accessible accounts.                   |
| Exclude actor IDs            | Exact IDs, avoiding reliance on mutable or non-unique names. Keep name exclusions separately available.         |
| Include raw activity         | Off by default; adds the original source record without changing the normalised output structure.               |
| Include current alert fields | Optional output enrichment. This does not disable requests required to validate scope or current-alert filters. |

`Status changed`, with no From selection and To set to `RESOLVED`, covers resolution. From `RESOLVED` to either `NEW` or `IN_PROGRESS` covers reopening. Verdict transitions preserve source enum spellings, including `UNDEFINED` and `FALSE_POSITIVE_BENIGN`.

Expose only Status and Analyst verdict as transition fields initially. The screenshots establish these paths, but fixture and live read-only verification remain prerequisites. Severity, ticket ID, assignment, confidence and mitigation result are candidates, not implemented or verified transition mappings.

## Advanced controls

Use repeatable transition conditions with a fixed supported-field selector and `Match any` or `Match all`. Each condition has a field and optional From/To value lists. Values within a list use OR; From and To within one condition use AND and must match the same change record. Multiple conditions are evaluated against one activity, never combined across separate activities or separate polls.

For example, Match any can accept Status changing to `RESOLVED` or Analyst verdict changing from `UNDEFINED` to `FALSE_POSITIVE_BENIGN`. Match all requires one activity containing both matching changes; it does not wait for two activities to arrive.

Keep custom numeric activity IDs under advanced options. Validate their format and preserve unknown IDs, but do not name IDs from numeric proximity or enum order. If a JSON editor is added, it must use the same validated condition schema and semantics as the controls. Defer arbitrary payload paths, free-form SDL fragments and executable expressions inside the condition language.

## Change semantics

Treat a transition as verified only when both source endpoints exist and differ. A From/To filter does not match a missing-endpoint record, even when its one supplied endpoint matches. Generic activity output may still carry that incomplete change evidence.

Missing properties, explicit null and the literal string `UNDEFINED` are distinct. Preserve null and source strings; omit an oldValue/newValue property when the source did not supply it. Do not fill a missing old value from current alert data, parse it from human-readable text, or infer it from the previous polling snapshot. Equal endpoints do not match a changed predicate.

Simple and advanced transition controls use only recorded event values. Existing status, severity and name filters on the parent alert must be separately labelled as current-alert filters. A historical `NEW` to `RESOLVED` event can arrive after the alert has reopened. It should still match the transition unless the user separately opts into a current-alert restriction.

## Output contract

Emit one item per activity, containing all recognised changes. Retain the original activity type ID and activity identity as strings. A proposed output, with synthetic identifiers, is:

```json
{
	"eventType": "alert.activity",
	"activityId": "example-activity",
	"activityTypeId": "source-type-id",
	"alertId": "example-alert",
	"eventTimestamp": "2026-09-09T12:00:00.000Z",
	"changes": [
		{
			"field": "status",
			"oldValue": "NEW",
			"newValue": "RESOLVED"
		}
	]
}
```

Add actor information and type-specific data such as a note when supplied. Retain scope information, explicitly identified as current scope when resolved by current-alert lookup. Optional `currentAlert` and `rawActivity` fields must not be confused with the historical activity payload. Preserve the actual raw record's flattened keys rather than labelling a reconstructed object as original data.

`changes` contains recognised source changes, not a guarantee that every source field has been normalised. An empty array means no recognised changes, not proof that nothing changed. Partial change records remain partial. Avoid a single status/verdict kind that loses information when one activity contains both; consumers can inspect the changes array.

Do not attach purported historical changes to the existing snapshot-based `Alert > Updated` output. A snapshot may combine several intervening changes. A future snapshot-diff option would need explicit attribution as an observed snapshot difference, not an original activity transition.

## Practical review

The useful first upgrade is a general event envelope, Status/Analyst verdict transition selectors, and one-item-per-activity output. It reuses the existing polling node and leaves note actions unchanged. Preserve the existing Alert Note configuration, output and state contract through a compatibility adapter if the reader is shared.

The current reader cannot become generic merely by removing `activity_type='16007'`: its table and raw-record decoders require note text and compare note-specific fields. Introduce a common identity decoder with optional type-specific payloads. Keep selection equivalent across normalised and raw output modes.

## Critical review

| Risk                                                        | Required response                                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Current-state filters hide matching historical transitions  | Separate event transition predicates from current-alert filters and enrichment.                                                                        |
| Unnamed numeric types invite guessed mappings               | Preserve raw IDs; derive supported transitions from verified payload fields.                                                                           |
| Mitigation payloads may update under the same activity ID   | Verify identity/version semantics before promising progress or completion triggers.                                                                    |
| Generic activity volume exceeds note-specific limits        | Test saturated windows, response size, pagination, checkpoints and backlog recovery before broad deployment.                                           |
| Missing or inaccessible alerts block scope validation       | Retain fail-without-advance initially; do not silently skip records or invent scope. Document the limitation.                                          |
| Rare preview conditions cause long historical searches      | Use a visible bounded preview lookback, return the first non-empty matching batch up to 10, and report when no match exists within the searched range. |
| Workflow actions retrigger their own activity subscriptions | Offer exact actor exclusions and retain activity IDs for downstream idempotency; do not claim automatic loop prevention.                               |
| Retention, late arrival and overlap create delivery limits  | State the limits. Do not promise exactly-once delivery or complete historical coverage.                                                                |

No new permanent explanatory banners are proposed. Put setup requirements in credential help and semantics in field descriptions and documentation. Show actionable errors only when something prevents execution.

## Phases and acceptance

1. Validate the supplied status/verdict payload shapes with synthetic fixtures and completed read-only queries. Confirm activity IDs, timestamps, actor fields and relevant producer variations. No test mutations are authorised by this proposal.
2. Add the generic activity reader, output contract, simple and repeated transition conditions, and preserved note-created behaviour. Keep scope validation, baseline rules and deduplication intact.
3. Add safer operational options: bounded preview range, exact actor-ID exclusion and stage-specific, sanitised diagnostics for SDL launch/poll and alert lookup. Preserve useful HTTP categories without leaking response bodies or record identifiers.
4. Add more named fields and mitigation events only after their payload and identity semantics are verified. Distinguish request, progress and result events. Defer arbitrary-path filters and snapshot-diff output.

Required tests cover missing/null/literal-UNDEFINED, equal endpoints, multiple changes per activity, From/To composition, any/all conditions, old/new transitions between polls, reopening before enrichment, raw/table parity, repeated IDs with changed payloads, overlap/late arrival, unavailable alerts, configuration changes, baseline state, saturation and preview exhaustion. Existing note and alert workflows must continue to pass. Test the actual editor node after the final build, without rebuilding during a live poll.

No trigger operations, credentials, workflows or publishing configuration were changed for this proposal.
