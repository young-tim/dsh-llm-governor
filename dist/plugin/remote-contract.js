import { z } from 'zod/v4';
import { TASK_TYPES } from '../index.js';
function stringSchema(allowed) {
    return allowed === undefined ? z.string() : z.enum(allowed);
}
const revisionOptionsSchema = z.object({ expectedRevision: z.number().int().optional() }).strict();
const modelPatchSchema = z
    .object({
    enabled: z.boolean().optional(),
    multiplier: z.number().nonnegative().optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    quality: z.partialRecord(z.enum(TASK_TYPES), z.number().min(0).max(100).nullable()).optional(),
})
    .strict();
const userPatchSchema = z
    .object({ monthlyCredits: z.number().optional(), allow: z.array(z.string()).optional() })
    .strict();
const routingPatchSchema = z
    .object({
    default: z.enum(['manual', 'quality_first', 'credit_first', 'auto']).optional(),
    creditFirst: z
        .object({
        minimumQuality: z.number().optional(),
        onNoMatch: z.enum(['quality_first', 'none']).optional(),
    })
        .strict()
        .optional(),
    auto: z
        .object({
        confidenceThreshold: z.number().optional(),
        qualityThreshold: z
            .object({
            low: z.number().optional(),
            medium: z.number().optional(),
            high: z.number().optional(),
        })
            .strict()
            .optional(),
    })
        .strict()
        .optional(),
    fallback: z
        .object({
        enabled: z.boolean().optional(),
        maxAttempts: z.number().int().optional(),
        afterPartialOutput: z.boolean().optional(),
        strategy: z.enum(['quality_first', 'credit_first', 'auto']).optional(),
    })
        .strict()
        .optional(),
})
    .strict();
const usageQuerySchema = z
    .object({
    from: z.string().optional(),
    to: z.string().optional(),
    userId: z.string().optional(),
    provider: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
})
    .strict();
const selectionOptionsSchema = z
    .object({
    expectedRevision: z.number().int().optional(),
    lastManualRoute: z.string().optional(),
    currentRoute: z.string().optional(),
})
    .strict();
const routingModeSchema = z.enum(['manual', 'quality_first', 'credit_first', 'auto']);
const accessResultSchema = z
    .object({
    actorId: z.string(),
    capabilities: z.array(z.enum(['governor.read', 'governor.manage', 'governor.audit'])),
})
    .strict();
const modelResultSchema = z
    .object({
    routeId: z.string(),
    provider: z.string(),
    model: z.string(),
    enabled: z.boolean(),
    available: z.boolean(),
    unavailableReason: z.enum(['credential_missing', 'availability_check_failed']).optional(),
    multiplierPpm: z.number().int().nonnegative(),
    capabilities: z.array(z.string()),
    quality: z.record(z.string(), z.number()),
    configRevision: z.number().int().nonnegative(),
})
    .strict();
const userResultSchema = z
    .object({
    userId: z.string(),
    allow: z.array(z.string()),
    monthlyCredits: z.number().int().nonnegative(),
    usedCredits: z.number().nonnegative(),
    usedCreditNanos: z.string().regex(/^\d+$/),
    configRevision: z.number().int().nonnegative(),
})
    .strict();
const routingResultSchema = z
    .object({
    default: routingModeSchema,
    creditFirst: z
        .object({
        minimumQuality: z.number(),
        onNoMatch: z.enum(['quality_first', 'none']),
    })
        .strict(),
    auto: z
        .object({
        confidenceThreshold: z.number(),
        qualityThreshold: z
            .object({ low: z.number(), medium: z.number(), high: z.number() })
            .strict(),
    })
        .strict(),
    fallback: z
        .object({
        enabled: z.boolean(),
        maxAttempts: z.number().int(),
        afterPartialOutput: z.boolean(),
        strategy: z.enum(['quality_first', 'credit_first', 'auto']),
    })
        .strict(),
    configRevision: z.number().int().nonnegative(),
})
    .strict();
const usageResultSchema = z
    .object({
    requestId: z.string(),
    sessionId: z.string(),
    userId: z.string(),
    provider: z.string(),
    model: z.string(),
    routingMode: z.string(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    creditNanos: z.string().regex(/^\d+$/),
    success: z.boolean(),
    latencyMs: z.number().nonnegative(),
    fallbackIndex: z.number().int().nonnegative(),
    createdAt: z.string(),
})
    .strict();
const selectionResultSchema = z
    .object({
    mode: z.enum(['auto', 'manual']),
    lastManualRoute: z.string().optional(),
    selectionRevision: z.number().int().nonnegative(),
    isDefault: z.boolean(),
})
    .strict();
const selectionUpdateResultSchema = z
    .object({
    mode: z.enum(['auto', 'manual']),
    selectionRevision: z.number().int().nonnegative(),
})
    .strict();
const decisionCandidateSchema = z
    .object({
    routeId: z.string(),
    quality: z.number().optional(),
    multiplierPpm: z.number().int(),
})
    .strict();
const decisionResultSchema = z
    .object({
    decisionId: z.string(),
    decisionHash: z.string().optional(),
    requestId: z.string(),
    sessionId: z.string().optional(),
    turn: z.number().int().optional(),
    step: z.number().int().optional(),
    fallbackIndex: z.number().int().nonnegative(),
    trigger: z.string().optional(),
    causes: z.array(z.string()).optional(),
    changedFields: z.array(z.string()).optional(),
    selectionMode: z.enum(['manual', 'auto']).optional(),
    effectiveStrategy: z.string().optional(),
    classifierSource: z.string().optional(),
    mode: routingModeSchema,
    taskType: z.string().optional(),
    complexity: z.string().optional(),
    confidence: z.number().optional(),
    minimumQuality: z.number().optional(),
    candidates: z.array(decisionCandidateSchema),
    candidateTruncated: z.boolean(),
    candidateTotalCount: z.number().int().nonnegative().optional(),
    excluded: z.array(z.object({ routeId: z.string(), reason: z.string() }).strict()),
    excludedTruncated: z.boolean(),
    excludedTotalCount: z.number().int().nonnegative().optional(),
    outcome: z.enum(['selected', 'rejected']),
    selectedRoute: z.string().optional(),
    errorCode: z.string().optional(),
    auditState: z.enum(['pending', 'committed']),
    configRevision: z.number().int().nonnegative(),
    createdAt: z.string(),
})
    .strict();
const auditResultSchema = z
    .object({
    id: z.number().int().optional(),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    changedFields: z.array(z.string()).optional(),
    oldRevision: z.number().int().optional(),
    newRevision: z.number().int().optional(),
    result: z.enum(['success', 'denied', 'error']),
    errorCode: z.string().optional(),
    createdAt: z.string(),
})
    .strict();
function numberSchema() {
    return z.number();
}
function parameter(name, schema, acceptsUndefined = false) {
    return {
        name,
        wire: name,
        source: 'json',
        codec: { mode: 'strict', typeSymbol: `dsh-llm-governor/remote#${name}`, schema },
        ...(acceptsUndefined ? { acceptsUndefined: true } : {}),
    };
}
function descriptor(method, resultSchema, parameters = []) {
    return {
        id: `dsh-llm-governor#governor/${method}`,
        service: 'governorRemote',
        namespace: 'governor',
        method,
        invocation: { kind: 'direct' },
        parameters,
        result: {
            mode: 'strict',
            typeSymbol: `dsh-llm-governor/remote#${method}Result`,
            schema: resultSchema,
        },
    };
}
/** Host 与 Client 共用的严格 descriptors；顺序同时是公开 API 清单。 */
export const GOVERNOR_REMOTE_DESCRIPTORS = Object.freeze([
    descriptor('describeAccess', accessResultSchema),
    descriptor('listModels', z.array(modelResultSchema)),
    descriptor('updateModel', modelResultSchema, [
        parameter('routeId', stringSchema()),
        parameter('patch', modelPatchSchema),
        parameter('options', revisionOptionsSchema, true),
    ]),
    descriptor('listUsers', z.array(userResultSchema)),
    descriptor('updateUser', userResultSchema, [
        parameter('userId', stringSchema()),
        parameter('patch', userPatchSchema),
        parameter('options', revisionOptionsSchema, true),
    ]),
    descriptor('getRouting', routingResultSchema),
    descriptor('updateRouting', routingResultSchema, [
        parameter('patch', routingPatchSchema),
        parameter('options', revisionOptionsSchema, true),
    ]),
    descriptor('queryUsage', z.array(usageResultSchema), [parameter('query', usageQuerySchema)]),
    descriptor('getSessionSelectionMode', selectionResultSchema, [
        parameter('sessionId', stringSchema()),
    ]),
    descriptor('setSessionSelectionMode', selectionUpdateResultSchema, [
        parameter('sessionId', stringSchema()),
        parameter('mode', stringSchema(['auto', 'manual'])),
        parameter('options', selectionOptionsSchema, true),
    ]),
    descriptor('explainDecision', z.array(decisionResultSchema), [
        parameter('requestId', stringSchema()),
        parameter('fallbackIndex', numberSchema(), true),
    ]),
    descriptor('listAuditEntries', z.array(auditResultSchema), [parameter('limit', numberSchema())]),
]);
/** Client 入口 mount 的严格贡献。 */
export const GOVERNOR_REMOTE_CONTRIBUTION = Object.freeze({
    package: 'dsh-llm-governor',
    descriptors: GOVERNOR_REMOTE_DESCRIPTORS,
});
