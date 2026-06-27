/**
 * skill-resolver.ts — 把 (用户级 + 项目级) skill 列表与 issue 上的 selected / excluded
 * 化简成 "本次 session 实际要注入的 skills".
 *
 * 规则:
 *   1) 如果 issue.selected_skills 非空: 只保留 id ∈ selected 的 skill (白名单).
 *      如果为空: 全部默认启用.
 *   2) 在以上基础上再扣掉 issue.excluded_skills (黑名单).
 *   3) 同 name 的 skill 去重 (保留先出现的; 列表已按 scope DESC 排序, 用户级先出现).
 */

function resolveEffectiveSkills(
  allSkills: any[],
  { selected = [], excluded = [] }: { selected?: string[]; excluded?: string[] } = {},
): any[] {
  const selectedSet = new Set(selected);
  const excludedSet = new Set(excluded);
  let out = allSkills.slice();
  if (selectedSet.size > 0) {
    out = out.filter((s) => selectedSet.has(s.id));
  }
  out = out.filter((s) => !excludedSet.has(s.id));
  const seen = new Set<string>();
  const dedup: any[] = [];
  for (const s of out) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    dedup.push(s);
  }
  return dedup;
}

export { resolveEffectiveSkills };
