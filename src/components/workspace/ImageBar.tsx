import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { ProjectAsset } from "../../lib/project";
import { Edit11, Image24 } from "../ui/icons";
import { ReferenceImage } from "./ReferenceImage";
import "../../styles/image-editor.css";

/* The strip of an image project's images along the foot of the Editor and the
   Export tab: one thumbnail per image, the selected one ringed in accent, a
   draft badged. The mouse wheel scrolls it sideways, and a new image scrolls
   into view at the end; the arrow keys step through it. `onMenu` opens a
   context menu for an image (id) or for the bar (null) at a point; without it
   the bar has no menu. */
export const ImageBar = forwardRef<HTMLDivElement | null, {
  images: ProjectAsset[];
  selectedId: string | null | undefined;
  folderPath: string;
  onSelect: (id: string) => void;
  onMenu?: (id: string | null, x: number, y: number) => void;
}>(function ImageBar({ images, selectedId, folderPath, onSelect, onMenu }, ref) {
  const bar = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => bar.current as HTMLDivElement);

  const previousCount = useRef(images.length);
  useLayoutEffect(() => {
    const element = bar.current;
    if (element && images.length > previousCount.current) element.scrollLeft = element.scrollWidth;
    previousCount.current = images.length;
  }, [images.length]);
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || element.scrollWidth <= element.clientWidth) return;
      event.preventDefault();
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      element.scrollLeft += delta * unit;
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [images.length]);

  /* Left and Right step the focus along the thumbnails, Home and End jump to
     either end, and the bar scrolls to keep the focused one in view. Moving
     the focus does not open the image: Enter or Space does, as a click. From
     the bar itself, the first step lands on the selected thumbnail. */
  const arrowKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return false;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-image-asset]")];
    if (buttons.length === 0) return false;
    event.preventDefault();
    event.stopPropagation();
    const at = buttons.indexOf(event.target as HTMLButtonElement);
    const selected = Math.max(0, buttons.findIndex((button) => button.getAttribute("aria-pressed") === "true"));
    const next = event.key === "Home" ? 0
      : event.key === "End" ? buttons.length - 1
        : at < 0 ? selected
          : Math.min(buttons.length - 1, Math.max(0, at + (event.key === "ArrowRight" ? 1 : -1)));
    buttons[next].focus();
    buttons[next].scrollIntoView?.({ block: "nearest", inline: "nearest" });
    return true;
  };

  const menuKey = (event: KeyboardEvent) => event.key === "ContextMenu" || (event.shiftKey && event.key === "F10");

  return <div ref={bar} tabIndex={0} className="image-results" aria-label="Generated images"
    onContextMenu={onMenu && ((event) => { event.preventDefault(); onMenu(null, event.clientX, event.clientY); })}
    onKeyDown={(event) => {
      if (arrowKey(event)) return;
      if (!onMenu || event.target !== event.currentTarget || !menuKey(event)) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onMenu(null, bounds.left, bounds.top);
    }}>
    {images.map((asset) => <button key={asset.id} type="button" data-image-asset={asset.id} data-tooltip={asset.name} aria-label={`View ${asset.name}`} aria-pressed={asset.id === selectedId}
      onContextMenu={onMenu && ((event) => { event.preventDefault(); event.stopPropagation(); onMenu(asset.id, event.clientX, event.clientY); })}
      onKeyDown={onMenu && ((event) => {
        if (!menuKey(event)) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onMenu(asset.id, bounds.left, bounds.bottom);
      })}
      onClick={() => onSelect(asset.id)}>
      {asset.relativePath || asset.sourcePath ? <ReferenceImage folderPath={folderPath} relativePath={asset.relativePath} sourcePath={asset.sourcePath} alt={asset.name} /> : <Image24 aria-hidden="true" />}
      {asset.imageDraft && <span className="image-draft-badge"><Edit11 aria-hidden="true" />{asset.imageGeneration?.scene.rootType === "image" ? "Editing" : "Draft"}</span>}
    </button>)}
  </div>;
});
