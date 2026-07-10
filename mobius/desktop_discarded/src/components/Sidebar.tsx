import {
  Box,
  Clock3,
  ExternalLink,
  Folder,
  FolderPlus,
  ListFilter,
  LogOut,
  PenLine,
  Settings,
} from "lucide-react";
import { threadGroups } from "../mock/threads";

interface SidebarProps {
  onLogout: () => void;
  onMockAction: (message: string) => void;
}

export function Sidebar({ onLogout, onMockAction }: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-drag" />
      <div className="traffic-spacer">
        <div className="window-badge" />
      </div>

      <nav className="sidebar-primary" aria-label="Primary">
        <button onClick={() => onMockAction("New thread 是 mock 按钮")}>
          <PenLine size={21} />
          <span>New thread</span>
        </button>
        <button onClick={() => onMockAction("Automations 是 mock 按钮")}>
          <Clock3 size={22} />
          <span>Automations</span>
          <strong>1</strong>
        </button>
        <button onClick={() => onMockAction("Skills 是 mock 按钮")}>
          <Box size={22} />
          <span>Skills</span>
        </button>
      </nav>

      <div className="threads-header">
        <span>Threads</span>
        <div>
          <button aria-label="New folder" onClick={() => onMockAction("新建分组暂未接入")}>
            <FolderPlus size={19} />
          </button>
          <button aria-label="Filter threads" onClick={() => onMockAction("筛选暂未接入")}>
            <ListFilter size={19} />
          </button>
        </div>
      </div>

      <div className="thread-groups">
        {threadGroups.map((group) => (
          <section className="thread-group" key={group.workspace}>
            <div className="workspace-title">
              <Folder size={24} />
              <span>{group.workspace}</span>
            </div>

            {group.threads.length === 0 ? (
              <div className="empty-thread">No threads</div>
            ) : (
              group.threads.map((thread) => (
                <button
                  className={thread.id === "expire-time" ? "thread-row active" : "thread-row"}
                  key={thread.id}
                  onClick={() => onMockAction(`${thread.title} 是静态 mock 线程`)}
                >
                  <span className="thread-title">{thread.title}</span>
                  {thread.external && <ExternalLink size={18} />}
                  {thread.additions ? <span className="diff-add">+{thread.additions}</span> : null}
                  {thread.deletions ? <span className="diff-del">-{thread.deletions}</span> : null}
                  {thread.age ? <span className="thread-age">{thread.age}</span> : null}
                </button>
              ))
            )}
          </section>
        ))}
      </div>

      <div className="sidebar-footer">
        <button onClick={() => onMockAction("设置暂未接入")}>
          <Settings size={23} />
          <span>Settings</span>
        </button>
        <button aria-label="Logout" onClick={onLogout} title="返回登录页">
          <LogOut size={21} />
        </button>
      </div>
    </aside>
  );
}
