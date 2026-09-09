# SentinelOne Unified Alerts GraphQL schema

This directory contains the standard introspection query used to check the Unified Alerts GraphQL documents during development. Authenticated schema captures stay local and are excluded from the repository.

## Files

- `introspection-query.graphql` contains the standard query used to produce local raw responses.

## Collection method

The collector sent `introspection-query.graphql` to this endpoint:

```text
POST /web/api/v2.1/unifiedalerts/graphql
```

The collector keeps each token in memory and writes only the GraphQL response.

## Update procedure

1. Send `introspection-query.graphql` to each authenticated endpoint.
2. Save the complete JSON response with the date in the file name.
3. Build the client schema with GraphQL.js.
4. Sort the schema with `lexicographicSortSchema`.
5. Write the SDL with `printSchema`.
6. Compare the normalized SDL files.
7. Review all differences before you update a query in the node.

Do not put an API token in a command, source file, log, or schema artifact.
