// UserPicker 的两件事: 顶层浮层定位, 以及"谁能看到谁"的角色分档.
// 账号名录策略本体在 tests/user-directory-policy.js 里用真实库测; 这里只锁接线.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const picker = read('frontend/src/components/user-picker.tsx');
const teamPanel = read('frontend/src/components/project-page/ProjectTeamPanel.tsx');
const auth = read('backend/routes/auth.ts');
const directory = read('backend/services/user-directory.ts');

assert(picker.includes("from 'react-dom'"), 'UserPicker should render suggestions through a portal');
assert(picker.includes('computeUserPickerPlacement'), 'UserPicker should use shared placement logic');
assert(picker.includes("useStore((s) => s.user)"), 'UserPicker should read the current user to pick the search wording');
assert(picker.includes('EXACT_PLACEHOLDER'), 'UserPicker should tell non-admins to type a full account');
assert(
  !picker.includes("placeholder={placeholder}"),
  'UserPicker must not fall back to the admin placeholder for ordinary users',
);
assert(
  teamPanel.includes('member-candidates'),
  'ProjectTeamPanel should search through the project-scoped candidate endpoint',
);

// 后端接线: 两个名册查询端点都必须走 services/user-directory (按角色分档),
// 不允许再出现"直接 SELECT ... FROM users"的旁路.
assert(auth.includes('searchDirectory(user, req.query.q)'), 'auth user-search should go through the directory service');
assert(auth.includes('resolveDirectoryIds(user,'), 'auth users-by-id should go through the directory service');
assert(!/FROM users/.test(auth), 'auth.ts must not query the users table directly any more');
assert(/COLLATE NOCASE/.test(directory), 'directory service should still do case-insensitive exact matching');
assert(directory.includes("if (!q) return []"), 'directory service must not list accounts for an empty query');

const { computeUserPickerPlacement } = require('../frontend/src/components/user-picker-position');

assert.strictEqual(
  computeUserPickerPlacement(
    { top: 100, bottom: 136, left: 20, width: 300 },
    { width: 1000, height: 800 },
    224,
    4,
  ).direction,
  'down',
);
assert.strictEqual(
  computeUserPickerPlacement(
    { top: 700, bottom: 736, left: 20, width: 300 },
    { width: 1000, height: 760 },
    224,
    4,
  ).direction,
  'up',
);

console.log('project user picker tests passed');
