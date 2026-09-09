import type { INodeProperties } from 'n8n-workflow';
import { debugSetting } from '../shared/Debug';
import { description as get } from './actions/alert/get.operation';
import { description as getMany } from './actions/alert/getMany.operation';
import { description as update } from './actions/alert/update.operation';
import { description as noteGet } from './actions/alertNote/getMany.operation';
import { description as noteCreate } from './actions/alertNote/create.operation';
import { sdlOperation, sdlDescription } from './actions/sdlQuery/execute.operation';
export const sentinelOneProperties: INodeProperties[] = [
	debugSetting,
	{
		displayName: 'Resource',
		name: 'resource',
		type: 'options',
		noDataExpression: true,
		default: 'alert',
		options: [
			{ name: 'Alert', value: 'alert' },
			{ name: 'Alert Note', value: 'alertNote' },
			{ name: 'SDL Query', value: 'sdlQuery' },
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'get',
		displayOptions: { show: { resource: ['alert'] } },
		options: [
			{
				name: 'Get',
				value: 'get',
				description: 'Get an alert by ID',
				action: 'Get alert',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get alerts in a management scope',
				action: 'Get many alerts',
			},
			{
				name: 'Update',
				value: 'update',
				description: 'Update one alert through its available actions',
				action: 'Update alert',
			},
		],
	},
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		default: 'getAll',
		displayOptions: { show: { resource: ['alertNote'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Create a plain-text or Markdown note on an alert',
				action: 'Create alert note',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				description: 'Get many notes on an alert',
				action: 'Get many alert notes',
			},
		],
	},
	sdlOperation,
	...get,
	...getMany,
	...update,
	...noteGet,
	...noteCreate,
	...sdlDescription,
];
