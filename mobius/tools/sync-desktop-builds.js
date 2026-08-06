#!/usr/bin/env node
/**
 * CLI: 手动 / cron 同步桌面客户端产物。
 *
 * 用法:
 *   node tools/sync-desktop-builds.js              # 从 GitHub Release 同步
 *   node tools/sync-desktop-builds.js --cron       # cron 模式 (静默, 仅变更时输出)
 *   GITHUB_TOKEN=xxx node tools/sync-desktop-builds.js  # 带 token (避免 rate limit)
 *
 * 多服务器: 每台机器独立运行此脚本, 各自从同一个 GitHub Release 拉取, 互不干扰。
 * cron 建议: 每 30 分钟跑一次 (GitHub API rate limit: 未认证 60/h, 认证 5000/h)。
 *    */30 * * * * node /app/mobius/tools/sync-desktop-builds.js --cron >> /data/logs/desktop-sync.log 2>&1
 */

const { syncDesktopBuilds } = require("../backend/services/sync-desktop-builds");

const isCron = process.argv.includes("--cron");

async function main() {
  const result = await syncDesktopBuilds({
    log: isCron ? () => {} : console.log,
  });

  if (!result.ok) {
    const msg = `[${new Date().toISOString()}] SYNC FAILED: ${result.error || "unknown"}\n`;
    process.stderr.write(msg);
    process.exit(1);
  }

  // cron 模式: 只有实际有下载时才输出一行 (避免日志噪音)
  if (isCron) {
    if (result.downloaded > 0) {
      console.log(`[${new Date().toISOString()}] synced ${result.tag}: ${result.downloaded} downloaded, ${result.skipped} cached → ${result.dest}`);
    }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  const msg = `[${new Date().toISOString()}] SYNC ERROR: ${err.message}\n`;
  process.stderr.write(msg);
  process.exit(1);
});
