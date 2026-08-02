// lib/job-store.js — detached worker 的文件系统状态层。
// handler ↔ worker 仅通过 ext_data_dir/jobs/<id>/ 下文件通信（无 IPC / 无 stdout 解析 / 无 socket）。
// 文件：spec.json(输入) / status.json(状态+心跳) / pid.json / checkpoint.json / events.jsonl / worker.log
// 状态机见方案 §4.2：queued→researching→outlining→writing→reviewing→waiting_user→rendering→uploading→done
//   以及 paused/cancelled/failed/unknown_external_result。心跳超 90s 且 PID 不在 → 自愈标 failed。

const fs = require("fs"), path = require("path"), crypto = require("crypto");
const now = () => new Date().toISOString();
const STALE_MS = 90_000;

const ACTIVE_STATES = new Set(["queued", "running", "researching", "outlining", "writing", "reviewing", "rendering", "uploading",
  "illustrating", "exporting", "collecting", "filtering", "clustering", "verifying", "ranking"]);

function jobsDir(extDataDir) { return path.join(extDataDir, "jobs"); }
function jobDir(extDataDir, jobId) { return path.join(jobsDir(extDataDir), jobId); }

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return dflt; }
}
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp." + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
function newId(prefix) { return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`; }

function createJob(extDataDir, { kind = "article", spec }) {
  const jobId = newId(kind);
  const dir = jobDir(extDataDir, jobId);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, "spec.json"), { id: jobId, kind, extDataDir, createdAt: now(), ...spec });
  writeJsonAtomic(path.join(dir, "status.json"), {
    jobId, kind, state: "queued", phase: "init", progress: 0,
    message: "已入队", startedAt: now(), updatedAt: now(),
  });
  return jobId;
}
function getSpec(extDataDir, jobId) { return readJson(path.join(jobDir(extDataDir, jobId), "spec.json"), null); }

function pidAlive(pid) {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}
function readPid(extDataDir, jobId) { return readJson(path.join(jobDir(extDataDir, jobId), "pid.json"), null); }
function writePid(extDataDir, jobId, pid) { writeJsonAtomic(path.join(jobDir(extDataDir, jobId), "pid.json"), { pid, startedAt: now() }); }

function readStatusRaw(extDataDir, jobId) { return readJson(path.join(jobDir(extDataDir, jobId), "status.json"), null); }

// 自愈：活跃态但 PID 死 / 心跳超时 → failed
function readStatus(extDataDir, jobId) {
  const dir = jobDir(extDataDir, jobId);
  const st = readJson(path.join(dir, "status.json"), null);
  if (!st) return null;
  if (ACTIVE_STATES.has(st.state)) {
    const pid = readJson(path.join(dir, "pid.json"), null);
    const upd = st.updatedAt ? Date.parse(st.updatedAt) : 0;
    const stale = upd && (Date.now() - upd) > STALE_MS;
    if (!pidAlive(pid?.pid) || stale) {
      st.state = "failed";
      st.error = stale ? "worker 心跳超时（可能被杀）" : "worker 进程异常退出";
      st.fixedAt = now();
      writeJsonAtomic(path.join(dir, "status.json"), st);
    }
  }
  return st;
}
function updateStatus(extDataDir, jobId, patch) {
  const file = path.join(jobDir(extDataDir, jobId), "status.json");
  const st = { ...readJson(file, {}), ...patch, updatedAt: now() };
  writeJsonAtomic(file, st);
  return st;
}
function heartbeat(extDataDir, jobId) {
  const file = path.join(jobDir(extDataDir, jobId), "status.json");
  const st = readJson(file, {});
  if (st && ACTIVE_STATES.has(st.state)) {
    st.updatedAt = now();
    writeJsonAtomic(file, st);
  }
}
function appendEvent(extDataDir, jobId, evt) {
  const file = path.join(jobDir(extDataDir, jobId), "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ t: Date.now(), ...evt }) + "\n");
}
function readEvents(extDataDir, jobId) {
  try {
    return fs.readFileSync(path.join(jobDir(extDataDir, jobId), "events.jsonl"), "utf8")
      .trim().split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function writeCheckpoint(extDataDir, jobId, ck) { writeJsonAtomic(path.join(jobDir(extDataDir, jobId), "checkpoint.json"), { ...ck, savedAt: now() }); }
function readCheckpoint(extDataDir, jobId) { return readJson(path.join(jobDir(extDataDir, jobId), "checkpoint.json"), null); }

// 取消：杀进程组（detached worker 是 session leader，-pid = PGID，连带 ffmpeg 等子进程）
function cancelJob(extDataDir, jobId) {
  const dir = jobDir(extDataDir, jobId);
  const pid = readJson(path.join(dir, "pid.json"), null);
  if (pid && pidAlive(pid.pid)) {
    try { process.kill(-pid.pid); }
    catch { try { process.kill(pid.pid); } catch (_) {} }
  }
  updateStatus(extDataDir, jobId, { state: "cancelled", message: "已取消", endedAt: now() });
  return { ok: true, state: "cancelled" };
}

function listJobs(extDataDir, limit = 50) {
  const dir = jobsDir(extDataDir);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); }
  catch { return []; }
  const jobs = entries.map((d) => {
    const st = readStatus(extDataDir, d.name);
    if (!st) return null;
    const spec = readJson(path.join(dir, d.name, "spec.json"), {});
    return { jobId: d.name, state: st.state, phase: st.phase, progress: st.progress,
      title: spec.title || spec.topic?.title || st.title || "", kind: st.kind || spec.kind,
      updatedAt: st.updatedAt, startedAt: st.startedAt, error: st.error };
  }).filter(Boolean);
  jobs.sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
  return jobs.slice(0, limit);
}

module.exports = {
  jobsDir, jobDir, newId, createJob, getSpec,
  readStatus, readStatusRaw, updateStatus, heartbeat,
  readPid, writePid, pidAlive,
  appendEvent, readEvents, writeCheckpoint, readCheckpoint,
  cancelJob, listJobs, STALE_MS, ACTIVE_STATES,
};
