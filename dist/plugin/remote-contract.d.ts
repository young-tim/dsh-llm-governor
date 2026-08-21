/** Governor Typert 严格 Remote descriptors 的共享运行时合同。 */
import type { InvocationDescriptor, TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol';
/** Host 与 Client 共用的严格 descriptors；顺序同时是公开 API 清单。 */
export declare const GOVERNOR_REMOTE_DESCRIPTORS: readonly InvocationDescriptor[];
/** Client 入口 mount 的严格贡献。 */
export declare const GOVERNOR_REMOTE_CONTRIBUTION: TypertRemoteContribution;
