const test = require('node:test');
const assert = require('node:assert/strict');
const {
	pollAlertActivities,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/ActivityNotePoll.js');
const {
	fingerprintConfig,
} = require('../../dist/nodes/SentinelOnePlatformTrigger/SentinelOneTriggerHelpers.js');
const PREVIEW_START = Date.UTC(2020, 0, 1);
const NOW = 1788776400000;
const cfg = (extra = {}) => ({
	baseUrl: 'https://tenant.example',
	credentialIdentity: { id: 'c' },
	scopeType: 'ACCOUNT',
	scopeIds: ['a'],
	allVisibleAccounts: false,
	events: ['alert.activity'],
	severities: [],
	statuses: [],
	alertName: '',
	simplifyOutput: true,
	debug: false,
	overlapSeconds: 300,
	alertLookbackDays: 1,
	alertLookbackMinutes: 15,
	maxAlertPages: 25,
	requestTimeoutMs: 30000,
	...extra,
});
const ns = (time) => (BigInt(time) * 1000000n).toString();
const state = (c, extra = {}) => ({
	configFingerprint: fingerprintConfig(c) + ':sdl-activities-v1',
	initialized: true,
	checkpointMs: NOW - 1000,
	activityActivationMs: NOW - 100000,
	seenActivityIds: [],
	seenActivityTimestamps: {},
	...extra,
});
const alert = () => ({
	id: 'old-alert',
	name: 'Old alert',
	severity: 'HIGH',
	status: 'NEW',
	realTime: {
		scope: {
			account: { id: 'a', name: 'Account' },
			site: { id: 'site', name: 'Site' },
			group: null,
		},
	},
});
const feed = (events = [['activity', NOW - 500, 'Exact SDL note text']]) => ({
	id: 'q',
	stepsCompleted: 1,
	stepsTotal: 1,
	data: {
		columns: [
			'activity_id',
			'created_at',
			'data.alert.id',
			'timestampNs',
			'noteText',
			'authorId',
			'authorName',
		].map((name) => ({ name })),
		values: events.map(([id, time, text]) => [
			id,
			new Date(time).toISOString(),
			'old-alert',
			ns(time),
			text,
			null,
			null,
		]),
	},
});
const page = (rows) => ({
	data: { alerts: { edges: rows.map((node) => ({ node })), pageInfo: { hasNextPage: false } } },
});
const logFeed = (table) => ({
	...table,
	data: {
		matches: table.data.values.map(
			([id, createdAt, alertId, timestamp, text, authorId, authorName]) => ({
				cursor: 'source-cursor',
				serverInfo: { parser: 'activityLog' },
				timestamp,
				values: {
					activity_id: id,
					created_at: createdAt,
					'data.alert.id': alertId,
					'data.payload.note_text': text,
					'data.user.id': authorId,
					'data.user.enriched_name': authorName,
					activity_type: '16007',
					'dataSource.name': 'ActivityFeed',
					'extra.nested': { tags: ['keep', 'everything'] },
				},
			}),
		),
	},
});
const request =
	(options = {}) =>
	async (r) => {
		if (r.url.includes('/sdl/')) {
			const source = options.feed ?? feed();
			const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
			assert.equal(body?.queryType, 'LOG');
			return logFeed(source);
		}
		assert.ok(r.body.query.includes('ActivityAlerts'));
		assert.ok(!r.body.query.includes('alertTimeline'));
		assert.ok(!r.body.query.includes('alertNotes('));
		return page(options.alerts ?? [alert()]);
	};

test('direct SDL baseline only reads the feed and seeds activity identities', async () => {
	const c = cfg();
	let calls = 0;
	const result = await pollAlertActivities(
		async (r) => {
			calls++;
			assert.ok(r.url.includes('/sdl/'));
			return logFeed(feed());
		},
		c,
		{},
		'scheduled',
		NOW,
	);
	assert.equal(calls, 1);
	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.activityActivationMs, NOW);
	assert.deepEqual(result.nextState.seenActivityIds, ['activity']);
	assert.equal(result.nextState.pendingNoteBalances, undefined);
	assert.equal(result.nextState.seenNoteIds, undefined);
});

test('direct SDL emits exact text with activity ID and never fabricates note identity or author', async () => {
	const c = cfg({ excludeActorName: '.*' });
	const result = await pollAlertActivities(request(), c, state(c), 'scheduled', NOW);
	const item = result.items[0];
	assert.equal(item.note.text, 'Exact SDL note text');
	assert.equal(item.activityId, 'activity');
	assert.equal(item.noteId, undefined);
	assert.equal(item.actor.name, null);
	assert.equal(item.actor.id, null);
	assert.equal(item.updatedAt, undefined);
});

test('distinct activity IDs at the same millisecond emit separately then never duplicate', async () => {
	const c = cfg();
	const source = request({
		feed: feed([
			['A', NOW - 500, 'first'],
			['B', NOW - 500, 'second'],
		]),
	});
	const first = await pollAlertActivities(source, c, state(c), 'scheduled', NOW);
	assert.deepEqual(
		first.items.map((x) => x.activityId),
		['A', 'B'],
	);
	const second = await pollAlertActivities(source, c, first.nextState, 'scheduled', NOW + 1000);
	assert.deepEqual(second.items, []);
});

test('preactivation activity is not emitted while late postactivation activity is', async () => {
	const c = cfg();
	const result = await pollAlertActivities(
		request({
			feed: feed([
				['before', NOW - 200000, 'old'],
				['late', NOW - 10000, 'late'],
			]),
		}),
		c,
		state(c),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((x) => x.activityId),
		['late'],
	);
});

test('scope, severity and account-name exclusions apply before SDL output', async () => {
	for (const c of [
		cfg({ severities: ['LOW'] }),
		cfg({ statuses: ['CLOSED'] }),
		cfg({ excludeAccountName: 'Account' }),
		cfg({ scopeType: 'SITE', scopeIds: ['other'], activityAccountIds: ['a'] }),
	]) {
		const result = await pollAlertActivities(request(), c, state(c), 'scheduled', NOW);
		assert.deepEqual(result.items, []);
		assert.deepEqual(result.nextState.seenActivityIds, ['activity']);
	}
});

test('unindexed alert scope fails without advancing or mutating state', async () => {
	const c = cfg(),
		previous = state(c),
		before = structuredClone(previous);
	await assert.rejects(
		() => pollAlertActivities(request({ alerts: [] }), c, previous, 'scheduled', NOW),
		/resolve current alert scope/,
	);
	assert.deepEqual(previous, before);
});

test('GraphQL metadata failures never return a successful checkpoint', async () => {
	const c = cfg(),
		previous = state(c);
	await assert.rejects(() =>
		pollAlertActivities(
			async (r) =>
				r.url.includes('/sdl/') ? logFeed(feed()) : Promise.reject(new Error('unavailable')),
			c,
			previous,
			'scheduled',
			NOW,
		),
	);
	assert.equal(previous.checkpointMs, NOW - 1000);
});

test('manual preview returns newest ten direct events and ignores corrupt scheduled state', async () => {
	const c = cfg({ includeRawActivity: true });
	const events = Array.from({ length: 12 }, (_, i) => [
		String(i),
		NOW - 12000 + i * 1000,
		'text-' + i,
	]);
	const result = await pollAlertActivities(
		request({ feed: feed(events) }),
		c,
		state(c, { seenActivityTimestamps: 'invalid' }),
		'manual',
		NOW,
	);
	assert.equal(result.items.length, 10);
	assert.equal(result.items[0].activityId, '11');
	assert.equal(result.items[0].note.id, undefined);
	assert.equal(result.items[0].note.text, 'text-11');
	assert.equal(result.nextState, undefined);
});

test('manual preview stops searching older windows after its first matching note', async () => {
	let queries = 0;
	const result = await pollAlertActivities(
		async (r) => {
			if (!r.url.includes('/sdl/')) return page([alert()]);
			queries++;
			assert.equal(queries, 1, 'must not search another window after finding a note');
			return logFeed(feed());
		},
		cfg(),
		{},
		'manual',
		NOW,
	);
	assert.equal(queries, 1);
	assert.equal(result.items.length, 1);
	assert.equal(result.nextState, undefined);
});

test('activity retention drops only timestamps older than next overlap', async () => {
	const c = cfg(),
		previous = state(c, {
			seenActivityTimestamps: { old: ns(NOW - 301000), keep: ns(NOW - 299000) },
		});
	const result = await pollAlertActivities(
		request({ feed: feed([]) }),
		c,
		previous,
		'scheduled',
		NOW,
	);
	assert.deepEqual(result.nextState.seenActivityIds, ['keep']);
	assert.equal(previous.seenActivityTimestamps.old, ns(NOW - 301000));
});

test('activity state capacity fails instead of evicting identities inside overlap', async () => {
	const c = cfg(),
		previous = state(c, {
			seenActivityTimestamps: Object.fromEntries(
				Array.from({ length: 40000 }, (_, i) => ['id-' + i, ns(NOW - 1000)]),
			),
		});
	await assert.rejects(
		() => pollAlertActivities(request(), c, previous, 'scheduled', NOW),
		/capacity inside the overlap/,
	);
	assert.equal(Object.keys(previous.seenActivityTimestamps).length, 40000);
});

test('metadata scope queries stay within 500 account IDs', async () => {
	const c = cfg({ scopeIds: ['a', ...Array.from({ length: 500 }, (_, i) => 'a-' + i)] });
	const lengths = [];
	const result = await pollAlertActivities(
		async (r) => {
			if (r.url.includes('/sdl/')) return logFeed(feed());
			lengths.push(r.body.variables.scope.scopeIds.length);
			return page(r.body.variables.scope.scopeIds.includes('a') ? [alert()] : []);
		},
		c,
		state(c),
		'scheduled',
		NOW,
	);
	assert.equal(result.items.length, 1);
	assert.deepEqual(lengths, [500, 1]);
});

test('a later revision of an already seen activity does not emit again', async () => {
	const c = cfg();
	const result = await pollAlertActivities(
		request(),
		c,
		state(c, { seenActivityTimestamps: { activity: ns(NOW - 501) } }),
		'scheduled',
		NOW,
	);
	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.seenActivityTimestamps.activity, ns(NOW - 500));
});

test('manual SDL preview finds old notes and keeps scope nested', async () => {
	const result = await pollAlertActivities(
		request({ feed: feed([['old', NOW - 90 * 86400000, 'older note']]) }),
		cfg({ alertLookbackMinutes: 0 }),
		{},
		'manual',
		NOW,
	);
	assert.equal(result.items[0].activityId, 'old');
	assert.deepEqual(result.items[0].scope.account, { id: 'a', name: 'Account' });
	assert.equal('accountId' in result.items[0], false);
	assert.equal('scopeId' in result.items[0], false);
	assert.equal(result.nextState, undefined);
});

test('manual SDL preview visits newest split first and returns up to ten eligible notes', async () => {
	const windows = [];
	const result = await pollAlertActivities(
		async (r) => {
			if (!r.url.includes('/sdl/')) return page([alert()]);
			const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
			windows.push([Date.parse(body.startTime), Date.parse(body.endTime)]);
			return logFeed(
				feed(
					Array.from({ length: windows.length === 1 ? 1000 : 10 }, (_, i) => [
						'id' + i,
						NOW - 1000 + i,
						'note',
					]),
				),
			);
		},
		cfg(),
		{},
		'manual',
		NOW,
	);
	assert.deepEqual(windows, [
		[NOW - 86400000, NOW],
		[NOW - 43200000, NOW],
	]);
	assert.equal(result.items.length, 10);
	assert.equal(result.items[0].activityId, 'id9');
});

test('manual preview continues into older windows after newer notes fail filters', async () => {
	let queries = 0;
	const result = await pollAlertActivities(
		async (r) => {
			if (r.url.includes('/sdl/')) {
				queries++;
				if (queries === 1)
					return logFeed(
						feed(Array.from({ length: 1000 }, (_, i) => ['n' + i, NOW - 1000 + i, 'new'])),
					);
				return logFeed(
					feed([
						[
							queries === 2 ? 'excluded' : 'included',
							queries === 2 ? NOW - 500 : NOW - 86400000 + 1000,
							'text',
						],
					]),
				);
			}
			return page([{ ...alert(), severity: queries === 2 ? 'LOW' : 'HIGH' }]);
		},
		cfg({ severities: ['HIGH'] }),
		{},
		'manual',
		NOW,
	);
	assert.equal(queries, 3);
	assert.deepEqual(
		result.items.map((x) => x.activityId),
		['included'],
	);
});

test('actor fields stay identical with optional raw output', async () => {
	const source = feed();
	source.data.values[0][5] = '90071992547409930003';
	source.data.values[0][6] = 'Example Actor';
	for (const includeRawActivity of [true, false]) {
		const c = cfg({ includeRawActivity });
		const { items } = await pollAlertActivities(
			request({ feed: source }),
			c,
			state(c),
			'scheduled',
			NOW,
		);
		assert.deepEqual(items[0].actor, { id: '90071992547409930003', name: 'Example Actor' });
	}
});

test('SDL author exclusions apply in scheduled and manual polls while missing names remain included', async () => {
	const source = feed([
		['robot', NOW - 700, 'automation note'],
		['human', NOW - 600, 'person note'],
		['unknown', NOW - 500, 'missing author'],
	]);
	source.data.values[0][5] = '90071992547409930003';
	source.data.values[0][6] = 'ai-soc-tool';
	source.data.values[1][5] = '90071992547409930002';
	source.data.values[1][6] = 'Example Analyst';
	const c = cfg({ excludeActorName: '^AI-SOC-TOOL$' });
	for (const mode of ['scheduled', 'manual']) {
		const result = await pollAlertActivities(request({ feed: source }), c, state(c), mode, NOW);
		assert.deepEqual(
			result.items.map((x) => x.activityId),
			mode === 'scheduled' ? ['human', 'unknown'] : ['unknown', 'human'],
		);
		if (mode === 'scheduled') assert.ok(result.nextState.seenActivityIds.includes('robot'));
	}
});

test('Raw enrichment preserves the entire SDL activity record alongside the envelope', async () => {
	const c = cfg({ includeRawActivity: true });
	for (const mode of ['manual', 'scheduled']) {
		const result = await pollAlertActivities(request(), c, state(c), mode, NOW);
		assert.deepEqual(result.items[0].rawActivity, logFeed(feed()).data.matches[0]);
		assert.deepEqual(result.items[0].rawActivity.values['extra.nested'], {
			tags: ['keep', 'everything'],
		});
		assert.equal(result.items[0].scope.account.id, 'a');
	}
});

test('missing selected current site or group fails without advancing', async () => {
	for (const scopeType of ['SITE', 'GROUP']) {
		const c = cfg({ scopeType, scopeIds: ['selected'], activityAccountIds: ['a'] });
		const parent = alert();
		parent.realTime.scope[scopeType.toLowerCase()] = null;
		const previous = state(c);
		const before = structuredClone(previous);
		await assert.rejects(
			() => pollAlertActivities(request({ alerts: [parent] }), c, previous, 'scheduled', NOW),
			/resolve current alert scope/,
		);
		assert.deepEqual(previous, before);
	}
});
test('exact actor IDs exclude independently of mutable names', async () => {
	const source = feed();
	source.data.values[0][5] = '90071992547409930003';
	const c = cfg({ excludeActorIds: ['90071992547409930003'] });
	const result = await pollAlertActivities(
		request({ feed: source }),
		c,
		state(c),
		'scheduled',
		NOW,
	);
	assert.deepEqual(result.items, []);
	assert.deepEqual(result.nextState.seenActivityIds, ['activity']);
});
test('historical transition matches before optional current alert enrichment', async () => {
	const c = cfg({
		activityConditions: [{ field: 'status', to: ['RESOLVED'] }],
		includeCurrentAlert: true,
	});
	const source = logFeed(feed());
	source.data.matches[0].values.activity_type = '16001';
	source.data.matches[0].values['data.payload.changes.old_status'] = 'NEW';
	source.data.matches[0].values['data.payload.changes.new_status'] = 'RESOLVED';
	const read = async (r) =>
		r.url.includes('/sdl/') ? source : page([{ ...alert(), status: 'IN_PROGRESS' }]);
	const result = await pollAlertActivities(read, c, state(c), 'scheduled', NOW);
	assert.equal(result.items[0].currentAlert.status, 'IN_PROGRESS');
	assert.deepEqual(result.items[0].changes, [
		{ field: 'status', oldValue: 'NEW', newValue: 'RESOLVED' },
	]);
	assert.equal(result.items[0].scope.source, 'current');
	assert.equal(result.items[0].eventType, 'alert.activity');
});
test('activity configuration changes establish a new scheduled baseline', async () => {
	const c = cfg();
	const previous = state(c);
	const next = cfg({ activityConditions: [{ field: 'status' }] });
	const result = await pollAlertActivities(request(), next, previous, 'scheduled', NOW);
	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.activityActivationMs, NOW);
	assert.notEqual(result.nextState.configFingerprint, previous.configFingerprint);
});

test('name-filter lookup with unresolved selected scope fails without advance', async () => {
	const c = cfg({
		scopeType: 'SITE',
		scopeIds: ['site'],
		activityAccountIds: ['a'],
		alertName: 'Old',
	});
	let lookups = 0;
	const read = async (r) => {
		if (r.url.includes('/sdl/')) return logFeed(feed());
		const parent = alert();
		if (++lookups === 2) parent.realTime.scope.site = null;
		return page([parent]);
	};
	const previous = state(c),
		before = structuredClone(previous);
	await assert.rejects(
		() => pollAlertActivities(read, c, previous, 'scheduled', NOW),
		/resolve current alert scope/,
	);
	assert.deepEqual(previous, before);
});
