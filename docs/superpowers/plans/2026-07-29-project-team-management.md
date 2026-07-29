# Employee Groups and Project Teams Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate long-lived employee groups from dynamic per-project teams, support multiple employee-group memberships, and let project owners manage cross-group project members and roles.

**Architecture:** Add two normalized membership tables while retaining `users.group_id` as a compatibility projection. Put membership mutations in focused repositories, make project membership a first-class input to access control, expose admin and project-scoped APIs, then add a reusable employee multi-select and a project-team settings panel.

**Tech Stack:** SQLite with `better-sqlite3`, Express, TypeScript, React 18, Tailwind CSS, existing `api()` client, Node test scripts loaded through `tsx/cjs`.

## Global Constraints

- Every enabled employee may create a normal project; the creator becomes its first `owner` in the same transaction.
- Normal-project creation accepts optional initial `member_user_ids`; selected enabled employees become `member` roles in the same transaction.
- Only system administrators manage long-lived employee groups and their memberships.
- Project `owner` and `manager` roles manage dynamic project members; system administrators retain global override.
- A project must always retain at least one active `owner`.
- Adding an employee group to a project copies the currently selected enabled employees; it does not create a live group-to-project binding.
- Existing `users.group_id`, `group_name`, and single-group request fields remain compatible during this change.
- Do not delete or reinterpret existing project ACL rows; project memberships augment current visibility and allow-list behavior.
- Do not add dependencies or generated build output.
- Frontend network requests use existing request helpers and no new `setInterval` polling.
- Commit messages are English code-change descriptions, contain no personal names, and commits use `mobius_os@163.com`.
- After Mobius code changes are committed, run `python3 start.py` to deploy the committed code.

---

## File Structure

- Modify `mobius/schema.sql`: declare membership tables for clean installations.
- Modify `mobius/db.ts`: add idempotent migration/backfill for existing databases.
- Modify `mobius/backend/types/rows.ts`: define employee-group and project-membership row types.
- Modify `mobius/backend/repositories/users.ts`: expose multi-group reads and replacement mutations while maintaining the legacy primary group projection.
- Create `mobius/backend/repositories/project-memberships.ts`: own project-role validation, reads, writes, bulk-add, and last-owner protection.
- Modify `mobius/backend/repositories/projects.ts`: create a project and its owner membership atomically.
- Modify `mobius/backend/services/access-control.ts`: recognize project members and all employee groups.
- Modify `mobius/backend/routes/admin.ts`: accept `group_ids` and replace employee memberships.
- Modify `mobius/backend/routes/projects.ts`: expose project-member endpoints and shape project role/manage flags.
- Modify `mobius/frontend/src/components/panels.tsx`: change employee administration from one group select to multi-group selection.
- Create `mobius/frontend/src/components/project-page/ProjectTeamPanel.tsx`: isolate project-team loading and mutations from the already-large settings panel.
- Modify `mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx`: render the project-team panel and use project-role permissions.
- Modify `mobius/frontend/src/components/modals.tsx`: select initial project-team members in the normal/research project creation flow.
- Modify `mobius/frontend/src/components/global-create.tsx`: provide the same initial-member selection in the global quick-create flow.
- Modify `mobius/frontend/src/store.ts`: type group arrays and project role fields returned by the APIs.
- Create `mobius/tests/user-group-memberships.js`: cover migration and repository behavior.
- Create `mobius/tests/project-memberships.js`: cover roles, access-control integration, and last-owner rules.
- Modify `mobius/package.json`: add focused test scripts.

---

### Task 1: Membership Schema and Idempotent Migration

**Files:**
- Modify: `mobius/schema.sql`
- Modify: `mobius/db.ts`
- Modify: `mobius/backend/types/rows.ts`
- Create: `mobius/tests/user-group-memberships.js`
- Modify: `mobius/package.json`

**Interfaces:**
- Produces table `user_group_memberships(user_id, group_id, is_primary, created_by, created_at)`.
- Produces table `project_memberships(project_id, user_id, role, created_by, created_at, updated_at)`.
- Backfills `users.group_id` into exactly one primary employee-group membership.
- Backfills every existing normal project creator as project role `owner`.

- [ ] **Step 1: Write the failing migration test**

Create a temporary database test that requires `../db`, then asserts the two tables exist and these rows can be read:

```js
const membership = db.prepare(
  'SELECT user_id, group_id, is_primary FROM user_group_memberships WHERE user_id = ?'
).get('legacy-user')
expectDeepEqual('legacy group is backfilled', membership, {
  user_id: 'legacy-user', group_id: 'legacy-group', is_primary: 1,
})

const owner = db.prepare(
  'SELECT project_id, user_id, role FROM project_memberships WHERE project_id = ?'
).get('legacy-project')
expectDeepEqual('legacy creator is owner', owner, {
  project_id: 'legacy-project', user_id: 'legacy-user', role: 'owner',
})
```

The test must require the database twice in separate child processes against the same temporary path and assert counts stay at one, proving idempotency.

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd mobius && node --require tsx/cjs tests/user-group-memberships.js`

Expected: FAIL because `user_group_memberships` and `project_memberships` do not exist.

- [ ] **Step 3: Add clean-install schema**

Add both tables and indexes to `mobius/schema.sql`. Use role validation:

```sql
CHECK(role IN ('owner','manager','member','viewer'))
```

Use composite primary keys and foreign keys with project deletion cascading while user deletion remains restricted because employees are soft-deleted.

- [ ] **Step 4: Add existing-database migration and backfill**

Add `migrateEmployeeAndProjectMemberships()` to `mobius/db.ts` after `migrateUserGroups()`:

```ts
const migrate = db.transaction(() => {
  db.exec(/* CREATE TABLE/INDEX statements */)
  db.exec(`
    INSERT OR IGNORE INTO user_group_memberships (user_id, group_id, is_primary)
    SELECT u.id,
           CASE WHEN g.id IS NULL THEN 'default' ELSE u.group_id END,
           1
    FROM users u
    LEFT JOIN user_groups g ON g.id = u.group_id
  `)
  db.exec(`
    INSERT OR IGNORE INTO project_memberships (project_id, user_id, role, created_by)
    SELECT p.id, p.created_by, 'owner', p.created_by
    FROM projects p
    JOIN users u ON u.id = p.created_by
  `)
})
```

Call the transaction once during startup and log a concise success/failure message.

- [ ] **Step 5: Add row types and test script**

Add `UserGroupMembershipRawRow`, `ProjectMembershipRole`, and `ProjectMembershipRawRow` in `rows.ts`. Add scripts:

```json
"test:user-group-memberships": "node --require tsx/cjs tests/user-group-memberships.js",
"test:project-memberships": "node --require tsx/cjs tests/project-memberships.js"
```

- [ ] **Step 6: Run the migration test**

Run: `cd mobius && npm run test:user-group-memberships`

Expected: all migration and idempotency assertions print `PASS`; exit code 0.

- [ ] **Step 7: Commit**

```bash
git add mobius/schema.sql mobius/db.ts mobius/backend/types/rows.ts mobius/tests/user-group-memberships.js mobius/package.json
git commit -m "Add employee and project membership schema"
```

---

### Task 2: Multi-Group Employee Repository and Admin APIs

**Files:**
- Modify: `mobius/backend/repositories/users.ts`
- Modify: `mobius/backend/routes/admin.ts`
- Modify: `mobius/tests/user-group-memberships.js`

**Interfaces:**
- Produces `Users.replaceGroups(userId, groupIds, actorId)`.
- Produces `Users.listGroupMemberships(userId)`.
- `Users.listForAdmin()` returns `group_ids`, `groups`, `primary_group_id`, plus compatible `group_id` and `group_name`.
- `PUT /api/admin/users/:id/groups` consumes `{ group_ids: string[] }`.
- Employee create/bulk-create consumes `group_ids` and legacy single-group fields.

- [ ] **Step 1: Add failing repository tests**

Extend `tests/user-group-memberships.js` with assertions for:

```js
Users.replaceGroups('employee', ['g1', 'g2'], 'admin')
expectDeepEqual('employee has two groups', Users.listGroupMemberships('employee').map(x => x.group_id), ['g1', 'g2'])

Users.replaceGroups('employee', [], 'admin')
expectDeepEqual('empty replacement falls back to default', Users.listGroupMemberships('employee').map(x => x.group_id), ['default'])

const row = Users.listForAdmin().find(x => x.id === 'employee')
expectDeepEqual('admin shape exposes groups', row.group_ids, ['default'])
expectEqual('legacy primary projection remains', row.group_id, 'default')
```

Also test invalid group IDs, duplicate IDs, soft-deleted users, and deletion refusal when a group has active memberships.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `cd mobius && npm run test:user-group-memberships`

Expected: FAIL because `replaceGroups` and `listGroupMemberships` are missing.

- [ ] **Step 3: Implement transactional multi-group mutations**

In `users.ts`, normalize and deduplicate IDs, validate all groups before writing, default an empty selection to `default`, select the first requested group as primary, replace membership rows in one transaction, and update `users.group_id` to that primary group.

Return a stable shape:

```ts
type UserGroupSummary = {
  id: string
  name: string
  description: string
  is_primary: boolean
}
```

Change group counts and deletion checks to join `user_group_memberships` rather than `users.group_id`.

- [ ] **Step 4: Make create/restore write memberships**

After `insertUser` or `restoreUser`, call the transaction-local membership replacement with normalized `group_ids`. Legacy `group_id` continues to produce a single group. Preserve old response fields and add arrays.

- [ ] **Step 5: Add admin route compatibility**

Add:

```ts
router.put('/users/:id/groups', adminAuth, (req, res) => {
  const actor = adminReqUser(req)
  const groupIds = Array.isArray(req.body?.group_ids) ? req.body.group_ids : []
  res.json(Users.replaceGroups(req.params.id, groupIds, actor.id))
})
```

Extend single/bulk employee payload normalization to accept `group_ids`, while preserving `group_id`, `group_name`, and automatic group creation for the existing bulk syntax.

- [ ] **Step 6: Run repository and backend type checks**

Run:

```bash
cd mobius
npm run test:user-group-memberships
npm run typecheck
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add mobius/backend/repositories/users.ts mobius/backend/routes/admin.ts mobius/tests/user-group-memberships.js
git commit -m "Support multiple employee group memberships"
```

---

### Task 3: Project Membership Repository and Access Control

**Files:**
- Create: `mobius/backend/repositories/project-memberships.ts`
- Modify: `mobius/backend/services/access-control.ts`
- Create: `mobius/tests/project-memberships.js`
- Modify: `mobius/tests/access-control-policy.js`

**Interfaces:**
- Produces `ProjectMemberships.list(projectId)`.
- Produces `ProjectMemberships.roleFor(projectId, userId)`.
- Produces `ProjectMemberships.addMany({ projectId, userIds, role, actorId })`.
- Produces `ProjectMemberships.updateRole({ projectId, userId, role, actorId })`.
- Produces `ProjectMemberships.remove({ projectId, userId })`.
- Produces `ProjectMemberships.canManage(projectId, user)`.
- Access control treats any active project member as readable and maps roles to write capabilities.

- [ ] **Step 1: Write failing project membership tests**

Create fixtures for owner, manager, member, viewer, outsider, and administrator. Assert:

```js
expectEqual('owner manages team', ProjectMemberships.canManage('p1', user('owner')), true)
expectEqual('manager manages team', ProjectMemberships.canManage('p1', user('manager')), true)
expectEqual('member cannot manage team', ProjectMemberships.canManage('p1', user('member')), false)
expectEqual('project member reads private project', access.canReadProject(user('member'), 'p1'), true)
expectThrows('last owner cannot be removed', () => ProjectMemberships.remove({ projectId: 'p1', userId: 'owner' }), '项目必须至少保留一名负责人')
```

Also cover duplicate add idempotency, disabled employee rejection, manager inability to change an owner, administrator override, and owner transfer before removal.

- [ ] **Step 2: Run tests and verify failure**

Run: `cd mobius && npm run test:project-memberships`

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement the repository**

Keep all role normalization and last-owner rules in `project-memberships.ts`. Use a transaction for multi-add, role update, and removal. `list()` joins users and aggregates employee-group summaries with a deterministic order.

Expose this role order for comparisons:

```ts
const PROJECT_ROLE_RANK = { viewer: 0, member: 1, manager: 2, owner: 3 } as const
```

- [ ] **Step 4: Integrate project membership into access control**

Replace single-group helpers with all-group membership queries for legacy `team` and group ACL matching. Add project membership checks before visibility fallbacks:

```ts
const membershipRole = ProjectMemberships.roleFor(project.id, user.id)
if (membershipRole) return true
```

Update management and creation helpers so `owner`/`manager` have project management rights, `member` follows project write switches for issue/session creation, and `viewer` remains read-only.

- [ ] **Step 5: Update existing access-control tests**

Backfill fixture creators as owners and add an explicit project member on a private project. Preserve all existing ACL and legacy team assertions.

- [ ] **Step 6: Run focused tests**

Run:

```bash
cd mobius
npm run test:project-memberships
npm run test:access-control
npm run test:user-isolation-v3
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add mobius/backend/repositories/project-memberships.ts mobius/backend/services/access-control.ts mobius/tests/project-memberships.js mobius/tests/access-control-policy.js
git commit -m "Add project team roles to access control"
```

---

### Task 4: Atomic Project Ownership and Project Member APIs

**Files:**
- Modify: `mobius/backend/repositories/projects.ts`
- Modify: `mobius/backend/routes/projects.ts`
- Modify: `mobius/tests/project-memberships.js`

**Interfaces:**
- `Projects.insert()` atomically creates the project and owner membership.
- `Projects.insert()` consumes optional `memberUserIds` and atomically creates initial `member` rows after validating enabled employees.
- `GET /api/projects/:id/members` returns `{ members, can_manage, actor_role }`.
- `GET /api/projects/:id/member-candidates?q=` returns safe enabled-employee identity and group summaries to project-team managers.
- `POST /api/projects/:id/members` accepts `{ user_ids, role }`.
- `POST /api/projects/:id/members/from-group` accepts `{ group_id, user_ids, role }` and validates every submitted user currently belongs to the group.
- `PATCH /api/projects/:id/members/:userId` accepts `{ role }`.
- `DELETE /api/projects/:id/members/:userId` removes a member.

- [ ] **Step 1: Add failing atomic-create, initial-member, and route-contract tests**

Extend `tests/project-memberships.js` to assert `Projects.insert()` creates an owner row, adds deduplicated `memberUserIds` as `member`, ignores the creator if repeated in `memberUserIds`, and rolls back project creation when any selected employee is missing or disabled. Add source-level route contract checks for all member endpoints and their management guard.

- [ ] **Step 2: Run the test and verify failure**

Run: `cd mobius && npm run test:project-memberships`

Expected: FAIL because project insertion is not transactional and routes are absent.

- [ ] **Step 3: Make normal project insertion atomic**

Wrap existing `Projects.insert` SQL, `ProjectMemberships.ensureOwner(id, createdBy)`, and `ProjectMemberships.addMany({ projectId: id, userIds: memberUserIds, role: 'member', actorId: createdBy })` in a `db.transaction`. Validate every initial member before inserting the project so a bad selection cannot leave a half-created project. Extension project upsert remains administrator-only and does not expose a normal project team.

- [ ] **Step 4: Add member routes with a shared guard**

Implement a helper that loads the project, verifies read or manage permission, and returns clear 403/404 responses. All write endpoints call `ProjectMemberships.canManage`. Managers cannot modify owners; owners and system administrators can.

For `from-group`, verify `user_ids` is a deduplicated subset of active memberships in the submitted employee group. This keeps group addition a reviewed snapshot rather than a live binding.

Add `GET /:id/member-candidates?q=` behind the same project-team management guard. Return only `id`, `display_name`, `groups`, and `already_member`; never return password hashes, work directories, preferences, or administrator-only account fields.

- [ ] **Step 5: Shape project responses**

Add `project_role`, `is_project_member`, and membership-aware `can_manage` to the existing project response shape. Preserve `created_by` and current owner-based behavior for old clients.

- [ ] **Step 6: Run backend verification**

Run:

```bash
cd mobius
npm run test:project-memberships
npm run test:access-control
npm run typecheck
```

Expected: all commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add mobius/backend/repositories/projects.ts mobius/backend/routes/projects.ts mobius/tests/project-memberships.js
git commit -m "Expose project team management APIs"
```

---

### Task 5: Employee Multi-Group Administration UI

**Files:**
- Modify: `mobius/frontend/src/components/panels.tsx`
- Modify: `mobius/frontend/src/store.ts`
- Modify: `mobius/frontend/src/components/modals.tsx`
- Modify: `mobius/frontend/src/components/global-create.tsx`

**Interfaces:**
- Admin employee rows consume `group_ids` and `groups` while falling back to legacy `group_id`.
- Employee create form sends `group_ids`.
- Existing bulk text accepts `研发组|AI 技术组` in the group column.
- Employee row saves all group selections through `PUT /api/admin/users/:id/groups`.

- [ ] **Step 1: Add pure selection helpers and a failing check**

Extract within `panels.tsx` or a focused nearby helper these pure functions:

```ts
function normalizedEmployeeGroupIds(row: AdminUserRow, defaultGroupId: string): string[]
function toggleEmployeeGroup(groupIds: string[], groupId: string, defaultGroupId: string): string[]
```

Add a small Node source assertion in `tests/user-group-memberships.js` that confirms the UI no longer posts to `PATCH /users/:id/group` and contains the plural `group_ids` contract. Run it first and expect failure.

- [ ] **Step 2: Change admin types and form state**

Add `groups`, `group_ids`, and `primary_group_id` to `AdminUserRow`; replace `EmployeeFormState.group_id` with `group_ids: string[]`; retain API fallbacks for older response data.

- [ ] **Step 3: Replace single selects with accessible multi-select controls**

Render groups as checkbox rows inside a compact popover/dropdown with selected-group chips. Keep “默认组” selected when the last chip would be removed. Use text labels for save/loading/error states and keep the existing card visual language.

- [ ] **Step 4: Update create and bulk flows**

Send `group_ids` from the single-create form. Parse the bulk group field by `|`, trim and deduplicate names, and send an array-compatible payload while keeping one-name inputs valid.

- [ ] **Step 5: Update employee rows and statistics**

Display all long-term groups as wrapping chips. Replace the old immediate single-select PATCH with an explicit multi-select save that calls the plural endpoint and updates the row from the server response.

- [ ] **Step 6: Run frontend build and focused test**

Run:

```bash
cd mobius
npm run test:user-group-memberships
cd frontend
npm run build
```

Expected: both commands exit 0.

- [ ] **Step 7: Commit**

```bash
git add mobius/frontend/src/components/panels.tsx mobius/frontend/src/store.ts mobius/tests/user-group-memberships.js
git commit -m "Add multi-group employee administration"
```

---

### Task 6: Project Team Settings UI

**Files:**
- Create: `mobius/frontend/src/components/project-page/ProjectTeamPanel.tsx`
- Modify: `mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx`
- Modify: `mobius/frontend/src/store.ts`
- Modify: `mobius/tests/project-memberships.js`

**Interfaces:**
- `ProjectTeamPanel` consumes `{ projectId, canManage, actorRole }`.
- Loads `GET /api/projects/:id/members`.
- Mutates through the four project member write endpoints.
- Employee/group search consumes `GET /api/projects/:id/member-candidates?q=` so non-admin project owners never receive password, work-directory, preference, or administrator-only account fields.
- `NewProjectModal` and `CreateProjectForm` consume the safe `/api/auth/user-search` identity endpoint and submit `member_user_ids` for normal/research projects.

- [ ] **Step 1: Add a failing source contract test**

Assert that `ProjectSettingsPanel.tsx` imports and renders `ProjectTeamPanel`, that the component source references the members list/add/update/delete endpoints, and that both `NewProjectModal` and `CreateProjectForm` render a “项目组成员” picker and submit `member_user_ids`. Run `npm run test:project-memberships` and expect failure.

- [ ] **Step 2: Connect the safe project-member candidates API**

Query `GET /api/projects/:id/member-candidates?q=` after a debounced search-term change. Render only the returned `id`, `display_name`, `groups`, and `already_member` fields. Abort the prior request when the query changes and ignore `AbortError` in the inline error state.

- [ ] **Step 3: Implement project member list and role controls**

Render four role counts, a searchable candidate list grouped by long-term employee group, selected-user chips, and a role selector. Existing members show name, account ID, employee-group chips, project role, and join time.

Use these labels exactly:

```ts
const PROJECT_ROLE_LABELS = {
  owner: '项目负责人',
  manager: '项目管理员',
  member: '项目成员',
  viewer: '项目访客',
}
```

- [ ] **Step 4: Add initial members to project creation**

In both `NewProjectModal` and `CreateProjectForm`, add `memberUserIds` to draft state for normal/research projects. Render a `UserPicker` section labeled “项目组成员（可选）” below the project permission summary, explain that the creator is automatically the project负责人, and send:

```ts
body.member_user_ids = memberUserIds.filter(id => id !== user?.id)
```

Do not render this control for extension projects. Preserve selected members when reopening the creation draft and clear them after successful creation.

- [ ] **Step 5: Implement group snapshot selection**

Selecting an employee group loads current enabled members, shows a confirmation checklist, and submits only checked IDs to `/members/from-group`. Do not silently add future group members.

- [ ] **Step 6: Implement permission-aware actions and error recovery**

Hide management controls for members/viewers, show the system-administrator override notice when applicable, disable only the active mutation, refresh after successful mutations, and preserve the current list with an inline error if refresh fails.

- [ ] **Step 7: Render the panel in project settings**

Place it before the existing “权限设置” card because membership is the primary collaboration model and visibility/allow-list is the secondary sharing model. Update copy under visibility settings to distinguish project members from public/allow-list readers.

- [ ] **Step 8: Run build and focused tests**

Run:

```bash
cd mobius
npm run test:project-memberships
npm run typecheck
cd frontend
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 9: Commit**

```bash
git add mobius/frontend/src/components/project-page/ProjectTeamPanel.tsx mobius/frontend/src/components/project-page/ProjectSettingsPanel.tsx mobius/frontend/src/components/modals.tsx mobius/frontend/src/components/global-create.tsx mobius/frontend/src/store.ts mobius/tests/project-memberships.js
git commit -m "Add project team management interface"
```

---

### Task 7: End-to-End Regression, Browser Validation, and Deployment

**Files:**
- No planned source files. Any regression fix must be limited to a file already listed in Tasks 1–6 and must rerun that task's focused tests before the final commit.

**Interfaces:**
- No new interface; validates the complete feature and deployment.

- [ ] **Step 1: Run the complete focused backend suite**

Run:

```bash
cd mobius
npm run test:user-group-memberships
npm run test:project-memberships
npm run test:access-control
npm run test:user-isolation-v3
npm run typecheck
```

Expected: every command exits 0 with no failed assertion.

- [ ] **Step 2: Run the frontend production build**

Run: `cd mobius/frontend && npm run build`

Expected: TypeScript and Vite complete successfully.

- [ ] **Step 3: Validate the administrator flow in a browser**

Using the documented passwordless development login, verify:

1. Create two long-term employee groups.
2. Assign one employee to both groups and refresh.
3. Create a normal project as a non-administrator account.
4. Confirm the creator appears as project负责人.
5. Add employees from different long-term groups.
6. Promote one member to project管理员.
7. Confirm a plain project member cannot manage the team.
8. Confirm removing the final project负责人 is blocked.
9. Capture a screenshot showing the completed project-team panel.

- [ ] **Step 4: Inspect repository state and commit all remaining changes**

Set the required commit identity, stage every repository change as instructed, review the staged diff for credentials/build output, then commit with an English code-change message.

```bash
git config user.email 'mobius_os@163.com'
git config user.name 'Mobius OS'
git add -A
git diff --cached --check
git commit -m "Complete employee groups and project teams"
```

If there is nothing left to commit, record that fact instead of creating an empty commit.

- [ ] **Step 5: Deploy the committed Mobius code**

Run: `python3 start.py`

Expected: backend restarts, frontend build/deployment succeeds, and the final process health output contains no fatal error.

- [ ] **Step 6: Verify the deployed page once more**

Hard-refresh the administrator employee page and project settings page. Confirm the saved memberships persist against the deployed process and no console/API errors appear.

- [ ] **Step 7: Finish the task flag**

After all verification succeeds, delete only:

```text
/home/tianyi/imac-test/.imac/flags/5cade0b6/running.flag
```

Do not create `failed.flag` when the implementation and verification succeed.
