// lib/render.js — Markdown → 微信公众号内联 HTML（方案 §11/§12，参考 Doocs/md 思路）。
// 公众号编辑器会剥离 <style> 与 class，故关键样式必须 inline。
// MVP 支持：#/##/### 标题、段落、有序/无序列表、引用、粗斜体、行内代码、代码块、分隔线、链接、图片。
// 发布版自动去掉 [事实N] 标注。

function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function inline(s) {
  return esc(s)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}" style="max-width:100%;border-radius:8px;margin:12px 0;" />`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, href) => `<a href="${href}" style="color:#576b95;text-decoration:none;">${t}</a>`)
    .replace(/`([^`]+)`/g, (_, c) => `<code style="background:#f3f4f6;padding:2px 5px;border-radius:4px;font-family:Menlo,monospace;font-size:14px;color:#d63384;">${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function render(md) {
  const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^<!--\s*mobius-image:(start|end)\s*-->$/.test(line.trim())) { i++; continue; }
    if (/^```/.test(line)) {
      const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out.push(`<pre style="background:#1e1e1e;color:#eee;padding:14px;border-radius:8px;overflow-x:auto;font-size:13px;line-height:1.6;">${esc(buf.join("\n"))}</pre>`);
      continue;
    }
    if (/^#\s+/.test(line)) { out.push(`<h1 style="font-size:22px;font-weight:bold;margin:24px 0 12px;color:#1a1a1a;">${inline(line.replace(/^#\s+/, ""))}</h1>`); i++; continue; }
    if (/^##\s+/.test(line)) { out.push(`<h2 style="font-size:18px;font-weight:bold;margin:22px 0 10px;color:#1a1a1a;border-left:4px solid #576b95;padding-left:10px;">${inline(line.replace(/^##\s+/, ""))}</h2>`); i++; continue; }
    if (/^###\s+/.test(line)) { out.push(`<h3 style="font-size:16px;font-weight:bold;margin:18px 0 8px;color:#333;">${inline(line.replace(/^###\s+/, ""))}</h3>`); i++; continue; }
    if (/^>\s?/.test(line)) { out.push(`<blockquote style="border-left:3px solid #ccc;margin:14px 0;padding:6px 14px;color:#666;background:#fafafa;font-size:14px;">${inline(line.replace(/^>\s?/, ""))}</blockquote>`); i++; continue; }
    if (/^[-*+]\s+/.test(line)) {
      const items = []; while (i < lines.length && /^[-*+]\s+/.test(lines[i])) { items.push(`<li style="margin:4px 0;line-height:1.75;">${inline(lines[i].replace(/^[-*+]\s+/, ""))}</li>`); i++; }
      out.push(`<ul style="padding-left:22px;margin:12px 0;font-size:15px;color:#3f3f3f;">${items.join("")}</ul>`); continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items = []; while (i < lines.length && /^\d+\.\s+/.test(lines[i])) { items.push(`<li style="margin:4px 0;line-height:1.75;">${inline(lines[i].replace(/^\d+\.\s+/, ""))}</li>`); i++; }
      out.push(`<ol style="padding-left:22px;margin:12px 0;font-size:15px;color:#3f3f3f;">${items.join("")}</ol>`); continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) { out.push(`<hr style="border:none;border-top:1px solid #eee;margin:20px 0;" />`); i++; continue; }
    if (line.trim() === "") { i++; continue; }
    out.push(`<p style="margin:14px 0;line-height:1.85;font-size:15px;color:#3f3f3f;letter-spacing:0.3px;">${inline(line)}</p>`);
    i++;
  }
  return out.join("\n").replace(/\s*\[事实\d+\]/g, ""); // 发布版去事实标注
}

// 微信字段校验（方案 §12.3）
function validateWechatFields({ title, author, digest, bodyHtml }) {
  const errs = [];
  if (title && title.length > 32) errs.push("标题超过 32 字");
  if (author && author.length > 16) errs.push("作者超过 16 字");
  if (digest && digest.length > 120) errs.push("摘要超过 120 字");
  if (bodyHtml) {
    if (bodyHtml.length > 20000) errs.push("正文超 2 万字符");
    if (Buffer.byteLength(bodyHtml, "utf8") > 1_000_000) errs.push("正文超 1MB");
  }
  return { ok: errs.length === 0, errors: errs };
}

module.exports = { render, validateWechatFields };
