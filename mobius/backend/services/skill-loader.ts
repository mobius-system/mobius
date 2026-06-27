/**
 * skill-loader.ts — 解析 SKILL.md 文本.
 *
 * 一个 Skill 是一段 SKILL.md 文本, 必须以 YAML frontmatter 开头:
 *   ---
 *   name: my-skill
 *   description: 一句话说明
 *   allowed-tools: Bash(...)        # 可选, 仅展示
 *   ---
 *   # 正文 ...
 *
 * 我们只解析 frontmatter 的 name / description, body 即整段 SKILL.md 原文,
 * 注入到 prompt 时直接拼接.
 */

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
  if (!match) return { meta: {}, body: text };
  const block = match[1];
  const body = text.slice(match[0].length);
  const meta: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
    meta[m[1]] = v;
  }
  return { meta, body };
}

// 从 SKILL.md 文本提取 { name, description, body } (body = 原文整段).
function loadSkillFromText(text: string): { name: string; description: string; body: string } {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('SKILL.md 内容不能为空');
  }
  const raw = text.replace(/\r\n/g, '\n');
  const { meta } = parseFrontmatter(raw);
  const name = (meta.name || '').trim();
  const description = (meta.description || '').trim();
  if (!name) throw new Error('SKILL.md frontmatter 必须包含 name 字段');
  return { name, description, body: raw };
}

export { loadSkillFromText, parseFrontmatter };
