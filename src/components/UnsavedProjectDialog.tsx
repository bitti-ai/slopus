import { ContentDialog, InfoBar } from "./ui";

/* Leaving a project with unsaved edits. The Windows question, in the Windows
   order: [Save] [Don't save] [Cancel]. Save is the default (Enter), Esc is
   Cancel. While the save is in flight every button is off and Esc does
   nothing, so the answer cannot change under the write. */
export function UnsavedProjectDialog({ name, busy, error, onSave, onDiscard, onBack }: {
  name: string;
  busy: boolean;
  error: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onBack: () => void;
}) {
  return (
    <ContentDialog
      title={`Save changes to “${name}”?`}
      primaryText={busy ? "Saving…" : "Save"}
      onPrimary={onSave}
      primaryDisabled={busy}
      secondaryText="Don't save"
      onSecondary={onDiscard}
      secondaryDisabled={busy}
      closeText="Cancel"
      onClose={() => { if (!busy) onBack(); }}
      disableEscape={busy}
      defaultButton="primary"
    >
      <p>Your changes will be lost if you don't save them.</p>
      {error && <InfoBar severity="error" title="Couldn’t save the project" message={error} />}
    </ContentDialog>
  );
}
