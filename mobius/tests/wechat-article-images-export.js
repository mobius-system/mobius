const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "../extension/wechat-article");
const store = require(path.join(root, "backend/lib/store"));
const image = require(path.join(root, "backend/lib/image"));
const { articleRoot } = require(path.join(root, "backend/lib/assets"));
const { buildArticlePackage } = require(path.join(root, "backend/lib/export"));

function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wechat-article-export-"));
  try {
    const db = store.open(dir);
    const articleId = "art_export_test";
    const body = "# 测试文章\n\n## 第一部分\n\n正文。";
    const withImage = image.insertImageBlocks(body, [{ position: 1, filename: "01-机器人.jpg", caption: "机器人工作场景",
      alt_text: "机器人", author: "Example Author", license: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0",
      source_page_url: "https://commons.wikimedia.org/wiki/File:Example.jpg", source_url: "https://upload.wikimedia.org/example.jpg" }]);
    assert.match(withImage, /images\/01-机器人\.jpg/);
    assert.match(withImage, /作者：Example Author/);
    assert.strictEqual(image.stripGeneratedImages(withImage), body);

    const art = store.upsertArticle(db, { id: articleId, title: "测试文章", digest: "测试摘要", body_md: withImage, state: "draft" });
    const imageDir = path.join(articleRoot(dir, "admin", articleId), "images");
    fs.mkdirSync(imageDir, { recursive: true });
    const filePath = path.join(imageDir, "01-机器人.jpg");
    fs.writeFileSync(filePath, Buffer.from("ffd8ffe000104a464946", "hex"));
    store.replaceArticleImages(db, articleId, [{ id: "img_1", position: 1, file_path: filePath, filename: "01-机器人.jpg",
      caption: "机器人工作场景", alt_text: "机器人", content_hash: "hash", bytes: 10, author: "Example Author",
      license: "CC BY 4.0", license_url: "https://creativecommons.org/licenses/by/4.0",
      source_page_url: "https://commons.wikimedia.org/wiki/File:Example.jpg", source_url: "https://upload.wikimedia.org/example.jpg",
      search_query: "humanoid robot" }]);
    const rows = store.listArticleImages(db, articleId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].filename, "01-机器人.jpg");

    const result = buildArticlePackage({ extDataDir: dir, username: "admin", article: { ...art, body_md: withImage }, images: rows });
    assert(fs.existsSync(result.path));
    assert.strictEqual(result.image_count, 1);
    const names = execFileSync("unzip", ["-Z1", result.path], { encoding: "utf8" });
    assert.match(names, /images\/01-/);
    assert.match(names, /\.csv/);
    assert.match(names, /\.html/);
    execFileSync("unzip", ["-t", result.path], { stdio: "pipe" });
    db.close();

    const handler = fs.readFileSync(path.join(root, "backend/extension_backend_handler.js"), "utf8");
    const frontend = fs.readFileSync(path.join(root, "frontend/main.js"), "utf8");
    assert(handler.includes('case "start_images"'));
    assert(handler.includes('case "prepare_export"'));
    assert(frontend.includes('api("start_images"'));
    assert(frontend.includes('api("prepare_export"'));
    assert(frontend.includes("下载图文包 ZIP"));
    console.log("wechat-article image/export tests passed");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main();
