# Actions

## Alert

Get requires an Alert ID. Get Many supports Account, Site, and Group selections, filters, and pagination. Empty hierarchy selections include accessible records.

Options > Additional Alert Fields adds supported extras without removing common fields. Large enrichments remain opt-in. Get also accepts selection-only Additional GraphQL Fields, including nested selections. It does not accept a complete query or mutation; follow the input's syntax restrictions.

Update supports status, analyst verdict, and ticket ID. Strings are preserved; objects and arrays are serialized once. Ticket updates replace the entire value. Merge existing JSON explicitly if other metadata must survive. For example, after checking the existing value is a JSON object, use `{ ...existingMetadata, externalTicketId: 'demo-ticket' }`.

Advanced Update Payload uses the same fields. Enable its toggle before supplying JSON. Guided and JSON inputs are additive; duplicate keys are rejected. Severity changes and clearing fields are unsupported.

A disabled action reports the service reason. An absent action does not prove a permission problem. See [verification](ticket-update-verification.md).

## Alert Note

Get Many takes an Alert ID and a limit or Return All. Create takes an Alert ID, text, and content format. Neither operation needs scope.

Create retains the snapshot needed to identify a new note and submits once. If the result is uncertain, inspect existing notes before another attempt. Keep Retry On Fail off for writes.

## SDL Query

Execute submits a query, polls within configured limits, retrieves results, and performs cleanup. Choose Entire Tenant or selected accounts as appropriate. SDL access is separate from alert-update permission.

## Debug

Settings > Debug logs GraphQL structure, redacted variables, attempts, timing, and outcomes to the n8n server log at Info level. It excludes credentials and full write payloads, and does not change normal output.
