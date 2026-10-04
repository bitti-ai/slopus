import { useEffect, useState } from "react";
import { referenceTypeLabel, type ProjectReference } from "../../lib/project";
import { referenceMediaTypes, selectReferences, type ReferenceMediaType } from "../../lib/referenceSelection";
import { Audio16, ChevronDown14, Image16, Text16, Video16 } from "../ui/icons";
import { ReferenceIcon } from "./ReferenceIcon";
import { ReferencePicker } from "./ReferencePicker";

/** `accept={["image"]}`, `["audio"]`, or `["image", "audio"]` constrain the
 * same searchable picker used by prompt chips; selection stores a reference ID. */
export function ReferenceSelector({ id, value, references, accept, folderPath, disabled, onChange, "aria-label": label }: {
  id?: string; value: string; references: readonly ProjectReference[]; accept: readonly ReferenceMediaType[]; folderPath: string;
  disabled?: boolean; onChange: (id: string) => void; "aria-label": string;
}) {
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  useEffect(() => { if (disabled) setAnchor(null); }, [disabled]);
  const selected = selectReferences(references, accept).find((reference) => reference.id === value);
  const name = selected?.name ?? (value ? references.find((reference) => reference.id === value)?.name ?? "Unavailable reference" : "None");
  const choose = (next: string) => { anchor?.focus(); setAnchor(null); onChange(next); };
  const icon = (reference: ProjectReference) => <ReferenceIcon reference={reference} folderPath={folderPath}
    fallback={reference.kind === "audio" ? <Audio16 /> : reference.kind === "video" ? <Video16 /> : referenceMediaTypes(reference).includes("image") ? <Image16 /> : <Text16 />} />;
  return <>
    <button id={id} type="button" className={`reference-selector${value && !selected ? " reference-selector--missing" : ""}`} aria-label={label} aria-haspopup="dialog"
      aria-expanded={!disabled && Boolean(anchor)} disabled={disabled} data-value={value}
      onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}>
      {selected && <span className="reference-selector__icon" aria-hidden="true">{icon(selected)}</span>}
      <span className="reference-selector__name">{name}</span><ChevronDown14 aria-hidden="true" />
    </button>
    <ReferencePicker anchor={disabled ? null : anchor} title={label} current={value || null} currentLabel={name} accept={accept} allowEmpty clearLabel="None"
      references={references.map((reference) => ({ id: reference.id, name: reference.name, detail: referenceTypeLabel(reference), mediaTypes: referenceMediaTypes(reference),
        icon: icon(reference) }))}
      emptyLabel="No matching references — add them under References."
      onChoose={(reference) => choose(reference.id)} onRemove={() => choose("")} onClose={() => setAnchor(null)} />
  </>;
}
