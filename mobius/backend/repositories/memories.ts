/**
 * memories.ts — Memory 仓库. 文件系统存储 (memories-fs), 兼容层.
 */
const memoriesFs = require('../services/memories-fs');
const { syncProjectKnowledgeForProjectId } = require('../services/project-knowledge');

function listForProjectWithKnowledgeSync(projectId: string): any {
  const result = syncProjectKnowledgeForProjectId(projectId);
  if (result && !result.ok) {
    console.warn(`[memories] project knowledge sync failed for ${projectId}: ${result.error}`);
  }
  return memoriesFs.listForProject(projectId);
}

const Memories = {
  listForUser: memoriesFs.listForUser,
  listForProject: listForProjectWithKnowledgeSync,
  listAll: memoriesFs.listAll,
  findById: memoriesFs.findById,
  create: memoriesFs.create,
  upsertProjectMemory: memoriesFs.upsertProjectMemory,
  update: memoriesFs.update,
  delete: memoriesFs.deleteById,
  deleteForProject: memoriesFs.deleteForProject,
  copyToScope: memoriesFs.copyToScope,
  importLocal: memoriesFs.importFromLocalPath,
  move: memoriesFs.moveMemory,
  syncProjectKnowledge: syncProjectKnowledgeForProjectId,
};

export { Memories };
