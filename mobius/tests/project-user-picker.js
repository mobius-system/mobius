const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const picker = read('frontend/src/components/user-picker.tsx');
const modal = read('frontend/src/components/modals.tsx');
const panel = read('frontend/src/components/project-page/ProjectSettingsPanel.tsx');
const auth = read('backend/routes/auth.ts');

assert(picker.includes("from 'react-dom'"), 'UserPicker should render suggestions through a portal');
assert(picker.includes('computeUserPickerPlacement'), 'UserPicker should use shared placement logic');
assert(modal.includes('<ProjectAllowlistField'), 'ProjectSettingsModal should render the shared allowlist field');
assert(modal.includes('allow_user_ids: allowUserIds'), 'ProjectSettingsModal should persist allow_user_ids');
assert(panel.includes('<ProjectAllowlistField'), 'ProjectSettingsPanel should render the shared allowlist field');
assert(
  !auth.includes("if (!q) {\n    res.json([]);"),
  'empty user search should return bounded initial options',
);

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
