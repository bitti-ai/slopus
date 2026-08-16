import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Construction } from "lucide-react";

export function EmptyPlaceholder({ title, copy, icon: Icon = Construction, onBack }: {
  title: string; copy: string; icon?: LucideIcon; onBack: () => void;
}) {
  return (
    <main className="placeholder-view">
      <button className="back-link" onClick={onBack}><ArrowLeft size={15} /> Project library</button>
      <div className="placeholder-view__card">
        <span><Icon size={24} /></span>
        <p className="eyebrow">Workspace preview</p>
        <h1>{title}</h1>
        <p>{copy}</p>
        <button className="primary-button" onClick={onBack}>Return to projects</button>
      </div>
    </main>
  );
}
