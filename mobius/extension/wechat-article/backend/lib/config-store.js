// lib/config-store.js — 加密配置层（config.enc，AES-256-GCM）。
// 单用户：微信凭据 / 账号画像 / 风格档案 / 预算 / AI 声明 / 模型选择。
// 缺主密钥时生产模式拒绝落凭据（方案 §13）；对外只回脱敏视图（不回传假 Key）。

const fs = require("fs"), path = require("path");
const { hasKey, encryptObj, decryptObj } = require("./crypto");
const CONFIG_FILE = "config.enc";

function configPath(extDataDir) { return path.join(extDataDir, CONFIG_FILE); }

function defaultConfig() {
  return {
    wx: { appid: "", secret: "", note: "" },
    account_profile: { positioning: "", audience: "", forbidden: "", goals: "", tone: "" },
    style: { tone: "", structure: "", syntax: "", opinion_strength: "", banned_phrases: "" },
    budgets: { per_article_search: 6, per_article_tokens: 20000, per_article_images: 3, per_article_amount: 2.0, daily_amount: 20.0 },
    ai_declaration: "本文由作者借助 AI 辅助整理资料与初稿，最终观点与文字经人工核实与修改。",
    model_key: "",
    inline_images: true,
  };
}

function load(extDataDir) {
  const file = configPath(extDataDir);
  if (!fs.existsSync(file)) return defaultConfig();
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return defaultConfig();
    return { ...defaultConfig(), ...decryptObj(raw) };
  } catch (_) { return defaultConfig(); }
}

function save(extDataDir, cfg) {
  if (!hasKey()) {
    if (process.env.NODE_ENV === "production") throw new Error("缺少主密钥，生产模式拒绝保存凭据");
    throw new Error("缺少主密钥（MOBIUS_EXTENSION_SECRET/JWT_SECRET），无法保存配置");
  }
  const file = configPath(extDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encryptObj(cfg), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
  return true;
}

// 脱敏：凭据只暴露"已配置"+ 前 4 位掩码
function publicView(cfg) {
  return {
    wx_configured: !!(cfg.wx && cfg.wx.appid && cfg.wx.secret),
    wx_appid_masked: cfg.wx && cfg.wx.appid ? cfg.wx.appid.slice(0, 4) + "***" : "",
    account_profile: cfg.account_profile || {},
    style: cfg.style || {},
    budgets: cfg.budgets || {},
    ai_declaration: cfg.ai_declaration || "",
    model_key: cfg.model_key || "",
    inline_images: !!cfg.inline_images,
    crypto_available: hasKey(),
  };
}

// 部分更新（前端只传改动字段；凭据字段空串=不覆盖，避免误清空）
function mergeSave(extDataDir, patch) {
  const cur = load(extDataDir);
  const next = JSON.parse(JSON.stringify(cur));
  for (const k of Object.keys(defaultConfig())) {
    if (patch[k] && typeof patch[k] === "object" && !Array.isArray(patch[k])) {
      next[k] = { ...next[k], ...patch[k] };
    } else if (k in patch) {
      next[k] = patch[k];
    }
  }
  // 凭据：空串保留旧值
  if (next.wx) {
    next.wx.appid = next.wx.appid || cur.wx.appid || "";
    next.wx.secret = next.wx.secret || cur.wx.secret || "";
  }
  save(extDataDir, next);
  return next;
}

module.exports = { load, save, mergeSave, publicView, defaultConfig, configPath };
