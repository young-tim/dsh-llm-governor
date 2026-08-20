/**
 * Identity 模块单元测试：覆盖 Local/Header/Jwt/Custom Provider 与 SessionIdentityStore。
 */
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  LocalIdentityProvider,
  HeaderIdentityProvider,
  JwtIdentityProvider,
  CustomIdentityProvider,
  SessionIdentityStore,
  IdentityError,
} from '../../src/identity/index.js';
import type { GovernorIdentity, IdentityContext } from '../../src/identity/index.js';

// ===== LocalIdentityProvider =====

describe('LocalIdentityProvider', () => {
  it('默认返回 user_id="local"', async () => {
    const provider = new LocalIdentityProvider();
    const identity = await provider.resolve({ sessionId: 's1' });
    expect(identity.userId).toBe('local');
    expect(provider.kind).toBe('local');
  });

  it('返回配置的 user_id 与展示属性', async () => {
    const provider = new LocalIdentityProvider({
      userId: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
    });
    const identity = await provider.resolve({ sessionId: 's1' });
    expect(identity.userId).toBe('alice');
    expect(identity.displayName).toBe('Alice');
    expect(identity.email).toBe('alice@example.com');
  });

  it('显式空 user_id 抛 IDENTITY_REQUIRED', () => {
    let caught: IdentityError | undefined;
    try {
      new LocalIdentityProvider({ userId: '' });
    } catch (e) {
      caught = e as IdentityError;
    }
    expect(caught).toBeInstanceOf(IdentityError);
    expect(caught!.code).toBe('IDENTITY_REQUIRED');
  });
});

// ===== HeaderIdentityProvider =====

describe('HeaderIdentityProvider', () => {
  it('从 header 读取 user_id（大小写不敏感）', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
    });
    // header 名大小写与配置不同
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { 'x-user-id': 'bob' },
    });
    expect(identity.userId).toBe('bob');
    expect(provider.kind).toBe('header');
  });

  it('携带 displayName/email header 时一并读取', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
      displayNameHeader: 'X-Display-Name',
      emailHeader: 'X-Email',
    });
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: {
        'X-User-Id': 'bob',
        'x-display-name': 'Bob',
        'x-email': 'bob@example.com',
      },
    });
    expect(identity.userId).toBe('bob');
    expect(identity.displayName).toBe('Bob');
    expect(identity.email).toBe('bob@example.com');
  });

  it('无 trustedProxy 配置时抛 IDENTITY_INVALID', () => {
    let caught: IdentityError | undefined;
    try {
      new HeaderIdentityProvider({ headerName: 'X-User-Id', trustedProxy: '' });
    } catch (e) {
      caught = e as IdentityError;
    }
    expect(caught).toBeInstanceOf(IdentityError);
    expect(caught!.code).toBe('IDENTITY_INVALID');
  });

  it('无 headerName 配置时抛 IDENTITY_INVALID', () => {
    expect(() => new HeaderIdentityProvider({ headerName: '', trustedProxy: 'p' })).toThrow(
      IdentityError,
    );
  });

  it('无 headers 抛 IDENTITY_REQUIRED', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
    });
    await expect(provider.resolve({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'IDENTITY_REQUIRED',
    });
  });

  it('缺失 user_id header 抛 IDENTITY_REQUIRED', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
    });
    await expect(
      provider.resolve({ sessionId: 's1', headers: { 'X-Other': 'x' } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_REQUIRED' });
  });

  it('proxyHeaderName 不匹配 trustedProxy 抛 IDENTITY_INVALID', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
      proxyHeaderName: 'X-Proxy',
    });
    await expect(
      provider.resolve({
        sessionId: 's1',
        headers: { 'X-User-Id': 'bob', 'X-Proxy': 'evil' },
      }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('proxyHeaderName 匹配 trustedProxy 时通过', async () => {
    const provider = new HeaderIdentityProvider({
      headerName: 'X-User-Id',
      trustedProxy: 'trusted-proxy',
      proxyHeaderName: 'X-Proxy',
    });
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { 'X-User-Id': 'bob', 'X-Proxy': 'trusted-proxy' },
    });
    expect(identity.userId).toBe('bob');
  });
});

// ===== JwtIdentityProvider =====

/** 用 HS256 算法构造合法 JWT。 */
function makeJwt(payload: Record<string, unknown>, secret: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc({ alg: 'HS256', typ: 'JWT' });
  const payloadB64 = enc(payload);
  const signingInput = `${headerB64}.${payloadB64}`;
  const sigB64 = createHmac('sha256', secret).update(signingInput).digest().toString('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

/** 构造 alg=none 的非空签名 JWT。 */
function makeNoneJwt(): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64 = enc({ alg: 'none', typ: 'JWT' });
  const payloadB64 = enc({ sub: 'user-1' });
  const sigB64 = Buffer.from('sig').toString('base64url');
  return `${headerB64}.${payloadB64}.${sigB64}`;
}

describe('JwtIdentityProvider', () => {
  const secret = 'test-secret';

  it('禁止构造时配置 alg=none', () => {
    let caught: IdentityError | undefined;
    try {
      new JwtIdentityProvider({ algorithms: ['none'], key: secret });
    } catch (e) {
      caught = e as IdentityError;
    }
    expect(caught).toBeInstanceOf(IdentityError);
    expect(caught!.code).toBe('IDENTITY_INVALID');
  });

  it('禁止空算法列表', () => {
    expect(() => new JwtIdentityProvider({ algorithms: [], key: secret })).toThrow(IdentityError);
  });

  it('HS256 合法签名通过验证并解析身份', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      displayNameClaim: 'name',
      emailClaim: 'email',
    });
    const token = makeJwt({ sub: 'user-1', name: 'Alice', email: 'alice@example.com' }, secret);
    const identity = await provider.resolve({
      sessionId: 's1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(identity.userId).toBe('user-1');
    expect(identity.displayName).toBe('Alice');
    expect(identity.email).toBe('alice@example.com');
    expect(provider.kind).toBe('jwt');
  });

  it('过期 JWT 被拒绝（IDENTITY_EXPIRED）', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const exp = Math.floor(Date.now() / 1000) - 3600; // 1 小时前
    const token = makeJwt({ sub: 'user-1', exp }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_EXPIRED' });
  });

  it('签名错误被拒绝（IDENTITY_INVALID）', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const token = makeJwt({ sub: 'user-1' }, 'wrong-secret');
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('header 中 alg=none 即便 allowed 不含 none 也被拒绝', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const token = makeNoneJwt();
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('issuer 不匹配被拒绝', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      issuer: 'expected-issuer',
    });
    const token = makeJwt({ sub: 'user-1', iss: 'wrong-issuer' }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('audience 不匹配被拒绝', async () => {
    const provider = new JwtIdentityProvider({
      algorithms: ['HS256'],
      key: secret,
      audience: 'expected-aud',
    });
    const token = makeJwt({ sub: 'user-1', aud: 'wrong-aud' }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('缺失 Authorization header 抛 IDENTITY_REQUIRED', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    await expect(provider.resolve({ sessionId: 's1', headers: {} })).rejects.toMatchObject({
      code: 'IDENTITY_REQUIRED',
    });
  });

  it('scheme 不匹配抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const token = makeJwt({ sub: 'user-1' }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Basic ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });

  it('缺失 sub claim 抛 IDENTITY_INVALID', async () => {
    const provider = new JwtIdentityProvider({ algorithms: ['HS256'], key: secret });
    const token = makeJwt({ other: 'value' }, secret);
    await expect(
      provider.resolve({ sessionId: 's1', headers: { authorization: `Bearer ${token}` } }),
    ).rejects.toMatchObject({ code: 'IDENTITY_INVALID' });
  });
});

// ===== CustomIdentityProvider =====

describe('CustomIdentityProvider', () => {
  it('包装第三方 resolve 函数并校验返回值', async () => {
    const resolveFn = async (ctx: IdentityContext): Promise<GovernorIdentity> => {
      return { userId: `ext:${ctx.sessionId}` };
    };
    const provider = new CustomIdentityProvider(resolveFn, 'ext');
    const identity = await provider.resolve({ sessionId: 's1' });
    expect(identity.userId).toBe('ext:s1');
    expect(provider.kind).toBe('ext');
  });

  it('未传 kind 时默认为 custom', async () => {
    const provider = new CustomIdentityProvider(async () => ({ userId: 'u' }));
    expect(provider.kind).toBe('custom');
  });

  it('返回空 user_id 抛 IDENTITY_REQUIRED', async () => {
    const provider = new CustomIdentityProvider(async () => ({ userId: '' }));
    await expect(provider.resolve({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'IDENTITY_REQUIRED',
    });
  });

  it('第三方 resolve 返回 undefined 抛 IDENTITY_REQUIRED', async () => {
    const provider = new CustomIdentityProvider(
      async () => undefined as unknown as GovernorIdentity,
    );
    await expect(provider.resolve({ sessionId: 's1' })).rejects.toMatchObject({
      code: 'IDENTITY_REQUIRED',
    });
  });
});

// ===== SessionIdentityStore =====

describe('SessionIdentityStore', () => {
  it('bind/resolve/clear 生命周期', () => {
    const store = new SessionIdentityStore();
    const identity: GovernorIdentity = { userId: 'alice' };
    store.bind('s1', identity, 'header');
    expect(store.has('s1')).toBe(true);
    expect(store.resolve('s1')).toEqual(identity);
    store.clear('s1');
    expect(store.has('s1')).toBe(false);
    expect(store.resolve('s1')).toBeUndefined();
  });

  it('未绑定的 session resolve/has 返回 undefined/false', () => {
    const store = new SessionIdentityStore();
    expect(store.resolve('unknown')).toBeUndefined();
    expect(store.has('unknown')).toBe(false);
  });

  it('过期绑定 resolve 返回 undefined 并清除', async () => {
    const store = new SessionIdentityStore();
    const identity: GovernorIdentity = { userId: 'bob' };
    store.bind('s1', identity, 'header', 1); // 1ms 存活
    await new Promise((r) => setTimeout(r, 10));
    expect(store.resolve('s1')).toBeUndefined();
    // 二次 resolve 仍然返回 undefined（已被清除）
    expect(store.has('s1')).toBe(false);
  });

  it('未过期绑定可正常 resolve', () => {
    const store = new SessionIdentityStore();
    const identity: GovernorIdentity = { userId: 'carol' };
    store.bind('s1', identity, 'local', 60_000);
    expect(store.resolve('s1')).toEqual(identity);
    expect(store.has('s1')).toBe(true);
  });

  it('无 ttl 的绑定永不过期', () => {
    const store = new SessionIdentityStore();
    const identity: GovernorIdentity = { userId: 'dave' };
    store.bind('s1', identity, 'jwt');
    expect(store.resolve('s1')).toEqual(identity);
  });
});
