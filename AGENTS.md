# SentinelOne Platform

## Working rules

Read `docs/architecture.md` before changing module boundaries or adding operations. Read `docs/behavior.md` before changing requests, retries, verification, defaults, or output. Use the package scripts and the official n8n node CLI for build and lint.

Keep operation descriptions beside their execution, shared controls in one definition, and item pairing in the node entry point. Use n8n authenticated request helpers. Keep trigger checkpoint logic together. Preserve read/mutation distinctions: uncertain mutations are not replayed automatically.

This foundation release includes only Alert Get/Get Many/Update, Alert Note Get Many/Create, SDL Query Execute, and the existing alert/note triggers. New operations require a separate task. Its common alert response intentionally exceeds the n8n ten-field simplification guideline; optional extras add to that response.

Customer names, real tenant/record IDs, credentials, private paths, internal links, and operational captures do not belong in this repository. Use synthetic fixtures and generic examples. Keep public publisher identity and licence attribution.

Delegate independent work with explicit file ownership. Preserve other workers' changes. Require tests for behavior changes and an independent review before handoff. Verify editor controls in the actual editor; source metadata alone is insufficient.

The user runs live write tests against a designated demo account. Automated work may run mocks and read-only checks; it must not execute live mutations, publish npm, create release tags, or alter existing publishing secrets. Keep public workflows inactive and credential-free.

## Writing

Use concise, direct technical prose and consistent n8n terminology. Keep prose paragraphs on one physical line. Keep comments about behavior and decisions, not implementation narration. Use public GitHub noreply attribution for commits; exclude private contact information.
