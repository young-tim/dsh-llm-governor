/**
 * Governor HTTP API 请求处理器（GOV-SEC-001 安全收敛版）。
 *
 * - 方法级 capability 矩阵：governor.read / governor.manage / governor.audit，
 *   Host 端逐方法复核，不依赖菜单或按钮隐藏。
 * - 认证：Bearer token（Authorization: Bearer <token>），不使用 Cookie；
 *   未认证访问受保护资源返回 UNAUTHORIZED，权限不足返回 FORBIDDEN。
 * - CORS：默认不返回 CORS 头（同源语义）；显式配置 allowedOrigin 时只返回
 *   该 origin，绝不返回通配 `*`。
 * - 请求体上限 256 KiB；列表分页遵循 50/200 与 31 天窗口（service 层保证）。
 * - 错误响应只包含 code、requestId 与安全摘要，不泄露 SQL/路径/正文。
 *
 * 挂载方式：
 * 1. createGovernorApiServer：兼容 API 独立服务器（仅显式 compatApi.enabled
 *    时监听 loopback；handler 强制校验 loopback peer）。
 * 2. DSH webServer 前缀路由：/governor 注册到 ctx.webServer（受信 Host 面）。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { RoutingError } from '../routing/types.js';
/** 模块所在目录，用于定位 pages 子目录中的 HTML 文件。 */
const __dirname = dirname(fileURLToPath(import.meta.url));
/** HTML 页面目录。 */
const pagesDir = join(__dirname, 'pages');
/** 请求体上限（字节）：Remote/兼容 API 256 KiB（优化文档 7.1）。 */
export const MAX_REQUEST_BODY_BYTES = 256 * 1024;
/**
 * 生成至少 256 bit 的随机 Bearer token（部署方未提供时使用）。
 *
 * @returns 64 个十六进制字符（256 bit）的随机 token。
 */
export function generateCompatToken() {
    return randomBytes(32).toString('hex');
}
/**
 * 判断请求是否来自本地回环地址。
 * @param req - HTTP 请求对象。
 * @returns 是否为本地请求。
 */
function isLocalRequest(req) {
    const addr = req.socket.remoteAddress;
    if (!addr)
        return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
export { isLocalRequest };
/**
 * 创建 Governor 请求处理器。
 *
 * @param governor - GovernorService 实例，端点将调用其方法。
 * @param opts - 认证主体与 CORS 配置。
 * @returns 处理器函数；basePath 是挂载前缀（如 '/governor'），会先从路径中剥离。
 */
export function createGovernorRequestHandler(governor, opts) {
    /** token → actor 的映射（常量时间比较交给部署层；此处为本地进程内匹配）。 */
    const actors = new Map();
    for (const cfg of opts?.actors ?? []) {
        actors.set(cfg.token, {
            id: `token-${cfg.token.slice(0, 8)}`,
            capabilities: new Set(cfg.capabilities),
        });
    }
    // 兼容旧 adminToken：映射为全能力主体（迁移期保留，新部署应使用 actors）。
    if (opts?.adminToken !== undefined && !actors.has(opts.adminToken)) {
        actors.set(opts.adminToken, {
            id: 'legacy-admin',
            capabilities: new Set([
                'governor.read',
                'governor.manage',
                'governor.audit',
            ]),
        });
    }
    /** HTML 页面内容缓存，避免每次请求都读磁盘。 */
    const htmlCache = new Map();
    /** 允许访问的静态页面白名单。 */
    const allowedPages = new Set(['models.html', 'users.html', 'usage.html']);
    /**
     * 读取 HTML 页面（带缓存）。
     * @param name - 页面文件名，如 "models.html"。
     * @returns HTML 文本。
     */
    async function readPage(name) {
        const cached = htmlCache.get(name);
        if (cached !== undefined)
            return cached;
        try {
            const html = await readFile(join(pagesDir, name), 'utf-8');
            htmlCache.set(name, html);
            return html;
        }
        catch {
            return null;
        }
    }
    /**
     * 解析请求主体：Authorization: Bearer <token>；无凭证时返回默认主体
     * （仅 DSH webServer 受信前缀通道配置 defaultCapabilities 时）。
     *
     * @param req - HTTP 请求对象。
     * @returns 已认证主体；未认证返回 undefined。
     */
    function authenticate(req) {
        const header = req.headers['authorization'];
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            if ((opts?.defaultCapabilities?.length ?? 0) > 0) {
                return { id: 'dsh-webserver-channel', capabilities: new Set(opts?.defaultCapabilities) };
            }
            return undefined;
        }
        const token = header.slice('Bearer '.length);
        return actors.get(token);
    }
    /**
     * 发送 JSON 响应。CORS 只在显式配置 allowedOrigin 时返回该 origin（不返回 `*`）。
     * @param res - HTTP 响应对象。
     * @param status - HTTP 状态码。
     * @param body - 响应体（bigint 序列化为 number）。
     */
    function sendJson(res, status, body) {
        const json = JSON.stringify(body, (_key, value) => typeof value === 'bigint' ? Number(value) : value);
        const headers = {
            'Content-Type': 'application/json; charset=utf-8',
        };
        if (opts?.allowedOrigin !== undefined) {
            headers['Access-Control-Allow-Origin'] = opts.allowedOrigin;
            headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
            headers['Access-Control-Allow-Methods'] = 'GET, PATCH, OPTIONS';
            headers['Vary'] = 'Origin';
        }
        res.writeHead(status, headers);
        res.end(json);
    }
    /**
     * 发送安全错误响应：只包含 code、requestId 与摘要。
     * @param res - HTTP 响应对象。
     * @param status - HTTP 状态码。
     * @param code - 稳定错误码。
     */
    function sendError(res, status, code) {
        sendJson(res, status, { code, requestId: randomBytes(8).toString('hex') });
    }
    /**
     * 读取请求体文本（上限 256 KiB，超限拒绝）。
     * @param req - HTTP 请求对象。
     * @returns 请求体字符串；超限抛错。
     */
    function readBody(req) {
        return new Promise((resolve, reject) => {
            const declared = parseInt(req.headers['content-length'] ?? '0', 10);
            if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
                reject(new Error('PAYLOAD_TOO_LARGE'));
                return;
            }
            let size = 0;
            const chunks = [];
            req.on('data', (chunk) => {
                size += chunk.length;
                if (size > MAX_REQUEST_BODY_BYTES) {
                    reject(new Error('PAYLOAD_TOO_LARGE'));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            req.on('error', reject);
        });
    }
    /**
     * capability 检查：矩阵复核（Host 端，不依赖 UI 隐藏）。
     * @param actor - 已认证主体。
     * @param capability - 端点要求的 capability。
     * @returns 是否允许。
     */
    function hasCapability(actor, capability) {
        return actor?.capabilities.has(capability) ?? false;
    }
    /**
     * 将服务层异常转换为安全错误响应（不泄露内部细节）。
     * @param res - HTTP 响应对象。
     * @param err - 捕获到的异常。
     */
    function handleError(res, err) {
        if (err instanceof RoutingError) {
            // RoutingError 携带稳定 code（REVISION_CONFLICT 等），message 含安全摘要
            if (err.code === 'REVISION_CONFLICT') {
                sendError(res, 409, 'REVISION_CONFLICT');
                return;
            }
            if (err.code === 'UNAUTHORIZED' || err.code === 'FORBIDDEN') {
                sendError(res, 403, err.code);
                return;
            }
            sendError(res, 400, err.code);
            return;
        }
        if (err instanceof Error) {
            const code = err.message;
            if (code === 'MODEL_NOT_FOUND' || code === 'USER_NOT_FOUND' || code === 'NOT_FOUND') {
                sendError(res, 404, code);
            }
            else if (code === 'REVISION_CONFLICT') {
                sendError(res, 409, 'REVISION_CONFLICT');
            }
            else if (code === 'PAYLOAD_TOO_LARGE') {
                sendError(res, 413, 'PAYLOAD_TOO_LARGE');
            }
            else if (code === 'INVALID_JSON') {
                sendError(res, 400, 'INVALID_JSON');
            }
            else if (code === 'INVALID_MULTIPLIER') {
                // GOV-UI-002：Host 拒绝超界值
                sendError(res, 400, 'INVALID_MULTIPLIER');
            }
            else if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
                sendError(res, 403, code);
            }
            else {
                sendError(res, 500, 'INTERNAL_ERROR');
            }
        }
        else {
            sendError(res, 500, 'INTERNAL_ERROR');
        }
    }
    /** 实际请求处理：解析路径并路由到静态页面或 JSON API。 */
    return async function handle(req, res, basePath = '') {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        let path = url.pathname;
        const method = req.method ?? 'GET';
        // 兼容 API（独立监听）强制 loopback：拒绝非回环 peer 与代理头改写来源。
        if (opts?.requireLoopback === true && !isLocalRequest(req)) {
            sendError(res, 403, 'FORBIDDEN');
            return;
        }
        // OPTIONS 预检（仅显式 allowedOrigin 时返回 CORS 头）
        if (method === 'OPTIONS') {
            if (opts?.allowedOrigin !== undefined) {
                res.writeHead(204, {
                    'Access-Control-Allow-Origin': opts.allowedOrigin,
                    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                    'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
                    Vary: 'Origin',
                });
            }
            else {
                res.writeHead(204);
            }
            res.end();
            return;
        }
        // 剥离挂载前缀（DSH webServer 下为 /governor）
        if (basePath !== '' && path.startsWith(basePath)) {
            path = path.slice(basePath.length) || '/';
        }
        // 根路径重定向到模型页
        if (method === 'GET' && path === '/') {
            res.writeHead(302, { Location: `${basePath}/pages/models.html` });
            res.end();
            return;
        }
        // 静态页面路由（页面本身不含治理数据，无 capability 要求）
        if (method === 'GET' && path.startsWith('/pages/')) {
            const pageName = path.slice('/pages/'.length);
            if (allowedPages.has(pageName)) {
                const html = await readPage(pageName);
                if (html !== null) {
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                    res.end(html);
                }
                else {
                    sendError(res, 404, 'PAGE_NOT_FOUND');
                }
                return;
            }
        }
        // API 路由（方法级 capability 矩阵）
        if (path.startsWith('/api/')) {
            const actor = authenticate(req);
            // GET /api/models → governor.listModels()【governor.read】
            if (path === '/api/models' && method === 'GET') {
                if (!hasCapability(actor, 'governor.read')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
                const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
                const allModels = await governor.listModels();
                const safeLimit = Math.min(Number.isFinite(limit) && limit > 0 ? limit : 50, 200);
                const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
                const data = allModels.slice(safeOffset, safeOffset + safeLimit);
                sendJson(res, 200, { data, total: allModels.length, limit: safeLimit, offset: safeOffset });
                return;
            }
            // PATCH /api/models/:routeId → governor.updateModel()【governor.manage】
            if (path.startsWith('/api/models/') && method === 'PATCH') {
                if (!hasCapability(actor, 'governor.manage')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const routeId = decodeURIComponent(path.slice('/api/models/'.length));
                let patch;
                try {
                    patch = JSON.parse((await readBody(req)) || '{}');
                }
                catch (err) {
                    // 请求体超限与 JSON 解析失败给出可区分的安全错误码。
                    if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE')
                        handleError(res, err);
                    else
                        sendError(res, 400, 'INVALID_JSON');
                    return;
                }
                try {
                    const expectedRevision = url.searchParams.get('expectedRevision');
                    const result = await governor.updateModel(routeId, patch, {
                        ...(expectedRevision !== null ? { expectedRevision: Number(expectedRevision) } : {}),
                        ...(actor !== undefined ? { actor: actor.id } : {}),
                    });
                    sendJson(res, 200, result);
                }
                catch (err) {
                    handleError(res, err);
                }
                return;
            }
            // GET /api/users → governor.listUsers()【governor.read】
            if (path === '/api/users' && method === 'GET') {
                if (!hasCapability(actor, 'governor.read')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const users = await governor.listUsers();
                sendJson(res, 200, { data: users, total: users.length });
                return;
            }
            // PATCH /api/users/:userId → governor.updateUser()【governor.manage】
            if (path.startsWith('/api/users/') && method === 'PATCH') {
                if (!hasCapability(actor, 'governor.manage')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const userId = decodeURIComponent(path.slice('/api/users/'.length));
                let patch;
                try {
                    patch = JSON.parse((await readBody(req)) || '{}');
                }
                catch (err) {
                    if (err instanceof Error && err.message === 'PAYLOAD_TOO_LARGE')
                        handleError(res, err);
                    else
                        sendError(res, 400, 'INVALID_JSON');
                    return;
                }
                try {
                    const expectedRevision = url.searchParams.get('expectedRevision');
                    const result = await governor.updateUser(userId, patch, {
                        ...(expectedRevision !== null ? { expectedRevision: Number(expectedRevision) } : {}),
                        ...(actor !== undefined ? { actor: actor.id } : {}),
                    });
                    sendJson(res, 200, result);
                }
                catch (err) {
                    handleError(res, err);
                }
                return;
            }
            // GET /api/usage → governor.queryUsage()【governor.read】
            if (path === '/api/usage' && method === 'GET') {
                if (!hasCapability(actor, 'governor.read')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const query = {};
                const userIdParam = url.searchParams.get('userId');
                const providerParam = url.searchParams.get('provider');
                if (userIdParam !== null)
                    query.userId = userIdParam;
                if (providerParam !== null)
                    query.provider = providerParam;
                const events = await governor.queryUsage(query);
                const data = events.map((e) => ({
                    requestId: e.requestId,
                    provider: e.provider,
                    model: e.model,
                    inputTokens: e.inputTokens,
                    outputTokens: e.outputTokens,
                    credits: Number(e.creditNanos) / 1_000_000_000,
                    success: e.success,
                    latencyMs: e.latencyMs,
                }));
                sendJson(res, 200, { data, total: data.length });
                return;
            }
            // GET /api/decisions/:requestId → governor.explainDecision()【governor.read】
            if (path.startsWith('/api/decisions/') && method === 'GET') {
                if (!hasCapability(actor, 'governor.read')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const requestId = decodeURIComponent(path.slice('/api/decisions/'.length));
                const decisions = await governor.explainDecision(requestId);
                sendJson(res, 200, { data: decisions });
                return;
            }
            // GET /api/audit → governor.listAuditEntries()【governor.audit】
            if (path === '/api/audit' && method === 'GET') {
                if (!hasCapability(actor, 'governor.audit')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
                const entries = await governor.listAuditEntries(Math.min(Number.isFinite(limit) && limit > 0 ? limit : 50, 200));
                sendJson(res, 200, { data: entries, total: entries.length });
                return;
            }
            // GET /api/health → 存储/对账健康摘要【governor.read】
            if (path === '/api/health' && method === 'GET') {
                if (!hasCapability(actor, 'governor.read')) {
                    sendError(res, actor === undefined ? 401 : 403, actor === undefined ? 'UNAUTHORIZED' : 'FORBIDDEN');
                    return;
                }
                const pending = await governor.listPendingAuditCount();
                sendJson(res, 200, {
                    storage: 'available',
                    pendingDecisions: pending,
                    configRevision: governor.configRevision,
                });
                return;
            }
            // 未知 API 路由
            sendError(res, 404, 'NOT_FOUND');
            return;
        }
        // 非页面、非 API 路由
        sendError(res, 404, 'NOT_FOUND');
    };
}
/**
 * 创建兼容 API 独立服务器（仅显式 compatApi.enabled 时使用；强制 loopback）。
 *
 * @param governor - GovernorService 实例。
 * @param opts - 认证主体与 CORS 配置（requireLoopback 强制为 true）。
 * @returns http.Server 实例，调用方负责 listen（127.0.0.1 或 [::1]）和 close。
 */
export function createGovernorApiServer(governor, opts) {
    const handle = createGovernorRequestHandler(governor, { ...opts, requireLoopback: true });
    const server = http.createServer((req, res) => {
        void handle(req, res, '').catch(() => {
            // handle 内部已兜底；此处防止未处理拒绝
        });
    });
    return server;
}
