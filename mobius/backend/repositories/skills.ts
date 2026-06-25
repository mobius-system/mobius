/**
 * skills.ts — Skill 仓库. 现已切换到文件系统存储 (skills-fs).
 * 此文件仅作为兼容层, 保持 routes/issues.js 与 session-context.js 的调用面不变.
 */
const skillsFs = require('../services/skills-fs');

const Skills = {
  listForUser: skillsFs.listForUser,
  listForProject: skillsFs.listForProject,
  listForIssue: skillsFs.listForIssue,
  listBuiltin: skillsFs.listBuiltin,
  listAll: skillsFs.listAll,
  findById: skillsFs.findById,
  delete: skillsFs.deleteById,
  deleteForProject: skillsFs.deleteForProject,
  install: skillsFs.install,
  importLocal: skillsFs.importFromLocalPath,
  copyToScope: skillsFs.copyToScope,
  move: skillsFs.moveSkill,
};

export { Skills };
