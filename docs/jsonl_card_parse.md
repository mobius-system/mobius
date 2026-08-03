# JSONL 卡片解析: 合并 / 隐藏 / 折叠

代码均在 `mobius/frontend/src/components/viewer/` (下文简写为 `viewer/`).

## 1. 合并 — 单卡 open (所有条件在一个函数)

`resolveDesiredOpen` (`EntryCard.tsx:129`) 把全部展开/折叠条件合并判定, **顺序即优先级**; 调用见 `EntryCard.tsx:260`.

```
① forceOpen              搜索命中        → 展开 (压过一切)
② parentOrderedCollapse   forgotten-flag  → 折叠 (压过 ③④)
③ 本地展开条件            patch_apply / 计划 / 纯文本卡(可精简·图片·error, 非代码卡) → 展开
④ toolError              工具失败        → 展开 (被 ② 抑制)
⑤ 兜底                   折叠
```

- 调用方只传原子信号 (`isPatchApply/canPlan/canCode/canCompact/canImage/isErrorType/toolError`); ③ 在函数内联判定, 无外部中间变量.
- **ratchet**: 自动信号只掀开不折回; 折叠仅来自初值 ② 或用户手动 (`userToggledRef`). `forceOpen` 例外 — 手动折过也掀开.

## 2. 隐藏 — 整卡不渲染 (一处入口 + 一处规则)

- **入口**: `JsonlView.visibleItems` 的 filter (`JsonlView.tsx:154`).
- **规则**: `isHiddenJsonlNoiseEntry` (`entry-classify.ts:107`) → 7 类系统注入/元数据噪声: `token_count · environment_context · session_meta · turn_context · turn_duration · skill_listing · agent_listing_delta`.
- 新增噪声类型只往 `entry-classify.ts:107` 加谓词, filter 处不动.
- 纯 `tool_result` 不走隐藏 (由 `mergeBashToolResultItems` 合并回 `tool_use` 卡).

## 3. 折叠 — 容器整组 (三层, 各有 open state)

代码: `RoundGroups.tsx`. `forceOpen`/`parentOrderedCollapse` 不作用于容器, 只透传给内部单卡.

| 容器 | 位置 | open 初值 | 用户保护 |
|---|---|---|---|
| `ExploreGroupCard` (探索聚合) | `:50` | `hasError \|\| containsFocus` | 无 |
| `ContinuationGroup` (上文续接) | `:97` | `onlyGroup \|\| forceExpandAll \|\| containsFocus` | `onlyGroup` 锁定 |
| `RoundGroup` (轮次) | `:147` | `forceExpandAll \|\| forceOpen \|\| autoOpen \|\| onlyGroup` | `userToggledRef` |

- `autoOpen = isLast || isSecondLast` (最新两轮默认展开, 更早轮跌出自动折).
- `onlyGroup`: 全视图仅 1 组时锁定展开禁折.
- `forceExpandAll`: 点"加载全部"强制展开所有组.

---

## 附: 单卡两个 prop 怎么来

`JsonlView` 顶层算好, 4 处容器对称透传 (`JsonlView.tsx:290`):
- `forceOpen = (lineNo === focusLineNo)` — 搜索命中.
- `parentOrderedCollapse = collapseLineNos.has(lineNo)` — forgotten-flag. 规则 `computeCollapsedByForgottenFlag` (`fold-rules.ts:149`): 卡片含 `running.flag` 且往前 8 条内有一张 forgotten-flag 用户卡.

## 附: 已知边界
- `ExploreGroupCard` 无 `userToggledRef`, `hasError` 只取初值 → 延迟落地的探索失败不自动展开 (极边缘, 可手动展开).
- `parentOrderedCollapse` 卡即使后变 `toolError` 也不展开 (有意: 尊重折叠意图).
