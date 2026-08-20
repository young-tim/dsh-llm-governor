/**
 * Identity Providers 补充单元测试：覆盖 JwtIdentityProvider 的更多错误分支
 * 和辅助函数（verifyAudience 数组形式、签名长度不匹配、非对称算法路径）。
 */
import { describe, it, expect } from 'vitest';
import { createHmac, generateKeyPairSync, createPublicKey } from 'node:crypto';
import {
  JwtIdentityProvider,
  CustomIdentityProvider,
  IdentityError,
} from '../../src/identity/index.js';
import type { IdentityContext, GovernorIdentity } from '../../src/identity/index.js';

const secret = 'test-secret';

/** 用 HS256 构造合法 JWT。 */
function makeJwt(payload: Record<string, unknown>, key: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
  const payloadB64 = enc(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = createHmac('sha256', key).update(signingInput).digest().toString('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/** 构造指定 header 的 JWT（用于自定义 alg 测试）。 */
function makeJwtWithHeader(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: string,
  alg = 'HS256',
): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc({ ...header, typ: 'JWT' });
  const payloadB64 = enc(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = createHmac(alg === 'HS256' ? 'sha256' : 'sha256', key)
    .update(signingInput)
    .digest()
    .toString('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/** 构造任意三段式字符串（不一定是合法 JWT）。 */
function makeRawToken(headerB64: string, payloadB64: string, sigB64: string): string {
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

// ===== JwtIdentityProvider 错误分支 =====

describe('JwtIdentityProvider/错误分支', () => {
  it('无 headers 抛 IDENTITY_REQUIRED', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(provider.resolve({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'IDENTITY_REQUIRED',
    });
  });

  it('scheme="" 时直接用整个 header 值作为 token', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      scheme: '',
    });
    const token = makeJwt({ sub: 'user-1' }, secret);
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: token },
    });
    expect(identity.userId).toBe('user-1');
  });

  it('token 为空抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      scheme: '',
    });
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: '   ' } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('Bearer 后 token 为空抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: 'Bearer ' } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('自定义 header name 读取 token', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      headerName: 'X-JWT',
    });
    const token = makeJwt({ sub: 'user-1' }, secret);
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { 'x-jwt': `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
  });

  it('JWT 不是三段式抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: 'Bearer not.a.jwt' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('JWT 只有两段抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: 'Bearer header.payload' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('JWT 有空段抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: 'Bearer ..sig' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('header 缺少 alg 抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ typ: 'JWT' }); // 无 alg
    const payloadB64 = enc({ sub: 'user-1' });
    const sigB64 = createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest()
      .toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(headerB64, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('alg 不在允许列表抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'HS512', typ: 'JWT' }); // HS512 不在允许列表
    const payloadB64 = enc({ sub: 'user-1' });
    const sigB64 = createHmac('sha512', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest()
      .toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(headerB64, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('nbf 未来时间抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const nbf = Math.floor(Date.now() / 1000) + 3600; // 1 小时后
    const token = makeJwt({ sub: 'user-1', nbf }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('header 不是合法 JSON 抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const badHeader = Buffer.from('not-json').toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    const sigB64 = createHmac('sha256', secret)
      .update(`${badHeader}.${payloadB64}`)
      .digest()
      .toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(badHeader, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('header 是 JSON 数组而非对象抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const arrayHeader = Buffer.from('[1,2,3]').toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url');
    const sigB64 = createHmac('sha256', secret)
      .update(`${arrayHeader}.${payloadB64}`)
      .digest()
      .toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(arrayHeader, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('audience 为数组形式且包含期望值时通过', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      audience: 'expected-aud',
    });
    const token = makeJwt({ sub: 'user-1', aud: ['other-aud', 'expected-aud'] }, secret);
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
  });

  it('audience 为数组形式但不包含期望值时被拒绝', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      audience: 'expected-aud',
    });
    const token = makeJwt({ sub: 'user-1', aud: ['other-aud'] }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('audience 为非字符串非数组（数字）时被拒绝', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      audience: 'expected-aud',
    });
    const token = makeJwt({ sub: 'user-1', aud: 42 }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('clockTolerance 允许轻微的 nbf 偏移', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      clockToleranceMs: 5000,
    });
    const nbf = Math.floor(Date.now() / 1000) + 1; // 1 秒后
    const token = makeJwt({ sub: 'user-1', nbf }, secret);
    // 5 秒容忍度 → 通过
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
  });

  it('clockTolerance 允许轻微的 exp 偏移', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      clockToleranceMs: 5000,
    });
    const exp = Math.floor(Date.now() / 1000) - 1; // 1 秒前过期
    const token = makeJwt({ sub: 'user-1', exp }, secret);
    // 5 秒容忍度 → 通过
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
  });

  it('自定义 subjectClaim 从指定字段读取 userId', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      subjectClaim: 'uid',
    });
    const token = makeJwt({ uid: 'custom-user' }, secret);
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('custom-user');
  });

  it('subjectClaim 字段不存在抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      subjectClaim: 'uid',
    });
    const token = makeJwt({ sub: 'user-1' }, secret); // 没有 uid
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});

// ===== HMAC 密钥类型错误 =====

describe('JwtIdentityProvider/HMAC 密钥类型', () => {
  it('HMAC 算法配 KeyObject 而非 string secret 抛 IDENTITY_INVALID', async () => {
    // 用 RSA KeyObject 作为 key（非 string）→ HMAC 路径会抛错
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: publicKey,
    });
    const token = makeJwt({ sub: 'user-1' }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});

// ===== RSA 算法路径 =====

describe('JwtIdentityProvider/RSA 算法', () => {
  it('RS256 用 RSA 公钥验证签名', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const provider = new JwtIdentityProvider({
      algorithms: ['RS256'],
      key: publicKey,
      issuer: 'test-iss',
      audience: 'test-aud',
    });
    // 手工构造 RS256 JWT
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'RS256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'rsa-user', iss: 'test-iss', aud: 'test-aud' });
    const signingInput = `${headerB64}.${payloadB64}`;
    const { sign } = await import('node:crypto');
    const sigB64 = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    const token = `${headerB64}.${payloadB64}.${sigB64}`;
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('rsa-user');
  });

  it('RS256 签名错误被拒绝', async () => {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const { publicKey: otherPub, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const provider = new JwtIdentityProvider({
      algorithms: ['RS256'],
      key: publicKey,
    });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'RS256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'rsa-user' });
    const signingInput = `${headerB64}.${payloadB64}`;
    const { sign } = await import('node:crypto');
    // 用另一对密钥签名
    const sigB64 = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    const token = `${headerB64}.${payloadB64}.${sigB64}`;
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('RS256 用 PEM 字符串作为 key', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });
    const pemString = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const provider = new JwtIdentityProvider({
      algorithms: ['RS256'],
      key: pemString,
    });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'RS256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'pem-user' });
    const signingInput = `${headerB64}.${payloadB64}`;
    const { sign } = await import('node:crypto');
    const sigB64 = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString('base64url');
    const token = `${headerB64}.${payloadB64}.${sigB64}`;
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('pem-user');
  });
});

// ===== ECDSA 算法路径 =====

describe('JwtIdentityProvider/ECDSA 算法', () => {
  it('ES256 用 EC 公钥验证签名', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const provider = new JwtIdentityProvider({
      algorithms: ['ES256'],
      key: publicKey,
    });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'ES256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'ec-user' });
    const signingInput = `${headerB64}.${payloadB64}`;
    const { sign } = await import('node:crypto');
    // ES256 验证使用 ieee-p1363 编码，签名时也需指定
    const sigB64 = sign('SHA256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const token = `${headerB64}.${payloadB64}.${sigB64}`;
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('ec-user');
  });
});

// ===== 不支持的算法 =====

describe('JwtIdentityProvider/不支持的算法', () => {
  it('未在 HMAC/RSA/PSS/ECDSA 中的 alg 抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'BOGUS256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'user-1' });
    const sigB64 = Buffer.from('sig').toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(headerB64, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});

// ===== 签名长度不匹配 =====

describe('JwtIdentityProvider/签名长度不匹配', () => {
  it('HMAC 签名长度不一致返回 false', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
    const payloadB64 = enc({ sub: 'user-1' });
    // 短签名
    const sigB64 = Buffer.from('short').toString('base64url');
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { authorization: `Bearer ${makeRawToken(headerB64, payloadB64, sigB64)}` },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});

// ===== displayName / email claim 缺失 =====

describe('JwtIdentityProvider/可选 claim', () => {
  it('displayName claim 配置但不存在时不报错', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      displayNameClaim: 'name',
    });
    const token = makeJwt({ sub: 'user-1' }, secret); // 无 name
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
    expect(identity.displayName).toBeUndefined();
  });

  it('email claim 配置但不存在时不报错', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      emailClaim: 'email',
    });
    const token = makeJwt({ sub: 'user-1' }, secret); // 无 email
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
    expect(identity.email).toBeUndefined();
  });
});
