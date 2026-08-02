/**
 * 弹幕割草实验室扩展后端。
 * 游戏模拟全部在浏览器中完成；后端仅保存最佳战绩和排行榜。
 */
const path = require('path');
const fs = require('fs/promises');

const STATE_FILE = 'leaderboard.json';
const MAX_SCORE = 2_000_000_000;
const MAX_KILLS = 200_000;
const MAX_DURATION = 3_600;
const MAX_LEVEL = 200;

function finiteInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer >= min && integer <= max ? integer : null;
}

async function readRows(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object') : [];
  } catch {
    return [];
  }
}

async function writeRows(file, rows) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.leaderboard-${process.pid}-${Date.now()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function publicRow(row, rank) {
  return {
    rank,
    username: row.username,
    display_name: row.display_name || row.username,
    score: finiteInt(row.score, 0, MAX_SCORE) || 0,
    kills: finiteInt(row.kills, 0, MAX_KILLS) || 0,
    level: finiteInt(row.level, 1, MAX_LEVEL) || 1,
    duration: finiteInt(row.duration, 0, MAX_DURATION) || 0,
    victory: row.victory === true,
    runs: finiteInt(row.runs, 1, 1_000_000) || 1,
    ts: finiteInt(row.ts, 0, Number.MAX_SAFE_INTEGER) || 0,
  };
}

module.exports = async function bulletHeavenHandler({
  username,
  display_name,
  ext_main_payload,
  ext_data_dir,
  extension_name,
  logger,
}) {
  const payload = ext_main_payload && typeof ext_main_payload === 'object' ? ext_main_payload : {};
  const action = payload.action;
  const stateFile = path.join(ext_data_dir, STATE_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'get_leaderboard' || action === 'get_profile') {
    const rows = (await readRows(stateFile)).sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.ts || 0) - Number(b.ts || 0));
    const ownIndex = rows.findIndex((row) => row.username === username);
    return {
      ok: true,
      leaderboard: rows.slice(0, 10).map((row, index) => publicRow(row, index + 1)),
      profile: ownIndex >= 0 ? publicRow(rows[ownIndex], ownIndex + 1) : null,
    };
  }

  if (action === 'submit_run') {
    const score = finiteInt(payload.score, 0, MAX_SCORE);
    const kills = finiteInt(payload.kills, 0, MAX_KILLS);
    const duration = finiteInt(payload.duration, 0, MAX_DURATION);
    const level = finiteInt(payload.level, 1, MAX_LEVEL);
    if (score === null || kills === null || duration === null || level === null) {
      return { ok: false, error: 'invalid run result' };
    }

    const rows = await readRows(stateFile);
    const existing = rows.find((row) => row.username === username);
    const now = Date.now();
    const result = {
      username,
      display_name: String(display_name || username).slice(0, 80),
      score,
      kills,
      duration,
      level,
      victory: payload.victory === true,
      runs: ((existing && finiteInt(existing.runs, 1, 999_999)) || 0) + 1,
      ts: now,
    };

    let isBest = true;
    if (existing) {
      isBest = score > Number(existing.score || 0);
      if (isBest) {
        Object.assign(existing, result);
      } else {
        existing.display_name = result.display_name;
        existing.runs = result.runs;
        existing.last_score = score;
        existing.last_kills = kills;
        existing.last_level = level;
        existing.last_duration = duration;
        existing.last_victory = result.victory;
        existing.last_ts = now;
      }
    } else {
      rows.push(result);
    }

    rows.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || Number(a.ts || 0) - Number(b.ts || 0));
    const trimmed = rows.slice(0, 100);
    await writeRows(stateFile, trimmed);
    const ownIndex = trimmed.findIndex((row) => row.username === username);

    if (logger && logger.info) {
      logger.info('submit_run', { username, score, kills, level, isBest });
    }

    return {
      ok: true,
      is_best: isBest,
      rank: ownIndex >= 0 ? ownIndex + 1 : null,
      leaderboard: trimmed.slice(0, 10).map((row, index) => publicRow(row, index + 1)),
    };
  }

  return { ok: false, error: 'unknown action' };
};
