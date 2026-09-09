# XDR Demo acceptance testing

Import the four JSON files from [examples/workflows](../examples/workflows). They are inactive and contain no credentials. Select your credential on every SentinelOne node. The user executes live writes; development checks do not.

## Configure

Select XDR Demo under Account Names or IDs on List demo alerts and both listener nodes before running them. Public exports leave account IDs empty. Empty read selections otherwise include all accessible accounts.

Write branches have a Configure test node with an empty alertId. Fill it with a designated disposable XDR Demo alert ID. The branch fetches that exact ID and checks `realTime.scope.account.name === 'XDR Demo'` before writing. Missing IDs, mismatched IDs, other accounts, and missing account metadata stop the branch. Do not alter the guard or connect a mutation around it.

Keep workflows inactive and use editor test controls. Keep Retry On Fail off on writes.

## Read and fields

Open `01-read-and-fields.json`. Select the demo account and run the manual branch. Inspect Get common fields and Get optional fields. Only the second requests Raw Data. Limit is five, and each fetched alert retains its item relationship.

## Update and verification

Open `02-update-and-verification.json`. Fill alertId in Configure test. Its updates object requests IN_PROGRESS and synthetic ticket metadata by default. Edit that object to choose supported fields; analystVerdict can be added. Test status, verdict, and ticket separately to distinguish permission failures.

Run through Guard demo account first. Inspect and save its original object before executing Update designated alert. Original contains the previous status, analyst verdict, and ticket ID. Save it outside the execution if you need restoration after execution history expires.

Run the mutation once. Review update result returns original, requested, and the complete node result including verification. Matching readback should report verified. Unavailable readback does not mean the write failed; inspect the acknowledgement and current alert before another attempt.

To restore, copy supported non-empty original values into updates and rerun the guarded branch. Preserve an original ticket string as a string. A prior null or empty ticket cannot be restored with this node's unsupported clearing operation. Choose an alert with a non-empty ticket when exact restoration matters.

For multi-item testing, deliberately provide multiple explicit demo configurations and inspect item pairing. Never derive write targets from a listing.

## Notes

Open `03-notes.json`. Configure the explicit alert ID and select XDR Demo on Listen for demo notes. The listener uses Alert Activity > Occurred with Note created (`16007`) selected. For read-only checks, fetch a test event without executing either write branch. For user-run write acceptance, start listening, then run the manual creation branch once. The note has a `platform acceptance test` prefix and timestamp.

Expect a created-note result and a trigger event after polling. The trigger event has `eventType: "alert.activity"` and `activityTypeId: "16007"`; its `alertId` must match the designated target. Inspect note details within the event envelope. Remove the note manually in SentinelOne if permitted; this package has no note-delete operation.

## Alert changes

Open `04-alert-changes.json`, select XDR Demo, and listen for New or Updated events. Make a controlled change using the update workflow. Check event type, timestamp, alert ID, common fields, and normal deduplication over another poll.

## Record results

Record the workflow, operation, expected and observed outcome, verificationStatus, and sanitized errors. Settings > Debug provides redacted request diagnostics in server logs. Do not commit execution data, real identifiers, credential references, or logs. User testing precedes a separate publication step.

## Development runtime

Use one coordinated development server when testing several packages. Compile with `pnpm build` or `pnpm build:watch`, then request a restart through that server's launcher after other tests finish. Do not use `n8n-node dev`, `--external-n8n`, or this package's `pnpm dev` script against the shared instance. They register nodes through the CUSTOM loader; n8n 2.38.1 hot reload can lose other local node and credential registrations. Keep hot reload disabled for that setup.

Use package-qualified types for new workflows: `n8n-nodes-sentinelone-platform.sentinelOnePlatform` and `n8n-nodes-sentinelone-platform.sentinelOnePlatformTrigger`. Existing CUSTOM registrations may remain for saved-workflow compatibility. Do not replace existing workflow types or credentials as part of a server restart.

Local symlinks loaded through the community-package loader verify registration and editor behaviour. They do not prove that the published files and dependencies work alone. Before release, install the packed tarball into an isolated n8n instance without access to the source tree.

Scheduled checkpoint persistence also needs host-level acceptance. A separate isolated n8n 2.38.1 polling-engine probe found that activation with a null result discarded its initial cursor and concurrent scheduled tasks could overwrite cursor snapshots, even with durable polling flags enabled. Those observations are not a completed SentinelOne scheduled-runtime test. The package's in-process overlap guard does not establish cross-process cursor safety. Verify activation-to-first-tick behaviour, empty polls, downstream failure, restart recovery and overlapping jobs in an isolated instance before accepting scheduled delivery on a particular runtime. Do not change a shared server's scheduler flags or activate customer workflows for this test.
