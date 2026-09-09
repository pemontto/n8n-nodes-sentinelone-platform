# Observed alert ActivityFeed schema

Read-only verification on 2026-09-09 used the current `POST /sdl/v2/api/queries` endpoint with `queryType: "LOG"`. The authenticated requests used a credential from the authorised dev vault in memory. No V1 or deprecated query method was used. This file records generic field names and source enum values, not raw events, tenant identifiers, users or credentials.

The search filter required `dataSource.name='ActivityFeed'`, `dataset='activityLog'`, and `data.alert.id=*`. Completed samples covered a four-hour window with 69 events, a 24-hour window excluding creation and notes with 321 events, a seven-day window excluding five common types with 17 events, and a 30-day window targeting assignment and unidentified type `16006` with seven events. The seven-day sample contained 16 severity events and one assignment event. Each query requested at most 1,000 records; none of these completed samples reached that cap. Returned event fields were available under `data.matches[].values` as flattened keys. These are observations from the selected scope and periods, not an exhaustive vendor schema.

## Activity types observed

| Numeric type | Source description                                       | Relevant payload fields                                                                |
| ------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `16000`      | New alert was created                                    | No change payload observed.                                                            |
| `16001`      | Alert status was changed                                 | `data.payload.changes.old_status`, `data.payload.changes.new_status`                   |
| `16002`      | Alert verdict was changed                                | `data.payload.changes.old_analyst_verdict`, `data.payload.changes.new_analyst_verdict` |
| `16003`      | Alert severity was changed                               | `data.payload.changes.old_severity`, `data.payload.changes.new_severity`               |
| `16004`      | Alert assignee was changed                               | `data.payload.changes.new_assignee_id`, `data.payload.changes.new_assignee_email`      |
| `16005`      | Mitigation action has been executed for a detected alert | `data.payload.mitigation_action_type`, `data.payload.mitigation_action_status`         |
| `16007`      | New note was added to alert                              | `data.payload.note_text`                                                               |

The seven-day search found no `16006` event. Its meaning is not inferred from the sequence. Other catalogue types may be absent because they did not occur in the queried scope and period.

A final completed 30-day search restricted to assignment type `16004` and unidentified type `16006` returned assignment events only, below the row cap. Three of the seven assignment events also contained `data.payload.changes.old_assignee_email`. All seven supplied new assignee ID and email. No `old_assignee_id` field was observed, and no `16006` event was found in that search. This does not prove the latter type is unused globally.

## Observed change values

All of the status, verdict and severity values below were strings in the V2 results.

| Field           | Previous values observed                                           | New values observed                                                                                                                                   |
| --------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status          | `NEW`, `IN_PROGRESS`, `RESOLVED`                                   | `IN_PROGRESS`, `RESOLVED`                                                                                                                             |
| Analyst verdict | `UNDEFINED`, `FALSE_POSITIVE_UNDEFINED`, `TRUE_POSITIVE_UNDEFINED` | `FALSE_POSITIVE_BENIGN`, `FALSE_POSITIVE_BENIGN_BUT_SUSPICIOUS`, `FALSE_POSITIVE_SYSTEM_ERROR`, `FALSE_POSITIVE_UNDEFINED`, `TRUE_POSITIVE_UNDEFINED` |
| Severity        | `LOW`                                                              | `MEDIUM`                                                                                                                                              |

The status sample included `NEW` to `RESOLVED`, `NEW` to `IN_PROGRESS`, `RESOLVED` to `IN_PROGRESS`, and `IN_PROGRESS` to `RESOLVED`. Thus reopening was observed as well as resolution. Every sampled status and verdict change in the 24-hour query supplied both endpoints.

These are observed values, not restrictions on allowed values or transitions. Authoritative API enums remain the source for a complete supported dropdown where available. Observing severity changes does not add severity-write support to the current Update operation.

## Assignment and mitigation caveats

The assignment event in the seven-day sample supplied a new assignee ID and email as strings, but no old-assignee field. The subsequent 30-day assignment sample contained a previous email in some events, but still no previous ID. Preserve a supplied old email and distinguish it from a missing field. Do not resolve a current identity and present its ID as if the historical source supplied it. A destination-assignee-ID filter has direct evidence; previous-email matching is possible only where that field exists. A previous-ID selector is not supported by these observations.

No `old_verdict`, `new_verdict`, `old_assignee` or `new_assignee` keys were found in these samples. Preserve the actual `analyst_verdict` and `assignee_id`/`assignee_email` names rather than inventing aliases.

The mitigation samples carried action type `WORKFLOW` and status `RUNNING`. The source description says the action was executed, but that text does not prove successful completion. A completion trigger must inspect the structured status and needs additional evidence about result updates and activity identity.

## Consequences for the proposal

Status, analyst verdict and severity now have direct evidence for paired change fields and numeric activity mappings. Assignment has direct evidence for a destination-only payload. Keep transition predicates separate from source-event selection: an assignment event can be recognised without fabricating its previous assignee.

Use these observations to build synthetic decoder and filter fixtures. Preserve incomplete payloads, activity IDs, exact source enum strings and current-versus-historical semantics. No trigger or action behaviour was changed by this research.
