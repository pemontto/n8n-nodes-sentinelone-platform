# Alert activity verification

Verified on 2026-09-09 before delivery. All live checks were read-only. The note-creation and alert-update branches were not executed.

## Automated checks

The full build and test suite passed all 242 tests. Official node lint, the privacy scanner and the package-content check passed. Formatting passed for tracked files and the new implementation, tests and research documents. No package was published.

Coverage includes all seven activity categories, unknown types, every shared status/severity/verdict enum and mitigation schema enum, From/To and any/all composition, missing/null/UNDEFINED values, equal endpoints, partial assignment, multiple changes, current-alert reopening, exact actor exclusions, baseline/configuration changes, overlap and late arrivals, unavailable alerts, incomplete scope, query saturation and budget exhaustion, and normal/raw parity. Duplicate tests cover all input orderings of a newer record and conflicting older records with the same ID and timestamp. Snapshot fingerprints retain their previous values.

Independent review identified and verified fixes for custom-only ID selection, retired-resource rejection, snapshot fingerprint compatibility, unresolved scope during both alert lookup stages, and duplicate conflicts at older timestamps. No blocking findings remained after those fixes.

## Live verification

A direct V2 LOG probe returned 95 activities in a four-hour window, below the 1,000-row cap. The final compiled reader then queried a fixed four-hour window in normal and raw modes. Both returned the same 107 activities: 46 creations, five status changes, five verdict changes, 11 mitigation activities and 40 notes. Both requests used the current V2 LOG endpoint. Counts are observations from those windows, not coverage guarantees.

The actual editor exposed all seven selections and the repeatable condition builder. The full analyst-verdict list rendered, assignment displayed previous/new email and destination-ID controls, and mitigation displayed its distinct activity-status values. The temporary verification condition was removed afterwards.

The original local test workflow was re-read and migrated to Alert Activity > Occurred, filtered to Note Created (`16007`). Its credential, label, empty scope selections, options and inactive state were preserved. A manual trigger-only preview succeeded with 10 items containing the generic envelope, note details and `scope.source="current"`. No other node ran. The README screenshot shows that canvas without record contents.

The migrated trigger uses a new configuration fingerprint. Its first scheduled poll establishes a fresh baseline rather than reusing note-only state or replaying history. The workflow remains inactive; activation was not part of verification.

## Follow-up reviews

Fresh standards, specification and critic reviews examined the published implementation. The specification review found no deviations. The standards review found that SDL launch/poll errors discarded actionable HTTP categories. The critic found that historical preview forgot newer activity revisions between windows and could return an older matching revision.

Both findings were fixed and independently re-reviewed. SDL failures now retain sanitised authentication, permission, rate-limit, service and configuration categories. Preview retains newest-seen activity timestamps across historical windows and saturation splits. The two new regressions failed against the earlier build and passed after the fixes; the full suite passed 242 tests. The follow-up compiled build returned identical normal/raw selections for 109 activities, and its editor preview returned 10 note-created items with only the trigger running. The workflow remained inactive. Optional catalog consolidation and naming cleanup remain deferred.

## Delivery limits

Delivery is once per activity ID within the bounded checkpoint/overlap model. It does not monitor later revisions or mitigation completion and does not guarantee exactly-once downstream processing. Events outside the overlap or source retention may be missed. Incomplete source data, unresolved current alert scope and exhausted limits fail without advancing state. Manual search retains the January 2020 lower boundary and returns at most ten newest matches from its first nonempty matching window; a finite budget can prevent completing that search.

The subsequent shared-server setup uses community-package registration with hot reload disabled. A separate n8n 2.38.1 host probe exposed activation and concurrent-cursor persistence failures. The successful editor previews above do not resolve those scheduled-runtime acceptance gaps. See [development runtime checks](testing.md#development-runtime). No shared scheduler configuration or customer workflow was changed for this follow-up.
