# Project Allowlist User Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both project-settings entry points support a fully visible, browseable, searchable, and persistent project allowlist user picker.

**Architecture:** Keep `UserPicker` as the shared interaction component, move its suggestions into a document-level portal, and extract a focused `ProjectAllowlistField` used by both project settings implementations. Extend the existing authenticated user-search endpoint so an empty query returns a bounded initial list, while the existing project PATCH flow persists `allow_user_ids`.

**Tech Stack:** React 18, TypeScript, React portals, Express, SQLite, Node assertion tests, Playwright, Vite.

## Global Constraints

- Both project-settings entry points must support adding and removing allowlisted employees.
- Empty focus returns no more than 12 active employees and only `id`, `display_name`, and `role`.
- Suggestions must not be clipped by cards, modals, drawers, or scrolling containers.
- Visibility changes must not clear the stored allowlist.
- Preserve existing Mobius visual tokens, keyboard behavior, and 180 ms typed-search debounce.
- Do not refactor unrelated project settings.
- Do not commit generated frontend build output, temporary screenshots, logs, or test artifacts.
- Final code commit must use email `mobius_os@163.com` and an English message with no personal name.
- After the final code commit, run `python3 start.py` to deploy the update.

---

### Task 1: Add regression coverage for the confirmed failures

**Files:**
- Create: `mobius/tests/project-user-picker.js`
- Modify: `mobius/package.json`
- Test: `mobius/tests/project-user-picker.js`

**Interfaces:**
- Consumes: current source files and the future `computeUserPickerPlacement(anchor, viewport, menuHeight, gap)` helper.
- Produces: `npm run test:project-user-picker`, a focused regression command covering browse-on-focus, portal rendering, shared allowlist UI, modal persistence, and placement direction.

- [ ] **Step 1: Write the failing regression test**

Create a Node assertion test that reads the affected source files and imports the planned geometry helper:

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const picker = read('frontend/src/components/user-picker.tsx');
const modal = read('frontend/src/components/modals.tsx');
const panel = read('frontend/src/components/project-page/ProjectSettingsPanel.tsx');
const auth = read('backend/routes/auth.ts');

assert(picker.includes("from 'react-dom'"), 'UserPicker should render suggestions through a portal');
assert(picker.includes('computeUserPickerPlacement'), 'UserPicker should use shared placement logic');
assert(modal.includes('<ProjectAllowlistField'), 'ProjectSettingsModal should render the shared allowlist field');
assert(modal.includes('allow_user_ids: allowUserIds'), 'ProjectSettingsModal should persist allow_user_ids');
assert(panel.includes('<ProjectAllowlistField'), 'ProjectSettingsPanel should render the shared allowlist field');
assert(!auth.includes("if (!q) {\n    res.json([]);"), 'empty user search should return bounded initial options');

const { computeUserPickerPlacement } = require('../frontend/src/components/user-picker-position');
assert.strictEqual(
  computeUserPickerPlacement({ top: 100, bottom: 136, left: 20, width: 300 }, { width: 1000, height: 800 }, 224, 4).direction,
  'down',
);
assert.strictEqual(
  computeUserPickerPlacement({ top: 700, bottom: 736, left: 20, width: 300 }, { width: 1000, height: 760 }, 224, 4).direction,
  'up',
);

console.log('project user picker tests passed');
```

Add the package script:

```json
"test:project-user-picker": "node --require tsx/cjs tests/project-user-picker.js"
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
cd mobius && npm run test:project-user-picker
```

Expected: FAIL because portal rendering, shared allowlist field, empty browse behavior, modal persistence, and the placement helper do not exist yet.

---

### Task 2: Implement deterministic suggestion placement and portal rendering

**Files:**
- Create: `mobius/frontend/src/components/user-picker-position.ts`
- Modify: `mobius/frontend/src/components/user-picker.tsx`
- Test: `mobius/tests/project-user-picker.js`

**Interfaces:**
- Produces: `computeUserPickerPlacement(anchor, viewport, menuHeight, gap): UserPickerPlacement`.
- `UserPicker` consumes the placement helper and renders its suggestion list through `createPortal(..., document.body)`.

- [ ] **Step 1: Implement the minimal pure placement helper**

Define exported rectangle, viewport, direction, and placement types. Clamp the left coordinate inside the viewport, prefer downward placement, and switch upward when the requested menu height cannot fit below and there is more room above.

```ts
export function computeUserPickerPlacement(anchor, viewport, menuHeight = 224, gap = 4) {
  const spaceBelow = viewport.height - anchor.bottom - gap
  const spaceAbove = anchor.top - gap
  const direction = spaceBelow < Math.min(menuHeight, 120) && spaceAbove > spaceBelow ? 'up' : 'down'
  const available = Math.max(80, direction === 'down' ? spaceBelow : spaceAbove)
  const maxHeight = Math.min(menuHeight, available)
  const width = Math.min(anchor.width, Math.max(0, viewport.width - 16))
  const left = Math.min(Math.max(8, anchor.left), Math.max(8, viewport.width - width - 8))
  const top = direction === 'down' ? anchor.bottom + gap : Math.max(8, anchor.top - gap - maxHeight)
  return { direction, left, top, width, maxHeight }
}
```

- [ ] **Step 2: Update `UserPicker` to request initial options**

When `open` is true, request `searchPath?q=` even if `query.trim()` is empty. Keep the 180 ms delay only for non-empty typed queries; initial browse should load immediately. Reset highlighting and ignore stale responses using the existing `alive` guard.

- [ ] **Step 3: Move suggestions into a portal**

Add separate refs for the anchor and portal surface. Calculate fixed-position styles from `getBoundingClientRect()`. Recalculate while open on `resize` and capture-phase `scroll`, and treat clicks inside either ref as internal clicks.

Render:

```tsx
{open && createPortal(
  <div ref={menuRef} role="listbox" style={{ position: 'fixed', left, top, width, maxHeight, zIndex: 10050 }}>
    {suggestionContent}
  </div>,
  document.body,
)}
```

Keep the existing loading, error, no-match, role, selected, mouse, and keyboard behaviors.

- [ ] **Step 4: Run the focused test**

Run:

```bash
cd mobius && npm run test:project-user-picker
```

Expected: placement assertions and picker portal assertions pass; modal/shared-field assertions still fail.

---

### Task 3: Add bounded empty-query employee browsing

**Files:**
- Modify: `mobius/backend/routes/auth.ts`
- Test: `mobius/tests/project-user-picker.js`

**Interfaces:**
- Consumes: `GET /api/auth/user-search?q=<query>`.
- Produces: an authenticated JSON array containing at most 12 active `{ id, display_name, role }` rows for both empty and non-empty queries.

- [ ] **Step 1: Replace the empty-query early return**

Use two query branches:

```ts
if (!q) {
  const rows = db.prepare(`
    SELECT id, display_name, role
    FROM users
    WHERE (deleted_at IS NULL OR deleted_at = '')
    ORDER BY display_name COLLATE NOCASE ASC, id COLLATE NOCASE ASC
    LIMIT 12
  `).all();
  res.json(rows);
  return;
}
```

Retain the existing filtered query and 12-row limit for non-empty `q`.

- [ ] **Step 2: Run backend syntax/type verification and the focused test**

Run:

```bash
cd mobius && npm run typecheck
cd mobius && npm run test:project-user-picker
```

Expected: backend typecheck passes; empty-query source assertion passes; only shared-field/modal assertions remain failing.

---

### Task 4: Share project allowlist UI and persist it from the legacy modal

**Files:**
- Create: `mobius/frontend/src/components/project-allowlist-field.tsx`
- Modify: `mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx`
- Modify: `mobius/frontend/src/components/modals.tsx`
- Test: `mobius/tests/project-user-picker.js`

**Interfaces:**
- Produces: `ProjectAllowlistField({ visibility, selectedIds, onChange, disabled })`.
- Consumes: `UserPicker`, project visibility, allowlist IDs, and entry-point state setters.

- [ ] **Step 1: Create the shared allowlist field**

Render the shared label, inactive-state suffix, `UserPicker`, and explanatory copy:

```tsx
export function ProjectAllowlistField({ visibility, selectedIds, onChange, disabled }: Props) {
  const active = visibility === 'allowlist'
  return (
    <div>
      <label>添加用户{!active && <span>（仅在「指定用户」可见性下生效）</span>}</label>
      <UserPicker
        selectedIds={selectedIds}
        onChange={onChange}
        disabled={disabled}
        placeholder={active ? '输入用户名或 ID 添加...' : '允许名单已保留，切到「指定用户」后生效'}
        emptyHint={active ? '点击选择用户，或输入用户名搜索' : '允许名单当前不生效'}
      />
      {selectedIds.length > 0 && <p>项目创建者、管理员和名单中的用户可见。</p>}
    </div>
  )
}
```

Use existing CSS variables, type sizes, and spacing from the current project settings field.

- [ ] **Step 2: Replace the project detail inline field**

Import `ProjectAllowlistField` and replace the existing inline `UserPicker` block. Pass `editVisibility`, `editAllowUserIds`, `setEditAllowUserIds`, and `!canManageProject`.

- [ ] **Step 3: Add modal allowlist state and rendering**

Initialize:

```ts
const [allowUserIds, setAllowUserIds] = useState<string[]>(
  Array.isArray(project.access?.allow_user_ids) ? [...project.access.allow_user_ids] : [],
)
```

Render `ProjectAllowlistField` immediately after the visibility controls and pass `disabled={false}` because the modal is already restricted to manageable projects.

- [ ] **Step 4: Persist modal allowlist changes**

Include this exact field in the PATCH body:

```ts
allow_user_ids: allowUserIds,
```

Do not clear the array when `visibility` changes.

- [ ] **Step 5: Run focused tests and frontend build**

Run:

```bash
cd mobius && npm run test:project-user-picker
cd mobius/frontend && npm run build
```

Expected: focused tests pass and the frontend production build succeeds.

---

### Task 5: Verify both entry points in the running application

**Files:**
- Create temporarily: `/tmp/playwright-test-project-user-picker.js`
- Do not commit screenshots or temporary scripts.

**Interfaces:**
- Consumes: the running Vite frontend, authenticated project APIs, both project-settings entry points.
- Produces: browser evidence for empty browse, filtering, no clipping, selection, modal presence, save, refresh, and persistence.

- [ ] **Step 1: Run the application-level browser checks**

Use Playwright to log in through the passwordless local development configuration, locate `imac-self-develop`, and verify:

- Project detail settings: empty focus produces candidate buttons without typing.
- The suggestion overlay bounding box is within the viewport and extends outside the clipping card when needed.
- Typed search for a known active account returns a role-labelled option.
- User-home project settings modal contains “添加用户”.
- Selecting a user updates the modal chip list.
- Saving and reopening preserves the selected ID.
- Restore the original allowlist after verification so test data is not left changed.

- [ ] **Step 2: Capture targeted screenshots and inspect them**

Save screenshots under `/tmp`, inspect them for light/dark theme readability and mobile/narrow layout, and delete or leave them only in `/tmp`.

- [ ] **Step 3: Run final verification**

Run:

```bash
cd mobius && npm run test:project-user-picker
cd mobius && npm run typecheck
cd mobius/frontend && npm run build
git diff --check
```

Expected: all commands succeed with zero test failures and no whitespace errors.

---

### Task 6: Commit and deploy

**Files:**
- Stage every current repository change as required by the project workflow, after confirming no generated artifacts or secrets are present.

**Interfaces:**
- Produces: one final implementation commit and an updated running Mobius deployment.

- [ ] **Step 1: Review the complete diff and repository status**

Run:

```bash
git status --short
git diff --check
git diff --stat
```

Confirm that no `node_modules`, build output, logs, screenshots, temporary files, credentials, or unrelated destructive changes are included.

- [ ] **Step 2: Commit with the required identity**

Run:

```bash
git config user.name "Mobius Automation"
git config user.email "mobius_os@163.com"
git add -A
git commit -m "Unify project allowlist user selection"
```

- [ ] **Step 3: Deploy the committed code**

Run from the repository root:

```bash
python3 start.py
```

Expected: frontend build/deployment and Mobius process restart complete successfully.

- [ ] **Step 4: Perform a post-deploy smoke check**

Verify process health and repeat the two critical browser checks against the deployed frontend: empty-focus suggestions and allowlist field presence in the user-home modal.

- [ ] **Step 5: Complete the session marker**

After successful post-deploy verification, delete `.imac/flags/0482d740/running.flag`. Create `failed.flag` only if the task has definitively failed and cannot continue.
