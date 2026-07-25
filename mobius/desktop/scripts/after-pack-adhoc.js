// afterPack: 仅用于本地开发 (--dev-adhoc), 给未签名 .app 套一层 ad-hoc 签名。
//
// 用途: 没有 Apple Developer ID 证书时, Apple Silicon 机器必须至少有 ad-hoc 签名才能启动。
// 这是【开发测试专用】, 产物带 -dev-adhoc 后缀, 绝不复制到 /desktop-builds/ 或上传 Release。
// 正式分发走 CI 的 Developer ID 签名 + Apple 公证, 不经过本脚本。
//
// electron-builder 的 mac 签名顺序: pack -> afterPack -> sign(本 dev 配置 identity:null 故跳过)。
// 故 afterPack 写入的 ad-hoc 签名即为最终签名 (无论 sign 在前在后, identity:null 都不覆盖它)。
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== "mac") return;
  if (process.platform !== "darwin") {
    console.log("[after-pack-adhoc] 非 macOS 主机, 跳过 ad-hoc 签名 (产物仍为 dev 包, 不发布)");
    return;
  }
  const appOutDir = context.appOutDir;
  const apps = fs.readdirSync(appOutDir).filter((f) => f.endsWith(".app"));
  if (!apps.length) throw new Error(`[after-pack-adhoc] 未在 ${appOutDir} 找到 .app`);
  const appPath = path.join(appOutDir, apps[0]);
  console.log(`[after-pack-adhoc] ad-hoc 签名 (本地开发, 非 Developer ID): ${appPath}`);
  // --deep 递归签嵌套二进制 (含内置 python Mach-O)。ad-hoc 不带 timestamp。
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath], {
    stdio: "inherit",
  });
  console.log("[after-pack-adhoc] 校验签名:");
  execFileSync("codesign", ["-d", "--verbose=2", appPath], { stdio: "inherit" });
};
