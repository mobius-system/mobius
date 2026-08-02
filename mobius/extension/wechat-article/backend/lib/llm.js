// lib/llm.js — LLM 渠道与调用（自包含精简版，复用 ai-hotspot-radar 的已验证配方）。
// 渠道来源：宿主 model-access.json + ~/.claude/settings-<key>.json 的 anthropic 渠道，及 codex env（RCC2_API_KEY）。
// 单轮 messages 调用 + JSON 容错解析（去围栏 / 提取 {} / 修复字符串内部未转义引号）。

const fs = require("fs"), os = require("os"), path = require("path");
const REPO_ROOT = path.resolve(__dirname, "../../../../.."); // .../imac-test
const txt = (s, n = 512) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

function chatProviders() {
  const out = [];
  const accessPath = txt(process.env.MODEL_ACCESS_PATH || path.join(REPO_ROOT, ".deploy_data/data/model-access.json"), 1024);
  try {
    if (fs.existsSync(accessPath)) {
      const access = JSON.parse(fs.readFileSync(accessPath, "utf8"));
      for (const m of access.claudeCodeModels || []) {
        if (!m.enabled || !m.imported) continue;
        const sf = path.join(os.homedir(), ".claude", `settings-${m.key}.json`);
        if (!fs.existsSync(sf)) continue;
        let st; try { st = JSON.parse(fs.readFileSync(sf, "utf8")); } catch { continue; }
        const env = st.env || {};
        if (!env.ANTHROPIC_BASE_URL || !env.ANTHROPIC_AUTH_TOKEN) continue;
        out.push({ key: m.key, label: m.label || m.key, type: "anthropic",
          baseUrl: env.ANTHROPIC_BASE_URL, authToken: env.ANTHROPIC_AUTH_TOKEN,
          model: st.model || env.ANTHROPIC_DEFAULT_SONNET_MODEL || m.claude_model || "GLM-5.2" });
      }
    }
  } catch (_) {}
  const codexKey = txt(process.env.RCC2_API_KEY || process.env.RIGHTCODE_API_KEY || "", 512);
  if (codexKey) out.push({ key: "env:codex", label: "Codex (env)", type: "responses",
    baseUrl: "https://right.codes/codex/v1", apiKey: codexKey,
    model: txt(process.env.WECHAT_ART_LLM_MODEL || "gpt-5.5", 120) });
  return out;
}
function findProvider(modelKey) {
  const ps = chatProviders();
  if (!ps.length) throw new Error("没有可用的 AI 渠道（检查 model-access.json / RCC2_API_KEY）");
  if (!modelKey) return ps[0];
  return ps.find((p) => p.key === modelKey) || ps[0];
}
function defaultModelKey() { return txt(process.env.WECHAT_ART_REPORT_MODEL, 120) || (chatProviders()[0]?.key || ""); }
function channelsOut() {
  return chatProviders().map((p) => ({ key: p.key, label: p.label, model: p.model, type: p.type }));
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeModelError(error, timeoutMs) {
  if (error?.name === "AbortError") {
    const e = new Error(`模型响应超时（>${Math.ceil(timeoutMs / 1000)} 秒）`);
    e.name = "ModelTimeoutError";
    e.code = "MODEL_TIMEOUT";
    return e;
  }
  return error instanceof Error ? error : new Error(String(error || "模型调用失败"));
}

function isTransientModelError(error) {
  if (!error) return false;
  if (error.code === "MODEL_TIMEOUT") return true;
  const message = String(error.message || error);
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|HTTP (408|409|425|429|5\d\d)/i.test(message);
}

async function callModel({ provider, system, user, maxTokens = 3000, timeoutMs = 25000, retries = 0, retryDelayMs = 1200 }) {
  const p = provider || findProvider();
  const url = p.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  const maxAttempts = Math.max(1, Math.min(Number(retries) + 1 || 1, 3));
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { method: "POST", signal: ctrl.signal,
        headers: { "Content-Type": "application/json", "x-api-key": p.authToken,
          "anthropic-version": "2023-06-01", Authorization: `Bearer ${p.authToken}` },
        body: JSON.stringify({ model: p.model, max_tokens: maxTokens, system,
          messages: [{ role: "user", content: user }] }) });
      const j = await r.json();
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt(JSON.stringify(j?.error || j), 200)}`);
      const text = Array.isArray(j.content) ? j.content.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() : "";
      return { text, usage: j.usage || {}, model: p.label + "/" + p.model };
    } catch (rawError) {
      lastError = normalizeModelError(rawError, timeoutMs);
      if (attempt >= maxAttempts || !isTransientModelError(lastError)) throw lastError;
      await wait(Math.min(retryDelayMs * attempt, 5000));
    } finally { clearTimeout(timer); }
  }
  throw lastError || new Error("模型调用失败");
}

function repairInnerQuotes(json) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < json.length; i++) {
    const ch = json[i];
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\") { out += ch; esc = true; continue; }
      if (ch === '"') {
        let j = i + 1; while (j < json.length && /\s/.test(json[j])) j++;
        const nx = json[j];
        if (nx === "," || nx === "}" || nx === "]" || nx === ":") { out += '"'; inStr = false; }
        else out += '\\"';
        continue;
      }
      out += ch; continue;
    }
    if (ch === '"') { inStr = true; out += '"'; continue; }
    out += ch;
  }
  return out;
}
function parseJsonLoose(text) {
  if (!text) return null;
  let s = String(text);
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1];
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch {}
  try { return JSON.parse(repairInnerQuotes(m[0])); } catch {}
  return null;
}
async function callJson(args) {
  const resp = await callModel(args);
  return { ...resp, json: parseJsonLoose(resp.text) };
}

module.exports = { chatProviders, findProvider, defaultModelKey, channelsOut,
  callModel, callJson, parseJsonLoose, normalizeModelError, isTransientModelError };
