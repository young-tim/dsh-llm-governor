/**
 * 四种 IdentityProvider 实现：local、header、jwt、custom。
 *
 * 领域层，不导入任何 DSH 包。JWT 验证使用 Node crypto 模块。
 * 安全约束：
 * - JWT 禁止 alg=none，禁止只 decode 不 verify
 * - Header 模式必须配置可信代理来源
 * - 无身份或身份无效时 fail closed（抛 IdentityError）
 */
import {
  type JsonWebKey,
  KeyObject,
  constants as cryptoConstants,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify as cryptoVerify,
} from 'node:crypto';
import { IdentityError } from './types.js';
import type { GovernorIdentity, IdentityContext, IdentityProvider } from './types.js';

// ===== LocalIdentityProvider =====

/** LocalIdentityProvider 配置。 */
export interface LocalIdentityProviderConfig {
  /** 固定 user_id，默认 'local'。 */
  userId?: string;
  /** 展示名。 */
  displayName?: string;
  /** 邮箱。 */
  email?: string;
}

/**
 * LocalIdentityProvider：返回配置的固定 user_id，默认 'local'。
 * 适用于单用户或本地开发场景。
 */
export class LocalIdentityProvider implements IdentityProvider {
  readonly kind = 'local';
  private readonly _identity: GovernorIdentity;

  constructor(config: LocalIdentityProviderConfig = {}) {
    const userId = config.userId ?? 'local';
    if (!userId) {
      throw new IdentityError('IDENTITY_REQUIRED', 'local user_id must not be empty');
    }
    const identity: GovernorIdentity = { userId };
    if (config.displayName !== undefined) {
      identity.displayName = config.displayName;
    }
    if (config.email !== undefined) {
      identity.email = config.email;
    }
    this._identity = identity;
  }

  /** 返回配置的固定身份。 */
  async resolve(_context: IdentityContext): Promise<GovernorIdentity> {
    return this._identity;
  }
}

// ===== HeaderIdentityProvider =====

/** HeaderIdentityProvider 配置。 */
export interface HeaderIdentityProviderConfig {
  /** 读取 user_id 的 Header 名（查找时不区分大小写）。必填。 */
  headerName: string;
  /** 可信代理来源标识，必填。强制声明信任边界。 */
  trustedProxy: string;
  /** 代理标识 Header 名，可选。配置后验证该 Header 值等于 trustedProxy。 */
  proxyHeaderName?: string;
  /** 读取展示名的 Header 名，可选。 */
  displayNameHeader?: string;
  /** 读取邮箱的 Header 名，可选。 */
  emailHeader?: string;
}

/**
 * HeaderIdentityProvider：从 Header 读取 user_id。
 * 由 Web 入站 adapter 在可信反向代理之后读取 Header，并在 Agent 首次使用前绑定 session。
 * 必须配置可信代理来源；代理必须覆盖并删除客户端伪造 Header。
 */
export class HeaderIdentityProvider implements IdentityProvider {
  readonly kind = 'header';
  private readonly _headerName: string;
  private readonly _trustedProxy: string;
  private readonly _proxyHeaderName: string | undefined;
  private readonly _displayNameHeader: string | undefined;
  private readonly _emailHeader: string | undefined;

  constructor(config: HeaderIdentityProviderConfig) {
    if (!config.headerName) {
      throw new IdentityError('IDENTITY_INVALID', 'headerName must be configured');
    }
    if (!config.trustedProxy) {
      throw new IdentityError('IDENTITY_INVALID', 'trustedProxy must be configured');
    }
    this._headerName = config.headerName;
    this._trustedProxy = config.trustedProxy;
    this._proxyHeaderName = config.proxyHeaderName;
    this._displayNameHeader = config.displayNameHeader;
    this._emailHeader = config.emailHeader;
  }

  /** 从 Header 读取 user_id 并构造身份。 */
  async resolve(context: IdentityContext): Promise<GovernorIdentity> {
    if (!context.headers) {
      throw new IdentityError('IDENTITY_REQUIRED', 'no headers in identity context');
    }
    const headers = toLowerHeaderMap(context.headers);

    // 可信代理验证（可选）
    if (this._proxyHeaderName !== undefined) {
      const proxyValue = headers.get(this._proxyHeaderName.toLowerCase());
      if (proxyValue !== this._trustedProxy) {
        throw new IdentityError('IDENTITY_INVALID', 'trusted proxy verification failed');
      }
    }

    // 读取 user_id
    const userId = headers.get(this._headerName.toLowerCase());
    if (!userId) {
      throw new IdentityError(
        'IDENTITY_REQUIRED',
        `header '${this._headerName}' not present or empty`,
      );
    }

    const identity: GovernorIdentity = { userId };
    if (this._displayNameHeader !== undefined) {
      const displayName = headers.get(this._displayNameHeader.toLowerCase());
      if (displayName) {
        identity.displayName = displayName;
      }
    }
    if (this._emailHeader !== undefined) {
      const email = headers.get(this._emailHeader.toLowerCase());
      if (email) {
        identity.email = email;
      }
    }
    return identity;
  }
}

// ===== JwtIdentityProvider =====

/** JWT 密钥类型。HMAC 算法用 string；RSA/ECDSA 用 PEM 字符串、JWK 或 KeyObject。 */
export type JwtKey = string | JsonWebKey | KeyObject;

/** JwtIdentityProvider 配置。 */
export interface JwtIdentityProviderConfig {
  /** 允许的算法列表，如 ['RS256', 'ES256']。不能包含 'none'。必填。 */
  algorithms: readonly string[];
  /**
   * 验证签名的密钥。
   * HMAC 算法用字符串密钥；RSA/ECDSA 用 PEM 字符串、JWK 或 KeyObject。
   */
  key: JwtKey;
  /** 预期 issuer。配置后验证 JWT iss claim 必须匹配。 */
  issuer?: string;
  /** 预期 audience。配置后验证 JWT aud claim 必须匹配。 */
  audience?: string;
  /** 映射 userId 的 claim 名，默认 'sub'。 */
  subjectClaim?: string;
  /** 展示名 claim 名，如 'name'。 */
  displayNameClaim?: string;
  /** 邮箱 claim 名，如 'email'。 */
  emailClaim?: string;
  /** 时钟偏差（毫秒），默认 0。 */
  clockToleranceMs?: number;
  /** 从 Header 读取 JWT 的 Header 名（不区分大小写），默认 'authorization'。 */
  headerName?: string;
  /** Authorization scheme 前缀，默认 'Bearer '。设为空字符串禁用 scheme 检查。 */
  scheme?: string;
}

/** HMAC 算法到 Node hash 算法的映射。 */
const HMAC_ALGS: Readonly<Record<string, string>> = {
  HS256: 'sha256',
  HS384: 'sha384',
  HS512: 'sha512',
};

/** RSA 算法到 Node verify 算法的映射。 */
const RSA_ALGS: Readonly<Record<string, string>> = {
  RS256: 'RSA-SHA256',
  RS384: 'RSA-SHA384',
  RS512: 'RSA-SHA512',
};

/** RSA-PSS 算法到 Node verify 算法的映射。 */
const PSS_ALGS: Readonly<Record<string, string>> = {
  PS256: 'RSA-SHA256',
  PS384: 'RSA-SHA384',
  PS512: 'RSA-SHA512',
};

/** ECDSA 算法到 Node verify hash 算法的映射。 */
const ECDSA_ALGS: Readonly<Record<string, string>> = {
  ES256: 'SHA256',
  ES384: 'SHA384',
  ES512: 'SHA512',
};

/**
 * JwtIdentityProvider：验证 JWT 签名、允许算法、issuer、audience、exp、nbf 后映射 subject claim。
 *
 * 安全约束：
 * - 禁止 alg=none
 * - 禁止只 decode 不 verify，必须验证签名
 * - 密钥轮换失败时拒绝新请求
 */
export class JwtIdentityProvider implements IdentityProvider {
  readonly kind = 'jwt';
  private readonly _algorithms: readonly string[];
  private readonly _key: JwtKey;
  private readonly _issuer: string | undefined;
  private readonly _audience: string | undefined;
  private readonly _subjectClaim: string;
  private readonly _displayNameClaim: string | undefined;
  private readonly _emailClaim: string | undefined;
  private readonly _clockToleranceMs: number;
  private readonly _headerName: string;
  private readonly _scheme: string;

  constructor(config: JwtIdentityProviderConfig) {
    if (config.algorithms.length === 0) {
      throw new IdentityError(
        'IDENTITY_INVALID',
        'at least one allowed algorithm must be configured',
      );
    }
    if (config.algorithms.includes('none')) {
      throw new IdentityError('IDENTITY_INVALID', "algorithm 'none' is forbidden");
    }
    this._algorithms = [...config.algorithms];
    this._key = config.key;
    this._issuer = config.issuer;
    this._audience = config.audience;
    this._subjectClaim = config.subjectClaim ?? 'sub';
    this._displayNameClaim = config.displayNameClaim;
    this._emailClaim = config.emailClaim;
    this._clockToleranceMs = config.clockToleranceMs ?? 0;
    this._headerName = config.headerName ?? 'authorization';
    this._scheme = config.scheme ?? 'Bearer ';
  }

  /** 从 Header 读取 JWT，验证签名和 claims，返回身份。 */
  async resolve(context: IdentityContext): Promise<GovernorIdentity> {
    if (!context.headers) {
      throw new IdentityError('IDENTITY_REQUIRED', 'no headers in identity context');
    }
    const headers = toLowerHeaderMap(context.headers);

    // 读取 Authorization header
    const authHeader = headers.get(this._headerName.toLowerCase());
    if (!authHeader) {
      throw new IdentityError('IDENTITY_REQUIRED', `jwt header '${this._headerName}' not present`);
    }

    // 提取 token（去除 scheme 前缀）
    let token: string;
    if (this._scheme.length > 0) {
      if (!authHeader.startsWith(this._scheme)) {
        throw new IdentityError('IDENTITY_INVALID', 'authorization scheme mismatch');
      }
      token = authHeader.slice(this._scheme.length).trim();
    } else {
      token = authHeader.trim();
    }
    if (!token) {
      throw new IdentityError('IDENTITY_INVALID', 'jwt token is empty');
    }

    return this._verifyToken(token);
  }

  /** 验证 JWT 签名和 claims，返回身份。 */
  private _verifyToken(token: string): GovernorIdentity {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new IdentityError('IDENTITY_INVALID', 'jwt must have exactly 3 parts');
    }
    const headerB64 = parts[0];
    const payloadB64 = parts[1];
    const signatureB64 = parts[2];
    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new IdentityError('IDENTITY_INVALID', 'jwt has empty part');
    }

    // 解析 header（不信任 alg，与允许列表交叉校验）
    const header = parseJson(base64UrlDecode(headerB64));
    const alg = readStringClaim(header, 'alg');
    if (!alg) {
      throw new IdentityError('IDENTITY_INVALID', 'jwt header missing alg');
    }
    if (alg === 'none') {
      throw new IdentityError('IDENTITY_INVALID', "algorithm 'none' is forbidden");
    }
    if (!this._algorithms.includes(alg)) {
      throw new IdentityError('IDENTITY_INVALID', `algorithm '${alg}' not allowed`);
    }

    // 验证签名（禁止只 decode 不 verify）
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = base64UrlDecode(signatureB64);
    if (!verifySignature(alg, this._key, signingInput, signature)) {
      throw new IdentityError('IDENTITY_INVALID', 'jwt signature verification failed');
    }

    // 解析 payload
    const payload = parseJson(base64UrlDecode(payloadB64));

    // 验证 issuer（配置了才校验）
    if (this._issuer !== undefined) {
      const iss = readStringClaim(payload, 'iss');
      if (iss !== this._issuer) {
        throw new IdentityError('IDENTITY_INVALID', 'jwt issuer mismatch');
      }
    }

    // 验证 audience（配置了才校验）
    if (this._audience !== undefined) {
      if (!verifyAudience(payload['aud'], this._audience)) {
        throw new IdentityError('IDENTITY_INVALID', 'jwt audience mismatch');
      }
    }

    const now = Date.now();
    const toleranceMs = this._clockToleranceMs;

    // 验证 exp（存在才校验）
    const exp = payload['exp'];
    if (typeof exp === 'number') {
      if (now > exp * 1000 + toleranceMs) {
        throw new IdentityError('IDENTITY_EXPIRED', 'jwt has expired');
      }
    }

    // 验证 nbf（存在才校验）
    const nbf = payload['nbf'];
    if (typeof nbf === 'number') {
      if (now + toleranceMs < nbf * 1000) {
        throw new IdentityError('IDENTITY_INVALID', 'jwt not yet valid (nbf)');
      }
    }

    // 提取 userId
    const userId = readStringClaim(payload, this._subjectClaim);
    if (!userId) {
      throw new IdentityError(
        'IDENTITY_INVALID',
        `jwt '${this._subjectClaim}' claim missing or not a non-empty string`,
      );
    }

    const identity: GovernorIdentity = { userId };
    if (this._displayNameClaim !== undefined) {
      const displayName = readStringClaim(payload, this._displayNameClaim);
      if (displayName) {
        identity.displayName = displayName;
      }
    }
    if (this._emailClaim !== undefined) {
      const email = readStringClaim(payload, this._emailClaim);
      if (email) {
        identity.email = email;
      }
    }
    return identity;
  }
}

// ===== CustomIdentityProvider =====

/** 第三方注册的自定义解析函数。 */
export type CustomResolveFn = (context: IdentityContext) => Promise<GovernorIdentity>;

/**
 * CustomIdentityProvider：包装第三方插件注册的 resolve 函数。
 * 由第三方插件向 ctx.governor.identity 注册。
 */
export class CustomIdentityProvider implements IdentityProvider {
  readonly kind: string;
  private readonly _resolveFn: CustomResolveFn;

  constructor(resolveFn: CustomResolveFn, kind: string = 'custom') {
    this.kind = kind;
    this._resolveFn = resolveFn;
  }

  /** 调用第三方 resolve 函数，校验返回的 userId 非空。 */
  async resolve(context: IdentityContext): Promise<GovernorIdentity> {
    const identity = await this._resolveFn(context);
    if (!identity || !identity.userId) {
      throw new IdentityError('IDENTITY_REQUIRED', 'custom provider returned empty user_id');
    }
    return identity;
  }
}

// ===== 辅助函数 =====

/** 将 headers 对象转为小写键的 Map，实现不区分大小写的 Header 查找。 */
function toLowerHeaderMap(headers: Readonly<Record<string, string>>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) {
    map.set(k.toLowerCase(), v);
  }
  return map;
}

/** Base64URL 解码为 Buffer。 */
function base64UrlDecode(str: string): Buffer {
  return Buffer.from(str, 'base64url');
}

/** 将 Buffer 解析为 JSON 对象，非法 JSON 或非对象抛 IdentityError。 */
function parseJson(buf: Buffer): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new IdentityError('IDENTITY_INVALID', 'failed to parse JSON');
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new IdentityError('IDENTITY_INVALID', 'expected JSON object');
  }
  return obj as Record<string, unknown>;
}

/** 从 JSON 对象读取非空字符串 claim，非字符串或缺失返回 undefined。 */
function readStringClaim(obj: Record<string, unknown>, key: string): string | undefined {
  const val = obj[key];
  if (typeof val === 'string' && val.length > 0) {
    return val;
  }
  return undefined;
}

/** 验证 audience claim，支持字符串和数组形式。 */
function verifyAudience(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') {
    return aud === expected;
  }
  if (Array.isArray(aud)) {
    return aud.includes(expected);
  }
  return false;
}

/**
 * 验证 JWT 签名。
 * HMAC 算法用 createHmac + timingSafeEqual；RSA/ECDSA/PSS 用 crypto.verify。
 * 不支持的算法抛 IdentityError。
 */
function verifySignature(
  alg: string,
  key: JwtKey,
  signingInput: string,
  signature: Buffer,
): boolean {
  // HMAC（HS256/HS384/HS512）
  const hmacAlg = HMAC_ALGS[alg];
  if (hmacAlg !== undefined) {
    if (typeof key !== 'string') {
      throw new IdentityError(
        'IDENTITY_INVALID',
        `HMAC algorithm '${alg}' requires string secret key`,
      );
    }
    const hmac = createHmac(hmacAlg, key);
    hmac.update(signingInput);
    const expected = hmac.digest();
    if (expected.length !== signature.length) {
      return false;
    }
    return timingSafeEqual(expected, signature);
  }

  // RSA（RS256/RS384/RS512）
  const rsaAlg = RSA_ALGS[alg];
  if (rsaAlg !== undefined) {
    const publicKey = ensurePublicKey(key);
    return cryptoVerify(rsaAlg, Buffer.from(signingInput, 'utf8'), publicKey, signature);
  }

  // RSA-PSS（PS256/PS384/PS512）
  const pssAlg = PSS_ALGS[alg];
  if (pssAlg !== undefined) {
    const publicKey = ensurePublicKey(key);
    return cryptoVerify(
      pssAlg,
      Buffer.from(signingInput, 'utf8'),
      { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING },
      signature,
    );
  }

  // ECDSA（ES256/ES384/ES512）
  const ecdsaAlg = ECDSA_ALGS[alg];
  if (ecdsaAlg !== undefined) {
    const publicKey = ensurePublicKey(key);
    return cryptoVerify(
      ecdsaAlg,
      Buffer.from(signingInput, 'utf8'),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  }

  throw new IdentityError('IDENTITY_INVALID', `unsupported algorithm: ${alg}`);
}

/** 将密钥转换为 KeyObject（用于 RSA/ECDSA 等非对称算法）。 */
function ensurePublicKey(key: JwtKey): KeyObject {
  if (key instanceof KeyObject) {
    return key;
  }
  if (typeof key === 'string') {
    // PEM 字符串
    return createPublicKey(key);
  }
  // JWK
  return createPublicKey({ key, format: 'jwk' });
}
