# Triggers

Alert supports New, Updated, and New or Updated. Alert Note supports Created. These are polling triggers with checkpoint and deduplication state.

Choose Account, Site, and Group selections to narrow polling. Empty selections include accessible records. Options > Additional Alert Fields adds optional data to common alert fields; large enrichments are not requested by default.

Parent Alert Severity and Parent Alert Status apply to a note's parent at polling time. They do not reconstruct its state when the note was created.

A note event's `alertId` can feed Alert > Get directly without account or site scope. Trigger output retains event metadata.

Use [inactive testing workflows](testing.md) to check delivery and deduplication. Select the demo account before listening. Keep the listener running while making a designated test change. A poll without new qualifying events produces no items.
