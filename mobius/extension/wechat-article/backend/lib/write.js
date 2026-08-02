// lib/write.js — 写作（方案 §9）。三框架：interpretation(热点解读)/opinion(观点)/list(实用清单)。
// 顺序：主题+画像 → 主张账本(facts) → 论点-证据-段落映射 → 分段生成 → 全文检查 → 标题/摘要联调。
// 规则：具体事实优先；无证据的数字/引语/能力不写；允许有立场不强制表态；禁止编造用户经历；
//   引用具体事实时用 [事实N] 标注（render/humanize 不动该标注，发布版渲染时去除）。

const { callModel, callJson } = require("./llm");
const txt = (s, n = 8000) => String(s || "").trim().slice(0, n);

const FRAMEWORKS = {
  interpretation: "热点解读：解释这件事是什么、为什么重要、技术/产业上意味着什么，给出有依据的判断。",
  opinion: "观点文章：围绕一个明确观点展开论证，论点-证据-反驳-结论，允许有鲜明立场。",
  list: "实用清单：以可操作的清单/步骤为主体，每条配简短理由或证据。",
};
const BANNED_PHRASES = ["全面解析", "至关重要", "不断演变的格局", "日新月异", "综上所述",
  "随着", "赋能", "底层逻辑", "闭环", "在当今", "毋庸置疑"];

function buildOutlinePrompt({ topic, facts, profile, style }) {
  const fw = FRAMEWORKS[topic.framework] || FRAMEWORKS.interpretation;
  const factsBlock = (facts || []).slice(0, 20)
    .map((f, i) => `${i + 1}. [${f.risk}|${(f.evidence || []).join(",")}|${f.kind}] ${txt(f.text, 200)}`).join("\n");
  return [
    `你是公众号「${profile.positioning || "AI 热点"}」的资深作者。目标读者：${profile.audience || "关注 AI 的从业者"}。语气：${profile.tone || "克制、具体、有判断"}。`,
    `禁写：${profile.forbidden || "无"}。商业目标：${profile.goals || "建立专业信任"}。`,
    `框架：${fw}`,
    `选题：${txt(topic.title, 200)}`,
    `角度：${txt(topic.angle, 300)}`,
    "可用事实点（仅可引用这些，不可编造新的数字/引语/能力）：",
    factsBlock || "（无结构化事实点，只用通用且可核验的表述，避免具体数字）",
    `风格要求：${style.tone || ""}；禁用表达：${[...BANNED_PHRASES, style.banned_phrases || ""].filter(Boolean).join("、")}`,
    `输出大纲 JSON：{"title":"≤32字","digest":"≤110字摘要","outline":[{"heading":"","facts":[1]}]}`,
  ].join("\n");
}

async function outline(args) {
  const r = await callJson({ provider: args.provider, system: "只输出 JSON。", maxTokens: 1200, timeoutMs: 45_000, retries: 1,
    user: buildOutlinePrompt(args) });
  return r.json || { title: args.topic.title, digest: "", outline: [] };
}

async function draft({ provider, topic, profile, style, facts, outlineObj }) {
  const fw = FRAMEWORKS[topic.framework] || FRAMEWORKS.interpretation;
  const factsBlock = (facts || []).slice(0, 20)
    .map((f, i) => `${i + 1}. [${f.risk}|${(f.evidence || []).join(",")}] ${txt(f.text, 220)}`).join("\n");
  const outlineBlock = (outlineObj.outline || [])
    .map((o, i) => `${i + 1}. ${o.heading}（引用事实 ${(o.facts || []).join(",")}）`).join("\n");
  const user = [
    `按大纲写公众号正文（Markdown，800-1600 字）。框架：${fw}`,
    `画像/语气：${profile.positioning || ""} / 读者 ${profile.audience || ""} / 语气 ${profile.tone || "克制具体"}`,
    `选题：${txt(topic.title, 200)}；角度：${txt(topic.angle, 300)}`,
    `大纲：\n${outlineBlock}`,
    "事实点（只能引用这些；引用数字/引语时在句尾用 [事实N] 标注）：",
    factsBlock || "（无结构化事实点，避免具体数字与引语）",
    "硬规则：",
    "1) 没有证据的数字、日期、引语、产品能力一律不写。",
    "2) 不要编造作者/用户的个人经历、情绪、第一人称体验。",
    "3) 允许有立场，但不强制每段表态。",
    `4) 禁用模板表达：${[...BANNED_PHRASES, style.banned_phrases || ""].filter(Boolean).join("、")}。`,
    "5) 开头直接进入具体事实，不要用套话。",
    "输出：纯 Markdown 正文，不要 ```代码块；首行用 # 作为正文大标题（可与选题不同）。",
  ].join("\n");
  const r = await callModel({ provider, system: "你是优秀的中文科技公众号作者，文风克制、具体、有判断力。", maxTokens: 4000, timeoutMs: 75_000, retries: 1, user });
  return { bodyMd: (r.text || "").trim() };
}

module.exports = { outline, draft, FRAMEWORKS, BANNED_PHRASES };
