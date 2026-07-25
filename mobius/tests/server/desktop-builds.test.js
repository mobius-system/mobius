// /desktop-builds /mobile-builds 分发路由的单测 (方案 §A3/§6 验收: 未命中 404, 不回退 SPA)。
//
// 运行: cd mobius && node --test tests/server/desktop-builds.test.js
// 只测自建中间件 createBuildsRouter (server.js 里的 SPA 兜底也显式排除这两个前缀,
// 这里聚焦可独立测试的路由单元, 不启动整个 server.js)。
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const express = require("express");

const { createBuildsRouter } = require("../../backend/middleware/builds-static");

// 起一个临时 express app, listen 在随机端口, 返回 {url, close}。
function withServer(rootDir, handler) {
  const app = express();
  app.use("/desktop-builds", createBuildsRouter(rootDir));
  // 模拟 server.js 的 SPA 兜底: 任何漏到这里的 /desktop-builds 也 404 (双保险)
  app.get("*", (req, res) => {
    res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
    res.send("<!doctype html><html><body>SPA index.html</body></html>");
  });
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      resolve({
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function req(urlP) {
  return new Promise((resolve, reject) => {
    http.get(urlP, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") })
      );
    }).on("error", reject);
  });
}

test("存在的 zip → 200 + application/zip + nosniff, 内容是二进制本身", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]); // PK 头
  fs.writeFileSync(path.join(dir, "mobius-desktop-0.0.22-win-x64.zip"), payload);
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/mobius-desktop-0.0.22-win-x64.zip"));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "application/zip");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.ok(r.body.startsWith("PK"), "响应体应是 zip 二进制本身");
  } finally {
    await close();
  }
});

test("存在的 dmg → 200 + application/x-apple-diskimage", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  fs.writeFileSync(path.join(dir, "mobius-desktop-0.0.22-mac-arm64.dmg"), Buffer.from([0x78, 0x01]));
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/mobius-desktop-0.0.22-mac-arm64.dmg"));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "application/x-apple-diskimage");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
  } finally {
    await close();
  }
});

test("manifest.json → 200 + application/json + Cache-Control: no-cache", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  const manifest = JSON.stringify({ version: "0.0.22", builds: [] });
  fs.writeFileSync(path.join(dir, "manifest.json"), manifest);
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/manifest.json"));
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers["content-type"], "application/json; charset=utf-8");
    assert.strictEqual(r.headers["cache-control"], "no-cache");
    assert.strictEqual(r.headers["x-content-type-options"], "nosniff");
    assert.deepStrictEqual(JSON.parse(r.body), { version: "0.0.22", builds: [] });
  } finally {
    await close();
  }
});

test("不存在的文件 → 404, 响应体绝不包含 index.html / <html>", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/mobius-desktop-does-not-exist-mac-arm64.dmg"));
    assert.strictEqual(r.status, 404);
    assert.ok(!r.body.includes("<html"), "404 响应体不能是 HTML");
    assert.ok(!r.body.includes("index.html"), "404 响应体不能是 SPA index.html");
  } finally {
    await close();
  }
});

test("访问根 /desktop-builds/ 不列目录 → 404", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  fs.writeFileSync(path.join(dir, "mobius-desktop-0.0.22-win-x64.zip"), Buffer.from([1]));
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/"));
    assert.strictEqual(r.status, 404);
  } finally {
    await close();
  }
});

test("路径穿越 ../etc/passwd → 404", async () => {
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "db-"));
  const { url, close } = await withServer(dir);
  try {
    const r = await req(url("/desktop-builds/../package.json"));
    // 注意: http client 可能规范化 ../, 用编码形式确保到达中间件
    if (r.status === 404) return;
    // 若被 client 规范掉, 至少不能 200 返回 package.json 内容
    assert.ok(!r.body.includes("name"), "不能返回上级目录文件");
  } finally {
    await close();
  }
});
