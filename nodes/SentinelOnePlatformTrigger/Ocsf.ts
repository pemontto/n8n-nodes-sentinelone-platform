import type { IDataObject } from 'n8n-workflow';
import type { ScopeType } from '../shared/Scopes';
import type { AuthenticatedRequest } from './SentinelOneTriggerHelpers';

export const OCSF_QUERY = `
query AlertOcsf($id: ID!, $scope: ScopeSelectorInput!) {
  alert(id: $id, scope: $scope) {
    id
    updatedAt
    realTime { scope { account { id name } site { id name } group { id name } } }
    ocsf {
      action
      actionId
      startTimeDt
      endTimeDt
      cloud {
        name provider region zone uid uidAlt cloudPartition projectUid
        account { uid name type typeId }
        org { uid name ouUid ouName }
      }
      findingInfo {
        dataSources srcUrl
        attacks {
          version
          tactic { uid name srcUrl }
          technique { uid name srcUrl }
          subTechnique { uid name srcUrl }
        }
        killChain { phase phaseId }
      }
      observables {
        name type typeId value
        reputation { baseScore provider score scoreId }
      }
      evidences {
        uid name verdict verdictId
        device { uid name hostname ip mac domain type typeId }
        process {
          uid name pid cmdLine path createdTimeDt
          file { uid name path size hashes { algorithm algorithmId value } }
          parentProcess { uid name pid cmdLine path }
        }
        file { uid name path size hashes { algorithm algorithmId value } }
        user { uid name fullName domain emailAddr }
        srcEndpoint { uid hostname ip port domain }
        dstEndpoint { uid hostname ip port domain }
        url { urlString scheme hostname port path queryString }
      }
      osint {
        uid name type typeId value category confidence confidenceId
        riskScore severity severityId references srcUrl
      }
      remediation { kbArticles references s1QuarantinePath }
      s1DlpFindingInfo {
        s1DlpIsUserNotified s1DlpTransferChannel s1DlpTransferChannelId
      }
    }
  }
}`;

function asRecord(value: unknown): IDataObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as IDataObject)
		: undefined;
}

export async function fetchOcsfDetail(
	request: AuthenticatedRequest,
	baseUrl: string,
	alertId: string,
	scopeType: ScopeType,
	scopeIds: string[],
	timeout: number,
): Promise<IDataObject> {
	const response = asRecord(
		await request({
			method: 'POST',
			url: `${baseUrl}/web/api/v2.1/unifiedalerts/graphql`,
			timeout,
			body: {
				query: OCSF_QUERY,
				variables: { id: alertId, scope: { scopeType, scopeIds } },
			},
			json: true,
		}),
	);
	if (
		response?.errors !== undefined &&
		(!Array.isArray(response.errors) || response.errors.length > 0)
	) {
		throw new Error(
			'SentinelOne rejected the OCSF detail query. Check the tenant schema and credential permissions; state was not advanced.',
		);
	}
	const detail = asRecord(asRecord(response?.data)?.alert);
	if (
		!detail ||
		detail.id !== alertId ||
		!Object.prototype.hasOwnProperty.call(detail, 'ocsf') ||
		(detail.ocsf !== null && !asRecord(detail.ocsf))
	) {
		throw new Error(
			'SentinelOne returned an incomplete or mismatched OCSF alert detail; state was not advanced.',
		);
	}
	return detail;
}
