import { UserProjectView } from '../repositories/user-project-view';

function normalizeProjectSearch(raw: any): string {
  return String(raw || '').trim().toLowerCase();
}

function projectMatchesSearch(project: any, query: any): boolean {
  const q = normalizeProjectSearch(query);
  if (!q) return true;
  return [
    project.id,
    project.name,
    project.description,
    project.extension_name,
    project.created_by_name,
  ].some((value) => String(value || '').toLowerCase().includes(q));
}

function filterProjectListForUser(
  projects: any[],
  user: any,
  { query = '', showAll = false }: { query?: string; showAll?: boolean } = {},
): any[] {
  const prefs = UserProjectView.getPrefs(user?.id);
  const mutedIds = UserProjectView.mutedIds(user?.id);
  const searching = !!normalizeProjectSearch(query);
  return (Array.isArray(projects) ? projects : [])
    .filter((project) => projectMatchesSearch(project, query))
    .filter((project) => searching || !mutedIds.has(project.id))
    .filter((project) => {
      // search: keep all hits (also muted) so user can search across full list;
      // showAll: caller explicitly asks for the full visible list (e.g. "全部" tab),
      //          bypass hide_others_projects so users see every project they can read.
      if (searching || showAll || !prefs.hide_others_projects) return true;
      return project.created_by === user?.id || !!project.starred;
    });
}

export {
  UserProjectView,
  filterProjectListForUser,
  projectMatchesSearch,
  normalizeProjectSearch,
};
