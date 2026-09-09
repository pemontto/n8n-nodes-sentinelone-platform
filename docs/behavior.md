# Behavior contract

## Scope and fields

Alert Get/Update and note Get Many/Create target IDs, without management-scope controls or legacy fallback. Get Many and triggers use optional Account, Site, and Group selections; empty means accessible data and hidden children are not evaluated. Common alert fields always remain present. Options > Additional Alert Fields adds extras, empty by default. Raw Data and large enrichments are opt-in. This useful common response deliberately exceeds the n8n ten-field simplification recommendation.

Update supports status, analyst verdict, and non-empty ticket ID. All supported enum values are offered. Ticket strings remain unchanged and objects/arrays serialize once, without implicit merging. Advanced JSON is additive, enabled only by its toggle, and duplicate fields fail before requests. Severity and clearing remain unsupported.

## Requests and outcomes

Native authenticated helpers handle network access. Shared read transport retries transient network errors and HTTP 429/500/502/503/504 with bounded deadlines and backoff. Mutations are submitted once. Reject whole-node Retry On Fail for mutation operations before any requests. Permission and GraphQL validation failures are not retried. Debug is a node Setting, uses Info level, and logs only redacted query structure and timing; logging cannot affect execution.

Error messages distinguish configuration, permission, disabled/absent actions, rate limits, service failures, rejection, partial results, and uncertainty. Disabled actions show bounded sanitized service reasons. An absent action is not proof of denied permission. Never include credentials, write payloads, or response bodies in errors.

## Update verification

Remove the redundant initial alert read. Verify Update is enabled by default and can be disabled. Read only the ID and changed fields. Verification has one 30-second budget with at most three total reads, including transient failures and stale successful reads. Use 1- and 2-second backoff with small jitter; honor Retry-After without retrying beyond the deadline. No nested retry multiplication.

Compare strings exactly. Compare ticket JSON structurally when both sides parse, preserving types, numeric precision, and array order. On older JavaScript engines without original JSON number tokens, numeric JSON falls back to exact string comparison. Keep per-field requested, observed, and verified values; verified is null when comparison was impossible. Report verificationStatus as verified, mismatch, unavailable, skipped, or pending. Preserve the mutation acknowledgement when verification fails, and scheduled execution IDs. A matching read after an uncertain mutation proves the observed state, not causality. Explicit rejection needs no readback. Never repeat the mutation as part of verification.

The user performs live mutation tests against a designated demo account using inactive workflows supplied with the package. Automated implementation checks use mocks, schema validation, and read-only requests.
