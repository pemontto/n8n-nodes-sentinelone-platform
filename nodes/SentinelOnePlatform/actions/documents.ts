import { alertDetailSelection, alertListSelection } from '../../shared/AlertFields';
const ALERT_DETAIL_FIELDS = `fragment AlertDetailFields on UnifiedAlertDetail { ${alertDetailSelection()} }`;
const ALERT_NOTE_FIELDS = /* GraphQL */ `
	fragment AlertNoteFields on AlertNote {
		id
		alertId
		text
		type
		createdAt
		updatedAt
		createdBy {
			__typename
			... on UserNoteAuthor {
				userId
				email
				fullName
			}
			... on RuleNoteAuthor {
				id
				name
				version
			}
		}
	}
`;

export const GRAPHQL_DOCUMENTS = {
	getAlert: /* GraphQL */ `
		${ALERT_DETAIL_FIELDS}
		query SentinelOneGetAlert($id: ID!) {
			alert(id: $id) {
				...AlertDetailFields
			}
		}
	`,
	getManyAlerts: getManyAlertsDocument(),
	availableActions: /* GraphQL */ `
		query SentinelOneAvailableAlertActions(
			$scope: ScopeSelectorInput
			$filter: OrFilterSelectionInput!
			$viewType: ViewType!
		) {
			alertAvailableActions(scope: $scope, filter: $filter, viewType: $viewType) {
				data {
					id
					title
					isDisabled
					disabledReason
					types
					triggeredAfter
					triggersActions
				}
				errors {
					errorMessage
					errorPayload {
						__typename
						... on ActionsErrorConcurrentUserLimitPayload {
							limit
						}
						... on ActionsErrorLimitPayload {
							limit
						}
					}
				}
			}
		}
	`,
	updateAlert: /* GraphQL */ `
		mutation SentinelOneUpdateAlert(
			$scope: ScopeSelectorInput
			$filter: OrFilterSelectionInput!
			$actions: [TriggerActionInput!]!
			$viewType: ViewType!
		) {
			alertTriggerActions(scope: $scope, filter: $filter, actions: $actions, viewType: $viewType) {
				__typename
				... on ActionsTriggered {
					actions {
						actionId
						success {
							id
						}
						skip {
							id
							skipType
							skipMessage
						}
						failure {
							id
							errorType
							errorMessage
						}
					}
				}
				... on TriggerActionsError {
					errors {
						errorMessage
						errorPayload {
							__typename
							... on ActionsErrorConcurrentUserLimitPayload {
								limit
							}
							... on ActionsErrorLimitPayload {
								limit
							}
						}
					}
				}
				... on TriggerActionsScheduled {
					executionId
					bulkActionTriggerId
				}
			}
		}
	`,
	getAlertNotes: /* GraphQL */ `
		${ALERT_NOTE_FIELDS}
		query SentinelOneGetAlertNotes($alertId: ID!) {
			alertNotes(alertId: $alertId) {
				data {
					...AlertNoteFields
				}
			}
		}
	`,
	createAlertNote: /* GraphQL */ `
		${ALERT_NOTE_FIELDS}
		mutation SentinelOneCreateAlertNote(
			$alertId: ID!
			$text: String!
			$type: ContentType!
			$plainText: String
		) {
			addAlertNote(alertId: $alertId, text: $text, type: $type, plainText: $plainText) {
				data {
					...AlertNoteFields
				}
			}
		}
	`,
} as const;

export function getManyAlertsDocument(selection = alertListSelection()): string {
	return `
		fragment AlertSummaryFields on UnifiedAlert { ${selection} }
		query SentinelOneGetManyAlerts(
			$first: Int!
			$after: String
			$scope: ScopeSelectorInput
			$viewType: ViewType!
			$filters: [FilterInput!]
			$sorts: [SortInput!]
		) {
			alerts(
				first: $first
				after: $after
				scope: $scope
				viewType: $viewType
				filters: $filters
				sorts: $sorts
			) {
				edges {
					cursor
					node {
						...AlertSummaryFields
					}
				}
				pageInfo {
					hasNextPage
					endCursor
				}
				totalCount
			}
		}
	`;
}
