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
const MAX_ROWS_PER_THEME = 100;
const VALID_THEMES = new Set(['zombie', 'deadline']);

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

function normalizeTheme(value) {
  if (value === undefined || value === null || value === '') return 'zombie';
  return typeof value === 'string' && VALID_THEMES.has(value) ? value : null;
}

function publicRow(row, rank) {
  return {
    rank,
    theme: normalizeTheme(row.theme) || 'zombie',
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
  const theme = normalizeTheme(payload.theme);
  const stateFile = path.join(ext_data_dir, STATE_FILE);

  if (action === 'whoami') {
    return { ok: true, username, display_name, extension_name };
  }

  if (action === 'get_leaderboard' || action === 'get_profile') {
    if (!theme) return { ok: false, error: 'invalid theme' };
    const rows = await readRows(stateFile);
    const themeRows = rows
      .filter((row) => normalizeTheme(row.theme) === theme)
      .sort((a, b) => b.score - a.score || a.ts - b.ts);
    const leaderboard = themeRows.slice(0, 10).map((row, index) => publicRow(row, index + 1));
    const ownIndex = themeRows.findIndex((row) => row.username === username);
    return {
      ok: true,
      theme,
      leaderboard,
      profile: ownIndex >= 0 ? publicRow(themeRows[ownIndex], ownIndex + 1) : null,
    };
  }

  if (action === 'submit_run') {
    if (!theme) return { ok: false, error: 'invalid theme' };
    const score = finiteInt(payload.score, 0, MAX_SCORE);
    const kills = finiteInt(payload.kills, 0, MAX_KILLS);
    const duration = finiteInt(payload.duration, 0, MAX_DURATION);
    if (score === null || kills === null || duration === null) {
      return { ok: false, error: 'invalid run result' };
    }

    const rows = await readRows(stateFile);
    const existing = rows.find((row) => row.username === username && normalizeTheme(row.theme) === theme);
    const now = Date.now();
    const result = {
      username,
      theme,
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

    const trimmed = [...VALID_THEMES].flatMap((themeName) => rows
      .filter((row) => normalizeTheme(row.theme) === themeName)
      .sort((a, b) => b.score - a.score || a.ts - b.ts)
      .slice(0, MAX_ROWS_PER_THEME));
    await writeRows(stateFile, trimmed);
    const themeRows = trimmed
      .filter((row) => normalizeTheme(row.theme) === theme)
      .sort((a, b) => b.score - a.score || a.ts - b.ts);
    const ownIndex = themeRows.findIndex((row) => row.username === username);
    const leaderboard = themeRows.slice(0, 10).map((row, index) => publicRow(row, index + 1));

    if (logger && logger.info) {
      logger.info('submit_run', { username, theme, score, kills, victory: result.victory, isBest });
    }

    return {
      ok: true,
      theme,
      is_best: isBest,
      rank: ownIndex >= 0 ? ownIndex + 1 : null,
      leaderboard,
    };
  }

  return { ok: false, error: 'unknown action' };
};
