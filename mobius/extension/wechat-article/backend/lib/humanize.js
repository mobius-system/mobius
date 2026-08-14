// lib/humanize.js — 去 AI 味（方案 §9）。三层：
// 1) 检测套话/机械连接词/虚假归因/排比滥用；2) 句长与重复句式统计（仅提醒，不强制）；
// 3) 仅定向改写命中句子，不改引用/事实/用户内容。不用"AI 率"指标，最终看保留率/修改量/盲评。

const { callModel } = require("./llm");
const { NATURAL_WRITING_GUIDE, detectNaturalStyle } = require("./natural-style");
const txt = (s, n = 12000) => String(s || "").trim().slice(0, n);

function detect(md) {
  return detectNaturalStyle(md);
}

async function humanize({ provider, bodyMd, style }) {
  const det = detect(bodyMd);
  // 无明显问题且句长适中 → 跳过改写，避免无谓扰动
  if (!det.hits.length && det.stats.avg_len < 70) return { bodyMd, detection: det, changed: false };
  const r = await callModel({ provider, system: "你是中文编辑，只做局部润色，不改变事实、立场、段落结构或 Markdown 标记。\n" + NATURAL_WRITING_GUIDE, maxTokens: 4000, timeoutMs: 60_000, retries: 1,
    user: [
      "定向改写下面公众号正文中命中的套话、机械连接、抽象评价、无来源归因或重复句首，使其更自然、具体。只改确实有问题的句子，其余原样保留。",
      "硬规则：1) 不要改任何数字、日期、引语、专有名词、事实陈述；2) 不要改作者明确表达的观点；",
      "3) 不要新增未经证据的具体信息；4) 保持 Markdown 标题、列表、段落和 [事实N] 标注不变；5) 原句已足够自然则原样保留。",
      "命中：" + (det.hits.map((h) => h.label || h.pattern).join("、") || "无"),
      "禁用表达：" + ((style && style.banned_phrases) || "无"),
      "编辑规则：\n" + NATURAL_WRITING_GUIDE,
      "正文：", txt(bodyMd),
      "输出：纯 Markdown 正文（去掉```），保持同等结构与长度。",
    ].join("\n") });
  const out = (r.text || bodyMd).trim();
  return { bodyMd: out, detection: det, changed: out !== String(bodyMd).trim() };
}

module.exports = { detect, humanize };
