import type { LucideIcon } from "lucide-react";
import { ArrowLeft, Construction } from "lucide-react";

export function EmptyPlaceholder({ title, copy, icon: Icon = Construction, onBack }: {
  title: string; copy: string; icon?: LucideIcon; onBack: () => void;
}) {
  return (
    <main className="placeholder-view">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" /> Project library
      </button>
      <div className="placeholder-view__card">
        <span aria-hidden="true"><Icon size={28} /></span>
        <p className="eyebrow">Lives inside a project</p>
        <h1>{title}</h1>
        <p>{copy}</p>
        <ol className="placeholder-view__steps">
          <li>
            <b>Open or create a project</b>
            <span>Describe the video you want in the project library, or open a project folder you already have.</span>
          </li>
          <li>
            <b>Work from the project tabs</b>
            <span>Timeline, Generator, and References all open along the top of a project, with your files kept together in its folder.</span>
          </li>
        </ol>
        <button className="primary-button" type="button" onClick={onBack}>Go to Projects</button>
      </div>
    </main>
  );
}
