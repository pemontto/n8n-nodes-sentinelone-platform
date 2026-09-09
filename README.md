# SentinelOne Platform for n8n

Read and update SentinelOne alerts, work with notes, run SDL queries, and poll alert events. The credential determines which records and actions are accessible.

| Resource           | Operations                   |
| ------------------ | ---------------------------- |
| Alert              | Get, Get Many, Update        |
| Alert Note         | Get Many, Create             |
| SDL Query          | Execute                      |
| Alert trigger      | New, Updated, New or Updated |
| Alert Note trigger | Created                      |

Common alert fields are always returned. Options > Additional Alert Fields adds extras; Raw Data is opt-in. ID-based operations need no scope selection. Searches and triggers have optional Account, Site, and Group selections.

Update supports status, analyst verdict, and ticket ID. Verification reads changed fields after the mutation. Failed readback does not turn an acknowledged write into a rejected write.

## Documentation

- [Credentials](docs/credentials.md)
- [Actions](docs/actions.md)
- [Triggers](docs/trigger.md)
- [Verification](docs/ticket-update-verification.md)
- [Acceptance workflows](docs/testing.md)
- [Architecture and n8n references](docs/architecture.md)
- [Behavior contract](docs/behavior.md)

## Development

Use `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm test`, `pnpm lint`, and `pnpm dev`. This foundation targets 0.1.0; live acceptance testing and npm publication are separate steps. New node and credential identifiers do not automatically migrate existing workflows.

[Source and issues](https://github.com/pemontto/n8n-nodes-sentinelone-platform). MIT licence; see LICENSE.
