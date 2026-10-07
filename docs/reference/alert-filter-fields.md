# Alert filter fields

These are the alert fields SentinelOne accepts in Advanced Filters, with the comparators each one allows. SentinelOne does not publish this list in its GraphQL schema: `fieldId` is a free string. The console reports it at runtime through the `alertColumnMetadata` GraphQL query, which is where this table comes from (captured 2026-10-07 from a production console). Every field can be negated with `"isNegated": true`. Fields can differ between consoles and releases; if a filter fails with "does not exist or not supported for FILTER API call", check the field ID against your console.

Account, site and group are not filterable. Use the trigger's Scope and the Exclude Account, Site and Group Name options instead, or split the workflow into one trigger per account.

| Field ID                                    | Comparators                        |
| ------------------------------------------- | ---------------------------------- |
| `id`                                        | `match`, `stringIn`, `stringEqual` |
| `storylineId`                               | `match`, `stringIn`, `stringEqual` |
| `alertName`                                 | `match`, `stringIn`, `stringEqual` |
| `detectedAt`                                | `dateTimeRange`                    |
| `createdAt`                                 | `dateTimeRange`                    |
| `firstSeenAt`                               | `dateTimeRange`                    |
| `lastSeenAt`                                | `dateTimeRange`                    |
| `updatedAt`                                 | `dateTimeRange`                    |
| `severity`                                  | `stringIn`, `stringEqual`          |
| `confidenceLevel`                           | `stringIn`, `stringEqual`          |
| `analystVerdict`                            | `stringIn`, `stringEqual`          |
| `status`                                    | `stringIn`, `stringEqual`          |
| `mitigationHasQuarantineFiles`              | `booleanIn`, `booleanEqual`        |
| `result`                                    | `stringIn`, `stringEqual`          |
| `classification`                            | `stringIn`, `stringEqual`          |
| `aiInvestigationStatus`                     | `stringIn`, `stringEqual`          |
| `aiVerdict`                                 | `stringIn`, `stringEqual`          |
| `aiInvestigationAutoTriggered`              | `booleanIn`, `booleanEqual`        |
| `agentVersion`                              | `match`, `stringIn`, `stringEqual` |
| `detectionVendor`                           | `stringIn`, `stringEqual`          |
| `detectionProduct`                          | `stringIn`, `stringEqual`          |
| `analyticsCategory`                         | `stringIn`, `stringEqual`          |
| `analyticsName`                             | `stringIn`, `stringEqual`          |
| `analyticsType`                             | `stringIn`, `stringEqual`          |
| `analyticsUid`                              | `match`, `stringIn`, `stringEqual` |
| `assetId`                                   | `match`, `stringIn`, `stringEqual` |
| `assetStatus`                               | `stringIn`, `stringEqual`          |
| `assetName`                                 | `match`, `stringIn`, `stringEqual` |
| `assetOsVersion`                            | `stringIn`, `stringEqual`          |
| `assetOsType`                               | `stringIn`, `stringEqual`          |
| `assetLastLoggedInUser`                     | `match`, `stringIn`, `stringEqual` |
| `assetTypeClassifier`                       | `stringIn`, `stringEqual`          |
| `assetCategory`                             | `stringIn`, `stringEqual`          |
| `assetSubcategory`                          | `stringIn`, `stringEqual`          |
| `assetAgentUuid`                            | `match`, `stringIn`, `stringEqual` |
| `assetPolicy`                               | `match`, `stringIn`, `stringEqual` |
| `assetConnectivityToConsole`                | `stringIn`, `stringEqual`          |
| `assetAgentOperatingMode`                   | `stringIn`, `stringEqual`          |
| `assetPendingReboot`                        | `booleanIn`, `booleanEqual`        |
| `assetDecommissioned`                       | `booleanIn`, `booleanEqual`        |
| `assetTagKeys`                              | `stringIn`, `stringEqual`          |
| `assetTags`                                 | `stringIn`, `stringEqual`          |
| `alertNoteExists`                           | `booleanIn`, `booleanEqual`        |
| `ticketIdExists`                            | `booleanIn`, `booleanEqual`        |
| `ticketId`                                  | `match`, `stringIn`, `stringEqual` |
| `assigneeUserId`                            | `longIn`, `longEqual`              |
| `assigneeFullName`                          | `match`, `stringIn`, `stringEqual` |
| `processName`                               | `match`, `stringIn`, `stringEqual` |
| `cmdLine`                                   | `match`, `stringIn`, `stringEqual` |
| `fileName`                                  | `match`, `stringIn`, `stringEqual` |
| `filePath`                                  | `match`, `stringIn`, `stringEqual` |
| `actorFileSha1`                             | `match`, `stringIn`, `stringEqual` |
| `actorFileSha256`                           | `match`, `stringIn`, `stringEqual` |
| `actorFileMd5`                              | `match`, `stringIn`, `stringEqual` |
| `fileSha1`                                  | `match`, `stringIn`, `stringEqual` |
| `fileSha256`                                | `match`, `stringIn`, `stringEqual` |
| `fileMd5`                                   | `match`, `stringIn`, `stringEqual` |
| `publisherName`                             | `match`, `stringIn`, `stringEqual` |
| `detectionAssetOsType`                      | `match`, `stringIn`, `stringEqual` |
| `detectionAssetOsName`                      | `match`, `stringIn`, `stringEqual` |
| `detectionAssetOsRevision`                  | `match`, `stringIn`, `stringEqual` |
| `detectionAssetAgentVersion`                | `match`, `stringIn`, `stringEqual` |
| `detectionAssetPolicy`                      | `stringIn`, `stringEqual`          |
| `detectionAssetLastLoggedInUser`            | `match`, `stringIn`, `stringEqual` |
| `detectionAssetDomain`                      | `match`, `stringIn`, `stringEqual` |
| `detectionAssetIpV4`                        | `match`, `stringIn`, `stringEqual` |
| `detectionAssetIpV6`                        | `match`, `stringIn`, `stringEqual` |
| `detectionAssetSubscriptionTime`            | `dateTimeRange`                    |
| `detectionAssetConsoleIpAddress`            | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesClusterName`            | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesNodeName`               | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesNodeLabels`             | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesNamespaceName`          | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesNamespaceLabels`        | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesControllerName`         | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesControllerType`         | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesControllerLabels`       | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesPodName`                | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesPodLabels`              | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesContainerName`          | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesContainerImageName`     | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesContainerId`            | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesContainerLabels`        | `match`, `stringIn`, `stringEqual` |
| `detectionKubernetesContainerNetworkStatus` | `match`, `stringIn`, `stringEqual` |
| `detectionCloudProvider`                    | `match`, `stringIn`, `stringEqual` |
| `detectionCloudAccount`                     | `match`, `stringIn`, `stringEqual` |
| `detectionCloudLocation`                    | `match`, `stringIn`, `stringEqual` |
| `detectionCloudNetwork`                     | `match`, `stringIn`, `stringEqual` |
| `detectionCloudInstanceId`                  | `match`, `stringIn`, `stringEqual` |
| `detectionCloudTags`                        | `match`, `stringIn`, `stringEqual` |
| `detectionCloudImage`                       | `match`, `stringIn`, `stringEqual` |
| `detectionCloudInstanceSize`                | `match`, `stringIn`, `stringEqual` |
| `detectionAwsSubnetIds`                     | `match`, `stringIn`, `stringEqual` |
| `detectionAwsRole`                          | `match`, `stringIn`, `stringEqual` |
| `detectionAwsSecurityGroups`                | `match`, `stringIn`, `stringEqual` |
| `detectionGcpServiceAccount`                | `match`, `stringIn`, `stringEqual` |
| `detectionAzureResourceGroup`               | `match`, `stringIn`, `stringEqual` |
| `externalId`                                | `match`, `stringIn`, `stringEqual` |
| `dataSources`                               | `stringIn`, `stringEqual`          |
| `affectedByAutomationRules`                 | `match`, `stringIn`, `stringEqual` |
| `detectionAttackerIpAddress`                | `match`, `stringIn`, `stringEqual` |
| `detectionAttackerHostname`                 | `match`, `stringIn`, `stringEqual` |
| `detectionTargetUserName`                   | `match`, `stringIn`, `stringEqual` |
| `detectionTargetUserDomain`                 | `match`, `stringIn`, `stringEqual` |
| `labels`                                    | `stringIn`, `stringEqual`          |
| `primaryIndicatorType`                      | `stringIn`, `stringEqual`          |
| `mitreTechniques`                           | `stringIn`, `stringEqual`          |
| `mitreTactics`                              | `stringIn`, `stringEqual`          |
| `incidentId`                                | `match`, `stringIn`, `stringEqual` |
| `incidentName`                              | `match`, `stringIn`, `stringEqual` |
| `incidentExists`                            | `booleanEqual`                     |
