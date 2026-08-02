// lib/image.js — 封面/配图（方案 §11）。MVP 默认只封面。
// 校验：文件魔数/尺寸/像素/字节；统一重编码为 JPG/PNG；正文单图 <1MB；SVG 须先栅格化；
// 按 SHA-256 缓存微信上传。生图：env IMAGE_GEN_BASE/API 配置后启用；否则生成文字占位封面。

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const { execFileSync } = require("child_process");
const { safeFetch, stripHtml } = require("./safe-fetch");
const { articleRoot, safeSegment } = require("./assets");

const MAGIC = {
  jpg: [0xff, 0xd8, 0xff], png: [0x89, 0x50, 0x4e, 0x47],
  gif: [0x47, 0x49, 0x46, 0x38], webp: [0x52, 0x49, 0x46, 0x46],
};
function detectType(buf) {
  const eq = (arr) => arr.every((b, i) => buf[i] === b);
  if (eq(MAGIC.jpg)) return "jpg";
  if (eq(MAGIC.png)) return "png";
  if (eq(MAGIC.gif)) return "gif";
  if (eq(MAGIC.webp)) return "webp";
  return null;
}
function sha256(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// 校验并落地一张图到 images/
function ingestImage({ extDataDir, source, kind = "inline" }) {
  const imagesDir = path.join(extDataDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  let buf;
  if (Buffer.isBuffer(source)) buf = source;
  else buf = fs.readFileSync(source);
  const type = detectType(buf);
  if (!type) throw new Error("无法识别的图片格式（魔数校验失败）");
  if (buf.byteLength > 5_000_000) throw new Error("原图过大（>5MB）");
  const hash = sha256(buf);
  const file = path.join(imagesDir, `${kind}_${hash}.${type}`);
  fs.writeFileSync(file, buf);
  return { path: file, hash, type, bytes: buf.byteLength };
}

// 占位文字封面：SVG → 尝试 sharp 栅格化为 PNG；sharp 不可用则返回 SVG 并标记需手动替换。
async function generatePlaceholderCover({ extDataDir, title, subtitle = "" }) {
  const imagesDir = path.join(extDataDir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });
  const t = esc(String(title || "AI 热点").slice(0, 24));
  const sub = esc(String(subtitle || "").slice(0, 40));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="500">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="#1f2a44"/><stop offset="1" stop-color="#576b95"/></linearGradient></defs>
<rect width="900" height="500" fill="url(#g)"/>
<text x="60" y="240" font-family="PingFang SC, Microsoft YaHei, sans-serif" font-size="56" font-weight="bold" fill="#ffffff">${t}</text>
<text x="60" y="300" font-family="PingFang SC, sans-serif" font-size="26" fill="#c8d2ec">${sub}</text>
<text x="60" y="450" font-family="sans-serif" font-size="18" fill="#9fb0d8">AI 热点 · 公众号图文</text>
</svg>`;
  try {
    const sharp = require("sharp");
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const pngPath = path.join(imagesDir, `cover_${sha256(png).slice(0, 16)}.png`);
    fs.writeFileSync(pngPath, png);
    return { path: pngPath, hash: sha256(png), type: "png", bytes: png.length };
  } catch (_) {
    const svgPath = path.join(imagesDir, `cover_${sha256(Buffer.from(svg)).slice(0, 16)}.svg`);
    fs.writeFileSync(svgPath, svg);
    return { path: svgPath, hash: sha256(Buffer.from(svg)), type: "svg", bytes: svg.length, need_rasterize: true };
  }
}

// 远程生图（可选，env 驱动）
async function generateRemoteCover({ prompt }) {
  const base = process.env.IMAGE_GEN_BASE, key = process.env.IMAGE_GEN_API;
  if (!base || !key) throw new Error("未配置生图服务（IMAGE_GEN_BASE/API）");
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 40_000);
  try {
    const r = await fetch(base.replace(/\/+$/, "") + "/generate", { method: "POST", signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ prompt, size: "1024x576" }) });
    const j = await r.json();
    const url = j.url || (j.data && j.data[0] && j.data[0].url);
    if (!url) throw new Error("生图未返回 url");
    const f = await safeFetch(url, { maxBytes: 5_000_000, timeoutMs: 30_000 });
    return f.buffer;
  } finally { clearTimeout(timer); }
}

const COMMONS_HOSTS = new Set(["commons.wikimedia.org", "upload.wikimedia.org"]);
const OPEN_LICENSE = /^(CC|Creative Commons|Public domain|PD|GFDL)/i;

async function fetchCommons(rawUrl, { maxBytes = 5_000_000, timeoutMs = 18_000 } = {}) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:" || !COMMONS_HOSTS.has(parsed.hostname)) throw new Error("图片源域名不受信任");
  // 生产环境通常通过 proxychains 访问国际站点；未安装/不可用时立即回退到安全直连。
  try {
    return execFileSync("proxychains4", ["-q", "curl", "--location", "--fail", "--silent", "--show-error",
      "--max-time", String(Math.ceil(timeoutMs / 1000)), "--max-filesize", String(maxBytes), parsed.toString()],
    { timeout: timeoutMs + 3_000, maxBuffer: maxBytes + 64_000 });
  } catch (proxyError) {
    try {
      const result = await safeFetch(parsed.toString(), { httpsOnly: true, maxBytes, timeoutMs, maxRedirects: 3 });
      if (!result.ok) throw new Error("HTTP " + result.status);
      return result.buffer;
    } catch (directError) {
      throw new Error("Commons 请求失败: " + String(directError?.message || proxyError?.message || "网络不可用").slice(0, 120));
    }
  }
}

function metaText(meta, key, max = 240) {
  return stripHtml(meta && meta[key] && meta[key].value || "", max).replace(/\s+/g, " ").trim();
}

function cleanCaption(value, fallback) {
  return String(value || fallback || "配图").replace(/[\[\]()]/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "配图";
}

const SEARCH_TERMS = [
  [/机器人|人形机器人/g, "humanoid robot robotics"], [/人工智能|AI/g, "artificial intelligence"],
  [/大模型|语言模型/g, "large language model"], [/智能体|Agent/g, "AI agent software"],
  [/编程|代码|开发者/g, "software developer coding computer"], [/多模态|视觉识别/g, "computer vision artificial intelligence"],
  [/芯片|算力|GPU/g, "computer chip GPU data center"], [/自动驾驶/g, "autonomous vehicle"],
  [/开源/g, "open source software"], [/数据中心|服务器/g, "data center servers"],
];
function searchFriendly(value) {
  let text = String(value || "");
  for (const [pattern, replacement] of SEARCH_TERMS) text = text.replace(pattern, ` ${replacement} `);
  const ascii = text.replace(/[^A-Za-z0-9 .+_-]/g, " ").replace(/\s+/g, " ").trim();
  return ascii || String(value || "").replace(/\s+/g, " ").trim();
}

function buildSearchPlan(title, bodyMd, count) {
  const headings = String(bodyMd || "").split(/\r?\n/)
    .map((line, index) => ({ line: index, text: line.replace(/^##\s+/, "").trim() }))
    .filter((item) => /^##\s+/.test(String(bodyMd || "").split(/\r?\n/)[item.line]) && item.text);
  const wanted = Math.max(1, Math.min(Number(count) || 3, 6));
  const selected = headings.slice(0, wanted);
  while (selected.length < wanted) selected.push({ line: selected.length ? selected[selected.length - 1].line : 0, text: title });
  return selected.map((item, index) => ({
    position: index + 1,
    afterLine: item.line,
    heading: item.text || title,
    query: [searchFriendly(title), searchFriendly(item.text)].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ").slice(0, 180),
  }));
}

async function searchCommons(query, limit = 8) {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const params = {
    action: "query", generator: "search", gsrsearch: query, gsrnamespace: "6", gsrlimit: String(Math.min(limit, 12)),
    prop: "imageinfo", iiprop: "url|mime|size|extmetadata", iiurlwidth: "1000", format: "json", origin: "*",
  };
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  const data = JSON.parse((await fetchCommons(url.toString(), { maxBytes: 1_500_000, timeoutMs: 20_000 })).toString("utf8"));
  return Object.values(data?.query?.pages || {}).map((page) => {
    const info = page.imageinfo && page.imageinfo[0] || {};
    const meta = info.extmetadata || {};
    const license = metaText(meta, "LicenseShortName", 100);
    return {
      pageTitle: page.title || "", mime: info.mime || "", url: info.thumburl || info.url || "",
      sourceUrl: info.url || "", pageUrl: info.descriptionurl || "", width: info.thumbwidth || info.width || 0,
      height: info.thumbheight || info.height || 0, author: metaText(meta, "Artist", 180) || "Wikimedia Commons contributor",
      license, licenseUrl: metaText(meta, "LicenseUrl", 500),
      caption: cleanCaption(metaText(meta, "ObjectName", 100) || metaText(meta, "ImageDescription", 160), String(page.title || "").replace(/^File:/, "")),
    };
  }).filter((item) => /^image\/(jpeg|png)$/i.test(item.mime) && item.url && OPEN_LICENSE.test(item.license));
}

function stripGeneratedImages(bodyMd) {
  return String(bodyMd || "").replace(/\n?<!-- mobius-image:start -->[\s\S]*?<!-- mobius-image:end -->\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function insertImageBlocks(bodyMd, images) {
  const lines = stripGeneratedImages(bodyMd).split(/\r?\n/);
  const headings = lines.map((line, index) => ({ line, index })).filter((item) => /^##\s+/.test(item.line));
  const placements = [];
  for (const image of images) {
    const target = headings[Math.min(image.position - 1, Math.max(0, headings.length - 1))];
    const after = target ? target.index : Math.min(0, lines.length - 1);
    const sourceLink = image.source_page_url || image.source_url;
    const licenseText = image.license_url ? `[${image.license}](${image.license_url})` : image.license;
    const attribution = `*图${image.position}：${image.caption}；来源：[Wikimedia Commons](${sourceLink})；作者：${image.author}；许可：${licenseText}*`;
    placements.push({ after, block: ["<!-- mobius-image:start -->", `![图${image.position}：${image.alt_text}](images/${image.filename})`, attribution, "<!-- mobius-image:end -->"] });
  }
  placements.sort((a, b) => b.after - a.after);
  for (const item of placements) lines.splice(item.after + 1, 0, "", ...item.block, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function collectArticleImages({ extDataDir, username, articleId, title, bodyMd, count = 3, plan, logger }) {
  const imagesDir = path.join(articleRoot(extDataDir, username, articleId), "images");
  fs.rmSync(imagesDir, { recursive: true, force: true });
  fs.mkdirSync(imagesDir, { recursive: true });
  const searchPlan = Array.isArray(plan) && plan.length ? plan.slice(0, Math.max(1, Math.min(Number(count) || 3, 6))) : buildSearchPlan(title, bodyMd, count);
  const images = [];
  const used = new Set();
  const warnings = [];
  for (const item of searchPlan) {
    let candidates = [];
    try {
      const words = String(item.query || "").split(/\s+/).filter(Boolean);
      const queries = [...new Set([item.query, words.slice(0, 3).join(" "), words.slice(0, 2).join(" "), item.heading, title].filter(Boolean))];
      for (const query of queries) {
        const found = await searchCommons(query, 10);
        if (found.length > candidates.length) { candidates = found; item.query = query; }
        if (found.filter((entry) => !used.has(entry.sourceUrl || entry.url)).length >= 3) break;
      }
    }
    catch (error) { warnings.push(`「${item.heading}」检索失败：${error.message || error}`); continue; }
    const candidate = candidates.find((entry) => !used.has(entry.sourceUrl || entry.url));
    if (!candidate) { warnings.push(`「${item.heading}」未找到开放许可的 JPG/PNG 图片`); continue; }
    try {
      const buffer = await fetchCommons(candidate.url, { maxBytes: 5_000_000, timeoutMs: 25_000 });
      const type = detectType(buffer);
      if (!type || !["jpg", "png"].includes(type)) throw new Error("图片格式不是 JPG/PNG");
      const position = images.length + 1;
      const caption = cleanCaption(item.caption || item.heading, candidate.caption);
      const filename = `${String(position).padStart(2, "0")}-${safeSegment(caption, "配图", 54)}.${type}`;
      const filePath = path.join(imagesDir, filename);
      fs.writeFileSync(filePath, buffer);
      used.add(candidate.sourceUrl || candidate.url);
      images.push({
        id: `img_${crypto.randomBytes(8).toString("hex")}`, kind: "inline", position, prompt: item.query,
        file_path: filePath, filename, content_hash: sha256(buffer), caption, alt_text: item.heading || caption,
        source_url: candidate.sourceUrl || candidate.url, source_page_url: candidate.pageUrl,
        author: candidate.author, license: candidate.license, license_url: candidate.licenseUrl,
        search_query: item.query, width: candidate.width, height: candidate.height, bytes: buffer.length,
        metadata: JSON.stringify({ commons_title: candidate.pageTitle, commons_caption: candidate.caption }), created_at: new Date().toISOString(),
      });
    } catch (error) { warnings.push(`「${item.heading}」图片下载失败：${error.message || error}`); }
  }
  if (logger && warnings.length) warnings.forEach((warning) => logger.warn(warning));
  return { images, bodyMd: images.length ? insertImageBlocks(bodyMd, images) : stripGeneratedImages(bodyMd), warnings };
}

module.exports = { ingestImage, generatePlaceholderCover, generateRemoteCover, detectType, sha256,
  fetchCommons, searchCommons, stripGeneratedImages, insertImageBlocks, collectArticleImages, buildSearchPlan };
