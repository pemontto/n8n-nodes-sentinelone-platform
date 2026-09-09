# Behavior contract

## Scope and fields

Alert Get/Update and note Get Many/Create target IDs, without management-scope controls or legacy fallback. Get Many and triggers use optional Account, Site, and Group selections; empty means accessible data. Get Many ignores hidden child selections; triggers reject Group selections without a selected Site. Common alert fields always remain present. Options > Additional Alert Fields adds extras, empty by default. Raw Data and large enrichments are opt-in. This useful common response deliberately exceeds the n8n ten-field simplification recommendation.

Update supports status, analyst verdict, and non-empty ticket ID. All supported enum values are offered. Ticket strings remain unchanged and objects/arrays serialize once, without implicit merging. Advanced JSON is additive, enabled only by its toggle, and duplicate fields fail before requests. Severity and clearing remain unsupported.

## Requests and outcomes

Native authenticated helpers handle network access. Shared read transport retries transient network errors and HTTP 429/500/502/503/504 with bounded deadlines and backoff. Mutations are submitted once. Reject whole-node Retry On Fail for mutation operations before any requests. Permission and GraphQL validation failures are not retried. Debug is a node Setting, uses Info level, and logs only redacted query structure and timing; logging cannot affect execution.

Error messages distinguish configuration, permission, disabled/absent actions, rate limits, service failures, rejection, partial results, and uncertainty. Disabled actions show bounded sanitized service reasons. An absent action is not proof of denied permission. Never include credentials, write payloads, or response bodies in errors.

## Update verification

Remove the redundant initial alert read. Verify Update is enabled by default and can be disabled. Read only the ID and changed fields. Verification has one 30-second budget with at most three total reads, including transient failures and stale successful reads. Use 1- and 2-second backoff with small jitter; honor Retry-After without retrying beyond the deadline. No nested retry multiplication.

Compare strings exactly. Compare ticket JSON structurally when both sides parse, preserving types, numeric precision, and array order. On older JavaScript engines without original JSON number tokens, numeric JSON falls back to exact string comparison. Keep per-field requested, observed, and verified values; verified is null when comparison was impossible. Report verificationStatus as verified, mismatch, unavailable, skipped, or pending. Preserve the mutation acknowledgement when verification fails, and scheduled execution IDs. A matching read after an uncertain mutation proves the observed state, not causality. Explicit rejection needs no readback. Never repeat the mutation as part of verification.

The user performs live mutation tests against a designated demo account using inactive workflows supplied with the package. Automated implementation checks use mocks, schema validation, and read-only requests.

## Alert activity delivery

Alert Activity > Occurred replaces Alert Note > Created without an alias. It uses V2 LOG queries for both normal and raw output. Activity selection and builder conditions inspect one recorded event; current-parent filters inspect lookup state. The stable envelope retains all recognised changes, exact IDs, and optional raw/current-alert enrichment. See [the trigger contract](trigger.md) for endpoint-presence rules, migration, preview windows, and delivery limits.

Polling deduplicates by activity ID within bounded checkpoint/overlap history and does not monitor later revisions. Incomplete data, duplicate conflicts at the same timestamp and malformed scope metadata fail without advancing state. An exhausted scan budget can advance only through a fully completed forward prefix; with no such progress it fails. Activities whose parent alerts cannot be found are retried while inside the overlap window, then skipped with a sanitised warning. Catch-up polls advance through bounded chronological slices rather than repeatedly querying the entire outage backlog. First use and relevant configuration changes establish a baseline without replay. Manual searches retain the January 2020 lower boundary and stop at the first nonempty matching window, with at most 10 newest matches.
