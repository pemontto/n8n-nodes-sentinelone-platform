# Changelog

## 0.1.0 (unreleased)

- Breaking: replace the Alert Note > Created trigger with Alert Activity > Occurred, without a compatibility alias. Note actions and Alert snapshot triggers remain unchanged.
- Support seven verified activity types, unknown alert-linked types, and a builder for recorded transition and value conditions.
- Emit one generic envelope per activity, with optional raw activity and current alert enrichment.
- Deduplicate by activity ID without monitoring later revisions; reset migrated note triggers to a fresh scheduled baseline.
- Preserve long historical test searches, returning up to 10 newest matches from the first matching window and reporting budget exhaustion.

- Introduce SentinelOne Platform action, trigger, and credential identifiers.
- Organize operations into focused modules with shared controls and transport.
- Use common alert defaults and opt-in Additional Alert Fields.
- Remove scope from ID-based operations.
- Separate mutation acknowledgement and bounded readback verification.
- Report service action reasons and provide redacted Debug logs.
- Supply inactive acceptance workflows without credentials.
