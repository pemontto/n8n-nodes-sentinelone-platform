# Credentials

Create a SentinelOne Platform API credential with your console URL and API token. Use the base URL, such as `https://console.example.com`, rather than a GraphQL endpoint.

Select the credential on every action and trigger. n8n stores the token in its credential system. Never put tokens in workflow expressions, exports, command arguments, or repository files.

Read access does not imply update access. SentinelOne can disable or omit actions for an alert. SDL and management API permissions can differ. Example workflows contain no credential references; select your own credential after import.

The Alert Note > Created trigger requires SDL query access to read note events from ActivityFeed. Alert read access alone is not sufficient.
