import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { StatusBar } from "../ui";

/* The project window has ONE status bar, along its bottom, on every tab. Its
   trailing side (sequence format, save state) belongs to the workspace; its
   leading side belongs to whichever view is showing. A view says what goes
   there with <ProjectStatus>, which is portalled into the shared bar — the
   items stay the view's own components, rendered from its own state.

   A view rendered on its own (outside a project window) has no shared bar, so
   it gets a strip of its own at its foot instead, with the same label. */

/** The shared bar's leading slot: the element to portal into, null while it
 *  mounts, undefined outside a project window. */
export const ProjectStatusSlot = createContext<HTMLElement | null | undefined>(undefined);

export function ProjectStatus({ label, className, children }: {
  /** The view's name for its status ("Generator status"), used when the view
   *  stands alone. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const slot = useContext(ProjectStatusSlot);
  if (slot === undefined) return <StatusBar aria-label={label} className={className}>{children}</StatusBar>;
  return slot ? createPortal(children, slot) : null;
}
