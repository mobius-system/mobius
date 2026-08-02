#!/usr/bin/env node
// 热点后台任务：来源扫描 → 近时段过滤/去重 → 跨来源聚类 → 可信度与账号匹配排序 → 持久化结果。

const fs = require("fs"), path = require("path");

const specPath = process.argv[2];
if (!specPath) { console.error("hotspot-worker: missing spec path"); process.exit(2); }
let SPEC;
try { SPEC = JSON.parse(fs.readFileSync(specPath, "utf8")); }
catch (e) { console.error("hotspot-worker: bad spec: " + e.message); process.exit(2); }

const { extDataDir, searchId } = SPEC;
const jobId = SPEC.jobId || SPEC.id;
if (!extDataDir || !jobId || !searchId) { console.error("hotspot-worker: missing extDataDir/jobId/searchId"); process.exit(2); }

const job = require("./lib/job-store");
const store = require("./lib/store");
const hotspotStore = require("./lib/hotspot-store");
const hotspot = require("./lib/hotspot-core");
const cfgStore = require("./lib/config-store");
const llm = require("./lib/llm");

const logFile = path.join(extDataDir, "jobs", jobId, "worker.log");
const log = (...args) => { try { fs.appendFileSync(logFile, args.map(String).join(" ") + "\n"); } catch (_) {} };
let heartbeatTimer;
function startHeartbeat() { heartbeatTimer = setInterval(() => job.heartbeat(extDataDir, jobId), 10_000); heartbeatTimer.unref?.(); }
function stopHeartbeat() { if (heartbeatTimer) clearInterval(heartbeatTimer); }
function isCancelled() { return job.readStatusRaw(extDataDir, jobId)?.state === "cancelled"; }
function throwIfCancelled() { if (isCancelled()) { const e = new Error("用户取消"); e.cancelled = true; throw e; } }
function setState(state, phase, message, extra = {}) {
  job.updateStatus(extDataDir, jobId, { state, phase, message, searchId, ...extra });
  job.appendEvent(extDataDir, jobId, { type: "state", state, phase, message });
  log("[state]", state, phase, message);
}

async function main() {
  startHeartbeat();
  const db = store.open(extDataDir);
  try {
    hotspotStore.seedSources(db, hotspot.DEFAULT_SOURCES);
    const allSources = hotspotStore.listSources(db, { enabledOnly: true });
    const profile = cfgStore.load(extDataDir).account_profile || {};
    const windowHours = [24, 72, 168].includes(Number(SPEC.windowHours)) ? Number(SPEC.windowHours) : 72;
    const region = ["all", "domestic", "overseas"].includes(SPEC.region) ? SPEC.region : "all";
    const sources = allSources.filter((s) => region === "all" || s.region === region || s.region === "all");
    const categories = Array.isArray(SPEC.categories) ? SPEC.categories.slice(0, 12) : [];
    hotspotStore.updateSearch(db, searchId, { status: "collecting", coverage: { attempted: sources.length, succeeded: 0, failed: 0, recent_items: 0 } });
    setState("collecting", "collect", `正在扫描 ${sources.length} 个来源`, { progress: .08, coverage: { attempted: sources.length, completed: 0 } });
    let completed = 0, succeeded = 0, failed = 0, fetched = 0;
    const collected = await hotspot.collectSources({
      sources, query: SPEC.query || "", windowHours, region,
      onSourceResult: async (result) => {
        completed++; if (result.ok) succeeded++; else failed++; fetched += result.items.length;
        hotspotStore.recordSourceResult(db, result.source.id, result.ok);
        job.updateStatus(extDataDir, jobId, { progress: .08 + .42 * completed / Math.max(sources.length, 1),
          message: `已扫描 ${completed}/${sources.length} 个来源，取得 ${fetched} 条内容`,
          coverage: { attempted: sources.length, completed, succeeded, failed, fetched_items: fetched } });
      },
    });
    throwIfCancelled();
    hotspotStore.upsertItems(db, collected.items);
    hotspotStore.updateSearch(db, searchId, { status: "filtering", coverage: collected.coverage });
    setState("filtering", "filter", `近 ${windowHours} 小时取得 ${collected.items.length} 条候选（直接相关 ${collected.coverage.direct_matches || 0} 条），正在去重`, { progress: .56, coverage: collected.coverage });
    job.writeCheckpoint(extDataDir, jobId, { phase: "filter", searchId, coverage: collected.coverage, itemCount: collected.items.length });
    throwIfCancelled();

    let provider = null;
    try { provider = llm.findProvider(SPEC.modelKey || null); } catch (e) { log("[warn] no provider, deterministic fallback:", e.message); }
    setState("clustering", "cluster", "正在跨来源归并同一事件", { progress: .64, coverage: collected.coverage });
    const clusters = await hotspot.clusterAndScore(collected.items, {
      provider, query: SPEC.query || "", profile, searchId, windowHours, categories,
    });
    throwIfCancelled();
    setState("verifying", "verify", `已归并 ${clusters.length} 个事件，正在核验来源与时间`, { progress: .86, coverage: collected.coverage, partialCount: clusters.length });
    hotspotStore.replaceClusters(db, searchId, clusters);
    const coverage = { ...collected.coverage, clusters: clusters.length,
      official_clusters: clusters.filter((x) => x.official_count > 0).length,
      multi_source_clusters: clusters.filter((x) => x.source_count >= 2).length };
    hotspotStore.updateSearch(db, searchId, { status: "done", coverage, result_count: clusters.length, completed_at: new Date().toISOString() });
    job.writeCheckpoint(extDataDir, jobId, { phase: "done", searchId, coverage, resultCount: clusters.length });
    setState("done", "done", clusters.length ? `检索完成，得到 ${clusters.length} 个独立热点` : "检索完成，当前条件下没有发现热点",
      { progress: 1, coverage, resultCount: clusters.length, endedAt: new Date().toISOString() });
  } catch (e) {
    if (e.cancelled) {
      hotspotStore.updateSearch(db, searchId, { status: "cancelled", error: "用户取消", completed_at: new Date().toISOString() });
      setState("cancelled", "cancelled", "用户已取消检索", { endedAt: new Date().toISOString() });
    } else {
      hotspotStore.updateSearch(db, searchId, { status: "failed", error: e.message, completed_at: new Date().toISOString() });
      setState("failed", "error", "热点检索失败", { error: String(e.message || e).slice(0, 300), endedAt: new Date().toISOString() });
      log("[error]", e.stack || e);
      process.exitCode = 1;
    }
  } finally {
    try { db.close(); } catch (_) {}
    stopHeartbeat();
  }
}

main().then(() => process.exit(process.exitCode || 0)).catch((e) => { log("[fatal]", e.stack || e); stopHeartbeat(); process.exit(1); });
