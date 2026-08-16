import type { LucideIcon } from "lucide-react";
import {
  Aperture,
  BookImage,
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

const navItems: Array<{ id: WorkspaceView; label: string; icon: LucideIcon }> = [
  { id: "library", label: "Projects", icon: FolderKanban },
  { id: "generate", label: "Generate", icon: Sparkles },
  { id: "references", label: "References", icon: BookImage },
];

/* These two are not built yet. They stay visible so the shape of the app is
   honest, but they are disabled and labelled so nobody clicks a dead control. */
const notBuiltYet: Array<{ label: string; icon: LucideIcon; title: string }> = [
  { label: "Help & shortcuts", icon: CircleHelp, title: "Help & shortcuts isn’t available yet." },
  { label: "Settings", icon: Settings, title: "Settings aren’t available yet." },
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
              type="button"
              onClick={() => onNavigate(item.id)}
              aria-current={view === item.id ? "page" : undefined}
            >
              <Icon size={20} strokeWidth={1.8} aria-hidden="true" />
              <span>{item.label}</span>
              {item.id === "generate" && <span className="nav-item__badge">AI</span>}
            </button>
          );
        })}
      </nav>

      <div className="sidebar__status">
        <div className="sidebar__status-icon" aria-hidden="true"><Aperture size={20} /></div>
        <div>
          <strong>Local workspace</strong>
          <span>Files stay on this device</span>
        </div>
      </div>

      <div className="sidebar__bottom">
        {notBuiltYet.map((item) => {
          const Icon = item.icon;
          return (
            <button className="utility-button" key={item.label} type="button" disabled title={item.title}>
              <Icon size={18} aria-hidden="true" />
              <span>{item.label}</span>
              <span className="utility-button__soon">Soon</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}
