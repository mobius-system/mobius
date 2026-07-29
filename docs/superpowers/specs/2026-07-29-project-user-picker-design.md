# Project allowlist user picker design

Date: 2026-07-29

## Summary

Unify project allowlist management across both project-settings entry points and make user suggestions reliably visible. The project detail settings panel and the user-home project settings modal will both support browsing, searching, adding, and removing active employees. The shared user picker will render suggestions in a document-level overlay so card and modal overflow rules cannot clip the list.

## Current problems

Mobius currently has two project-settings implementations with different capabilities:

- The project detail settings panel renders `UserPicker` and persists `allow_user_ids`, but the absolutely positioned suggestion list is clipped by ancestor containers using `overflow-hidden`.
- The user-home `ProjectSettingsModal` can set visibility to `allowlist`, but it has no allowlist state, no user picker, and does not submit `allow_user_ids`.
- `UserPicker` only searches after the operator types a non-empty query. Focusing an empty field does not show available employees, so operators must already know part of an account ID or display name.

The result is an inconsistent and slow workflow. One entry point appears broken because suggestions are hidden; the other cannot manage the allowlist at all.

## Goals

- Give both project-settings entry points the same allowlist-management capability.
- Show a bounded initial employee list when the picker receives focus with an empty query.
- Preserve search by employee ID and display name.
- Ensure suggestions are never clipped by project cards, settings cards, modal scroll containers, or drawers.
- Preserve existing keyboard controls and selected-user chips.
- Persist allowlist changes without clearing them when project visibility temporarily changes.
- Keep the response limited to the minimum employee fields and a maximum of 12 rows.

## Non-goals

- Creating, deleting, or bulk-importing employee accounts from project settings.
- Adding pagination or a full employee-directory browser.
- Changing project visibility semantics or administrator/owner bypass rules.
- Refactoring unrelated project settings.
- Changing Skill or Memory permission models, although their existing `UserPicker` usage benefits from the overlay fix.

## Chosen approach

Use the existing shared `UserPicker` as the single interaction implementation, enhance it with bounded browse-on-focus and a document-level suggestion overlay, and add the missing allowlist state and field to `ProjectSettingsModal`.

This is preferred over removing overflow rules or duplicating picker markup. Removing overflow rules is fragile in scrollable modals and drawers, while duplication would allow the two project-settings entry points to drift again.

## User experience

### Opening the picker

When an enabled picker is focused or clicked with an empty query:

- It requests up to 12 active employees.
- It opens a suggestion list aligned to the picker width.
- Selected employees remain visible but disabled and marked as already added.

When the operator types:

- The existing 180 ms debounce remains.
- Results match employee ID or display name.
- Exact matches remain ordered before other matches.
- The list remains capped at 12 rows.

### Selecting and removing

- Mouse selection adds the employee.
- Arrow Up and Arrow Down move the active option.
- Enter adds the active option.
- Escape closes the list.
- Backspace with an empty query removes the final selected chip.
- Duplicate additions are prevented.
- Selected users render as chips with display name, ID, role, and a remove button.

### Visibility changes

The allowlist field remains available in both settings entry points. When visibility is not `allowlist`, explanatory text states that the stored list is currently inactive. Changing visibility away from and back to `allowlist` must not discard selected users.

### Suggestion placement

Suggestions render through a portal attached to `document.body` and use fixed positioning based on the picker bounding rectangle.

- Prefer opening below the field.
- Open above when the available space below is insufficient and space above is greater.
- Match the picker width.
- Recalculate position on window resize and relevant scrolling.
- Close when focus/click moves outside both the picker and suggestion overlay.

This removes dependency on ancestor overflow behavior and works in the project panel, centered modal, mobile drawer, and context-access modal.

## Component changes

### `UserPicker`

Responsibilities:

- Manage query, loading, errors, highlighting, resolved selected users, and open state.
- Request initial suggestions on empty focus.
- Request filtered suggestions after debounced typing.
- Render the suggestion surface through a portal.
- Keep keyboard and pointer behavior accessible.

The component will distinguish a closed picker from an open empty-query picker. Empty query will no longer automatically clear and stop without a request while the picker is open.

### Shared project allowlist field

Create a small shared presentation component for project allowlist editing. It receives:

- `visibility`
- `selectedIds`
- `onChange`
- `disabled`

It renders the label, `UserPicker`, inactive-state hint, and allowlist explanation. Both `ProjectSettingsPanel` and `ProjectSettingsModal` use this component so wording and behavior stay aligned without forcing the rest of their layouts to be identical.

### `ProjectSettingsModal`

Add local allowlist state initialized from `project.access.allow_user_ids`. Render the shared allowlist field near project visibility. Submit `allow_user_ids` with the project patch request. Existing values remain intact across visibility changes in the modal.

### `ProjectSettingsPanel`

Replace the inline allowlist markup with the shared field. Existing page-level dirty tracking and auto-save remain responsible for persistence.

## API behavior

Continue using `GET /api/auth/user-search`.

- Non-empty `q`: retain current matching and ordering behavior.
- Empty `q` used for initial browse: return the first 12 active users in stable display-name/ID order.
- Return only `id`, `display_name`, and `role`.
- Never return deleted users, password hashes, work directories, or other account data.
- Keep the hard limit of 12 rows.

This is a bounded chooser response, not a paginated employee-directory endpoint.

## Data flow

1. The operator opens either project-settings entry point.
2. The settings implementation initializes selected IDs from `project.access.allow_user_ids`.
3. Focusing the picker requests bounded initial suggestions.
4. Typing replaces the initial request with a debounced filtered request.
5. Selecting or removing a user updates the entry point's allowlist state.
6. The project detail page persists through its existing dirty-state auto-save.
7. The user-home modal submits `allow_user_ids` when Save is clicked.
8. The project API returns updated access data, and the caller refreshes project state through its existing saved callback/store flow.

## Error handling

- A failed suggestion request displays the existing inline search error and does not change selected users.
- An empty successful result displays a clear no-match message.
- Saving failures in `ProjectSettingsModal` use the existing modal error banner and keep local selections available for retry.
- Missing or deleted previously selected users continue to render by raw ID when resolution fails.
- Rapid query changes ignore stale responses through the component's existing lifecycle cancellation guard.

## Security and privacy

- All search requests remain authenticated.
- Initial browse exposes at most 12 active users and only the same minimal fields already returned by keyword search.
- No full-list pagination or unrestricted account export is introduced.
- Project visibility authorization and project update authorization remain enforced by existing backend access control.

## Testing strategy

Follow test-driven development for implementation changes.

Automated coverage should verify:

- Empty focus triggers the bounded user search and opens suggestions.
- Typing filters results after debounce.
- Keyboard and pointer selection update selected IDs.
- Selected users cannot be added twice.
- Portal suggestions remain outside clipping ancestors.
- `ProjectSettingsModal` initializes and submits `allow_user_ids`.
- Visibility changes do not clear the local allowlist.
- The shared project allowlist field is used in both project settings entry points.
- Empty-query API responses contain no more than 12 active users and only allowed fields.

Manual/Playwright verification should cover:

- Project detail settings at desktop width.
- User-home project settings modal.
- A narrow/mobile project settings drawer.
- Empty focus, typed search, add, remove, save, refresh, and persistence.
- Suggestion placement near the bottom of a scrollable settings surface.

Required final verification includes the focused tests, backend syntax/type checks appropriate to modified files, and `cd mobius/frontend && npm run build`.

## Acceptance criteria

- Both project-settings entry points can add and remove allowlisted employees.
- Clicking an empty user picker shows up to 12 active employees.
- Typing an ID or display name filters suggestions.
- Suggestions are fully visible and not clipped in cards, modals, or drawers.
- Saving from the user-home modal persists `allow_user_ids`.
- Project detail auto-save continues to persist `allow_user_ids`.
- Switching visibility does not erase the stored list.
- Existing Skill/Memory permission pickers continue to work and are not clipped.
- Frontend build and relevant automated tests pass.
