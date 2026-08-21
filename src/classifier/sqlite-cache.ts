/**
 * GOV-CLASSIFIER-001：SQLite 分类器缓存（运行时接入）。
 *
 * - 缓存键：HMAC-SHA256(canonicalInput) + classifierRoute + promptVersion +
 *   configRevision + tenantScope（规范化合同，HMAC key 存 governor_kv 可轮换）。
 * - 默认 TTL 7 天；过期条目 get 时视为 miss。
 * - 缓存只保存哈希、分类结果、版本与时间——不保存 Prompt 正文。
 * - 失败、超时、非法 JSON 与低置信度结果由调用方（index.ts）决定不写入。
 */
import { createHmac, randomBytes } from 'node:crypto';
import type { GovernorRepository } from '../storage/repository.js';
import type { ClassifierCache, Classification } from './types.js';

/** 默认缓存 TTL（毫秒）：7 天（优化文档 7.1）。 */
export const CLASSIFIER_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** HMAC key 的 kv 存储 key（轮换：更换该值即全部 miss）。 */
const HMAC_KEY_KV = 'classifier_hmac_key_v1';

/**
 * 构建 HMAC-SHA256 规范化输入哈希。
 *
 * @param canonicalInput - 规范化输入文本（JSON）。
 * @param hmacKey - HMAC 密钥。
 * @returns 小写十六进制摘要。
 */
export function hmacInputHash(canonicalInput: string, hmacKey: string): string {
  return createHmac('sha256', hmacKey).update(canonicalInput, 'utf8').digest('hex');
}

/**
 * 构建完整缓存键（版本化合同：inputHash:route:promptVersion:revision:tenant）。
 */
export function buildClassifierCacheKey(
  inputHash: string,
  classifierRoute: string,
  promptVersion: string,
  configRevision: number,
  tenantScope = 'default',
): string {
  return `${inputHash}:${classifierRoute}:${promptVersion}:${configRevision}:${tenantScope}`;
}

/** 由复合键计算存储键：整键 SHA-256 作为 input_hash（任何成分变化即 miss）。 */
function storageKey(key: string): { inputHash: string; configRevision: number } {
  const parts = key.split(':');
  const revision = Number(parts[3] ?? '1');
  const inputHash = createHash('sha256').update(key, 'utf8').digest('hex');
  return { inputHash, configRevision: Number.isFinite(revision) ? revision : 1 };
}

/**
 * SQLite 分类器缓存：读写 classifier_cache 表（HMAC 键 + TTL + revision 失效）。
 */
export class SQLiteClassifierCache implements ClassifierCache {
  private readonly _repo: GovernorRepository;
  private readonly _hmacKey: string;
  private readonly _ttlMs: number;
  private readonly _classifierRoute: string;
  private readonly _promptVersion: string;
  private readonly _tenantScope: string;

  constructor(
    repo: GovernorRepository,
    options?: {
      ttlMs?: number;
      classifierRoute?: string;
      promptVersion?: string;
      tenantScope?: string;
    },
  ) {
    this._repo = repo;
    this._ttlMs = options?.ttlMs ?? CLASSIFIER_CACHE_TTL_MS;
    this._classifierRoute = options?.classifierRoute ?? 'default';
    this._promptVersion = options?.promptVersion ?? 'v1';
    this._tenantScope = options?.tenantScope ?? 'default';
    // HMAC key：kv 已有则复用，否则生成 256 bit 随机值（轮换 = 换 kv 值）
    const existing = repo.getGovernorKv(HMAC_KEY_KV);
    if (existing !== undefined) {
      this._hmacKey = existing;
    } else {
      this._hmacKey = randomBytes(32).toString('hex');
      repo.setGovernorKvIfAbsent(HMAC_KEY_KV, this._hmacKey);
    }
  }

  /** 读取缓存；TTL 过期视为 miss。 */
  get(key: string): Classification | undefined {
    const { inputHash, configRevision } = splitKey(key);
    const row = this._repo.getClassifierCache(inputHash, configRevision);
    if (row === undefined) return undefined;
    // TTL 检查：过期条目视为 miss（惰性；批量清理在保留任务中）
    const createdAt = Date.parse(row.createdAt);
    if (Number.isFinite(createdAt) && Date.now() - createdAt > this._ttlMs) return undefined;
    return {
      taskType: row.taskType as Classification['taskType'],
      complexity: row.complexity as Classification['complexity'],
      confidence: row.confidence,
      source: row.source as Classification['source'],
    };
  }

  /** 写入缓存（幂等 UPSERT）。 */
  set(key: string, value: Classification): void {
    const { inputHash, configRevision } = splitKey(key);
    this._repo.setClassifierCache(inputHash, configRevision, {
      taskType: value.taskType,
      complexity: value.complexity,
      confidence: value.confidence,
      source: value.source,
    });
  }

  /** 生成当前配置下的完整缓存键（供 index.ts 调用）。 */
  buildKey(canonicalInput: string, configRevision: number): string {
    const inputHash = hmacInputHash(canonicalInput, this._hmacKey);
    return buildClassifierCacheKey(
      inputHash,
      this._classifierRoute,
      this._promptVersion,
      configRevision,
      this._tenantScope,
    );
  }
}

/**
 * Single-flight 包装：同一键的并发请求只触发一次底层调用。
 *
 * @returns 带去重的执行器。
 */
export function createSingleFlight(): {
  run: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
} {
  const inflight = new Map<string, Promise<unknown>>();
  return {
    /** 执行 fn；同键并发共享同一 Promise。 */
    run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inflight.get(key);
      if (existing !== undefined) return existing as Promise<T>;
      const p = fn().finally(() => {
        inflight.delete(key);
      });
      inflight.set(key, p);
      return p;
    },
  };
}
