const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const core = require('../extension/expense/backend/expense_core');
const ocr = require('../extension/expense/backend/ocr');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expense-extension-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function testTokenExpenseCategoryPreset() {
  assert(
    ocr.CATEGORY_PRESETS.includes('Token 费用'),
    'expense categories should include Token 费用',
  );
}

function testStatsUseUsernameForUserLabels() {
  withTempDir((dir) => {
    const db = core.openDb(dir);
    try {
      core.insertExpense(db, {
        username: 'wushiguang',
        display_name: '吴士广',
        expense_date: '2026-07-22',
        merchant: 'AI 网关',
        detail: '模型调用',
        amount: 12.34,
        category: 'Token 费用',
      });
      const stats = core.buildStats(db, {});
      assert.strictEqual(stats.by_user.length, 1);
      assert.strictEqual(stats.by_user[0].username, 'wushiguang');
      assert.strictEqual(
        stats.by_user[0].display_name,
        'wushiguang',
        'stats user label should expose the English username instead of display_name',
      );
    } finally {
      db.close();
    }
  });
}

function testFrontendRendersUsernameNotRealName() {
  const main = fs.readFileSync(path.join(__dirname, '../extension/expense/frontend/main.js'), 'utf8');
  assert(main.includes("$('#me').textContent = s.username || '-'"), 'current user should render username');
  assert(main.includes('${esc(u.username)}'), 'user tables should render username');
  assert(!main.includes('r.display_name || r.username'), 'expense list should not prefer display_name');
  assert(!main.includes('u.display_name || u.username'), 'stats table should not prefer display_name');
  assert(!main.includes('${esc(u.display_name)}'), 'user filters should not render display_name');
}

testTokenExpenseCategoryPreset();
testStatsUseUsernameForUserLabels();
testFrontendRendersUsernameNotRealName();

console.log('expense-extension tests passed');
