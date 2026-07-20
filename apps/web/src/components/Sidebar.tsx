import type { LucideIcon } from "lucide-react";
import {
  ChartArea,
  FolderGit2,
  Gauge,
  LibraryBig,
  Search,
  Settings2,
} from "lucide-react";

export type WorkspaceId = "now" | "spend" | "projects" | "library" | "system";

interface WorkspaceDef {
  id: WorkspaceId;
  label: string;
  icon: LucideIcon;
}

export const WORKSPACES: WorkspaceDef[] = [
  { id: "now", label: "Now", icon: Gauge },
  { id: "spend", label: "Spend", icon: ChartArea },
  { id: "projects", label: "Projects", icon: FolderGit2 },
  { id: "library", label: "Library", icon: LibraryBig },
  { id: "system", label: "System", icon: Settings2 },
];

interface SidebarProps {
  active: WorkspaceId;
  onNavigate: (id: WorkspaceId) => void;
  attentionCount: number;
  promptCount: number;
  connection: "checking" | "connected" | "offline";
  mode: "local" | "demo";
  version?: string;
  onOpenPalette: () => void;
}

export function Sidebar({
  active,
  onNavigate,
  attentionCount,
  promptCount,
  connection,
  mode,
  version,
  onOpenPalette,
}: SidebarProps) {
  const synced = connection === "connected";
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M5 6h14L6 18h13" />
          </svg>
        </div>
        <div>
          <div className="brand-name">ZipLyne</div>
          <div className="brand-sub">LENS</div>
        </div>
      </div>

      <button
        type="button"
        className="palette-hint"
        onClick={onOpenPalette}
        aria-label="Open command palette (Command K)"
      >
        <Search size={13} />
        <span>Jump to…</span>
        <span className="kbd">⌘K</span>
      </button>

      <nav className="nav" aria-label="Workspaces">
        {WORKSPACES.map((item, index) => {
          const isActive = active === item.id;
          const badge =
            item.id === "now"
              ? attentionCount
              : item.id === "library"
                ? promptCount
                : 0;
          return (
            <button
              className={isActive ? "nav-item active" : "nav-item"}
              key={item.id}
              onClick={() => onNavigate(item.id)}
              type="button"
              aria-current={isActive ? "page" : undefined}
              title={`${item.label} (⌘${index + 1})`}
            >
              <span className="nav-icon">
                <item.icon size={16} />
              </span>
              <span className="nav-text">{item.label}</span>
              {badge > 0 ? (
                <span
                  className={
                    item.id === "now"
                      ? "nav-badge alert tnum"
                      : "nav-badge tnum"
                  }
                >
                  {badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-foot">
        <div className="status-card">
          <span className={`dot ${synced ? "ok" : "off"}`} />
          <span>
            {synced
              ? "Local service"
              : mode === "demo"
                ? "Sample data"
                : "Waiting for data"}
          </span>
          {synced && version ? (
            <span className="status-version">v{version}</span>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
