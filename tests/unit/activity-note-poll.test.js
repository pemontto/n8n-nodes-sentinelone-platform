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
	assert.ok(Object.keys(item).indexOf('note') < Object.keys(item).indexOf('scope'));
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
	assert.equal(result.items[0].currentAlertStatus, 'IN_PROGRESS');
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

test('unavailable parents retry through the overlap boundary, then drop and warn without identifiers', async () => {
	const warnings = [];
	const c = cfg({ warnLog: (message, details) => warnings.push({ message, details }) });
	const timestamp = NOW - 300000;
	const previous = state(c, { activityActivationMs: NOW - 600000 });
	const read = request({
		feed: feed([['private-activity', timestamp, 'private-note']]),
		alerts: [],
	});
	const before = structuredClone(previous);
	await assert.rejects(
		() => pollAlertActivities(read, c, previous, 'scheduled', NOW),
		/recent activity/,
	);
	assert.deepEqual(previous, before);
	assert.deepEqual(warnings, []);
	const result = await pollAlertActivities(read, c, previous, 'scheduled', NOW + 1);
	assert.deepEqual(result.items, []);
	assert.equal(result.nextState.checkpointMs, NOW + 1);
	assert.deepEqual(warnings[0].details, { droppedActivityCount: 1 });
	assert.doesNotMatch(JSON.stringify(warnings), /private-activity|private-note|old-alert/);
});
test('expired unavailable parents do not block eligible activities and throwing loggers do not pin state', async () => {
	const c = cfg({
		warnLog: () => {
			throw new Error('logger unavailable');
		},
	});
	const source = logFeed(
		feed([
			['expired', NOW - 301000, 'drop'],
			['eligible', NOW - 500, 'keep'],
		]),
	);
	source.data.matches[0].values['data.alert.id'] = 'unavailable';
	const result = await pollAlertActivities(
		async (r) => (r.url.includes('/sdl/') ? source : page([alert()])),
		c,
		state(c, { activityActivationMs: NOW - 600000 }),
		'scheduled',
		NOW,
	);
	assert.deepEqual(
		result.items.map((item) => item.activityId),
		['eligible'],
	);
	assert.equal(result.nextState.checkpointMs, NOW);
});
test('one recent unavailable parent prevents advance and expiry warnings for the whole poll', async () => {
	const warnings = [];
	const c = cfg({ warnLog: (...args) => warnings.push(args) });
	await assert.rejects(
		() =>
			pollAlertActivities(
				request({
					feed: feed([
						['old', NOW - 301000, 'old'],
						['recent', NOW - 500, 'recent'],
					]),
					alerts: [],
				}),
				c,
				state(c, { activityActivationMs: NOW - 600000 }),
				'scheduled',
				NOW,
			),
		/recent activity/,
	);
	assert.deepEqual(warnings, []);
});
test('old activities still fail on malformed current scope and authentication or incomplete lookup', async () => {
	const c = cfg({ scopeType: 'SITE', scopeIds: ['site'], activityAccountIds: ['a'] });
	const old = logFeed(feed([['old', NOW - 301000, 'old']]));
	const malformed = alert();
	malformed.realTime.scope.site = null;
	for (const lookup of [
		() => page([malformed]),
		() => Promise.reject({ statusCode: 403, message: 'secret' }),
		() => ({ data: { alerts: { edges: [] } } }),
	]) {
		const previous = state(c, { activityActivationMs: NOW - 600000 }),
			before = structuredClone(previous);
		await assert.rejects(() =>
			pollAlertActivities(
				async (r) => (r.url.includes('/sdl/') ? old : lookup()),
				c,
				previous,
				'scheduled',
				NOW,
			),
		);
		assert.deepEqual(previous, before);
	}
});
test('manual preview skips expired unavailable parents and finds the first eligible older window', async () => {
	const warnings = [];
	const c = cfg({ warnLog: (message, details) => warnings.push({ message, details }) });
	let queries = 0;
	const result = await pollAlertActivities(
		async (r) => {
			if (r.url.includes('/sdl/')) {
				const source = logFeed(
					feed([
						[++queries === 1 ? 'missing' : 'eligible', NOW - queries * 86400000 + 1000, 'note'],
					]),
				);
				if (queries === 1) source.data.matches[0].values['data.alert.id'] = 'unavailable';
				return source;
			}
			return page(queries === 1 ? [] : [alert()]);
		},
		c,
		{},
		'manual',
		NOW,
	);
	assert.equal(queries, 2);
	assert.deepEqual(
		result.items.map((item) => item.activityId),
		['eligible'],
	);
	assert.equal(result.nextState, undefined);
	assert.deepEqual(warnings[0].details, { droppedActivityCount: 1 });
});
test('sparse outage catch-up reaches the advancing wall clock at supported polling cadences', async () => {
	for (const cadence of [300000, 600000, 3600000, 86400000, 604800000]) {
		const c = cfg();
		let wallClock = NOW;
		let previous = state(c, {
			checkpointMs: NOW - 2 * cadence,
			activityActivationMs: NOW - 3 * cadence,
		});
		for (let invocation = 0; invocation < 3; invocation++) {
			let queries = 0;
			const result = await pollAlertActivities(
				async (r) => {
					assert.ok(r.url.includes('/sdl/'));
					queries++;
					return logFeed(feed([]));
				},
				c,
				previous,
				'scheduled',
				wallClock,
			);
			assert.equal(
				result.nextState.checkpointMs,
				wallClock,
				`cadence ${cadence} invocation ${invocation}`,
			);
			assert.ok(queries <= 16, 'sparse ranges grow instead of using fixed five-minute windows');
			previous = result.nextState;
			wallClock += cadence;
		}
	}
});
test('exhausted shared query budget commits only the completed chronological prefix', async () => {
	const c = cfg();
	const checkpoint = NOW - 3600000;
	const windows = [];
	const previous = state(c, { checkpointMs: checkpoint, activityActivationMs: checkpoint - 1000 });
	const read = async (r) => {
		if (!r.url.includes('/sdl/')) return page([alert()]);
		const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
		const start = Date.parse(body.startTime),
			end = Date.parse(body.endTime);
		windows.push([start, end]);
		return logFeed(feed([['prefix-' + windows.length, end - 1, 'eligible']]));
	};
	const result = await pollAlertActivities(read, c, previous, 'scheduled', NOW, { maxQueries: 2 });
	assert.equal(windows.length, 2, 'all slices share one query budget');
	assert.equal(windows[1][0], windows[0][1]);
	assert.equal(result.nextState.checkpointMs, windows[1][1]);
	assert.ok(result.nextState.checkpointMs > checkpoint && result.nextState.checkpointMs < NOW);
	assert.equal(result.items.at(-1).activityId, 'prefix-2');
	assert.equal(result.nextState.seenActivityTimestamps['prefix-2'], ns(windows[1][1] - 1));
});
test('an incomplete first slice fails without advancing the saved checkpoint', async () => {
	const c = cfg();
	const previous = state(c, { checkpointMs: NOW - 3600000, activityActivationMs: NOW - 7200000 });
	const before = structuredClone(previous);
	await assert.rejects(
		() =>
			pollAlertActivities(
				async (r) => {
					const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
					const start = Date.parse(body.startTime);
					return logFeed(
						feed(Array.from({ length: 1000 }, (_, i) => ['saturated-' + i, start + i, 'note'])),
					);
				},
				c,
				previous,
				'scheduled',
				NOW,
				{ maxQueries: 1 },
			),
		/budget|complete|progress/,
	);
	assert.deepEqual(previous, before);
});
test('backlog prefix drops expired missing activity using wall clock age and retains slice overlap identities', async () => {
	const checkpoint = NOW - 3600000;
	const eventTime = checkpoint + 1000;
	const warnings = [];
	const c = cfg({ warnLog: (message, details) => warnings.push({ message, details }) });
	const result = await pollAlertActivities(
		request({ feed: feed([['missing', eventTime, 'expired']]), alerts: [] }),
		c,
		state(c, { checkpointMs: checkpoint, activityActivationMs: checkpoint - 1000 }),
		'scheduled',
		NOW,
		{ maxQueries: 1 },
	);
	assert.equal(result.nextState.checkpointMs, checkpoint + 300000);
	assert.equal(result.nextState.seenActivityTimestamps.missing, ns(eventTime));
	assert.equal(warnings.length, 1);
});
test('failed backlog slice keeps checkpoint and activation or changed config still baselines at now', async () => {
	const c = cfg();
	const previous = state(c, { checkpointMs: NOW - 3600000, activityActivationMs: NOW - 7200000 });
	const before = structuredClone(previous);
	await assert.rejects(() =>
		pollAlertActivities(
			async () => {
				throw new Error('unavailable');
			},
			c,
			previous,
			'scheduled',
			NOW,
		),
	);
	assert.deepEqual(previous, before);
	const changed = cfg({ activityTypeIds: ['16007'] });
	const baseline = await pollAlertActivities(request(), changed, previous, 'scheduled', NOW);
	assert.equal(baseline.nextState.checkpointMs, NOW);
	assert.equal(baseline.nextState.activityActivationMs, NOW);
	assert.deepEqual(baseline.items, []);
});

test('repeated budgeted prefixes shrink an outage backlog while wall time advances and do not redeliver overlap', async () => {
	const c = cfg();
	const initial = NOW - 3600000;
	let wallClock = NOW;
	let previous = state(c, { checkpointMs: initial, activityActivationMs: initial - 1000 });
	const activityTime = initial + 300000 - 1;
	let deliveries = 0;
	for (let invocation = 0; invocation < 12; invocation++) {
		const beforeLag = wallClock - previous.checkpointMs;
		const result = await pollAlertActivities(
			async (r) => {
				if (!r.url.includes('/sdl/')) return page([alert()]);
				const body = typeof r.body === 'string' ? JSON.parse(r.body) : r.body;
				const start = Date.parse(body.startTime),
					end = Date.parse(body.endTime);
				return logFeed(
					feed(
						activityTime >= start && activityTime < end ? [['once', activityTime, 'overlap']] : [],
					),
				);
			},
			c,
			previous,
			'scheduled',
			wallClock,
			{ maxQueries: 2 },
		);
		deliveries += result.items.length;
		assert.ok(wallClock - result.nextState.checkpointMs < beforeLag);
		previous = result.nextState;
		if (previous.checkpointMs === wallClock) break;
		wallClock += 600000;
	}
	assert.equal(previous.checkpointMs, wallClock);
	assert.equal(deliveries, 1);
});

test('activity output leads with alert identity and includes current context without extra lookups', async () => {
	for (const includeRawActivity of [false, true]) {
		const c = cfg({ includeRawActivity });
		let lookups = 0;
		const parent = {
			...alert(),
			externalId: '90071992547409930003',
			analystVerdict: 'FALSE_POSITIVE_BENIGN',
		};
		const read = async (r) => {
			if (r.url.includes('/sdl/')) return logFeed(feed());
			lookups++;
			assert.match(r.body.query, /\bexternalId\b/);
			assert.match(r.body.query, /\banalystVerdict\b/);
			return page([parent]);
		};
		const result = await pollAlertActivities(read, c, state(c), 'scheduled', NOW);
		const item = result.items[0];
		assert.deepEqual(Object.keys(item).slice(0, 3), ['alertId', 'alertName', 'alertExternalId']);
		assert.equal(item.alertId, 'old-alert');
		assert.equal(item.alertName, 'Old alert');
		assert.equal(item.alertExternalId, '90071992547409930003');
		assert.equal(item.currentAlertStatus, 'NEW');
		assert.equal(item.currentAlertSeverity, 'HIGH');
		assert.equal(item.currentAlertAnalystVerdict, 'FALSE_POSITIVE_BENIGN');
		assert.equal(item.currentAlert, undefined);
		assert.equal(lookups, 1);
	}
});

test('missing current alert context stays null and never borrows historical activity values', async () => {
	const c = cfg({ activityConditions: [{ field: 'status', to: ['RESOLVED'] }] });
	const source = logFeed(feed());
	Object.assign(source.data.matches[0].values, {
		activity_type: '16001',
		'data.payload.changes.old_status': 'NEW',
		'data.payload.changes.new_status': 'RESOLVED',
	});
	const parent = alert();
	for (const key of ['name', 'status', 'severity', 'externalId', 'analystVerdict'])
		delete parent[key];
	const result = await pollAlertActivities(
		async (r) => (r.url.includes('/sdl/') ? source : page([parent])),
		c,
		state(c),
		'scheduled',
		NOW,
	);
	const item = result.items[0];
	for (const key of [
		'alertName',
		'alertExternalId',
		'currentAlertStatus',
		'currentAlertSeverity',
		'currentAlertAnalystVerdict',
	])
		assert.equal(item[key], null);
	assert.equal(item.alertId, 'old-alert');
	assert.deepEqual(item.changes, [{ field: 'status', oldValue: 'NEW', newValue: 'RESOLVED' }]);
});
