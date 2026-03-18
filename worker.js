// Cloudflare Worker - 导航页后端
// KV 命名空间绑定名：NAV_KV
// KV key 结构：
//   user:{username}:pwd   -> SHA-256(password) hex
//   user:{username}:data  -> JSON { cats, cards, profile, syncAt }
//   nav_users             -> JSON string[] 用户名列表
//   invite:{code}         -> "1"（一次性注册码，用后删除）
// 环境变量：
//   ADMIN_USER            -> 管理员用户名（wrangler secret put ADMIN_USER）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function err(msg, status = 400) {
  return json({ ok: false, error: msg }, status);
}

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyUser(kv, username, password) {
  const stored = await kv.get(`user:${username}:pwd`);
  if (!stored) return false;
  const hash = await sha256hex(password);
  return hash === stored;
}

function getBearerToken(request) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth) return null;
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : auth.trim();
  return token || null;
}

// 从 Authorization: Bearer <token> 中解析并验证用户（session token），返回 username 或 null
async function authFromRequest(request, kv) {
  const token = getBearerToken(request);
  if (!token) return null;
  const username = await kv.get(`sess:${token}`);
  return username || null;
}

function randCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  arr.forEach(b => s += chars[b % chars.length]);
  return s;
}

function randToken(bytes = 24) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // GET /api/data — 读取当前登录用户数据（需登录）
    if (request.method === 'GET' && path === '/api/data') {
      const username = await authFromRequest(request, env.NAV_KV);
      if (!username) return err('未登录或 token 无效', 401);
      const raw = await env.NAV_KV.get(`user:${username}:data`);
      if (!raw) return json({ ok: true, data: null });
      return json({ ok: true, data: JSON.parse(raw) });
    }

    // POST /api/register — 注册账户（需要一次性邀请码）
    if (request.method === 'POST' && path === '/api/register') {
      const body = await request.json().catch(() => null);
      if (!body?.username || !body?.password) return err('缺少用户名或密码');
      if (!body?.invite) return err('缺少邀请码');
      const { username, password, invite } = body;
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return err('用户名只能包含字母数字下划线，3-20位');
      if (password.length < 6) return err('密码至少6位');
      // 验证邀请码
      const inviteVal = await env.NAV_KV.get(`invite:${invite}`);
      if (!inviteVal) return err('邀请码无效或已使用');
      const exists = await env.NAV_KV.get(`user:${username}:pwd`);
      if (exists) return err('用户名已存在');
      const hash = await sha256hex(password);
      await env.NAV_KV.put(`user:${username}:pwd`, hash);
      // 邀请码用完立即删除
      await env.NAV_KV.delete(`invite:${invite}`);
      // 更新用户列表
      const listRaw = await env.NAV_KV.get('nav_users');
      const list = listRaw ? JSON.parse(listRaw) : [];
      if (!list.includes(username)) list.push(username);
      await env.NAV_KV.put('nav_users', JSON.stringify(list));
      return json({ ok: true, message: '注册成功' });
    }

    // POST /api/login — 验证密码，返回 session token
    if (request.method === 'POST' && path === '/api/login') {
      const body = await request.json().catch(() => null);
      if (!body?.username || !body?.password) return err('缺少用户名或密码');
      const ok = await verifyUser(env.NAV_KV, body.username, body.password);
      if (!ok) return err('用户名或密码错误', 401);

      const token = randToken();
      // session 30 天过期
      await env.NAV_KV.put(`sess:${token}`, body.username, { expirationTtl: 2592000 });

      const isAdmin = env.ADMIN_USER && body.username === env.ADMIN_USER;
      return json({ ok: true, token, username: body.username, isAdmin: !!isAdmin });
    }

    // POST /api/data — 保存用户数据（需登录）
    if (request.method === 'POST' && path === '/api/data') {
      const username = await authFromRequest(request, env.NAV_KV);
      if (!username) return err('未登录或 token 无效', 401);
      const body = await request.json().catch(() => null);
      if (!body) return err('无效请求体');
      const data = {
        cats: body.cats || [],
        cards: body.cards || [],
        notes: body.notes || [],
        profile: body.profile || {},
        syncAt: new Date().toISOString(),
      };
      await env.NAV_KV.put(`user:${username}:data`, JSON.stringify(data));
      return json({ ok: true, syncAt: data.syncAt });
    }

    // POST /api/logout — 退出登录（删除当前 session）
    if (request.method === 'POST' && path === '/api/logout') {
      const token = getBearerToken(request);
      if (token) await env.NAV_KV.delete(`sess:${token}`);
      return json({ ok: true });
    }

    // POST /api/invite — 管理员生成一次性邀请码
    if (request.method === 'POST' && path === '/api/invite') {
      const username = await authFromRequest(request, env.NAV_KV);
      if (!username) return err('未登录', 401);
      if (!env.ADMIN_USER || username !== env.ADMIN_USER) return err('无权限', 403);
      const code = randCode();
      // 邀请码 7 天后自动过期
      await env.NAV_KV.put(`invite:${code}`, '1', { expirationTtl: 604800 });
      return json({ ok: true, code });
    }

    // POST /api/refresh — 刷新 session token（延长30天）
    if (request.method === 'POST' && path === '/api/refresh') {
      const token = getBearerToken(request);
      if (!token) return err('未登录', 401);
      const username = await kv.get(`sess:${token}`);
      if (!username) return err('token无效', 401);
      await kv.put(`sess:${token}`, username, { expirationTtl: 2592000 });
      return json({ ok: true });
    }

    // GET /api/users — 检查是否有已注册用户
    if (request.method === 'GET' && path === '/api/users') {
      const listRaw = await env.NAV_KV.get('nav_users');
      const list = listRaw ? JSON.parse(listRaw) : [];
      return json({ ok: true, hasUsers: list.length > 0, count: list.length });
    }

    // GET /api/fetch?url=xxx — 代理抓取页面 title+description（需登录）
    if (request.method === 'GET' && path === '/api/fetch') {
      const username = await authFromRequest(request, env.NAV_KV);
      if (!username) return err('未登录', 401);

      const targetUrl = url.searchParams.get('url');
      if (!targetUrl) return err('缺少 url 参数');

      let u;
      try {
        u = new URL(targetUrl);
      } catch {
        return err('url 格式不正确');
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return err('仅支持 http/https');

      // 简单拦截内网/本机（防止被滥用）
      const host = u.hostname;
      const isLocalhost = host === 'localhost' || host.endsWith('.localhost');
      const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
      const isPrivateIPv4 = isIPv4 && (
        host.startsWith('10.') ||
        host.startsWith('192.168.') ||
        host.startsWith('127.') ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
      );
      if (isLocalhost || isPrivateIPv4) return err('不支持抓取本机/内网地址');

      try {
        const res = await fetch(u.toString(), {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NavBot/1.0)' },
          signal: AbortSignal.timeout(8000),
        });

        const contentType = res.headers.get('content-type') || '';
        if (!contentType.includes('text/html')) {
          return json({ ok: true, title: '', description: '' });
        }

        // 只读取前 200KB，避免大页面拖死
        const reader = res.body?.getReader();
        if (!reader) {
          return json({ ok: true, title: '', description: '' });
        }
        const chunks = [];
        let total = 0;
        while (total < 200_000) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) {
            chunks.push(value);
            total += value.byteLength;
          }
        }
        try { await reader.cancel(); } catch {}

        const buf = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          buf.set(c, offset);
          offset += c.byteLength;
        }
        const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);

        const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
        const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
          || html.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
        return json({
          ok: true,
          title: titleMatch ? titleMatch[1].trim() : '',
          description: descMatch ? descMatch[1].trim() : '',
        });
      } catch (e) {
        return json({ ok: true, title: '', description: '' });
      }
    }

    return err('Not Found', 404);
  },
};
