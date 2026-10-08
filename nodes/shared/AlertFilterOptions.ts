import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { normalizeBaseUrl } from './Scopes';
import { authenticatedRequest } from './transport/authenticatedRequest';
import { responseStatus } from './transport/retry';
import {
	alertFilterComparators,
	comparatorsForField,
	loadAlertFilterMetadata,
	TriggerFilterError,
} from './AlertFilters';

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export const alertFilterLoadOptions = {
	async getAlertFilterFields(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		try {
			const credentials = await this.getCredentials('sentinelOnePlatformApi');

			const fields = await loadAlertFilterMetadata(
				authenticatedRequest(this),
				normalizeBaseUrl(credentials.baseUrl),
				String(this.getNode().credentials?.sentinelOnePlatformApi?.id ?? ''),
			);

			return fields.map(({ fieldId }) => ({ name: fieldId, value: fieldId }));
		} catch (error) {
			// Preserve authentication, permission, rate limit and timeout errors.
			// eslint-disable-next-line @n8n/community-nodes/require-node-api-error
			if (error instanceof NodeApiError) throw error;
			const status = responseStatus(error);

			if (status !== null)
				throw new NodeApiError(
					this.getNode(),
					{ message: errorMessage(error) },
					{
						httpCode: String(status),
						message: 'Unable to load SentinelOne alert filter metadata.',
						description: errorMessage(error),
					},
				);

			throw new NodeOperationError(
				this.getNode(),
				'Unable to load SentinelOne alert filter fields. Check the credential and try again.',
				{
					description:
						error instanceof TriggerFilterError ? error.description : errorMessage(error),
				},
			);
		}
	},
	async getAlertFilterComparators(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
		const fieldId = this.getCurrentNodeParameter('&fieldId');

		if (typeof fieldId !== 'string' || !fieldId || fieldId.startsWith('='))
			return alertFilterComparators;

		try {
			const credentials = await this.getCredentials('sentinelOnePlatformApi');

			const fields = await loadAlertFilterMetadata(
				authenticatedRequest(this),
				normalizeBaseUrl(credentials.baseUrl),
				String(this.getNode().credentials?.sentinelOnePlatformApi?.id ?? ''),
			);

			const field = fields.find((entry) => entry.fieldId === fieldId);

			if (!field) return alertFilterComparators;

			return comparatorsForField(field);
		} catch (error) {
			const status = responseStatus(error);

			if (status === 401 || status === 403)
				throw new NodeApiError(
					this.getNode(),
					{ message: errorMessage(error) },
					{
						httpCode: String(status),
						message: 'Unable to load SentinelOne alert filter metadata.',
						description: errorMessage(error),
					},
				);

			return alertFilterComparators;
		}
	},
};
