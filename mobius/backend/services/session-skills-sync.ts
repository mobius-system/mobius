/**
 * session-skills-sync.ts — 把当前 session 解析后的 effective skills (用户级 + 项目级)
 * 镜像到 session 工作目录下的 `.imac/skills/<dirName>/`, 让 agent 通过相对路径自取
 * SKILL.md, 取代之前把整段 SKILL.md 内嵌进首轮 prompt 的做法.
 *
 * 同步策略:
 *   - 整目录复制 (含 SKILL.md 之外的资源文件 / scripts).
 *   - 同名 skill 覆盖 (rmSync + cpSync); 其他已存在的 skill 子目录保留,
 *     不再因为本次未选中而删除.
 *   - 源不存在 / 复制失败的项不抛错, 通过返回值反馈给调用方.
 */
import * as fs from 'fs';
import * as path from 'path';
import { getSourceDir, parseSkillId } from './skills-fs';

// 用 POSIX 形式给 agent 看到相对路径, 跨平台时也保持一致.
const TARGET_SUBDIR = '.imac/skills';

function syncSkillsToWorkspace(workDir: string, skills: any[]): any[] {
  const results: any[] = [];
  if (!workDir || !Array.isArray(skills)) return results;

  const targetRoot = path.resolve(workDir, TARGET_SUBDIR);
  try {
    fs.mkdirSync(targetRoot, { recursive: true });
  } catch {
    return results;
  }

  // const keep = new Set(); // 新行为: 不再清理未选中的 skill, keep 集合停用
  for (const sk of skills) {
    const parsed = parseSkillId(sk.id);
    if (!parsed) { results.push({ id: sk.id, ok: false, reason: 'unparseable id' }); continue; }
    const src = getSourceDir(sk.id);
    const dest = path.join(targetRoot, parsed.dirName);
    try {
      fs.rmSync(dest, { recursive: true, force: true });
      if (src && fs.existsSync(src)) {
        fs.cpSync(src, dest, { recursive: true });
      } else if (sk.body) {
        fs.mkdirSync(dest, { recursive: true });
      } else {
        results.push({ id: sk.id, dirName: parsed.dirName, ok: false, reason: 'source missing' });
        continue;
      }
      if (sk.body) {
        fs.writeFileSync(path.join(dest, 'SKILL.md'), sk.body, 'utf8');
      }
      // keep.add(parsed.dirName); // 新行为: 不再清理未选中的 skill, 此行停用
      results.push({
        id: sk.id,
        dirName: parsed.dirName,
        ok: true,
        relPath: `${TARGET_SUBDIR}/${parsed.dirName}/SKILL.md`,
        absPath: path.join(dest, 'SKILL.md'),
      });
    } catch (e) {
      results.push({ id: sk.id, dirName: parsed.dirName, ok: false, reason: e.message });
    }
  }

  // 新行为标准 (按用户要求停用): 不再删除本次未选中的 skill.
  // 同名 skill 在循环内通过 rmSync + cpSync 已经覆盖, 其他 skill 子目录原样保留.
  // try {
  //   for (const ent of fs.readdirSync(targetRoot, { withFileTypes: true })) {
  //     if (ent.isDirectory() && !keep.has(ent.name)) {
  //       fs.rmSync(path.join(targetRoot, ent.name), { recursive: true, force: true });
  //     }
  //   }
  // } catch {}

  return results;
}

export { syncSkillsToWorkspace, TARGET_SUBDIR };
