/**
 * Governor browser half for DSH rc.8.
 *
 * This is an ordinary `dsh.client` plugin. The host-side client module registry
 * discovers the package from the live Loader tree, serves `dist/client.js`, and
 * mounts this `apply` function in the browser Cordis tree. Every registration
 * below therefore follows the plugin fiber and is removed by HMR/uninstall.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client';
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client';
import { type GovernorRemoteApi } from '../plugin/typert-remote-client.js';
import type { GovernorRoutingSettings, GovernorRoutingSettingsPatch } from '../plugin/service.js';
import type { ModelPolicyPatch } from '../plugin/service.js';
/**
 * Explicit onboarding presets. They align with Auto's default low / medium /
 * high quality gates without pretending to be measured benchmark results.
 */
export declare const QUALITY_PRESETS: readonly [{
    readonly score: 75;
    readonly label: "Lite";
    readonly description: "省成本档";
}, {
    readonly score: 85;
    readonly label: "均衡";
    readonly description: "Flash / 标准档";
}, {
    readonly score: 95;
    readonly label: "Pro";
    readonly description: "高质量档";
}];
type QualityPresetScore = (typeof QUALITY_PRESETS)[number]['score'];
/** Suggest a visible, user-confirmed starting tier from conventional model names. */
export declare function suggestedQualityPreset(model: string): QualityPresetScore;
/** Composer guard for the completely uninitialised state seen after first install. */
export declare function autoSetupIssue(rows: readonly GovernorModelView[]): string | null;
export interface SelectionModeView {
    readonly mode: 'auto' | 'manual';
    readonly selectionRevision: number;
    readonly lastManualRoute?: string;
    readonly isDefault?: boolean;
}
export interface GovernorModelView {
    readonly routeId: string;
    readonly provider: string;
    readonly model: string;
    readonly enabled: boolean;
    readonly multiplierPpm: number;
    readonly capabilities: readonly string[];
    readonly quality: Readonly<Record<string, number>>;
    readonly configRevision: number;
}
export interface GovernorUserView {
    readonly userId: string;
    readonly allow: readonly string[];
    readonly monthlyCredits: number;
    readonly usedCredits?: number;
    readonly usedCreditNanos?: string;
    readonly configRevision: number;
}
export type GovernorRoutingView = GovernorRoutingSettings;
export interface GovernorUsageView {
    readonly requestId: string;
    readonly provider: string;
    readonly model: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly creditNanos: string;
    readonly success: boolean;
    readonly latencyMs: number;
    readonly fallbackIndex: number;
    readonly createdAt?: string;
}
/** Browser-safe face of the generated Governor Typert namespace. */
export type GovernorRemoteFace = GovernorRemoteApi;
export interface GovernorClientApi {
    access(): Promise<{
        readonly actorId: string;
        readonly capabilities: readonly string[];
    }>;
    selection(sessionId: SessionId): Promise<SelectionModeView>;
    selectMode(sessionId: SessionId, mode: 'auto' | 'manual', options?: {
        expectedRevision?: number;
        lastManualRoute?: string;
        currentRoute?: string;
    }): Promise<SelectionModeView>;
    routing(): Promise<GovernorRoutingView>;
    saveRouting(patch: GovernorRoutingSettingsPatch, expectedRevision?: number): Promise<GovernorRoutingView>;
    models(): Promise<readonly GovernorModelView[]>;
    saveModel(routeId: string, patch: ModelPolicyPatch, expectedRevision?: number): Promise<GovernorModelView>;
    users(): Promise<readonly GovernorUserView[]>;
    saveUser(userId: string, patch: {
        monthlyCredits?: number;
        allow?: string[];
    }, expectedRevision?: number): Promise<GovernorUserView>;
    usage31Days(): Promise<readonly GovernorUsageView[]>;
}
/** Build the UI adapter over the generated, Host-authorized Typert namespace. */
export declare function createGovernorClientApi(remote: GovernorRemoteFace): GovernorClientApi;
interface ModelSelection {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: string;
}
interface ModelDirectoryState {
    readonly current: ModelSelection | null;
    readonly groups: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly models: ReadonlyArray<{
            readonly id: string;
            readonly name: string;
            readonly description?: string;
            readonly reasoning?: {
                readonly defaultEffort?: string;
                readonly efforts: ReadonlyArray<{
                    readonly id: string;
                    readonly name: string;
                    readonly description?: string;
                }>;
            };
        }>;
    }>;
    readonly status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error';
    readonly error: string | null;
}
interface AutoModelSelectProps {
    readonly locked: boolean;
    readonly available: boolean;
    readonly sessionId: SessionId;
    readonly directory: SnapshotStore<ModelDirectoryState>;
    readonly load: () => void;
    readonly selectModel: (selection: ModelSelection) => Promise<boolean>;
    readonly api: GovernorClientApi;
}
/** Native Composer model seat: Auto is the first control option, never a fake provider route. */
export declare function GovernorModelSelect({ locked, available, sessionId, directory, load, selectModel, api, }: AutoModelSelectProps): import("react").DetailedReactHTMLElement<{
    className: string;
}, HTMLElement> | null;
interface GovernorSettingsProps {
    readonly api: GovernorClientApi;
}
/** Native DSH Settings section; Host Remote remains the only data authority. */
export declare function GovernorSettings({ api }: GovernorSettingsProps): import("react").DetailedReactHTMLElement<{
    className: string;
    'aria-label': string;
}, HTMLElement>;
/** Required rc.8 client services. */
export declare const inject: string[];
/** Mount all native Governor browser surfaces with one reversible lifecycle. */
export declare function apply(ctx: Context): Promise<() => Promise<void>>;
export {};
