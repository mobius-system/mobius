// natural-style.js — 公众号正文的自然中文写作约束。
// 规则来自 .imac/skills/natural-document-writing，集中维护，供写作和复核阶段复用。

const NATURAL_WRITING_GUIDE = [
  "写给具体读者，不套用通用模板。开头直接进入选题、事实或判断，删去寒暄和背景套话。",
  "优先使用具体主语和动作动词；能写清对象、机制、数字、日期、限制或结果，就不要用抽象名词堆叠。",
  "以连贯段落承载论述。只有步骤、要求或互相独立的项目才使用列表，不要为了整齐强行凑成三点。",
  "句子长短随意思变化，避免连续使用‘首先/其次/最后’、‘一方面/另一方面’等报幕式连接。",
  "不要为了制造气势堆叠‘全面、深入、系统’等同义词；不要把普通变化夸大成‘里程碑、新篇章、新高度’。",
  "只有存在真实矛盾时才使用‘不是……而是……’或‘不仅……更是……’；不要用装饰性对比重复同一个判断。",
  "不要使用没有来源的‘专家认为、研究表明、业内普遍认为’；没有证据的数字、引语、能力和因果关系不写。",
  "事实之后直接说明具体影响或限制，不追加空洞的‘彰显意义、凸显价值、注入动力、展望未来’。",
  "保留作者真实立场和必要的专业术语，但语气克制、具体、有判断；不编造个人经历、用户故事或引用。",
].join("\n");

const STYLE_PATTERNS = [
  { kind: "cliche", label: "时代/背景套话", re: /(?:在当今|在这个|在当前)(?:[^。！？\n]{0,18})(?:时代|背景下|环境中)/ },
  { kind: "cliche", label: "发展进步套话", re: /随着(?:社会|科技|时代|行业|技术|人工智能|大模型)?[^。！？\n]{0,12}(?:不断)?(?:发展|进步|演进|变化)/ },
  { kind: "cliche", label: "空洞总结", re: /(?:综上所述|总而言之|由此可见|毋庸置疑|显而易见)/ },
  { kind: "cliche", label: "模板化标题", re: /(?:全面解析|不断演变的格局|日新月异|值得注意的是)/ },
  { kind: "cliche", label: "泛化评价", re: /(?:至关重要|不可或缺|意义重大|深远影响|举足轻重|不可忽视)/ },
  { kind: "inflated", label: "抽象商务词", re: /(?:赋能|抓手|闭环|全方位|多维度|一体化|体系化|组合拳|底层逻辑|生态)/ },
  { kind: "inflated", label: "空洞升华", re: /(?:彰显|凸显|奠定[^。！？\n]{0,8}基础|注入[^。！？\n]{0,8}动力|开启全新可能|引领变革|重新定义)/ },
  { kind: "mechanical", label: "报幕式连接", re: /首先[^。！？\n]{0,80}其次[^。！？\n]{0,80}(?:再次[^。！？\n]{0,80})?最后/ },
  { kind: "mechanical", label: "机械并列", re: /一方面[^。！？\n]{0,80}另一方面/ },
  { kind: "mechanical", label: "装饰性对比", re: /(?:不仅[^。！？\n]{0,60}(?:而且|更是)|不是[^。！？\n]{0,60}而是)/ },
  { kind: "attribution", label: "无来源共识", re: /(?:有专家(?:认为|指出)|研究表明|业内人士(?:认为|指出)|普遍认为|许多人相信)/ },
];

function detectNaturalStyle(md) {
  const source = String(md || "");
  const hits = [];
  for (const item of STYLE_PATTERNS) {
    if (item.re.test(source)) hits.push({ kind: item.kind, label: item.label, pattern: item.re.source });
  }
  const sentences = source
    .split(/[。！？\n]/)
    .map((s) => s.replace(/^\s*[-*+]\s+|^\s*\d+[.)]\s+/, "").trim())
    .filter(Boolean);
  const lengths = sentences.map((s) => s.length);
  const avg = lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : 0;
  const longRatio = lengths.length ? lengths.filter((n) => n > 80).length / lengths.length : 0;
  const repeatedStarts = {};
  sentences.forEach((s) => {
    // 取较短的句首，能发现“用户需要明确目标/边界/风险”这类只替换末尾名词的重复。
    const start = s.slice(0, 6);
    if (start) repeatedStarts[start] = (repeatedStarts[start] || 0) + 1;
  });
  const repeated = Object.entries(repeatedStarts).filter(([, count]) => count >= 3).map(([start]) => start);
  if (repeated.length) hits.push({ kind: "repetition", label: "重复句首", pattern: repeated.join("、") });
  return {
    hits,
    stats: { sentences: lengths.length, avg_len: avg, long_ratio: Math.round(longRatio * 100) / 100, repeated_starts: repeated },
  };
}

module.exports = { NATURAL_WRITING_GUIDE, STYLE_PATTERNS, detectNaturalStyle };
