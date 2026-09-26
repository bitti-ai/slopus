import { useEffect, useId, useRef, useState } from "react";
import { outputDimensions } from "../lib/export";
import { useShortcut } from "../lib/commands";
import type { AspectRatio, CreateProjectInput, ProjectConfig, Resolution } from "../lib/project";
import { PROJECT_RESOLUTIONS } from "../lib/project";
import { SHOT_TAG_GROUPS } from "../lib/shot-tags";
import { ContentDialog, InfoBar, RadioGroup } from "./ui";

interface PromptComposerProps {
  busy: boolean;
  onCreate: (input: CreateProjectInput) => Promise<void>;
  onClose: () => void;
  project?: ProjectConfig;
  error?: string | null;
  folderPath?: string;
  folderError?: string | null;
  checkingFolder?: boolean;
  onChooseFolder?: () => Promise<void>;
}

/* Chosen because it is the closest rung to the canvas slopfab actually plans a
   16:9 scene onto (1344×768), so a project made without opening this panel is
   not one that has to be rescaled the moment a scene is generated. */
const DEFAULT_RESOLUTION: Resolution = "768p";
const LOOKS = SHOT_TAG_GROUPS.find((group) => group.id === "visualStyle")!.options;

const folderName = (path?: string) => path?.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || "Untitled video";

/* New project, and the same form as Project settings for an open project.
   A standard 548px ContentDialog on a solid layer: the project type as two
   radio buttons, the folder as a read-only path with Browse…, the name, and
   the format. [Create] [Cancel] in the footer; Enter creates, Esc cancels.
   Errors — a folder that is not empty, a failed save — are an InfoBar in the
   body rather than red text beside the button. */
export function PromptComposer({ busy, onCreate: onSubmit, onClose, project, error, folderPath, folderError, checkingFolder, onChooseFolder }: PromptComposerProps) {
  const [generationType, setGenerationType] = useState<"video" | "image">(project?.generationType === "image" ? "image" : "video");
  const [name, setName] = useState(project?.name ?? folderName(folderPath));
  const previousFolderName = useRef(folderName(folderPath));
  useEffect(() => {
    const next = folderName(folderPath);
    const previous = previousFolderName.current;
    if (!project) setName((current) => current === previous ? next : current);
    previousFolderName.current = next;
  }, [folderPath, project]);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>(project?.settings.aspectRatio ?? "16:9");
  const [resolution, setResolution] = useState<Resolution>(project?.settings.resolution ?? DEFAULT_RESOLUTION);
  const [defaultLook, setDefaultLook] = useState(project?.settings.defaultLook ?? "");
  const nameInput = useRef<HTMLInputElement>(null);
  const id = useId();
  const resolutions: readonly Resolution[] = project && !PROJECT_RESOLUTIONS.some((value) => value === project.settings.resolution)
    ? [...PROJECT_RESOLUTIONS, project.settings.resolution] : PROJECT_RESOLUTIONS;
  const blocked = busy || Boolean(checkingFolder) || Boolean(folderError) || !name.trim();
  const close = () => { if (!busy) onClose(); };

  /* Naming is the only authored content required before the Agent takes over,
     so the name is focused and selected, ready to type over. */
  useEffect(() => { nameInput.current?.select(); }, []);

  /* Esc is the dialog's own key while focus is in it. This catches it when
     focus has wandered to the page (a click on the title bar). */
  useShortcut("Escape", close, { allowInModal: true, allowInInput: true });

  const submit = async () => {
    if (blocked) return;
    await onSubmit({
      generationType,
      name: name.trim(),
      prompt: project?.brief.prompt ?? "",
      aspectRatio,
      resolution,
      targetDurationSeconds: project?.brief.targetDurationSeconds ?? 60,
      defaultLook: defaultLook || null,
    });
  };

  const message = folderError || error;
  return (
    <ContentDialog
      title={project ? "Project settings" : "New project"}
      primaryText={project ? (busy ? "Saving…" : "Save changes") : (busy ? "Creating…" : "Create project")}
      onPrimary={() => void submit()}
      primaryDisabled={blocked}
      closeText="Cancel"
      onClose={close}
      disableEscape={busy}
      defaultButton="primary"
      initialFocus={nameInput}
      className="composer"
    >
      <div className="composer__form">
        {!project && (
          <RadioGroup
            label="Project type"
            orientation="horizontal"
            value={generationType}
            disabled={busy}
            onChange={(type) => {
              setGenerationType(type);
              if (!folderPath && (name === "Untitled video" || name === "Untitled image")) setName(`Untitled ${type}`);
            }}
            options={[
              { value: "video", label: "Video project" },
              { value: "image", label: "Image project" },
            ]}
          />
        )}
        {!project && folderPath && (
          <div className="composer__field">
            <label htmlFor={`${id}-folder`}>Project folder</label>
            <div className="composer__folder-row">
              <input id={`${id}-folder`} className="text-field" aria-label="Project folder" readOnly value={folderPath} data-tooltip={folderPath} />
              <button className="secondary-button" type="button" disabled={busy || checkingFolder} onClick={() => void onChooseFolder?.()}>Browse…</button>
            </div>
          </div>
        )}
        <div className="composer__field">
          <label htmlFor={`${id}-name`}>Project name</label>
          <input id={`${id}-name`} ref={nameInput} className="text-field" disabled={busy} value={name} onChange={(event) => setName(event.target.value)} aria-label="Project name" />
        </div>
        <div className="composer__grid">
          <div className="composer__field">
            <label htmlFor={`${id}-aspect`}>Aspect Ratio</label>
            <select id={`${id}-aspect`} disabled={busy} value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value as AspectRatio)}>
              <option value="16:9">Widescreen 16:9</option>
              <option value="9:16">Vertical 9:16</option>
              <option value="1:1">Square 1:1</option>
              <option value="4:5">Portrait 4:5</option>
            </select>
          </div>
          {/* The real pixels, not a name for them. Every rung is a multiple
              of 32 on both edges — what MiniMax H3 generates at — and they
              are relabelled when the shape above changes, because 768p is
              1376×768 widescreen and 768×1376 vertical. */}
          <div className="composer__field">
            <label htmlFor={`${id}-resolution`}>Resolution</label>
            <select id={`${id}-resolution`} disabled={busy} value={resolution} onChange={(event) => setResolution(event.target.value as Resolution)}>
              {resolutions.map((option) => {
                const { width, height } = outputDimensions(option, aspectRatio);
                return <option key={option} value={option}>{width} × {height}{option === DEFAULT_RESOLUTION ? " (default)" : ""}</option>;
              })}
            </select>
          </div>
          <div className="composer__field">
            <label htmlFor={`${id}-look`}>Look</label>
            <select id={`${id}-look`} aria-label="Look" disabled={busy} value={defaultLook} onChange={(event) => setDefaultLook(event.target.value)}>
              <option value="">None</option>
              {LOOKS.map((look) => <option key={look.id} value={look.id}>{look.label}</option>)}
            </select>
          </div>
        </div>
        {message && <InfoBar severity="error" title={folderError ? "Choose another folder" : project ? "Couldn’t save" : "Couldn’t create the project"} message={message} />}
      </div>
    </ContentDialog>
  );
}
