/**
 * 广告爽游实验室扩展后端。
 *
 * 游戏模拟完全在浏览器运行；后端只保存每个用户的最佳战绩和排行榜。
 * handler 保持无状态，所有文件都写入 ext_data_dir。
 */
const path = require('path');
const fs = require('fs/promises');

const STATE_FILE = 'leaderboard.json';
const MAX_SCORE = 1_000_000_000;
const MAX_KILLS = 100_000;
const MAX_DURATION = 3_600;
const MAX_ROWS = 100;

async function readRows(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === 'object') : [];
  } catch {
    return [];
  }
}

async function writeRows(file, rows) {
  const temp = path.join(path.dirname(file), `.leaderboard-${process.pid}-${Date.now()}.tmp`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(rows, null, 2), 'utf8');
  await fs.rename(temp, file);
}

function finiteInt(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const integer = Math.trunc(number);
  return integer >= min && integer <= max ? integer : null;
}

function publicRow(row, rank) {
  return {
    rank,
    username: row.username,
    display_name: row.display_name || row.username,
    score: row.score,
    kills: row.kills,
    victory: Boolean(row.victory),
    runs: row.runs || 1,
    ts: row.ts,
  };
}

module.exports = async function toyToyToyHandler({
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
    const rows = await readRows(stateFile);
    rows.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const leaderboard = rows.slice(0, 10).map((row, index) => publicRow(row, index + 1));
    const ownIndex = rows.findIndex((row) => row.username === username);
    return {
      ok: true,
      leaderboard,
      profile: ownIndex >= 0 ? publicRow(rows[ownIndex], ownIndex + 1) : null,
    };
  }

  if (action === 'submit_run') {
    const score = finiteInt(payload.score, 0, MAX_SCORE);
    const kills = finiteInt(payload.kills, 0, MAX_KILLS);
    const duration = finiteInt(payload.duration, 0, MAX_DURATION);
    if (score === null || kills === null || duration === null) {
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
      victory: payload.victory === true,
      runs: (existing && finiteInt(existing.runs, 1, 1_000_000)) || 0,
      ts: now,
    };
    result.runs += 1;

    let isBest = true;
    if (existing) {
      isBest = score > Number(existing.score || 0);
      if (isBest) {
        Object.assign(existing, result);
      } else {
        existing.runs = result.runs;
        existing.last_score = score;
        existing.last_kills = kills;
        existing.last_victory = result.victory;
        existing.last_ts = now;
        existing.display_name = result.display_name;
      }
    } else {
      rows.push(result);
    }

    rows.sort((a, b) => b.score - a.score || a.ts - b.ts);
    const trimmed = rows.slice(0, MAX_ROWS);
    await writeRows(stateFile, trimmed);
    const ownIndex = trimmed.findIndex((row) => row.username === username);
    const leaderboard = trimmed.slice(0, 10).map((row, index) => publicRow(row, index + 1));

    if (logger && logger.info) {
      logger.info('submit_run', { username, score, kills, victory: result.victory, isBest });
    }

    return {
      ok: true,
      is_best: isBest,
      rank: ownIndex >= 0 ? ownIndex + 1 : null,
      leaderboard,
    };
  }

  return { ok: false, error: 'unknown action' };
};
