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

Open `03-notes.json`. Configure the explicit alert ID and select XDR Demo on Listen for demo notes. Start listening, then run the manual creation branch once. The note has a `platform acceptance test` prefix and timestamp.

Expect a created-note result and a trigger event after polling. The event alertId must match the designated target. Remove the note manually in SentinelOne if permitted; this package has no note-delete operation.

## Alert changes

Open `04-alert-changes.json`, select XDR Demo, and listen for New or Updated events. Make a controlled change using the update workflow. Check event type, timestamp, alert ID, common fields, and normal deduplication over another poll.

## Record results

Record the workflow, operation, expected and observed outcome, verificationStatus, and sanitized errors. Settings > Debug provides redacted request diagnostics in server logs. Do not commit execution data, real identifiers, credential references, or logs. User testing precedes a separate publication step.
