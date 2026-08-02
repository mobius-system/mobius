// lib/safe-fetch.js — SSRF 防护抓取（方案 §6.3 / §8.1）。
// 默认 https；禁 localhost / 云元数据 / 私网 IP / 异常端口；DNS + 每跳重定向后重新校验 IP；
// 限制响应大小与超时；XML 禁 DTD/外部实体；HTML 只抽纯文本（不渲染原始内容，防存储型 XSS / 提示词注入）。

const dns = require("dns").promises;

const PRIVATE_IPV4 = [
  /^0\./, /^10\./, /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./, /^127\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./, /^192\.0\.0\./, /^192\.168\./, /^198\.(1[8-9])\./, /^203\.0\.113\./,
];
const BLOCKED_HOSTS = ["localhost", "metadata.google.internal", "metadata.azure.com", "metadata.tencentyun.com"];
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);

function ipBlocked(ip) {
  if (!ip) return true;
  if (PRIVATE_IPV4.some((re) => re.test(ip))) return true;
  // IPv6 私有 / 链路本地 / 环回
  if (ip === "::1" || ip === "::") return true;
  if (/^fe[89ab]/i.test(ip)) return true;       // link-local
  if (/^f[cd]/i.test(ip)) return true;           // unique local
  if (/^::ffff:/.test(ip)) return ipBlocked(ip.replace(/^::ffff:/, "")); // v4-mapped
  return false;
}

async function resolveAndCheck(host) {
  const h = String(host || "").toLowerCase();
  if (BLOCKED_HOSTS.includes(h)) throw new Error("host 被屏蔽");
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); }
  catch (e) { throw new Error("DNS 解析失败"); }
  if (!addrs.length) throw new Error("DNS 无记录");
  for (const a of addrs) { if (ipBlocked(a.address)) throw new Error("非公网 IP，已拒绝"); }
  return addrs.map((a) => a.address);
}

async function safeFetch(rawUrl, opts = {}) {
  const maxBytes = Math.min(opts.maxBytes || 2_000_000, 5_000_000);
  const timeoutMs = Math.min(opts.timeoutMs || 12_000, 20_000);
  const maxRedirects = Math.min(opts.maxRedirects ?? 3, 5);
  let u = String(rawUrl || "");
  let lastUrl = u;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error("非法 URL"); }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("仅允许 http/https");
    if (opts.httpsOnly && parsed.protocol !== "https:") throw new Error("该源仅允许 https");
    if (!ALLOWED_PORTS.has(parsed.port || "")) throw new Error("端口不被允许: " + parsed.port);
    await resolveAndCheck(parsed.hostname); // 每跳重校验
    lastUrl = u;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(u, {
        method: "GET",
        signal: ctrl.signal,
        redirect: "manual", // 手动跟，保证每跳 IP 重校验
        headers: { "user-agent": "Mobius/wechat-article (+https)", accept: "*/*", ...(opts.headers || {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      throw new Error("请求失败: " + (e?.name === "AbortError" ? "超时" : (e?.message || String(e))).slice(0, 120));
    }
    clearTimeout(timer);

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error("重定向无 location");
      u = new URL(loc, u).toString();
      continue;
    }
    if (!res.ok) return { ok: false, status: res.status, finalUrl: lastUrl };

    const ctype = (res.headers.get("content-type") || "").toLowerCase();
    const chunks = [];
    let n = 0, tooBig = false;
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        if (n > maxBytes) { tooBig = true; break; }
        chunks.push(Buffer.from(value));
      }
    } else {
      const text = await res.text();
      n = Buffer.byteLength(text);
      if (n > maxBytes) tooBig = true;
      else chunks.push(Buffer.from(text));
    }
    if (tooBig) throw new Error("响应过大（>" + maxBytes + "B），疑似压缩炸弹");
    const buf = Buffer.concat(chunks);
    return { ok: true, status: 200, finalUrl: lastUrl, contentType: ctype, bytes: n, buffer: buf,
      text: () => buf.toString("utf8") };
  }
  throw new Error("重定向跳数超限");
}

// 抽纯文本：去掉 script/style/标签/实体，不渲染原始 HTML（防 XSS / 注入）
function stripHtml(html, maxLen = 4000) {
  let s = String(html || "");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
       .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
  s = s.replace(/\s+/g, " ").trim();
  return s.slice(0, maxLen);
}

// XML 防 XXE：去 DOCTYPE / ENTITY 声明（RSS 解析前的保底清洗）
function sanitizeXml(xml) {
  return String(xml || "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!ENTITY[\s\S]*?>/gi, "")
    .replace(/SYSTEM\s+["'][^"']+["']/gi, "");
}

module.exports = { safeFetch, stripHtml, sanitizeXml, ipBlocked, resolveAndCheck, ALLOWED_PORTS };
