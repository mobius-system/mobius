// Best API 控制台拓展 — 后端 handler (阶段 A+B: 只读 + 写转发)
// 薄转发层: 前端 extCall({action, params?, body?}) → best-api /admin/api/* (GET/POST/PUT/DELETE)。
// best-api 是数据/鉴权/计费权威, 这里只做 admin key 注入 + URL 拼装 + 透传响应。
//
// 约束 (mobius 拓展): stateless worker, 30s/5MB/256MB, 只写 ext_data_dir (本 handler 不写文件)。
const ADMIN_KEY = process.env.BEST_API_ADMIN_KEY || "sk-c686c15deb1a4de79c1bdcf2e904f06d";
const BASE = (process.env.BEST_API_BASE_URL || "http://127.0.0.1:39929").replace(/\/+$/, "");
const enc = (s) => encodeURIComponent(String(s == null ? "" : s));

// action → { m: HTTP方法, p: 路径字符串 | (body)=>路径 }
const ROUTES = {
  // ---- 只读 (阶段A: 监控) ----
  overview:    { m: "GET", p: "/admin/api/overview" },
  key_usage:   { m: "GET", p: "/admin/api/key_usage" },
  usage:       { m: "GET", p: "/admin/api/usage" },
  calls:       { m: "GET", p: "/admin/api/calls" },
  glm_status:  { m: "GET", p: "/admin/api/glm_status" },
  users:       { m: "GET", p: "/admin/api/users" },
  ledger:      { m: "GET", p: "/admin/api/ledger" },
  stats:       { m: "GET", p: "/admin/api/stats" },
  users_usage: { m: "GET", p: "/admin/api/users_usage" },
  models:      { m: "GET", p: "/v1/models" },
  // ---- 渠道管理 (阶段B) ----
  list_channels:  { m: "GET",    p: "/admin/api/channels" },
  create_channel: { m: "POST",   p: "/admin/api/channels" },
  update_channel: { m: "PUT",    p: (b) => `/admin/api/channels/${enc(b.name)}` },
  delete_channel: { m: "DELETE", p: (b) => `/admin/api/channels/${enc(b.name)}` },
  // ---- 模型路由 (阶段B) ----
  list_routes:      { m: "GET",    p: "/admin/api/routes" },
  set_model_rank:   { m: "PUT",    p: (b) => `/admin/api/models/${enc(b.model)}/rank` },
  set_model_latency:{ m: "PUT",    p: (b) => `/admin/api/models/${enc(b.model)}/latency` },
  delete_model:     { m: "DELETE", p: (b) => `/admin/api/models/${enc(b.model)}` },
  set_rank_default: { m: "PUT",    p: "/admin/api/rank_default" },
  // ---- 上游 Key 池 (阶段B) ----
  list_keys:   { m: "GET",    p: "/admin/api/keys" },
  create_key:  { m: "POST",   p: "/admin/api/keys" },
  delete_key:  { m: "DELETE", p: (b) => `/admin/api/keys/${enc(b.key_id)}` },
  enable_key:  { m: "POST",   p: (b) => `/admin/api/keys/${enc(b.key_id)}/enable` },
  disable_key: { m: "POST",   p: (b) => `/admin/api/keys/${enc(b.key_id)}/disable` },
  update_key:  { m: "PUT",    p: (b) => `/admin/api/keys/${enc(b.key_id)}` },
  // ---- 用户与令牌 (阶段C) ----
  list_tokens: { m: "GET",    p: "/admin/api/tokens" },
  add_user:    { m: "POST",   p: "/admin/api/users" },
  delete_user: { m: "DELETE", p: (b) => `/admin/api/users/${enc(b.user)}` },
  set_balance: { m: "PUT",    p: (b) => `/admin/api/users/${enc(b.user)}/balance` },
  set_status:  { m: "PUT",    p: (b) => `/admin/api/users/${enc(b.user)}/status` },
  issue_key:   { m: "POST",   p: (b) => `/admin/api/users/${enc(b.user)}/keys` },
  revoke_key:  { m: "DELETE", p: (b) => `/admin/api/tokens/${enc(b.key)}` },
};

// 只读 action 允许透传的 query 白名单 (防注入)
const READ_QUERY = {
  overview: ["window"], key_usage: ["window"], usage: ["dim", "window"],
  calls: ["limit", "offset", "q", "status", "window"], ledger: ["limit", "offset", "user"],
};

module.exports = async function bestApiConsoleHandler({ ext_main_payload }) {
  const p = ext_main_payload || {};
  const action = p.action;

  // call_detail 动态路径
  if (action === "call_detail") {
    const id = String(p.id == null ? "" : p.id);
    if (!/^\d+$/.test(id)) return { ok: false, error: "invalid call id" };
    return await fwd("GET", `/admin/api/call/${id}`);
  }

  const route = ROUTES[action];
  if (!route) return { ok: false, error: `unknown action: ${action}` };

  const body = p.body || {};
  const path = typeof route.p === "function" ? route.p(body) : route.p;

  let qs = "";
  if (route.m === "GET" && READ_QUERY[action] && p.params) {
    const sp = new URLSearchParams();
    for (const k of READ_QUERY[action]) {
      if (p.params[k] != null && p.params[k] !== "") sp.set(k, String(p.params[k]));
    }
    const s = sp.toString();
    if (s) qs = "?" + s;
  }

  const reqBody = route.m !== "GET" ? body : undefined;
  return await fwd(route.m, path + qs, reqBody);
};

async function fwd(method, path, body) {
  let r;
  try {
    r = await fetch(BASE + path, {
      method,
      headers: Object.assign(
        { Authorization: "Bearer " + ADMIN_KEY, Accept: "application/json" },
        body ? { "content-type": "application/json" } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `best-api 不可达: ${e.message} (BASE=${BASE})` };
  }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) return { ok: false, error: `best-api HTTP ${r.status}`, status: r.status, detail: data };

  // 管理写接口统一返回 { ok, data } / { ok:false, error, status }，而旧只读接口
  // 直接返回业务对象。这里把两种契约归一为拓展前端期望的单层响应，避免
  // extCall 再包一层后页面把 channels / routes / keys 误读成空数据。
  if (data && typeof data === "object" && !Array.isArray(data) && typeof data.ok === "boolean") {
    if (!data.ok) {
      return {
        ok: false,
        error: data.error || "best-api 操作失败",
        status: Number(data.status) || 400,
        detail: data,
      };
    }
    if (Object.prototype.hasOwnProperty.call(data, "data")) {
      return { ok: true, data: data.data };
    }
  }
  return { ok: true, data };
}
