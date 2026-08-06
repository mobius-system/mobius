/**
 * Webhook endpoint: POST /api/webhook/desktop-sync
 *
 * CI 发版后立即触发本机同步 (加速器)。即使 webhook 未配或多台机器中只有一台收到,
 * 其他机器也会在 30 分钟 cron 周期内自动追上。多服务器安全: 每台独立运行, 互不依赖。
 *
 * 鉴权: X-Webhook-Token 匹配 DESKTOP_WEBHOOK_TOKEN 环境变量。
 */

const { syncDesktopBuilds } = require("../services/sync-desktop-builds");

function getWebhookToken() {
  return process.env.DESKTOP_WEBHOOK_TOKEN || null;
}

async function handleDesktopSync(req, res) {
  const startTime = Date.now();

  const expectedToken = getWebhookToken();
  if (!expectedToken) {
    return res.status(500).json({ error: "DESKTOP_WEBHOOK_TOKEN not configured on server" });
  }

  const providedToken = req.headers["x-webhook-token"] || "";
  if (!providedToken || providedToken !== expectedToken) {
    return res.status(403).json({ error: "Invalid webhook token" });
  }

  const version = req.body?.version || req.headers["x-desktop-version"] || "unknown";
  console.log(`[desktop-webhook] Sync triggered for version ${version} (from ${req.ip})`);

  try {
    const result = await syncDesktopBuilds({ log: (...args) => console.log("[desktop-webhook]", ...args) });
    result.elapsed = `${((Date.now() - startTime) / 1000).toFixed(1)}s (webhook)`;
    res.json(result);
  } catch (err) {
    console.error(`[desktop-webhook] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}

const router = require("express").Router();
router.post("/desktop-sync", handleDesktopSync);

module.exports = { router };
