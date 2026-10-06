const assert = require('node:assert/strict');
const test = require('node:test');
const { PollBudgetError } = require('../../dist/nodes/shared/transport/request.js');
const {
	fingerprintConfig,
	pollSentinelOne,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');

const NOW = Date.parse('2026-09-01T01:00:00.000Z');
const iso = (time) => new Date(time).toISOString();

function config(overrides = {}) {
	return {
		baseUrl: 'https://tenant.example',
		credentialIdentity: { type: 'sentinelOnePlatformApi', id: 'credential-1' },
		scopeType: 'ACCOUNT',
		scopeIds: ['account-1'],
		allVisibleAccounts: false,
		events: ['alert.new'],
		severities: [],
		statuses: [],
		alertName: '',
		simplifyOutput: true,
		debug: false,
		overlapSeconds: 300,
		concurrentRequests: 1,
		requestTimeoutMs: 30_000,
		alertPageSize: 200,
		maxAlertPages: 25,
		pollDeadlineMs: NOW + 36_000,
		...overrides,
	};
}

function cursorsFor(triggerConfig, checkpointMs) {
	const cursors = {};
	const scopes = [...triggerConfig.scopeIds].sort();
	for (let offset = 0; offset < scopes.length; offset += 500) {
		let hash = 2166136261;
		for (const character of scopes.slice(offset, offset + 500).join('\u0000')) {
			hash ^= character.charCodeAt(0);
			hash = Math.imul(hash, 16777619);
		}
		for (const event of triggerConfig.events) {
			const field = event === 'alert.new' ? 'createdAt' : 'updatedAt';
			cursors[`${field}:${(hash >>> 0).toString(16)}`] = { throughMs: checkpointMs, ids: [] };
		}
	}
	return cursors;
}

function stateFor(triggerConfig) {
	return {
		configFingerprint: fingerprintConfig(triggerConfig),
		initialized: true,
		activationMs: NOW - 3_600_000,
		checkpointMs: NOW - 600_000,
		alertCursors: cursorsFor(triggerConfig, NOW - 600_000),
		seenAlertIds: [],
		seenAlertVersions: [],
	};
}

function alert(id, createdAt, accountId = 'account-1', updatedAt = createdAt) {
	return {
		id,
		name: `Alert ${id}`,
		severity: 'HIGH',
		status: 'NEW',
		createdAt: iso(createdAt),
		updatedAt: iso(updatedAt),
		realTime: { scope: { account: { id: accountId, name: accountId } } },
	};
}

function fakeServer(alerts) {
	const requests = [];
	const request = async (options) => {
		requests.push(options);
		const variables = options.body.variables;
		const field = variables.sortBy;
		const range = variables.filters.find((filter) => filter.dateTimeRange).dateTimeRange;
		const excluded = new Set(
			variables.filters.find((filter) => filter.fieldId === 'id' && filter.isNegated)?.stringIn
				.values ?? [],
		);
		const scope = new Set(variables.scope.scopeIds);
		const direction = variables.sortOrder === 'ASC' ? 1 : -1;
		const rows = alerts
			.filter(
				(row) =>
					scope.has(row.realTime.scope.account.id) &&
					Date.parse(row[field]) >= range.start &&
					Date.parse(row[field]) <= range.end &&
					!excluded.has(row.id),
			)
			.sort(
				(left, right) =>
					direction * (Date.parse(left[field]) - Date.parse(right[field])) ||
					left.id.localeCompare(right.id),
			);
		const offset = variables.after ? Number(variables.after) : 0;
		const next = offset + variables.first;
		return {
			data: {
				alerts: {
					edges: rows.slice(offset, next).map((node) => ({ node })),
					pageInfo: {
						hasNextPage: next < rows.length,
						endCursor: next < rows.length ? String(next) : null,
					},
				},
			},
		};
	};
	return { request, requests };
}

async function seededState(triggerConfig) {
	const seeded = await pollSentinelOne(
		fakeServer([]).request,
		triggerConfig,
		stateFor(triggerConfig),
		'scheduled',
		NOW - 120_000,
	);
	return seeded.nextState;
}

const uuid = (prefix, index) =>
	`${prefix.padStart(8, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`;

async function stallState(triggerConfig) {
	const seeded = await seededState(triggerConfig);
	const cursors = structuredClone(seeded.alertCursors);
	const createdKey = Object.keys(cursors).find((key) => key.startsWith('createdAt:'));
	const updatedKey = Object.keys(cursors).find((key) => key.startsWith('updatedAt:'));
	cursors[updatedKey] = {
		throughMs: NOW - 600_000,
		ids: [],
		resumeMs: NOW - 600_000,
		resumeIds: [],
	};
	return { state: { ...seeded, alertCursors: cursors }, createdKey, updatedKey };
}

async function pollWithBlockedUpdated(triggerConfig, initialState, rowsForPoll, polls) {
	let state = initialState;
	for (let poll = 0; poll < polls; poll++) {
		const pollStart = NOW + poll * 60_000;
		const source = fakeServer(rowsForPoll(poll));
		const result = await pollSentinelOne(
			async (options) => {
				if (options.body.variables.sortBy === 'updatedAt') throw new PollBudgetError();
				return source.request(options);
			},
			{ ...triggerConfig, pollDeadlineMs: pollStart + 36_000 },
			state,
			'scheduled',
			pollStart,
		);
		state = result.nextState;
	}
	return state;
}

test('A completed empty New read does not hide a stalled Updated sibling', async () => {
	const warnings = [];
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const { state, createdKey, updatedKey } = await stallState(triggerConfig);
	const finalState = await pollWithBlockedUpdated(triggerConfig, state, () => [], 3);
	assert.equal(finalState.stalledAlertPolls?.[createdKey], undefined);
	assert.equal(finalState.stalledAlertPolls[updatedKey], 3);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0].message, /updatedAt stream in scope batch 1.*3 polls/);
});

test('A New sibling that fetched rows still counts as batch progress', async () => {
	const warnings = [];
	const triggerConfig = config({
		events: ['alert.new', 'alert.updated'],
		warnLog: (message, details) => warnings.push({ message, details }),
	});
	const { state, updatedKey } = await stallState(triggerConfig);
	const finalState = await pollWithBlockedUpdated(
		triggerConfig,
		state,
		(poll) => [alert(uuid('c', poll), NOW + poll * 60_000 - 5_000)],
		3,
	);
	assert.equal(finalState.stalledAlertPolls?.[updatedKey], undefined);
	assert.deepEqual(warnings, []);
});
