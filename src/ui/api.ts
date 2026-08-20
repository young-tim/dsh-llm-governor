/**
 * Governor HTTP API 服务器。
 *
 * 使用 Node 内置 http 模块，将 GovernorService 的方法包装为 JSON 端点。
 * 管理员写权限通过 X-Governor-Admin header 或本地回环地址检查。
 * 普通用户只能执行读操作（GET），写操作（PATCH）需要管理员权限。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { GovernorService } from '../plugin/service.js';

/** 模块所在目录，用于定位 pages 子目录中的 HTML 文件。 */
const __dirname = dirname(fileURLToPath(import.meta.url));
/** HTML 页面目录。 */
const pagesDir = join(__dirname, 'pages');

/** API 服务器选项。 */
export interface GovernorApiServerOptions {
  /** 管理员令牌；客户端通过 X-Governor-Admin header 传入以获得写权限。 */
  adminToken?: string;
}

/**
 * 创建 Governor HTTP API 服务器。
 *
 * @param governor - GovernorService 实例，端点将调用其方法。
 * @param opts - 可选配置，如管理员令牌。
 * @returns http.Server 实例，调用方负责 listen 和 close。
 */
export function createGovernorApiServer(
  governor: GovernorService,
  opts?: GovernorApiServerOptions,
): http.Server {
  const adminToken = opts?.adminToken;

  /** HTML 页面内容缓存，避免每次请求都读磁盘。 */
  const htmlCache = new Map<string, string>();

  /** 允许访问的静态页面白名单。 */
  const allowedPages = new Set(['models.html', 'users.html', 'usage.html']);

  /**
   * 读取 HTML 页面（带缓存），注入 admin token。
   * @param name - 页面文件名，如 "models.html"。
   * @param token - 可选 admin token，注入到页面 meta 标签。
   * @returns HTML 文本。
   */
  async function readPage(name: string): Promise<string> {
    const cached = htmlCache.get(name);
    if (cached !== undefined) return cached;
    const html = await readFile(join(pagesDir, name), 'utf-8');
    htmlCache.set(name, html);
    return html;
  }

  /**
   * 判断请求是否来自本地回环地址。
   * @param req - HTTP 请求对象。
   * @returns 是否为本地请求。
   */
  function isLocalRequest(req: http.IncomingMessage): boolean {
    const addr = req.socket.remoteAddress;
    if (!addr) return false;
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  }

  /**
   * 判断请求是否具有管理员权限。
   *
   * 只有携带正确 X-Governor-Admin header 的请求视为管理员。
   * 浏览器请求（即使来自 localhost）不是进程所有者，不能自动获得写权限。
   * @param req - HTTP 请求对象。
   * @returns 是否为管理员。
   */
  function isAdmin(req: http.IncomingMessage): boolean {
    if (adminToken) {
      const header = req.headers['x-governor-admin'];
      if (typeof header === 'string' && header === adminToken) return true;
    }
    return false;
  }

  /**
   * 发送 JSON 响应。
   * 使用 replacer 将 bigint 转为 number，避免 JSON.stringify 抛错。
   * @param res - HTTP 响应对象。
   * @param status - HTTP 状态码。
   * @param body - 响应体（将被 JSON.stringify）。
   */
  function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
    const json = JSON.stringify(body, (_key, value) =>
      typeof value === 'bigint' ? Number(value) : value,
    );
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-Governor-Admin',
      'Access-Control-Allow-Methods': 'GET, PATCH, OPTIONS',
    });
    res.end(json);
  }

  /**
   * 发送错误 JSON 响应。
   * @param res - HTTP 响应对象。
   * @param status - HTTP 状态码。
   * @param error - 人类可读错误描述。
   * @param code - 稳定错误码。
   */
  function sendError(res: http.ServerResponse, status: number, error: string, code: string): void {
    sendJson(res, status, { error, code });
  }

  /**
   * 读取请求体文本。
   * @param req - HTTP 请求对象。
   * @returns 请求体字符串。
   */
  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });
  }

  /**
   * 将服务层异常转换为 HTTP 错误响应。
   * @param res - HTTP 响应对象。
   * @param err - 捕获到的异常。
   */
  function handleError(res: http.ServerResponse, err: unknown): void {
    if (err instanceof Error) {
      const code = err.message;
      if (code === 'MODEL_NOT_FOUND' || code === 'USER_NOT_FOUND') {
        sendError(res, 404, code, code);
      } else {
        sendError(res, 500, code, code);
      }
    } else {
      sendError(res, 500, 'INTERNAL_ERROR', 'INTERNAL_ERROR');
    }
  }

  /** 创建 HTTP 服务器并注册路由处理。 */
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const path = url.pathname;
      const method = req.method ?? 'GET';

      // 根路径重定向到模型页
      if (method === 'GET' && path === '/') {
        res.writeHead(302, { Location: '/pages/models.html' });
        res.end();
        return;
      }

      // 静态页面路由
      if (method === 'GET' && path.startsWith('/pages/')) {
        const pageName = path.slice('/pages/'.length);
        if (allowedPages.has(pageName)) {
          try {
            const html = await readPage(pageName);
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
            });
            res.end(html);
          } catch {
            sendError(res, 404, 'PAGE_NOT_FOUND', 'PAGE_NOT_FOUND');
          }
          return;
        }
      }

      // API 路由
      if (path.startsWith('/api/')) {
        // GET /api/models → governor.listModels()
        // 支持 limit/offset 分页参数
        if (path === '/api/models' && method === 'GET') {
          const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
          const offset = parseInt(url.searchParams.get('offset') ?? '0', 10);
          const allModels = await governor.listModels();
          const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
          const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
          const data = allModels.slice(safeOffset, safeOffset + safeLimit);
          sendJson(res, 200, {
            data,
            total: allModels.length,
            limit: safeLimit,
            offset: safeOffset,
          });
          return;
        }

        // PATCH /api/models/:routeId → governor.updateModel()（需管理员）
        if (path.startsWith('/api/models/') && method === 'PATCH') {
          if (!isAdmin(req)) {
            sendError(res, 403, 'FORBIDDEN', 'FORBIDDEN');
            return;
          }
          const routeId = decodeURIComponent(path.slice('/api/models/'.length));
          const bodyText = await readBody(req);
          let patch: { enabled?: boolean; multiplier?: number };
          try {
            patch = JSON.parse(bodyText || '{}') as {
              enabled?: boolean;
              multiplier?: number;
            };
          } catch {
            sendError(res, 400, 'INVALID_JSON', 'INVALID_JSON');
            return;
          }
          try {
            const result = await governor.updateModel(routeId, patch);
            sendJson(res, 200, result);
          } catch (err) {
            handleError(res, err);
          }
          return;
        }

        // GET /api/users → governor.listUsers()
        if (path === '/api/users' && method === 'GET') {
          const users = await governor.listUsers();
          sendJson(res, 200, { data: users, total: users.length });
          return;
        }

        // PATCH /api/users/:userId → governor.updateUser()（需管理员）
        if (path.startsWith('/api/users/') && method === 'PATCH') {
          if (!isAdmin(req)) {
            sendError(res, 403, 'FORBIDDEN', 'FORBIDDEN');
            return;
          }
          const userId = decodeURIComponent(path.slice('/api/users/'.length));
          const bodyText = await readBody(req);
          let patch: { monthlyCredits?: number };
          try {
            patch = JSON.parse(bodyText || '{}') as {
              monthlyCredits?: number;
            };
          } catch {
            sendError(res, 400, 'INVALID_JSON', 'INVALID_JSON');
            return;
          }
          try {
            const result = await governor.updateUser(userId, patch);
            sendJson(res, 200, result);
          } catch (err) {
            handleError(res, err);
          }
          return;
        }

        // GET /api/usage?userId=&provider= → governor.queryUsage()
        if (path === '/api/usage' && method === 'GET') {
          const query: { userId?: string; provider?: string } = {};
          const userIdParam = url.searchParams.get('userId');
          const providerParam = url.searchParams.get('provider');
          if (userIdParam !== null) query.userId = userIdParam;
          if (providerParam !== null) query.provider = providerParam;
          const events = await governor.queryUsage(query);
          // 转换为前端所需字段，将 bigint creditNanos 转为人类可读 credits
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

        // GET /api/decisions/:requestId → governor.explainDecision()
        if (path.startsWith('/api/decisions/') && method === 'GET') {
          const requestId = decodeURIComponent(path.slice('/api/decisions/'.length));
          const decisions = await governor.explainDecision(requestId);
          sendJson(res, 200, { data: decisions });
          return;
        }

        // 未知 API 路由
        sendError(res, 404, 'NOT_FOUND', 'NOT_FOUND');
        return;
      }

      // 非页面、非 API 路由
      sendError(res, 404, 'NOT_FOUND', 'NOT_FOUND');
    } catch (err) {
      handleError(res, err);
    }
  });

  return server;
}
