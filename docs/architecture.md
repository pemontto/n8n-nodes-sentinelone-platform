# Architecture

The foundation retains one action node and one polling trigger. Entry points own n8n metadata, dispatch, item pairing, and continue-on-failure behavior. Operations own their descriptions and execution. Shared code owns transport, errors, retries, diagnostics, field projections, and scope controls.

Action modules live under `nodes/SentinelOnePlatform/actions/<resource>/<operation>.operation.ts`. GraphQL transport, documents, update action discovery, result parsing, and verification have separate focused modules. SDL transport and result decoding are separate from its bounded lifecycle. Trigger checkpoint and deduplication behavior remains together.

Shared catalogs live under `nodes/shared/`. Neither action nor trigger modules import configuration from the other node. Keep GraphQL list/detail differences explicit while sharing labels and common fields.

Use native n8n request helpers and no monorepo-private imports. Preserve the public six-action/four-trigger scope: Alert Activity > Occurred replaces the note-created trigger. This is a fresh package with no compatibility aliases.

## References

- [n8n code standards](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/create-nodes/build-your-node/reference/code-standards.md)
- [n8n UX guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/ux-guidelines)
- [n8n UI elements](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/create-nodes/build-your-node/reference/node-ui-elements.md)
- [Item linking](https://docs.n8n.io/data/data-mapping/data-item-linking/item-linking-code-node)
- [Official node tooling](https://github.com/n8n-io/n8n-docs/blob/main/docs/connect/create-nodes/build-your-node/using-the-n8n-node-tool.md)
- [Verification guidelines](https://docs.n8n.io/connect/create-nodes/build-your-node/reference/verification-guidelines)
- [Databricks router](https://github.com/n8n-io/n8n/blob/8e8daecba27277990ac1e269368d6b6f17b21281/packages/nodes-base/nodes/Databricks/actions/router.ts)
- [Databricks operation](https://github.com/n8n-io/n8n/blob/8e8daecba27277990ac1e269368d6b6f17b21281/packages/nodes-base/nodes/Databricks/actions/databricksSql/executeQuery.operation.ts)
- [Notion shared descriptions](https://github.com/n8n-io/n8n/blob/8e8daecba27277990ac1e269368d6b6f17b21281/packages/nodes-base/nodes/Notion/v3/actions/common.descriptions.ts)
- [Notion transport](https://github.com/n8n-io/n8n/blob/8e8daecba27277990ac1e269368d6b6f17b21281/packages/nodes-base/nodes/Notion/v3/transport/index.ts)
