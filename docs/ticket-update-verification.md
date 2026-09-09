# Update verification

Mutation acknowledgement and observed stored state answer different questions. The node retains both.

Options > Verify Update is on by default. A normal update uses action discovery, one mutation, and one readback. Readback requests only the ID and changed fields. Disabling verification removes the readback.

Verification permits at most three reads within 30 seconds. Failed transport attempts and successful reads showing stale values share that budget. Delays are approximately one and two seconds with jitter. Retry-After is honored within the deadline. Permission and validation failures are not retried. The mutation is never repeated.

Each field has `verification.<field>.requested`, `observed`, and `verified`. Null verified means comparison was impossible.

| verificationStatus | Meaning                                 |
| ------------------ | --------------------------------------- |
| verified           | Compared values match                   |
| mismatch           | Readback succeeded but values differ    |
| unavailable        | Readback could not establish values     |
| skipped            | Disabled or unnecessary after rejection |
| pending            | Action remains scheduled or incomplete  |

Inspect the mutation outcome alongside verificationStatus. Readback failure does not undo acknowledgement. A matching read after an uncertain response establishes current state, not which request caused it. Keep scheduled execution IDs and partial outcomes before deciding on another write.

Ticket JSON comparison ignores object key order but preserves types and array order. Other strings compare exactly. Ticket updates replace the entire value without implicit merging. Whole-node Retry On Fail is rejected for mutation operations because it could repeat writes.
