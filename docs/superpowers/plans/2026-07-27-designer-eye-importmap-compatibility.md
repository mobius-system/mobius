# Designer Eye Import Map Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Designer Eye available on every extension page without invalidating extension import maps or changing extension business behavior.

**Architecture:** Replace the injected module script with a deferred classic loader. The loader executes only after HTML parsing, then dynamically imports the existing Designer Eye module graph by relative URL.

**Tech Stack:** TypeScript, browser JavaScript modules, Node.js assertions, Playwright browser verification.

## Global Constraints

- Do not modify extension-owned HTML, Three.js, animation code, desktop host bar behavior, or Designer Eye business behavior.
- Do not add dependencies.
- Keep the loader failure non-fatal to the host extension.
- Work directly on the self-development main checkout; do not create a worktree.

---

### Task 1: Add the deferred Designer Eye loader contract

**Files:**
- Create: `mobius/tests/designer-eye-extension-loader.js`
- Create: `mobius/backend/services/designer-eye-loader.ts`
- Create: `mobius/frontend/public/designer-eye/loader.js`
- Modify: `mobius/backend/routes/ext.ts:801`
- Modify: `mobius/frontend/index.html:40`
- Modify: `mobius/package.json:9`

**Interfaces:**
- Produces: `buildDesignerEyeLoaderInjection(): string`
- Consumes: browser endpoint `/extension/_sdk/designer-eye/loader.js`, which dynamically imports `./index.js`

- [ ] **Step 1: Write the failing test**

```js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildDesignerEyeLoaderInjection } = require('../backend/services/designer-eye-loader');

const injection = buildDesignerEyeLoaderInjection();
assert(!/type=["']module["']/i.test(injection));
assert(/<script\s+defer\s+src=["']\/extension\/_sdk\/designer-eye\/loader\.js["']><\/script>/i.test(injection));

const loader = fs.readFileSync(path.join(__dirname, '../frontend/public/designer-eye/loader.js'), 'utf8');
assert(loader.includes("import('./index.js')"));
assert(loader.includes('.catch('));
```

- [ ] **Step 2: Run the test to verify RED**

Run: `cd mobius && node --require tsx/cjs tests/designer-eye-extension-loader.js`

Expected: FAIL because `backend/services/designer-eye-loader` does not exist.

- [ ] **Step 3: Implement the minimal loader and injection helper**

```ts
export function buildDesignerEyeLoaderInjection(): string {
  return '<script defer src="/extension/_sdk/designer-eye/loader.js"></script>';
}
```

```js
void import('./index.js').catch((error) => {
  console.error('[designer-eye] load failed', error);
});
```

Import `buildDesignerEyeLoaderInjection` in `routes/ext.ts` and replace only the old direct module injection assignment. Add `test:designer-eye-extension-loader` to `mobius/package.json`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `cd mobius && npm run test:designer-eye-extension-loader && npm run test:designer-eye-locator && npm run test:designer-eye-prompt`

Expected: all commands exit 0 with no assertion failures.

- [ ] **Step 5: Run static and browser verification**

Run:

```bash
cd mobius && npm run typecheck
cd mobius/frontend && npm run build
```

Then use Playwright against the publication page and assert:

```text
designerEyeInstalled=true
canvasCount=7
visibleReveals=7
pageErrors=[]
```

- [ ] **Step 6: Commit, deploy, and verify production assets**

```bash
git add docs/superpowers/specs/2026-07-27-designer-eye-importmap-compatibility-design.md \
  docs/superpowers/plans/2026-07-27-designer-eye-importmap-compatibility.md \
  mobius/tests/designer-eye-extension-loader.js \
  mobius/backend/services/designer-eye-loader.ts \
  mobius/frontend/public/designer-eye/loader.js \
  mobius/backend/routes/ext.ts mobius/package.json
git commit -m "Delay Designer Eye module loading (延迟设计师之眼模块加载)"
python3 start.py
```

Verify `/extension/_sdk/designer-eye/loader.js` and `/extension/_sdk/designer-eye/index.js` return HTTP 200, then rerun the publication Playwright assertions against the deployed page.
