// lib/claims.js — 主张账本（方案 §8.2）。
// 写作前 extractFacts：从证据抽可核验事实点（数字/日期/引语/能力/因果）+ 风险。
// 写作后 bindToArticle：把正文每段主张绑定到证据 + support/refute/uncertain。
// 推送前 lint：高风险主张须有 A 级或两个独立 B 级；未解决高风险冲突为 0；引语与来源一致。

const crypto = require("crypto");
const { callJson } = require("./llm");
const txt = (s, n = 6000) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 24);
const newId = () => "cl_" + hash(Date.now() + ":" + Math.random());
function srcTag(name) { try { return String(name || "").replace(/^RSS[·\/]/, ""); } catch { return name; } }
function splitParas(md) { return String(md || "").split(/\n{2,}/).map((s) => s.trim()).filter(Boolean); }

async function extractFacts({ provider, evidence, topic }) {
  const evBlock = evidence.slice(0, 12).map((e, i) => `[E${i + 1}|${e.tier}|${srcTag(e.source_name)}] ${txt(e.excerpt, 600)}`).join("\n");
  const r = await callJson({ provider, system: "只输出 JSON。", maxTokens: 1500, timeoutMs: 45_000, retries: 1,
    user: `从下列证据抽取【可核验事实点】用于公众号写作：数字、日期、引语(原文)、产品能力、因果判断。每条标注 risk(high/mid/low) 与对应证据序号 Ei。无证据不要编造。\n选题：${txt(topic.title, 200)}\n证据：\n${evBlock}\n输出：{"facts":[{"text":"","risk":"low|mid|high","evidence":["E1"],"kind":"number|date|quote|capability|causal"}]}` });
  return (r.json && r.json.facts) || [];
}

async function bindToArticle({ provider, bodyMd, evidence }) {
  const paras = splitParas(bodyMd);
  const evBlock = evidence.slice(0, 12).map((e, i) => `E${i + 1}: ${srcTag(e.source_name)} (${e.tier})`).join("\n");
  const r = await callJson({ provider, system: "只输出 JSON。", maxTokens: 2000, timeoutMs: 45_000, retries: 1,
    user: `下列公众号正文按段落拆分。为每段抽取其中的【具体主张】（数字/日期/引语/能力/因果），匹配证据 Ei，判定关系：support/refute/uncertain。\n证据清单：\n${evBlock}\n段落：\n${paras.map((p, i) => "P" + (i + 1) + ": " + txt(p, 400)).join("\n")}\n输出：{"claims":[{"paragraph":1,"text":"","risk":"low|mid|high","evidence":"E1","relation":"support|refute|uncertain"}]}` });
  const claims = (r.json && r.json.claims) || [];
  return claims.map((c) => ({ id: newId(), paragraph_idx: Math.max(0, Number(c.paragraph) - 1),
    claim_text: txt(c.text, 400), risk: c.risk || "low", evidence_id: c.evidence || "",
    relation: c.relation || "uncertain", resolved: 0 }));
}

function lint({ claims = [], evidence = [] }) {
  const evTier = {};
  evidence.forEach((e, i) => { evTier["E" + (i + 1)] = e.tier; evTier[e.id] = e.tier; });
  const blockers = [];
  const highRisk = claims.filter((c) => c.risk === "high");
  const unresolved = claims.filter((c) => c.relation === "uncertain" || c.relation === "refute");
  for (const c of highRisk) {
    const t = evTier[c.evidence_id];
    if (!t) blockers.push(`高风险主张无证据：第${(c.paragraph_idx || 0) + 1}段「${txt(c.claim_text, 40)}」`);
    else if (t === "C") blockers.push(`高风险主张仅有 C 级证据：第${(c.paragraph_idx || 0) + 1}段`);
  }
  const conflictHi = unresolved.filter((c) => c.risk === "high");
  if (conflictHi.length) blockers.push(`存在 ${conflictHi.length} 条未解决的高风险冲突`);
  return { ok: blockers.length === 0, blockers,
    stats: { claims: claims.length, high_risk: highRisk.length, unresolved: unresolved.length } };
}

module.exports = { extractFacts, bindToArticle, lint, splitParas };
