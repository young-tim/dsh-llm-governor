/** Browser Client 挂载的 Governor Typert contribution 与类型声明。 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { AuditEntry, DecisionQueryResult } from '../storage/repository.js';
import type { GovernorRoutingSettings, GovernorRoutingSettingsPatch, GovernorService, GovernorUsageQuery } from './service.js';
import type { GovernorRemoteUsage } from './remote-service.js';
import { GOVERNOR_REMOTE_CONTRIBUTION } from './remote-contract.js';
type Models = Awaited<ReturnType<GovernorService['listModels']>>;
type ModelUpdate = Awaited<ReturnType<GovernorService['updateModel']>>;
type Users = Awaited<ReturnType<GovernorService['listUsers']>>;
type UserUpdate = Awaited<ReturnType<GovernorService['updateUser']>>;
type SelectionMode = ReturnType<GovernorService['getSessionSelectionMode']>;
type SelectionUpdate = Awaited<ReturnType<GovernorService['setSessionSelectionMode']>>;
export interface GovernorRemoteApi {
    describeAccess(): Promise<RemoteResult<{
        actorId: string;
        capabilities: string[];
    }>>;
    listModels(): Promise<RemoteResult<Models>>;
    updateModel(routeId: string, patch: {
        enabled?: boolean;
        multiplier?: number;
    }, options?: {
        expectedRevision?: number;
    }): Promise<RemoteResult<ModelUpdate>>;
    listUsers(): Promise<RemoteResult<Users>>;
    updateUser(userId: string, patch: {
        monthlyCredits?: number;
        allow?: string[];
    }, options?: {
        expectedRevision?: number;
    }): Promise<RemoteResult<UserUpdate>>;
    getRouting(): Promise<RemoteResult<GovernorRoutingSettings>>;
    updateRouting(patch: GovernorRoutingSettingsPatch, options?: {
        expectedRevision?: number;
    }): Promise<RemoteResult<GovernorRoutingSettings>>;
    queryUsage(query: GovernorUsageQuery): Promise<RemoteResult<GovernorRemoteUsage[]>>;
    getSessionSelectionMode(sessionId: string): Promise<RemoteResult<SelectionMode>>;
    setSessionSelectionMode(sessionId: string, mode: 'auto' | 'manual', options?: {
        expectedRevision?: number;
        lastManualRoute?: string;
        currentRoute?: string;
    }): Promise<RemoteResult<SelectionUpdate>>;
    explainDecision(requestId: string, fallbackIndex?: number): Promise<RemoteResult<DecisionQueryResult[]>>;
    listAuditEntries(limit: number): Promise<RemoteResult<AuditEntry[]>>;
}
declare module '@deepseek-ai/dsh-typert-protocol' {
    interface TypertRemoteNamespaceMap {
        governor: GovernorRemoteApi;
    }
    interface TypertRemoteMap {
        'governor/describeAccess': GovernorRemoteApi['describeAccess'];
        'governor/listModels': GovernorRemoteApi['listModels'];
        'governor/updateModel': GovernorRemoteApi['updateModel'];
        'governor/listUsers': GovernorRemoteApi['listUsers'];
        'governor/updateUser': GovernorRemoteApi['updateUser'];
        'governor/getRouting': GovernorRemoteApi['getRouting'];
        'governor/updateRouting': GovernorRemoteApi['updateRouting'];
        'governor/queryUsage': GovernorRemoteApi['queryUsage'];
        'governor/getSessionSelectionMode': GovernorRemoteApi['getSessionSelectionMode'];
        'governor/setSessionSelectionMode': GovernorRemoteApi['setSessionSelectionMode'];
        'governor/explainDecision': GovernorRemoteApi['explainDecision'];
        'governor/listAuditEntries': GovernorRemoteApi['listAuditEntries'];
    }
}
export { GOVERNOR_REMOTE_CONTRIBUTION };
export declare const TYPERT_REMOTE: import("@deepseek-ai/dsh-typert-protocol").TypertRemoteContribution;
export default GOVERNOR_REMOTE_CONTRIBUTION;
