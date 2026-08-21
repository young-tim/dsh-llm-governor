/**
 * GOV-OPS-002：数据导出（CSV/JSON）与 CSV 注入防护。
 *
 * - CSV 中以 `=`、`+`、`-`、`@` 开头的单元格必须转义（前缀单引号），
 *   防止公式注入；不包含禁止字段（Prompt/JWT/API Key 等）。
 * - 导出上限：10,000 行或 10 MiB，以先到者为准。
 * - 默认以稳定假名展示 user。
 */
import type { DecisionQueryResult, UsageEventRow } from '../storage/repository.js';

/** 导出限制常量（优化文档 7.1）。 */
export const EXPORT_LIMITS = {
  /** 最大导出行数。 */
  maxRows: 10_000,
  /** 最大导出字节数。 */
  maxBytes: 10 * 1024 * 1024,
} as const;

/**
 * CSV 单元格注入转义：以 =、+、-、@ 开头的值前加单引号。
 *
 * @param value - 原始值。
 * @returns 转义后的安全值。
 */
export function escapeCsvCell(value: string): string {
  if (/^[=+\-@]/.test(value)) return `'${value}`;
  return value;
}

/** Usage 导出行（扁平化、假名化、无禁止字段）。 */
export interface UsageExportRow {
  requestId: string;
  fallbackIndex: number;
  sessionId: string;
  usageKind: string;
  parentRequestId?: string;
  turn: number;
  step: number;
  pseudonymousUser: string;
  provider: string;
  model: string;
  routingMode: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  creditNanos: string;
  success: boolean;
  latencyMs: number;
  usageMissing: boolean;
  createdAt: string;
}

/** Decision 导出行。 */
export interface DecisionExportRow {
  decisionId: string;
  requestId: string;
  sessionId?: string;
  turn?: number;
  step?: number;
  fallbackIndex: number;
  trigger?: string;
  selectionMode?: string;
  effectiveStrategy?: string;
  outcome: string;
  selectedRoute?: string;
  errorCode?: string;
  configRevision: number;
  createdAt: string;
}

/**
 * 生成稳定假名：同一 user 的不同输入产生可区分但稳定的显示 ID。
 *
 * @param userId - 原始用户 ID。
 * @returns 形如 `user-a1b2c3d4` 的假名。
 */
export function pseudonymizeUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return `user-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * 将 Usage 行转换为导出行（假名化 user）。
 *
 * @param rows - Usage 查询行。
 * @returns 导出行。
 */
export function toUsageExportRows(rows: readonly UsageEventRow[]): UsageExportRow[] {
  return rows.map((r) => ({
    requestId: r.requestId,
    fallbackIndex: r.fallbackIndex,
    sessionId: r.sessionId,
    ...(r.usageKind !== undefined ? { usageKind: r.usageKind } : { usageKind: 'conversation' }),
    ...(r.parentRequestId !== undefined ? { parentRequestId: r.parentRequestId } : {}),
    turn: r.turn,
    step: r.step,
    pseudonymousUser: pseudonymizeUser(r.userId),
    provider: r.provider,
    model: r.model,
    routingMode: r.routingMode,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cacheReadTokens: r.cacheReadTokens,
    cacheWriteTokens: r.cacheWriteTokens,
    creditNanos: r.creditNanos.toString(),
    success: r.success,
    latencyMs: r.latencyMs,
    usageMissing: r.usageMissing,
    createdAt: r.createdAt,
  }));
}

/**
 * 将 Decision 行转换为导出行。
 *
 * @param rows - Decision 查询行。
 * @returns 导出行。
 */
export function toDecisionExportRows(rows: readonly DecisionQueryResult[]): DecisionExportRow[] {
  return rows.map((r) => ({
    decisionId: r.decisionId,
    requestId: r.requestId,
    ...(r.sessionId !== undefined ? { sessionId: r.sessionId } : {}),
    ...(r.turn !== undefined ? { turn: r.turn } : {}),
    ...(r.step !== undefined ? { step: r.step } : {}),
    fallbackIndex: r.fallbackIndex,
    ...(r.trigger !== undefined ? { trigger: r.trigger } : {}),
    ...(r.selectionMode !== undefined ? { selectionMode: r.selectionMode } : {}),
    ...(r.effectiveStrategy !== undefined ? { effectiveStrategy: r.effectiveStrategy } : {}),
    outcome: r.outcome,
    ...(r.selectedRoute !== undefined ? { selectedRoute: r.selectedRoute } : {}),
    ...(r.errorCode !== undefined ? { errorCode: r.errorCode } : {}),
    configRevision: r.configRevision,
    createdAt: r.createdAt,
  }));
}

/**
 * 将行数组序列化为 CSV（表头 + 转义单元格）。
 *
 * @param rows - 导出行（对象数组；首行字段决定表头）。
 * @returns CSV 文本。
 */
export function toCsv(rows: readonly Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0] as Record<string, unknown>);
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(
      headers
        .map((h) => {
          const v = (row as Record<string, unknown>)[h];
          return escapeCsvCell(v === undefined || v === null ? '' : String(v));
        })
        .join(','),
    );
  }
  return lines.join('\n');
}

/** 导出结果（上限以先到者为准）。 */
export interface ExportResult {
  /** 序列化文本。 */
  content: string;
  /** 实际导出行数（不含表头）。 */
  rowCount: number;
  /** 是否因上限截断。 */
  truncated: boolean;
  /** 截断原因（行数或字节上限）。 */
  truncatedBy?: 'rows' | 'bytes';
}

/**
 * 执行导出：应用 10,000 行 / 10 MiB 上限（先到者为准）。
 *
 * @param rows - 全量导出行。
 * @param serialize - 序列化函数（CSV 或 JSON）。
 * @returns 导出结果。
 */
export function exportWithLimits(
  rows: readonly Record<string, unknown>[],
  serialize: (rows: readonly Record<string, unknown>[]) => string,
): ExportResult {
  const limited = rows.slice(0, EXPORT_LIMITS.maxRows);
  const content = serialize(limited);
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > EXPORT_LIMITS.maxBytes) {
    // 字节超限：按行二分收缩（简化为逐行裁剪，保证不超限）
    let kept = limited.length;
    let text = content;
    while (kept > 0 && Buffer.byteLength(text, 'utf8') > EXPORT_LIMITS.maxBytes) {
      kept = Math.floor(kept / 2);
      text = serialize(limited.slice(0, kept));
    }
    return {
      content: text,
      rowCount: kept,
      truncated: true,
      truncatedBy: 'bytes',
    };
  }
  return {
    content,
    rowCount: limited.length,
    truncated: rows.length > limited.length,
    ...(rows.length > limited.length ? { truncatedBy: 'rows' as const } : {}),
  };
}
