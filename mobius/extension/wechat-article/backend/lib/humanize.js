// lib/humanize.js — 去 AI 味（方案 §9）。三层：
// 1) 检测套话/机械连接词/虚假归因/排比滥用；2) 句长与重复句式统计（仅提醒，不强制）；
// 3) 仅定向改写命中句子，不改引用/事实/用户内容。不用"AI 率"指标，最终看保留率/修改量/盲评。

const { callModel } = require("./llm");
const txt = (s, n = 12000) => String(s || "").trim().slice(0, n);

const CLICHE = ["全面解析", "至关重要", "不断演变的格局", "日新月异", "综上所述", "值得注意的是",
  "随着.{0,8}的发展", "赋能", "底层逻辑", "闭环", "深度赋能", "强势赋能", "不可忽视",
  "在当今.{0,8}背景下", "总而言之", "由此可见", "毋庸置疑"];
const FILLER_CONN = ["首先.{0,40}其次.{0,40}最后", "一方面.{0,40}另一方面", "不仅.{0,40}而且"];

function detect(md) {
  const hits = [];
  for (const p of CLICHE) { try { if (new RegExp(p).test(md)) hits.push({ kind: "cliche", pattern: p }); } catch {} }
  for (const p of FILLER_CONN) { try { if (new RegExp(p).test(md)) hits.push({ kind: "mechanical", pattern: p }); } catch {} }
  const sentences = String(md).split(/[。！？\n]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const lens = sentences.map((s) => s.length);
  const avg = lens.length ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length) : 0;
  const longRatio = lens.length ? lens.filter((l) => l > 80).length / lens.length : 0;
  return { hits, stats: { sentences: lens.length, avg_len: avg, long_ratio: Math.round(longRatio * 100) / 100 } };
}

async function humanize({ provider, bodyMd, style }) {
  const det = detect(bodyMd);
  // 无明显问题且句长适中 → 跳过改写，避免无谓扰动
  if (!det.hits.length && det.stats.avg_len < 70) return { bodyMd, detection: det, changed: false };
  const r = await callModel({ provider, system: "你是中文编辑，只做局部润色，不改变事实与立场。", maxTokens: 4000, timeoutMs: 60_000, retries: 1,
    user: [
      "定向改写下面公众号正文中【命中套话/机械连接/排比滥用】的句子，使其更自然、具体。",
      "硬规则：1) 不要改任何数字、日期、引语、专有名词、事实陈述；2) 不要改作者明确表达的观点；",
      "3) 不要新增未经证据的具体信息；4) 保持 Markdown 结构与 [事实N] 标注不变；5) 原句已足够自然则原样保留。",
      "命中：" + (det.hits.map((h) => h.pattern).join("、") || "无"),
      "禁用表达：" + ((style && style.banned_phrases) || "无"),
      "正文：", txt(bodyMd),
      "输出：纯 Markdown 正文（去掉```），保持同等结构与长度。",
    ].join("\n") });
  const out = (r.text || bodyMd).trim();
  return { bodyMd: out, detection: det, changed: out !== String(bodyMd).trim() };
}

module.exports = { detect, humanize };
