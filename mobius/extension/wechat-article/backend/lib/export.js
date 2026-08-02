const fs = require("fs");
const path = require("path");
const { render } = require("./render");
const { createZip } = require("./zip");
const { articleRoot, relativeToUser, safeSegment } = require("./assets");

function csvCell(value) {
  return `"${String(value == null ? "" : value).replace(/"/g, '""')}"`;
}

function htmlDocument(article, bodyHtml) {
  const title = String(article.title || "公众号文章").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head><body style="max-width:760px;margin:32px auto;padding:0 20px;font-family:-apple-system,PingFang SC,Microsoft YaHei,sans-serif;color:#222;">
<h1 style="font-size:24px;">${title}</h1>
${article.digest ? `<p style="color:#777;">${String(article.digest).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</p>` : ""}
${bodyHtml}
</body></html>`;
}

function buildArticlePackage({ extDataDir, username, article, images }) {
  if (!article || !article.id) throw new Error("文章不存在");
  const root = articleRoot(extDataDir, username, article.id);
  const exportsDir = path.join(root, "exports");
  fs.mkdirSync(exportsDir, { recursive: true });
  const titleBase = safeSegment(article.title || "公众号文章", "公众号文章", 60);
  const zipName = `${titleBase}-图文包.zip`;
  const outputPath = path.join(exportsDir, zipName);
  const bodyMd = String(article.body_md || "");
  const bodyHtml = render(bodyMd);
  const markdownDocument = `${/^#\s+/m.test(bodyMd) ? "" : `# ${article.title || ""}\n\n`}${article.digest ? `> 摘要：${article.digest}\n\n` : ""}${bodyMd}\n`;
  const rows = [["次序", "文件名", "图注", "作者", "许可", "许可链接", "来源页", "原图链接", "检索词"]];
  const entries = [
    { name: `${titleBase}.md`, data: Buffer.from(markdownDocument, "utf8") },
    { name: `${titleBase}-公众号预览.html`, data: Buffer.from(htmlDocument(article, bodyHtml), "utf8") },
  ];
  const manifest = [];
  const expectedRoot = path.resolve(root) + path.sep;
  for (const image of images || []) {
    const absolute = path.resolve(String(image.file_path || ""));
    if (!absolute.startsWith(expectedRoot) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
    const filename = image.filename || path.basename(absolute);
    entries.push({ name: `images/${filename}`, path: absolute });
    rows.push([image.position, filename, image.caption, image.author, image.license, image.license_url,
      image.source_page_url, image.source_url, image.search_query]);
    manifest.push({ order: image.position, filename, caption: image.caption, alt_text: image.alt_text,
      author: image.author, license: image.license, license_url: image.license_url,
      source_page_url: image.source_page_url, source_url: image.source_url, search_query: image.search_query,
      width: image.width, height: image.height, bytes: image.bytes });
  }
  entries.push({ name: "图片清单.csv", data: Buffer.from("\ufeff" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n"), "utf8") });
  entries.push({ name: "图片清单.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
  entries.push({ name: "使用说明.txt", data: Buffer.from([
    "公众号图文包使用说明", "", "1. Markdown 与 HTML 文档中的图片均按 images/01、02、03……顺序引用。",
    "2. 图片文件名包含次序和图注摘要，可直接按顺序上传到公众号编辑器。",
    "3. 图片清单.csv / json 保存了每张图的作者、许可协议和来源链接，发布前请保留必要署名并再次核验授权要求。",
    "4. HTML 文件可在浏览器中打开预览；Markdown 文件适合继续编辑或导入其他排版工具。",
  ].join("\r\n"), "utf8") });
  const result = createZip(outputPath, entries);
  return { ...result, filename: zipName, download_path: relativeToUser(extDataDir, username, outputPath), image_count: manifest.length };
}

module.exports = { buildArticlePackage, htmlDocument, csvCell };
