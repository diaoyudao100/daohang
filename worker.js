// Cloudflare Worker - 导航页后端
// KV 命名空间绑定名：NAV_KV
// KV key 结构：
//   user:{username}:pwd   -> SHA-256(password) hex
//   user:{username}:data  -> JSON { cats, cards, profile, syncAt }
//   nav_users             -> JSON string[] 用户名列表

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // GET /api/data?user=xxx — 读取用户数据（公开）
    if (request.method === 'GET' && path === '/api/data') {
      const username = url.searchParams.get('user');
      if (!username) return err('缺少 user 参数');
      const raw = await env.NAV_KV.get(`user:${username}:data`);
      if (!raw) return json({ ok: true, data: null }); // 新用户，无数据
      return json({ ok: true, data: JSON.parse(raw) });
    }

    // POST /api/register — 注册账户
    if (request.method === 'POST' && path === '/api/register') {
      const body = await request.json().catch(() => null);
      if (!body?.username || !body?.password) return err('缺少用户名或密码');
      const { username, password } = body;
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) return err('用户名只能包含字母数字下划线，3-20位');
      if (password.length < 6) return err('密码至少6位');
      const exists = await env.NAV_KV.get(`user:${username}:pwd`);
      if (exists) return err('用户名已存在');
      const hash = await sha256hex(password);
      await env.NAV_KV.put(`user:${username}:pwd`, hash);
      // 更新用户列表
      const listRaw = await env.NAV_KV.get('nav_users');
      const list = listRaw ? JSON.parse(listRaw) : [];
      if (!list.includes(username)) list.push(username);
      await env.NAV_KV.put('nav_users', JSON.stringify(list));
      return json({ ok: true, message: '注册成功' });
    }

    // POST /api/login — 验证密码，返回 token（简单实现：base64(user:pwd_hash)）
    if (request.method === 'POST' && path === '/api/login') {
      const body = await request.json().catch(() => null);
      if (!body?.username || !body?.password) return err('缺少用户名或密码');
      const ok = await verifyUser(env.NAV_KV, body.username, body.password);
      if (!ok) return err('用户名或密码错误', 401);
      // token = base64(username:sha256(password))
      const hash = await sha256hex(body.password);
      const token = btoa(`${body.username}:${hash}`);
      return json({ ok: true, token, username: body.username });
    }

    // POST /api/data — 保存用户数据（需 Authorization: Bearer <token>）
    if (request.method === 'POST' && path === '/api/data') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace('Bearer ', '').trim();
      if (!token) return err('未登录', 401);
      let username, hash;
      try {
        const decoded = atob(token);
        const colon = decoded.indexOf(':');
        username = decoded.slice(0, colon);
        hash = decoded.slice(colon + 1);
      } catch {
        return err('无效 token', 401);
      }
      const stored = await env.NAV_KV.get(`user:${username}:pwd`);
      if (!stored || stored !== hash) return err('token 无效或已过期', 401);

      const body = await request.json().catch(() => null);
      if (!body) return err('无效请求体');
      const data = {
        cats: body.cats || [],
        cards: body.cards || [],
        profile: body.profile || {},
        syncAt: new Date().toISOString(),
      };
      await env.NAV_KV.put(`user:${username}:data`, JSON.stringify(data));
      return json({ ok: true, syncAt: data.syncAt });
    }

    // GET /api/users — 检查是否有已注册用户（用于首次访问引导）
    if (request.method === 'GET' && path === '/api/users') {
      const listRaw = await env.NAV_KV.get('nav_users');
      const list = listRaw ? JSON.parse(listRaw) : [];
      return json({ ok: true, hasUsers: list.length > 0, count: list.length });
    }

    return err('Not Found', 404);
  },
};
