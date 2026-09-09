import type { IDataObject, INodePropertyOptions } from 'n8n-workflow';

export type AlertProjection = 'list' | 'detail';
interface AlertField {
	name: string;
	list?: string;
	detail?: string;
	standard: boolean;
	core: boolean;
}

// List and detail types share meaning but can expose different nested fields.
const fields: Record<string, AlertField> = {
	id: { name: 'ID', list: 'id', detail: 'id', standard: true, core: true },
	externalId: {
		name: 'External ID',
		list: 'externalId',
		detail: 'externalId',
		standard: true,
		core: true,
	},
	name: { name: 'Name', list: 'name', detail: 'name', standard: true, core: true },
	severity: { name: 'Severity', list: 'severity', detail: 'severity', standard: true, core: true },
	status: { name: 'Status', list: 'status', detail: 'status', standard: true, core: true },
	createdAt: {
		name: 'Created At',
		list: 'createdAt',
		detail: 'createdAt',
		standard: true,
		core: true,
	},
	updatedAt: {
		name: 'Updated At',
		list: 'updatedAt',
		detail: 'updatedAt',
		standard: true,
		core: true,
	},
	detectedAt: {
		name: 'Detected At',
		list: 'detectedAt',
		detail: 'detectedAt',
		standard: true,
		core: true,
	},
	firstSeenAt: {
		name: 'First Seen At',
		list: 'firstSeenAt',
		detail: 'firstSeenAt',
		standard: true,
		core: true,
	},
	lastSeenAt: {
		name: 'Last Seen At',
		list: 'lastSeenAt',
		detail: 'lastSeenAt',
		standard: true,
		core: true,
	},
	noteExists: {
		name: 'Note Exists',
		list: 'noteExists',
		detail: 'noteExists',
		standard: true,
		core: true,
	},
	realTime: {
		name: 'Real-Time Scope',
		list: 'realTime { scope { account { id name } group { id name } site { id name } } }',
		detail: 'realTime { scope { account { id name } group { id name } site { id name } } }',
		standard: true,
		core: true,
	},
	ticketId: {
		name: 'Ticket ID',
		list: 'ticketId',
		detail: 'ticketId',
		standard: true,
		core: false,
	},
	result: { name: 'Result', list: 'result', detail: 'result', standard: true, core: false },
	storylineId: {
		name: 'Storyline ID',
		list: 'storylineId',
		detail: 'storylineId',
		standard: true,
		core: false,
	},
	dataSources: {
		name: 'Data Sources',
		list: 'dataSources',
		detail: 'dataSources',
		standard: true,
		core: false,
	},
	confidenceLevel: {
		name: 'Confidence Level',
		list: 'confidenceLevel',
		detail: 'confidenceLevel',
		standard: true,
		core: false,
	},
	classification: {
		name: 'Classification',
		list: 'classification',
		detail: 'classification',
		standard: true,
		core: false,
	},
	description: {
		name: 'Description',
		list: 'description',
		detail: 'description',
		standard: true,
		core: false,
	},
	detectionSource: {
		name: 'Detection Source',
		list: 'detectionSource { product vendor }',
		detail: 'detectionSource { product vendor }',
		standard: true,
		core: false,
	},
	analystVerdict: {
		name: 'Analyst Verdict',
		list: 'analystVerdict',
		detail: 'analystVerdict',
		standard: true,
		core: false,
	},
	analytics: {
		name: 'Analytics',
		list: 'analytics { category name typeValue uid }',
		detail: 'analytics { category name typeValue uid }',
		standard: true,
		core: false,
	},
	assignee: {
		name: 'Assignee',
		list: 'assignee { userId fullName email }',
		detail: 'assignee { email fullName userId }',
		standard: true,
		core: false,
	},
	attackPathExists: {
		name: 'Attack Path Exists',
		list: 'attackPathExists',
		detail: 'attackPathExists',
		standard: true,
		core: false,
	},
	attackSurfaces: {
		name: 'Attack Surfaces',
		list: 'attackSurfaces',
		detail: 'attackSurfaces',
		standard: true,
		core: false,
	},
	availableActionIds: {
		name: 'Available Action IDs',
		list: 'availableActionIds',
		standard: true,
		core: false,
	},
	assets: {
		name: 'Assets',
		list: 'assets { accessible agentOperatingMode agentUuid agentVersion assetTypeClassifier category connectivityToConsole decommissioned deleted id lastLoggedInUser name origin osType osVersion paths pendingReboot policy primary role status subcategory tags { key keyValue type value } }',
		detail:
			'assets { accessible agentOperatingMode agentUuid agentVersion assetTypeClassifier category connectivityToConsole decommissioned deleted id lastLoggedInUser name origin osType osVersion paths pendingReboot policy primary role status subcategory tags { key keyValue type value } }',
		standard: true,
		core: false,
	},
	detectionTime: {
		name: 'Detection Time',
		list: 'detectionTime { asset { agentVersion consoleIpAddress domain ipV4 ipV4Addresses ipV6 ipV6Addresses lastLoggedInUser osName osRevision osType policy subscriptionTime } assets { accessible deleted origin paths primary } attacker { host ip } cloud { accountId cloudProvider image instanceId instanceSize location network tags } kubernetes { clusterName containerId containerImageName containerLabels containerName controllerLabels controllerName controllerType namespaceLabels namespaceName nodeLabels nodeName podLabels podName } scope { accountId accountName groupId groupName siteId siteName } targetUser { displayName domain emailAddress name } }',
		detail:
			'detectionTime { asset { agentVersion consoleIpAddress domain ipV4 ipV4Addresses ipV6 ipV6Addresses lastLoggedInUser osName osRevision osType policy subscriptionTime } assets { accessible asset { agentVersion consoleIpAddress domain ipV4 ipV4Addresses ipV6 ipV6Addresses lastLoggedInUser osName osRevision osType policy subscriptionTime } cloud { accountId cloudProvider image instanceId instanceSize location network tags } deleted kubernetes { clusterName containerId containerImageName containerLabels containerName controllerLabels controllerName controllerType namespaceLabels namespaceName nodeLabels nodeName podLabels podName } origin paths primary scope { accountId accountName groupId groupName siteId siteName } } attacker { host ip } cloud { accountId cloudProvider image instanceId instanceSize location network providerDetails { __typename ... on DetectionAws { accountId imageId instanceId instanceType region role securityGroups subnetIds tags vpcId } ... on DetectionAzure { imageId instanceId instanceType region resourceGroup subscriptionId tags } ... on DetectionGcp { imageId instanceId instanceType projectId serviceAccount tags vpcId zone } } tags } kubernetes { clusterName containerId containerImageName containerLabels containerName controllerLabels controllerName controllerType namespaceLabels namespaceName nodeLabels nodeName podLabels podName } scope { accountId accountName groupId groupName siteId siteName } targetUser { displayName domain emailAddress name } }',
		standard: true,
		core: false,
	},
	mitigationDetails: {
		name: 'Mitigation Details',
		list: 'mitigationDetails { reports { mitigationActionType successCount } }',
		standard: true,
		core: false,
	},
	primaryIndicatorType: {
		name: 'Primary Indicator Type',
		list: 'primaryIndicatorType',
		detail: 'primaryIndicatorType',
		standard: true,
		core: false,
	},
	process: {
		name: 'Process',
		list: 'process { cmdLine file { certSubject md5 name path sha1 sha256 } parentName }',
		detail:
			'process { cmdLine file { certExpiresAt certSerialNumber certSubject md5 name path sha1 sha256 signatureVerification size } parentName userDisplayName userDomain username }',
		standard: true,
		core: false,
	},
	selfLink: { name: 'Self Link', detail: 'selfLink', standard: true, core: false },
	aiInvestigation: {
		name: 'AI Investigation',
		list: 'aiInvestigation { autoTriggered purpleAiStatus status timestamp verdict }',
		detail: 'aiInvestigation { autoTriggered status timestamp verdict }',
		standard: false,
		core: false,
	},
	attackPaths: {
		name: 'Attack Paths',
		list: 'attackPaths { id name }',
		detail: 'attackPaths { id name }',
		standard: false,
		core: false,
	},
	counters: { name: 'Counters', detail: 'counters { key value }', standard: false, core: false },
	enrichments: {
		name: 'Enrichments',
		detail:
			'enrichments { __typename ... on FormattedEnrichment { isSimulation name path paths provider retrievedAt sourceUrl value { content type } } ... on GeoLocationEnrichment { city coordinates { latitude longitude } country name path paths postalCode provider region } ... on IntEnrichment { intValue name path paths provider } ... on LocationEnrichment { latitude longitude name path paths provider } ... on ReputationEnrichment { name path paths provider scoreType scoreValue } ... on StringEnrichment { name path paths provider stringValue } ... on TimestampEnrichment { name path paths provider timestampValue } }',
		standard: false,
		core: false,
	},
	exclusionHashes: {
		name: 'Exclusion Hashes',
		list: 'exclusionHashes { sha1 sha256 }',
		detail: 'exclusionHashes { sha1 sha256 }',
		standard: false,
		core: false,
	},
	incident: {
		name: 'Incident',
		list: 'incident { id name }',
		detail: 'incident { id name }',
		standard: false,
		core: false,
	},
	indicators: {
		name: 'Indicators',
		detail:
			'indicators { attacks { tactic { name sourceUrl uid } technique { name sourceUrl uid } version } description eventSearchParams { accountId endTime filter startTime type view { filter type } } eventTime message observables { name type typeName value } primary severity title type uid }',
		standard: false,
		core: false,
	},
	labels: { name: 'Labels', list: 'labels', detail: 'labels', standard: false, core: false },
	observables: {
		name: 'Observables',
		detail: 'observables { name type typeName value }',
		standard: false,
		core: false,
	},
	ocsf: {
		name: 'OCSF',
		detail:
			'ocsf { action actionId cloud { account { labels name type typeId uid } cloudPartition name org { name ouName ouUid uid } projectUid provider region uid uidAlt zone } endTimeDt evidences { actor { appName appUid invokedBy } answers { class flagIds flags packetUid rdata ttl type } api { operation version } connectionInfo { boundary boundaryId communityUid direction directionId flagHistory protocolName protocolNum protocolVer protocolVerId tcpFlags uid } container { name networkDriver orchestrator podUuid runtime size tag uid } database { createdTimeDt desc modifiedTimeDt name size type typeId uid } databucket { cloudPartition createdTimeDt criticality desc hostname ip isBackedUp isEncrypted isPublic labels modifiedTimeDt name namespace region size type typeId uid uidAlt version zone } device { autoscaleUid bootTimeDt bootUid createdTimeDt desc domain eid firstSeenTimeDt hostname hypervisor iccid imei imeiList interfaceName interfaceUid ip isBackedUp isCompliant isManaged isMobileAccountActive isPersonal isShared isSupervised isTrusted lastSeenTimeDt mac meid model modifiedTimeDt name namespacePid osMachineUuid region riskLevel riskLevelId riskScore subnet subnetUid type typeId udid uid uidAlt vendorName vlanUid vpcUid zone } dstEndpoint { domain hostname instanceUid interfaceName interfaceUid intermediateIps ip isp ispOrg mac name namespacePid port subnetUid svcName type typeId uid vlanUid vpcUid zone } email { cc ccMailboxes deliveredTo deliveredToList from fromList fromMailbox fromMailboxes isRead messageUid rawHeader replyTo replyToList replyToMailboxes returnPath sender senderMailbox size smtpFrom smtpTo subject to toMailboxes uid xOriginatingIp } file { accessedTimeDt attributes companyName confidentiality confidentialityId createdTimeDt desc driveType driveTypeId ext internalName isDeleted isEncrypted isPublic isReadonly isSystem mimeType modifiedTimeDt name parentFolder path securityDescriptor size storageClass type typeId uid uri version volume } httpRequest { args bodyLength httpMethod length referrer uid userAgent version xForwardedFor } httpResponse { bodyLength code contentType latency length message status } ja4FingerprintList { sectionA sectionB sectionC sectionD type typeId value } job { cmdLine createdTimeDt desc lastRunTimeDt name nextRunTimeDt runState runStateId } module { baseAddress functionName loadType loadTypeId startAddress type } name process { cmdLine cpid createdTimeDt integrity integrityId lineage loadedModules name namespacePid path pid ptid sandbox terminatedTimeDt tid uid workingDirectory } query { class hostname opcode opcodeId packetUid type } regKey { isSystem modifiedTimeDt path securityDescriptor } regValue { isDefault isSystem modifiedTimeDt name path regBinaryData regIntegerData regStringData regStringListData type typeId } resources { cloudPartition createdTimeDt criticality hostname ip isBackedUp labels modifiedTimeDt name namespace namespacePid region role roleId type uid uidAlt version zone } s1Authentication { logonType logonTypeId s1AuthActivity s1AuthActivityId s1IsAdmin s1IsSuccessful } s1Clipboard { size } s1DlpRole s1DlpRoleId s1PrevRegValue { isDefault isSystem modifiedTimeDt name path regBinaryData regIntegerData regStringData regStringListData type typeId } script { name parentUid s1MacroDetectionSource s1MacroDetectionSourceId type typeId uid } secret { isValid maskedValue type } srcEndpoint { domain hostname instanceUid interfaceName interfaceUid intermediateIps ip isp ispOrg mac name namespacePid port subnetUid svcName type typeId uid vlanUid vpcUid zone } tls { alert certificateChain cipher clientCiphers handshakeDur keyLength serverCiphers sni version } traffic { bytes bytesIn bytesMissed bytesOut chunks chunksIn chunksOut packets packetsIn packetsOut } uid url { categories categoryIds domain hostname path port queryString resourceType scheme subdomain urlString } user { credentialUid displayName domain emailAddr forwardAddr fullName hasMfa modifiedTimeDt name phoneNumber riskLevel riskLevelId riskScore type typeId uid uidAlt } verdict verdictId winService { cmdLine labels loadOrderGroup name serviceCategory serviceCategoryId serviceDependencies serviceErrorControl serviceErrorControlId serviceStartName serviceStartType serviceStartTypeId serviceType serviceTypeId uid version } } findingInfo { attacks { version } dataSources killChain { phase phaseId } srcUrl } observables { name reputation { baseScore provider score scoreId } type typeId value } osint { answers { class flagIds flags packetUid rdata ttl type } attacks { version } autonomousSystem { name number } campaign { name } category comment confidence confidenceId createdTimeDt creator { credentialUid displayName domain emailAddr forwardAddr fullName hasMfa modifiedTimeDt name phoneNumber riskLevel riskLevelId riskScore type typeId uid uidAlt } desc detectionPattern detectionPatternType detectionPatternTypeId email { cc ccMailboxes deliveredTo deliveredToList from fromList fromMailbox fromMailboxes isRead messageUid rawHeader replyTo replyToList replyToMailboxes returnPath sender senderMailbox size smtpFrom smtpTo subject to toMailboxes uid xOriginatingIp } emailAuth { dkim dkimDomain dkimSignature dmarc dmarcOverride dmarcPolicy spf } expirationTimeDt externalUid file { accessedTimeDt attributes companyName confidentiality confidentialityId createdTimeDt desc driveType driveTypeId ext internalName isDeleted isEncrypted isPublic isReadonly isSystem mimeType modifiedTimeDt name parentFolder path securityDescriptor size storageClass type typeId uid uri version volume } intrusionSets killChain { phase phaseId } labels location { aerialHeight city continent coordinates country desc geodeticAltitude geodeticVerticalAccuracy geohash horizontalAccuracy isOnPremises isp lat long postalCode pressureAltitude provider region } malware { classificationIds classifications name numInfected path provider severity severityId uid } modifiedTimeDt name references relatedAnalytics { algorithm category desc name state stateId type typeId uid version } reputation { baseScore provider score scoreId } riskScore script { name parentUid s1MacroDetectionSource s1MacroDetectionSourceId type typeId uid } severity severityId signatures { algorithm algorithmId createdTimeDt developerUid state stateId } srcUrl subdomains subnet threatActor { name type typeId } tlp type typeId uid uploadedTimeDt value vendorName vulnerabilities { category dependencyChain desc exploitLastSeenTimeDt exploitRefUrl exploitRequirement exploitType firstSeenTimeDt fixAvailable fixCoverage fixCoverageId isExploitAvailable isFixAvailable kbArticles lastSeenTimeDt references relatedVulnerabilities severity title vendorName } whois { createdTimeDt dnssecStatus dnssecStatusId domain emailAddr isp ispOrg lastSeenTimeDt nameServers phoneNumber registrar status subdomains subnet } } remediation { cisControls { desc name version } kbArticleList { bulletin classification createdTimeDt installState installStateId isSuperseded severity size srcUrl title uid } kbArticles references s1QuarantinePath } s1DlpFindingInfo { s1DlpIsUserNotified s1DlpTransferChannel s1DlpTransferChannelId } startTimeDt }',
		standard: false,
		core: false,
	},
	preemptiveMitigationType: {
		name: 'Preemptive Mitigation Type',
		detail: 'preemptiveMitigationType',
		standard: false,
		core: false,
	},
	rawData: { name: 'Raw Data', detail: 'rawData', standard: false, core: false },
	relatedAlerts: {
		name: 'Related Alerts',
		detail:
			'relatedAlerts { id name relationData { __typename ... on CustomRuleRelationData { ruleId } ... on MarkActionRelationData { confidenceLevel result severity } } }',
		standard: false,
		core: false,
	},
	sloDetails: {
		name: 'SLO Details',
		list: 'sloDetails { timeToResolveData { actionComplete actionDue completion completionTime status target targetTime } timeToResponseData { actionComplete actionDue completion completionTime status target targetTime } }',
		detail:
			'sloDetails { timeToResolveData { actionComplete actionDue completion completionTime status target targetTime } timeToResponseData { actionComplete actionDue completion completionTime status target targetTime } }',
		standard: false,
		core: false,
	},
	ticketIdExists: {
		name: 'Ticket ID Exists',
		detail: 'ticketIdExists',
		standard: false,
		core: false,
	},
};

export const DEFAULT_ADDITIONAL_ALERT_FIELDS = Object.keys(fields).filter(
	(key) => fields[key].list && fields[key].standard && !fields[key].core,
);
export const DEFAULT_ALERT_DETAIL_FIELDS = Object.keys(fields).filter(
	(key) => key !== 'id' && fields[key].detail && fields[key].standard,
);

function optionsFor(projection: AlertProjection): INodePropertyOptions[] {
	return Object.entries(fields)
		.filter(([, field]) => field[projection] && !field.standard)
		.map(([value, field]) => ({ name: field.name, value }))
		.sort((a, b) => a.name.localeCompare(b.name));
}
export const additionalAlertFieldOptions = optionsFor('list');
export const alertDetailFieldOptions = optionsFor('detail');

function chosenFields(selected: unknown, projection: AlertProjection): string[] {
	if (selected === undefined) return [];
	if (
		!Array.isArray(selected) ||
		selected.some(
			(key) =>
				typeof key !== 'string' ||
				!Object.prototype.hasOwnProperty.call(fields, key) ||
				!fields[key][projection],
		)
	)
		throw new Error(
			'Additional Alert Fields contains an unsupported alert field. Choose fields from the list.',
		);
	return [...new Set(selected as string[])];
}
export function selectedAlertFields(selected: unknown): string[] {
	return [...new Set([...DEFAULT_ADDITIONAL_ALERT_FIELDS, ...chosenFields(selected, 'list')])];
}
export function alertFieldSelection(selected: unknown): string {
	return selectedAlertFields(selected)
		.map((key) => fields[key].list)
		.join('\n');
}
export function additionalAlertOutput(selected: unknown, alert: IDataObject): IDataObject {
	return Object.fromEntries(selectedAlertFields(selected).map((key) => [key, alert[key] ?? null]));
}
export function alertListSelection(selected?: unknown): string {
	return [
		...new Set([
			...Object.keys(fields).filter((key) => fields[key].list && fields[key].standard),
			...chosenFields(selected, 'list'),
		]),
	]
		.map((key) => fields[key].list)
		.join('\n');
}

function additionalSelection(value: unknown): string {
	if (value === undefined || value === '') return '';
	if (typeof value !== 'string' || value.length > 20_000)
		throw new Error('Additional GraphQL Fields must be text of at most 20,000 characters.');
	const source = value.replace(/#[^\n\r]*/g, '');
	const tokens = source.match(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}]/g) ?? [];
	if (source.replace(/\.\.\.|[_A-Za-z][_0-9A-Za-z]*|[{}]|\s|,/g, '') || tokens.length > 2_000)
		throw new Error(
			'Additional GraphQL Fields accepts field names, nested braces, and inline fragments. Arguments, aliases, directives, and complete queries are not supported.',
		);
	let index = 0;
	const isName = (token: string | undefined) =>
		token !== undefined && /^[_A-Za-z][_0-9A-Za-z]*$/.test(token);
	function selectionSet(nested: boolean, depth: number): void {
		if (depth > 12) throw new Error('Additional GraphQL Fields cannot exceed 12 nesting levels.');
		let count = 0;
		while (index < tokens.length && tokens[index] !== '}') {
			const fragment = tokens[index] === '...';
			if (fragment) {
				index++;
				if (tokens[index++] !== 'on')
					throw new Error('Use inline fragments in the form ... on Type { fields }.');
			}
			if (!isName(tokens[index++]))
				throw new Error('Additional GraphQL Fields contains an invalid field selection.');
			count++;
			if (tokens[index] === '{') {
				index++;
				selectionSet(true, depth + 1);
			} else if (fragment) throw new Error('An inline fragment must contain a field selection.');
		}
		if (count === 0 && nested) throw new Error('Nested GraphQL field selections cannot be empty.');
		if (nested && tokens[index++] !== '}')
			throw new Error('Additional GraphQL Fields has unbalanced braces.');
	}
	selectionSet(false, 0);
	if (index !== tokens.length) throw new Error('Additional GraphQL Fields has unbalanced braces.');
	return tokens.join(' ');
}

export function alertDetailSelection(selected?: unknown, additional: unknown = ''): string {
	return [...new Set(['id', ...DEFAULT_ALERT_DETAIL_FIELDS, ...chosenFields(selected, 'detail')])]
		.map((key) => fields[key].detail)
		.concat(additionalSelection(additional))
		.filter(Boolean)
		.join('\n');
}
