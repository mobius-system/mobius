// 桌面/移动客户端分发的同源静态路由 (替代原先裸 express.static)。
//
// 原先 mobius/server.js 用 express.static 挂 /desktop-builds /mobile-builds, 未命中时 fallthrough
// 到后面的 SPA `app.get('*')` 回退, 返回 index.html 且 HTTP 200 —— 浏览器把 HTML 存成 .zip,
// 用户看到"解压失败"而非清楚的 404 (见方案 §2.6)。
//
// 本中间件保证:
//   - 未命中 → 直接 404 (纯文本, 不调 next, SPA 回退永远拿不到这两个前缀);
//   - 正确 Content-Type: .zip / .dmg / .apk / .json (浏览器别再当成 HTML);
//   - X-Content-Type-Options: nosniff;
//   - manifest.json → Cache-Control: no-cache (每次拿最新版本/SHA); 其它版本化二进制 → 1h 可重验;
//   - 不列目录 (根路径访问直接 404);
//   - 防路径穿越 (解析后须落在 rootDir 内)。
//
// 拆成独立模块便于 tests/server/desktop-builds.test.js 单测 (不启动整个 server.js)。
const path = require("node:path");
const fs = require("node:fs");

// 扩展名 → Content-Type。express/mime 的默认对 .dmg/.apk 不一定对, 这里显式控制。
const EXT_TYPE = {
  ".zip": "application/zip",
  ".dmg": "application/x-apple-diskimage",
  ".apk": "application/vnd.android.package-archive",
  ".json": "application/json; charset=utf-8",
  ".pkg": "application/octet-stream",
  ".exe": "application/vnd.microsoft.portable-executable",
  ".blockmap": "application/octet-stream",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

function contentTypeFor(filename) {
  const ext = path.extname(filename).toLowerCase();
  return EXT_TYPE[ext] || "application/octet-stream";
}

// manifest.json 每次都要拿最新 (版本/SHA 会随发布更新); 版本化二进制 (文件名含版本号) 可缓存。
function cacheControlFor(filename) {
  if (filename === "manifest.json") return "no-cache";
  return "public, max-age=3600";
}

function headersFor(filename) {
  return {
    "Content-Type": contentTypeFor(filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cacheControlFor(filename),
  };
}

// 统一的"文件不存在"响应: 404 + 纯文本 + nosniff。绝不返回 index.html, 也不调 next()。
function sendMissing(res) {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(404);
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "no-cache");
  res.send("404 Not Found\n");
}

/** 创建挂在 /desktop-builds 或 /mobile-builds 下的路由。rootDir = 磁盘真实目录。 */
function createBuildsRouter(rootDir) {
  const root = path.resolve(rootDir);
  // 用 Router: 挂载点前缀会被 express 剥掉, req.url/req.path 是相对路径。
  const router = require("express").Router();
  router.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    // 相对路径, 去掉前导斜杠与 query
    const rel = decodeURIComponent((req.url || "").split("?")[0]).replace(/^\/+/, "");
    if (!rel) return sendMissing(res); // 根路径: 不列目录
    const abs = path.resolve(root, rel);
    // 防穿越: 解析后必须在 rootDir 之内 (拒绝 ../ 越界)
    if (abs !== root && !abs.startsWith(root + path.sep)) return sendMissing(res);
    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) return sendMissing(res);
      // 命中: 用 sendFile 流式发送 (支持 Range/ETag/Last-Modified), headers 显式控制类型。
      res.sendFile(
        abs,
        {
          lastModified: true,
          headers: headersFor(path.basename(abs)),
        },
        (sendErr) => {
          if (!sendErr) return;
          // 极少数: stat 命中但读取中途失败 (文件被删等) → 干净 404, 不进 SPA。
          if (!res.headersSent) sendMissing(res);
          else if (!res.writableEnded) res.end();
        }
      );
    });
  });
  return router;
}

module.exports = {
  createBuildsRouter,
  contentTypeFor,
  cacheControlFor,
  headersFor,
  sendMissing,
  EXT_TYPE,
};
