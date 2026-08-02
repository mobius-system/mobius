// lib/wechat.js — 微信公众号草稿箱（方案 §12）。
// token：加密缓存(wx-token.enc) + 提前 5 分钟刷新 + 短租约文件锁 + 失效重试 1 次；
// 正文图 media/uploadimg（仅 JPG/PNG<1MB）；封面永久素材 add_material 取 thumb_media_id；
// draft/add 前字段校验；draft/get/batchget 对账；draft/add 超时 → unknown_external_result（不自动重发）。
// 调用固定 api.weixin.qq.com（非用户可控 URL），用带超时的裸 fetch，无 SSRF 风险。

const fs = require("fs"), path = require("path");
const { decryptObj, encryptObj, hasKey } = require("./crypto");
const { validateWechatFields } = require("./render");

const API = "https://api.weixin.qq.com/cgi-bin";
const TOKEN_FILE = "wx-token.enc";

async function timedFetch(url, opts, timeoutMs = 20_000) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- token：缓存 + 提前 5 分钟刷新 + 短租约锁 ----
async function freshToken({ extDataDir, appid, secret, force, logger }) {
  const file = path.join(extDataDir, TOKEN_FILE);
  if (!force) {
    try { const c = decryptObj(fs.readFileSync(file, "utf8")); if (c && c.expires_at - 300_000 > Date.now()) return c.access_token; }
    catch (_) {}
  }
  const lock = file + ".lock";
  try {
    if (fs.existsSync(lock)) {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs > 30_000) fs.unlinkSync(lock); // 过期锁
      else { await sleep(800); } // 别的进程在刷
    }
  } catch (_) {}
  try {
    const r = await timedFetch(`${API}/token?grant_type=client_credential&appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}`, {}, 15_000);
    const j = await r.json();
    if (!j.access_token) throw new Error("获取 token 失败: " + (j.errcode || "") + " " + (j.errmsg || ""));
    const obj = { access_token: j.access_token, expires_at: Date.now() + (j.expires_in || 7200) * 1000 };
    if (hasKey()) { try { fs.writeFileSync(file, encryptObj(obj), { mode: 0o600 }); fs.chmodSync(file, 0o600); } catch (_) {} }
    return obj.access_token;
  } finally { try { fs.unlinkSync(lock); } catch (_) {} }
}

// token 失效(errcode 40001/42001/40014) 自动刷新重试一次
async function withRetry(ctx, fn) {
  const t1 = await freshToken(ctx);
  try { return await fn(t1); }
  catch (e) {
    if (!/40001|42001|40014|invalid credential/i.test(String(e && e.message))) throw e;
    (ctx.logger || (() => {}))("warn", "token 失效，强制刷新重试");
    const t2 = await freshToken({ ...ctx, force: true });
    return await fn(t2);
  }
}

function mimeOf(p) {
  if (/\.png$/i.test(p)) return "image/png";
  if (/\.jpe?g$/i.test(p)) return "image/jpeg";
  if (/\.gif$/i.test(p)) return "image/gif";
  return "image/jpeg";
}

// ---- 正文图（media/uploadimg：仅 JPG/PNG <1MB）----
async function uploadContentImage(ctx, filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.byteLength > 1_000_000) throw new Error("正文图超过 1MB");
  const form = new FormData();
  form.append("media", new Blob([buf], { type: mimeOf(filePath) }), path.basename(filePath));
  return withRetry(ctx, async (token) => {
    const r = await timedFetch(`${API}/media/uploadimg?access_token=${token}`, { method: "POST", body: form });
    const j = await r.json();
    if (!j.url) throw new Error("uploadimg 失败: " + JSON.stringify(j).slice(0, 200));
    return j.url;
  });
}

// ---- 封面永久素材（add_material → thumb_media_id）----
async function uploadThumb(ctx, filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("media", new Blob([buf], { type: mimeOf(filePath) }), path.basename(filePath));
  return withRetry(ctx, async (token) => {
    const r = await timedFetch(`${API}/material/add_material?access_token=${token}&type=image`, { method: "POST", body: form });
    const j = await r.json();
    if (!j.media_id) throw new Error("add_material 失败: " + JSON.stringify(j).slice(0, 200));
    return j.media_id;
  });
}

// ---- draft/add（超时 → unknown，不重发）----
async function addDraft(ctx, { title, author, digest, bodyHtml, coverMediaId, declaration }, timeoutMs = 25_000) {
  const v = validateWechatFields({ title, author, digest, bodyHtml });
  if (!v.ok) throw new Error("字段不合规: " + v.errors.join("；"));
  const content = bodyHtml + (declaration ? `<section style="font-size:12px;color:#999;margin-top:24px;">${declaration}</section>` : "");
  const body = { articles: [{ title, author: author || " ", digest: digest || title, content,
    thumb_media_id: coverMediaId || "", need_open_comment: 0, only_fans_can_comment: 0, content_source_url: "" }] };
  let resp;
  try {
    resp = await withRetry(ctx, async (token) => {
      const r = await timedFetch(`${API}/draft/add?access_token=${token}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeoutMs);
      return await r.json();
    });
  } catch (e) {
    if (/abort/i.test(String(e && e.name || e))) {
      const err = new Error("draft/add 超时，结果未知，需人工对账");
      err.unknown = true; throw err;
    }
    throw e;
  }
  if (resp.errcode && resp.errcode !== 0) throw new Error("draft/add 失败: " + resp.errcode + " " + resp.errmsg);
  return { media_id: resp.media_id };
}

async function getDraft(ctx, mediaId) {
  return withRetry(ctx, async (token) => {
    const r = await timedFetch(`${API}/draft/get?access_token=${token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ media_id: mediaId }) });
    return await r.json();
  });
}
async function batchGetDraft(ctx, { count = 20, offset = 0 } = {}) {
  return withRetry(ctx, async (token) => {
    const r = await timedFetch(`${API}/draft/batchget?access_token=${token}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ offset, count, no_content: 1 }) });
    return await r.json();
  });
}

// 对账：按标题/摘要判断超时未知结果是否实际已生成草稿
async function reconcile(ctx, { title, digest }) {
  const data = await batchGetDraft(ctx, { count: 20 });
  const items = (data && data.item) || [];
  const hit = items.find((it) => {
    const a = (it.content && it.content.news_item && it.content.news_item[0]) || {};
    return a.title === title || (digest && a.digest === digest);
  });
  return hit ? { found: true, media_id: hit.media_id } : { found: false };
}

module.exports = { freshToken, withRetry, uploadContentImage, uploadThumb, addDraft, getDraft, batchGetDraft, reconcile };
