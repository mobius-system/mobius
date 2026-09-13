# Mobius Maxmal UI Studio

An incremental, frontend-only adaptation of `minimal-ui-studio`. The original shell, font assets, neutral palette, spacing, controls, and adjustable design settings are retained. Open `/extension/maxmal-ui-studio/`.

## UI and backend vocabulary

The following mapping was checked against the existing backend; the prototype makes no business API calls and changes no backend implementation.

| UI | Existing entity | Source |
| --- | --- | --- |
| 项目 | Issue inside a backing Project; its conversations are Sessions with `scope_type=issue` and `issue_id` | `backend/routes/issues.ts`, `backend/repositories/sessions.ts` |
| 专业项目 | Research in an enabled backing Project, `mode=chief_led`; Chief is a Session with `scope_type=research`, `research_role=chief_researcher` | `backend/routes/researches.ts`, `backend/services/research-team.ts` |
| 我的作品 | Registered extension; its backing Project has `kind=extension` | `backend/services/extension-registry.ts` |
| 我的世界 | Project-scoped `aimux_remote_inventory`, with AIMUX connection, file and port capabilities | `backend/routes/projects.ts` |

The UI's “project” is intentionally an Issue, not a replacement for the backend Project container. A future integration must resolve the backing Project and preserve authorization. Chief creation requires the existing Chief skill selection and research enablement; the prototype model selector is presentation only. Members are Sessions, not a separately invented team protocol. Remote file operations must ultimately use AIMUX file dispatch; no SSH commands or real connections run here.

## Flows

- **项目:** welcome → create an Issue-shaped demo project → create/open its Sessions → independent local conversations, goal editing, flat recent sidebar with on-demand conversation disclosure, global search.
- **专业项目:** welcome → specify title, objective and Chief → overview → Chief conversation → explicit Chief planning preview → team and progress. New projects always start with exactly one Chief Session, without assistant selection.
- **我的作品:** welcome → create a todo/notes demo extension → interactive preview → about/version → edit metadata.
- **我的世界:** welcome → local/SSH/reverse connection form → simulated connected/offline states → files, terminal and ports. No credentials are collected. Terminal input is never executed and ports never establish tunnels.
- Brand/help or Ctrl/Cmd+Alt+E opens inherited design controls. Column resizing, editable welcome/navigation copy, colors, font size, module visibility, export and reset remain available.

## Local data

- `maxmal-ui-studio-design-v1`: design configuration, independent of the original extension.
- `maxmal-ui-studio-content-v1`: demo projects, sessions/messages, research teams, works and devices.
- Hash routes support refreshing or linking directly to a view. Unavailable records fall back to the matching welcome page.
- “恢复参考布局” resets visual settings; “恢复演示内容” resets demo content only.

The registry-required backend handler is an inert placeholder. All visible connections, assistant messages, team plans, files and tools are explicitly demonstration states. Font license is included under `frontend/fonts/LICENSE.txt`.

## Recent sidebar

The lower sidebar is one flat, text-only Recent list shared by Issues and Research. It starts with ten rows; “显示更多” appends ten. The heading menu filters by type. Only one conversation branch expands at a time, initially showing five sessions; more can be revealed without drawing every session in the DOM. No connector lines, dots, type badges or per-project “new conversation” rows are rendered.

Opening an item updates its local recent timestamp. A directly opened session is kept visible at the top of its branch. Sidebar scrolling is independent of the fixed navigation and account footer; disclosure and loading preserve scroll/focus. Global search covers all data with thirty results per batch. Demo-only stress fixtures belong in external browser tests, never in shipped seed content.

## Hand-drawn layout adaptation

`sketch.js` / `sketch.css` adapt the existing shell to the supplied September sketch. All new behavior remains frontend-only.

- Mobius brand menu switches ordinary Issues / Research; only matching projects and sessions appear in the left list. Three navigation items remain: new conversation, extensions, devices.
- Cluster-Overview sits outside the scrolling list and is global. Area, edge, and multi-agent visibility controls update a local SVG map; clicking a node opens its space. A representative subset is drawn for readability, not a live topology.
- Extensions open an associated editor Session in the center and a real, local `app-preview.html?work=<id>` iframe URL on the right. The preview and editor use the extension's own localStorage key. Only this authored same-origin preview allows forms and shared storage. Browser previews accept HTTP(S) URLs and may be blocked by the destination's embedding policy.
- Device configuration uses the existing demo device views. No physical connection, remote command, or port forwarding is performed.
- Self-iteration filters Issues marked as belonging to the demo self-evolution backing Project. Versions and evolution suggestions are simulated. Real Mobius uses `is_self_develop` and its authenticated `/:id/deploy-version` route; the prototype does not invoke it.
- Skill/Memory catalogs live in settings; selections and follow-up emphasis belong to each Session. Message snapshots retain the chosen labels. Existing backend session selection uses skill/memory IDs and exclusion/whitelist rules; no real context injection is performed here.
- Quick operations include pin, rename, model/Harness selection, editable knowledge extraction, local usage estimates, suspend/resume and delete. Message controls reveal time, copy and details on hover or keyboard focus.
- Right views cover local file editing, a VS Code-shaped editor, application/browser frames and a generic document editing surface. Office/PDF choices are visual demonstrations, not real file parsers.
- The pet sits at the lower right of the right panel, moving to the center pane when that panel is hidden, including responsive breakpoints.

Design controls still use Ctrl/Cmd+Alt+E. Footer settings → “通用与外观” opens them. The inherited font assets, palette and primary layout measurements remain unchanged.
