# Acceptance testing

The four example workflows are inactive and contain no credentials. Import them, select your `sentinelOnePlatformApi` credential on each SentinelOne node, and review their parameters before running them. Keep workflows inactive and use manual or trigger test controls. Automated checks use fake servers and do not perform live mutations.

## Scope and reads

The read example lists up to five alerts from all credential-accessible accounts, then reads each alert's common fields and Raw Data. Add Options > Scope > Selection when you want the list restricted to selected accounts, sites, or groups. Empty selections include all records accessible to the credential.

## Alert Update

The update example requires an explicit alert ID and fetches that exact alert before any write. Its guard also checks that the alert belongs to the expected account. The sample guard has a fixed account name in Configure test and Guard demo account; inspect both nodes and change the expected name together to match a designated disposable test account before running it. Keep the ID and account checks in place. The example's default update requests `IN_PROGRESS` and synthetic ticket metadata; edit its updates object to test supported fields. The workflow saves original values before the write so they can be reviewed for restoration.

Run the mutation once with Retry On Fail disabled. Review the acknowledgement and verification result. An unavailable readback does not mean the write failed; inspect the current alert before any further write. Ticket ID clearing is unsupported, so choose a test alert with a non-empty ticket value if exact restoration matters.

## Alert Notes and activity

The note example requires an explicit alert ID and uses the same fixed account-name guard described above. The listener uses Alert Activity > Occurred with Note created (`16007`). Activate the listener and wait for its first scheduled poll to establish a baseline before creating a note; the baseline does not emit earlier activity. Then create one note from the manual branch and wait for the next poll. The resulting activity has `eventType: "alert.activity"`, `activityTypeId: "16007"`, and the parent `alertId`. This package has no note-delete operation, so remove test notes manually if permitted.

For a read-only check, use Fetch Test Event without running a write branch. A manual preview searches historical windows and does not establish scheduled polling state.

## Alert snapshot trigger

The alert-changes example listens for New or Updated alerts. Its first scheduled poll records the activation baseline and does not replay earlier alerts. Wait for that poll before making a controlled change to a designated test alert. Later matching alerts are emitted according to the configured scope, filters, overlap, and retained checkpoint state.

## Development

For package-local development, run `pnpm dev`. It invokes the official `n8n-node dev` workflow. Use `pnpm run build`, `node --test tests/**/*.test.js`, `pnpm run lint`, and `pnpm run format:check` for package checks. Install the packed package in an isolated n8n instance before release to check it without the source tree.
