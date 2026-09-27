import { useState } from "react";
import { Checkbox, ContentDialog } from "./ui";

/* Asks before the engine spends GPU time on reference icons. A ContentDialog
   rather than a native message box because it carries a check box. Cancel is
   the default answer (Enter), and it is a real button rather than the dialog's
   close action so that only choosing it remembers "Don't ask again": Esc
   skips this batch and remembers nothing. */
export function ReferenceIconGenerationDialog({ count, onAnswer, builtins = false }: {
  count: number;
  builtins?: boolean;
  onAnswer: (confirmed: boolean, remember: boolean) => void;
}) {
  const [remember, setRemember] = useState(false);
  return (
    <ContentDialog
      title={builtins ? "Generate built-in reference icons?" : "Generate reference icons?"}
      primaryText="Start generation"
      onPrimary={() => onAnswer(true, remember)}
      secondaryText="Cancel"
      onSecondary={() => onAnswer(false, remember)}
      onClose={() => onAnswer(false, false)}
      defaultButton="secondary"
    >
      {builtins ? <>
        <p>Generate icons for {count} built-in references to make them easier to browse? This can take a long time. It runs in the background and pauses for video generation.</p>
        <p>The icons are shared across projects.</p>
      </> : <>
        <p>{count} {count === 1 ? "reference needs an icon" : "references need icons"}. Generate them with the video engine now? This uses your GPU; videos waiting to render go first.</p>
      </>}
      <Checkbox
        checked={remember}
        onChange={setRemember}
        label="Don't ask again"
        description={builtins ? "Remember the answer when you open Add a reference." : "Start turns on automatic generation; Cancel turns it off."}
      />
    </ContentDialog>
  );
}
