import type { ProjectRecord } from "../lib/project";
import { askNative, inTauri } from "../lib/nativeShell";
import { ContentDialog } from "./ui";

const question = (project: ProjectRecord) => ({
  title: `Delete “${project.config.name}”?`,
  message: "This permanently deletes the project folder and every file inside it. This can't be undone.",
});

/* Deleting a project is a plain yes/no question, so in the desktop app it is
   the system's own message box (askNative). The browser build and the tests
   have no message box to ask with — askNative answers "no" there — so they
   get the same question as a ContentDialog instead. */

/** Asks with the native message box. Resolves false outside the desktop app. */
export function confirmProjectDeletionNatively(project: ProjectRecord): Promise<boolean> {
  const { title, message } = question(project);
  return askNative({ title, message: `${message}\n\n${project.folderPath}`, kind: "warning", okLabel: "Delete", cancelLabel: "Cancel" });
}

/** True when the question can be put as a native message box. */
export const canConfirmNatively = () => inTauri();

export function DeleteProjectDialog({ project, deleting, onConfirm, onCancel }: {
  project: ProjectRecord;
  deleting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { title, message } = question(project);
  return (
    <ContentDialog
      title={title}
      destructive
      primaryText={deleting ? "Deleting…" : "Delete"}
      onPrimary={onConfirm}
      primaryDisabled={deleting}
      closeText="Cancel"
      onClose={() => { if (!deleting) onCancel(); }}
      disableEscape={deleting}
      defaultButton="close"
    >
      <p>{message}</p>
      <p className="dialog-path">{project.folderPath}</p>
    </ContentDialog>
  );
}
