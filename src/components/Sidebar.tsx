import {
  Aperture,
  BookImage,
  ChevronDown,
  CircleHelp,
  FolderKanban,
  Settings,
  Sparkles,
} from "lucide-react";
import { Brand } from "./Brand";

export type WorkspaceView = "library" | "generate" | "references";

interface SidebarProps {
  view: WorkspaceView;
  onNavigate: (view: WorkspaceView) => void;
}

const navItems = [
  { id: "library" as const, label: "Projects", icon: FolderKanban },
  { id: "generate" as const, label: "Generate", icon: Sparkles },
  { id: "references" as const, label: "References", icon: BookImage },
];

export function Sidebar({ view, onNavigate }: SidebarProps) {
  return (
    <aside className="sidebar">
      <Brand />
      <nav className="sidebar__nav" aria-label="Workspace">
        <p className="sidebar__label">Workspace</p>
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className={`nav-item ${view === item.id ? "nav-item--active" : ""}`}
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon size={17} strokeWidth={1.8} />
              <span>{item.label}</span>
              {item.id === "generate" && <span className="nav-item__badge">AI</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__status">
        <div className="sidebar__status-icon"><Aperture size={17} /></div>
        <div>
          <strong>Local workspace</strong>
          <span>Files stay on this device</span>
        </div>
      </div>

      <div className="sidebar__bottom">
        <button className="utility-button"><CircleHelp size={16} /> Help & shortcuts</button>
        <button className="utility-button"><Settings size={16} /> Settings</button>
        <button className="profile-button" aria-label="Open profile menu">
          <span className="profile-button__avatar">PS</span>
          <span><strong>Pol Studio</strong><small>Creator workspace</small></span>
          <ChevronDown size={14} />
        </button>
      </div>
    </aside>
  );
}

