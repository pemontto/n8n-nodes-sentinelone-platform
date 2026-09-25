# Full code review, 2026-09-09

Reviewed at 837a2fd (the whole package, three foundation commits plus the note preview fix that landed mid-review). Build, lint, prettier, and the unit suite (217 tests) all pass. Four independent reviewers ran in parallel over the same tree: standards, spec, security, correctness. Their findings are kept separate below and are not reranked against each other.

## Do first

1. Trigger sends the API token on cross-origin redirects. Set `sendCredentialsOnCrossOriginRedirect: false` in the trigger's `authenticatedRequest` wrapper (`nodes/SentinelOnePlatformTrigger/SentinelOnePlatformTrigger.node.ts:79`). The action node already sets it everywhere.
2. `sanitizeReason` mangles service messages when Ticket ID is JSON (`nodes/shared/Errors.ts:12-32`). Redact only tokens of four or more characters at word boundaries.
3. Include OCSF drops alerts on scope mismatch and still advances the checkpoint (`nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.ts:701-709`). Throw instead of returning null.
4. Trigger help links point at docs that do not exist (`SentinelOnePlatformTrigger.node.ts:263,280,289,298,375`). Add the sections to `docs/trigger.md` or remove the links.
5. Validate the console URL as an `https://` origin in the credential and in `normalizeBaseUrl`.

## Security

### Reachable in production today

**The trigger hands the SentinelOne API token to any host the console redirects to.** Every trigger request omits `sendCredentialsOnCrossOriginRedirect`, and n8n defaults it to true, so the bearer header follows a 30x to a different origin. Sites: `SentinelOneTriggerHelpers.ts:396`, `ActivityNotePoll.ts:72`, `Ocsf.ts:78`, `ActivityFeed.ts:306,346,368`. The main node sets the flag everywhere (`transport/graphql.ts:53`, `transport/sdl.ts:196,237`, `shared/Scopes.ts:213,439`), so this is an omission. Fix: set it once in the trigger's `authenticatedRequest` wrapper so every caller inherits it.

**The console URL is never validated, so `http://` sends the token in clear text.** `credentials/SentinelOnePlatformApi.credentials.ts:22-29` accepts any string; `normalizeBaseUrl` only trims trailing slashes. A mistyped or internal hostname turns the node into an authenticated request generator against arbitrary hosts. Fix: reject anything that is not an `https://host[:port]` origin at credential level and in `normalizeBaseUrl`.

**`usableAsTool: true` (`SentinelOnePlatform.node.ts:121`) makes alert text a control channel.** An LLM agent reading alert names or note bodies can be steered into calling Update or Note Create with attacker-chosen values. Options: document the risk in `docs/behavior.md`, or restrict tool use to read operations. Recommendation: document now, revisit if write operations grow.

**The privacy check passes real identifiers that look random.** `scripts/privacy-check.mjs:21` matches only v1/v6/v7 UUIDs, so a genuine v4 alert or account ID passes, and `tests/unit/privacy-check.test.js:38` asserts exactly that. The token pattern covers npm and GitHub only, and the hostname rule only knows `sentinelone.net|com`. Fix: add a generic high-entropy token rule and flag any UUID in `examples/`, `docs/`, and `tests/fixtures/` unless it matches the synthetic `1111…`/`0000…` shapes.

### Reachable in principle

**Response size limits apply after the body is in memory.** `transport/sdl.ts:93-104` measures `Buffer.byteLength` on received text, so a hostile console returning a multi-gigabyte body exhausts the worker first. `results.ts:259-267` also re-serialises output up to 17 times during the binary search. Fix: pass `maxContentLength` at the transport and cache serialised sizes.

**A failed SDL query throws a bare `Error` carrying the tenant query ID** (`sdlQuery/execute.operation.ts:239`). It is the one path that bypasses the `safeError` discipline.

**Author-supplied key names are echoed into error text** (`alert/filters.ts:45,171`, `SentinelOneTriggerHelpers.ts:137`). Self-inflicted only.

### Verified as claimed

Mutations run once: `requestWithRetry` forces one attempt when `mutation` is set (`shared/transport/request.ts:16`), `assertMutationRetryDisabled` blocks node-level Retry On Fail (`actions/common.ts:359`), and verification re-reads without repeating the write. GraphQL and SDL take user values through variables and JSON bodies; Additional GraphQL Fields is tokenised and rejects arguments, aliases, and directives (`shared/AlertFields.ts:344-382`). Debug logging redacts string literals and variable scalars. No path reads `apiToken` into node code. Packaging has no runtime deps, no install scripts, and an enforced `files` allowlist.

Non-security note: `tests/fixtures/schema/console-a.graphql` and `console-b.graphql` are byte-identical, so `tests/unit/schema-contract.test.js:22` compares a file with itself.

## Correctness

**pairedItem is clean.** Every output item is produced at `SentinelOnePlatform.node.ts:96-109`, which maps `pairedItem` onto both the success fan-out and the continueOnFail failure item. Handlers return plain arrays, so bulk results cannot desynchronise. A failure on item N does not stop N+1, non-Error throws are wrapped, and everything carries `itemIndex`. Covered by `tests/unit/sentinelone-node.test.js:236-365`.

**A JSON ticket ID turns SentinelOne's refusal message into gibberish.** With Ticket ID set to `{"a":1,"ref":"INC-42"}` and the update refused, the reason reads `St[v[value]lue]tus upd[v[value]lue]te…`. `sanitizeReason` (`nodes/shared/Errors.ts:12-32`) adds every key and scalar of the parsed ticket JSON as a redaction token and does an unanchored split/join, so a one-character key redacts every matching letter and the replacement is re-scanned. Reached from `discovery.ts:68` and `results.ts:12`. The existing test only asserts the secret is absent. Fix: skip tokens under four to six characters and require a word boundary.

**A denied alert update arrives as a green success item.** `update.operation.ts:165-216` returns `outcome: 'rejected'` rather than throwing for 401/403 and GraphQL-level rejection. A downstream node that does not read `outcome` treats the alert as updated. `docs/behavior.md` treats rejection as an outcome, so this may be deliberate, but it is the highest-consequence silent-wrong-output path. Recommendation: throw the `NodeApiError` for rejected; the acknowledgement fields survive on the error.

**Include OCSF silently drops alerts and still advances the checkpoint.** An alert moved between scopes between the list and detail queries vanishes and is never re-emitted. `SentinelOneTriggerHelpers.ts:701-709` returns `[id, null]` when `scope.id !== scopeId`, and `:718-721` drops those items. Fix: throw for the mismatch case (matching the sibling `scope.id === null` throw) and keep the drop only for exclusion matches.

**Events older than the 300-second overlap are lost permanently.** `overlapSeconds: 300` is hard-coded (`SentinelOnePlatformTrigger.node.ts:560`) and the window end is n8n's local clock. Console clock lag or indexing lag beyond five minutes loses alerts silently. Window boundaries themselves are correct. Fix: expose the overlap as an option, default 300 s.

Lower consequence:

- Retry classification (`retry.ts:20`) omits 408 and `ECONNREFUSED`/`EPIPE`. `request.ts:17` shares one 30 s budget across attempts, so a slow first failure collapses three attempts to one.
- Completed ActivityFeed SDL queries are never deleted (`ActivityFeed.ts:363`), unlike `sdl.ts`. Confirm against SDL quota.
- SDL rows use `Object.create(null)` for `json` (`sdlQuery/results.ts:175`); any caller using `hasOwnProperty` throws. Cheap to change to `{}`.

Test gaps: sanitised message readability, 408 and `ECONNREFUSED` classification, attempts collapse under a consumed deadline, OCSF scope-mismatch drop, clock-skew loss past the overlap.

## Standards

### Hard violations

**Icons live in the trigger folder, not `icons/`.** The action node (`SentinelOnePlatform.node.ts:52-53`) and credential (`credentials/SentinelOnePlatformApi.credentials.ts:14-15`) point at `nodes/SentinelOnePlatformTrigger/sentinelone.svg`. The guide (`02-project-structure.md`, Icons) requires `icons/<service>.svg` at the root. Fix: move both SVGs, update three references and the build copy step.

**SDL failures reach the user as untyped errors identified by string prefix.** `actions/sdlQuery/common.ts:9` returns a bare `Error`, `execute.operation.ts:239` throws another, and `:236` tests `startsWith('SentinelOne SDL query ')`. The guide (`08-common-patterns.md`, Error Handling) requires `NodeApiError`/`NodeOperationError`, and `localError`/`apiError` already exist in `actions/common.ts`. Fix: route SDL errors through them with a discriminating field.

**The trigger discards its own error metadata.** `SentinelOnePlatformTrigger.node.ts:576-580` wraps every caught error, including already-built `NodeOperationError`s from `:117-121` and `:152-155`, by string concatenation. The user sees a double-prefixed message and `statusCode`/`retryable`/`retryAfterMs` vanish. Fix: rethrow when `error instanceof NodeOperationError`.

**README has no node icon at top** (`02-project-structure.md`, README Icon).

### Judgement calls

1. Duplicated code: `isRecord`/`asRecord` in six files (`actions/common.ts:10`, `shared/transport/retry.ts:2`, `shared/Scopes.ts:51`, `sdlQuery/common.ts:3`, `Trigger/Ocsf.ts:61`, `Trigger/SentinelOneTriggerHelpers.ts:110`); `normalizeBaseUrl` in three; `Scopes.ts:54 statusCode` duplicates `retry.ts:8`. Fix: one `nodes/shared/Guards.ts`.
2. Two different `authenticatedRequest`s (`Scopes.ts:42`, trigger `:62`), the latter choosing retry count by sniffing the URL (`:104`). Fix: one factory with an explicit policy.
3. Dead code: `GRAPHQL_DOCUMENTS.getAlert`/`getManyAlerts` (`actions/documents.ts:28,36`) have no callers; `ManagementScopeType = ScopeType` (`Scopes.ts:13`); `results.ts:5` re-exports `sanitizeReason`.
4. Four near-identical exclusion regex options in the trigger (`:274-299`, `:351-385`). Fix: a small option helper.
5. Local `scopeIds` at trigger `:498` shadows the imported function (`:9`).
6. `graphQlRequest` takes seven positional params, two booleans (`transport/graphql.ts:22-30`). Fix: options object.
7. Duplicated range validation in `filters.ts:127-129` and `:197-199`.
8. `boundOutput` takes `itemIndex` only to rebuild the pairedItem wrapper for byte counting (`sdlQuery/results.ts:205,219`). Pass an overhead number instead.
9. `group: ['output']` on a mostly-read node (`SentinelOnePlatform.node.ts:55`); `['transform']` fits better.

## Spec

**Trigger help links point at documentation that does not exist.** "See examples" (`SentinelOnePlatformTrigger.node.ts:263`) targets `docs/trigger.md#advanced-filters`, which has no such section; four exclusion fields say "See the README for supported syntax" (`:280,289,298,375`) and README has none. Users guess and hit `Unknown advanced filter key` or the one-quantifier regex rejection (`Exclusions.ts:11-50`). Fix: add "Advanced filters" and "Exclusion regex syntax" sections to `docs/trigger.md` mirroring `validateRawFilter` and `compileExclusion`, or remove the links.

**Most trigger behaviour is undocumented.** `docs/trigger.md` covers only Additional Alert Fields and Parent Alert Severity/Status. Absent: Advanced Filters, Alert Name, four exclusion regexes, Include SentinelOne OCSF (an extra request per alert), Simplify (default true, so output is flattened), Severity, Status. Fix: an options table.

**Return All has an undocumented hard cap that discards the whole run.** `docs/actions.md:5` says only "filters, and pagination"; `getMany.operation.ts:17,87-97` throws `Return All is limited to 10,000 alerts` mid-pagination, so a busy tenant pages for minutes and gets nothing. Fix: document the cap; better, emit what was collected with a truncation warning.

**`pending` is narrower than its documented meaning.** `docs/ticket-update-verification.md:17` says pending means "scheduled or incomplete", but `update.operation.ts:267-270` maps to pending only for scheduled and mismatch. A scheduled action with an unavailable readback reports `unavailable`, and a partial immediate outcome reports `mismatch`, so a user may re-issue a write that is still executing. Fix: report pending for any non-verified status when the outcome is scheduled, and for partial.

**Documented output fields are incomplete.** Update emits `outcome`, `mutationAcknowledged`, `mayHaveCommitted`, `results[]`, `verificationAttempts`; note Create emits `identification.status` and `candidates` (`create.operation.ts:62-88`); SDL emits `metadata.cleanupStatus`/`warnings`. Docs describe only `verification.<field>` and `verificationStatus`. Fix: an output section per operation in `docs/actions.md`.

**SDL controls and defaults are undocumented.** Output Mode, Timeout 100 s, Poll Interval 1500 ms, Max Rows 5000, Max Output 10 MiB (`execute.operation.ts:105-125`). Get Many always sorts `createdAt DESC` with no control (`getMany.operation.ts:82`).

**`docs/implementation-status.md:14` is stale** ("216 tests pass"; it is 217). Prefer "the suite passes" over a count.

Minor: the note trigger's SDL access requirement appears only in the editor notice (`:241`), not in `docs/trigger.md`.

Checked clean: example workflows are inactive, credential-free, and every parameter name matches the node descriptions. Scope statements match the router. Mutation-once, Retry On Fail rejection, verification budget and backoff, Retry-After handling, and ticket comparison all match `docs/behavior.md`.

## Totals

| Axis        | Findings                         | Worst                                               |
| ----------- | -------------------------------- | --------------------------------------------------- |
| Security    | 7 (4 production, 3 in principle) | Token follows cross-origin redirects in the trigger |
| Correctness | 7 plus test gaps                 | Rejected update emitted as a success item           |
| Standards   | 4 hard, 9 judgement              | SDL errors bypass n8n error types                   |
| Spec        | 8                                | Help links to non-existent docs                     |
