import type {
	IAuthenticate,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class SentinelOnePlatformApi implements ICredentialType {
	name = 'sentinelOnePlatformApi';

	displayName = 'SentinelOne Platform API';

	icon = {
		light: 'file:../nodes/SentinelOnePlatformTrigger/sentinelone.svg',
		dark: 'file:../nodes/SentinelOnePlatformTrigger/sentinelone.dark.svg',
	} as const;

	documentationUrl =
		'https://github.com/pemontto/n8n-nodes-sentinelone-platform/blob/main/docs/credentials.md';

	properties: INodeProperties[] = [
		{
			displayName: 'Management Console URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://your-tenant.sentinelone.net',
			required: true,
		},
		{
			displayName: 'API Token',
			name: 'apiToken',
			type: 'string',
			typeOptions: {
				password: true,
			},
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticate = async (credentials, requestOptions) => {
		requestOptions.headers = {
			...requestOptions.headers,
			Authorization: `Bearer ${credentials.apiToken}`,
		};
		return requestOptions;
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}',
			url: '/web/api/v2.1/sites?limit=1&states=active',
			method: 'GET',
		},
	};
}
