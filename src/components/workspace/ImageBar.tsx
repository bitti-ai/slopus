import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { imageFamily, imageFamilyRoot } from "../../lib/imageHistory";
import type { ProjectAsset } from "../../lib/project";
import { ChevronLeft16, Edit11, Image24 } from "../ui/icons";
import { ReferenceImage } from "./ReferenceImage";
import "../../styles/image-editor.css";

/* The strip of an image project's images along the foot of the Editor and the
   Export tab: one thumbnail per image, the selected one ringed in accent, a
   draft badged. The mouse wheel scrolls it sideways, and a new image scrolls
   into view at the end; the arrow keys step through it. `onMenu` opens a
   context menu for an image (id) or for the bar (null) at a point, and says
   whether the bar is showing a family; without it the bar has no menu.

   An image regenerated or edited from another joins that image's family. The
   bar lists the primary images; while an image with a family is selected it
   shows just that family — the primary first, then the other versions — with
   a back button at its leading edge that returns to all primary images. */
export const ImageBar = forwardRef<HTMLDivElement | null, {
  images: ProjectAsset[];
  selectedId: string | null | undefined;
  folderPath: string;
  onSelect: (id: string) => void;
  onMenu?: (id: string | null, x: number, y: number, inFamily: boolean) => void;
}>(function ImageBar({ images, selectedId, folderPath, onSelect, onMenu }, ref) {
  const bar = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => bar.current as HTMLDivElement);

  const root = imageFamilyRoot(images, selectedId);
  const family = imageFamily(images, selectedId);
  // Selecting an image opens its family; Back shows the primaries until the
  // next selection.
  const [showAll, setShowAll] = useState(false);
  useEffect(() => setShowAll(false), [selectedId]);
  const inFamily = !showAll && family.length > 1;
  const primaries = images.filter((asset) => imageFamilyRoot(images, asset.id) === asset.id);
  const shown = inFamily ? family : primaries;
  const pressed = inFamily ? selectedId : root;
  const childCount = (id: string) => images.filter((asset) => asset.id !== id && imageFamilyRoot(images, asset.id) === id).length;

  const previousCount = useRef(shown.length);
  useLayoutEffect(() => {
    const element = bar.current;
    if (element && shown.length > previousCount.current) element.scrollLeft = element.scrollWidth;
    previousCount.current = shown.length;
  }, [shown.length]);
  useLayoutEffect(() => {
    const selected = [...(bar.current?.querySelectorAll<HTMLElement>("[data-image-asset]") ?? [])].find((element) => element.dataset.imageAsset === pressed);
    selected?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pressed, inFamily]);
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
  }, [shown.length]);

  /* The platform's overlay scrollbar appears for a moving pointer, not for a
     scroll made in code — which is what the wheel above is — so the bar is
     marked while it scrolls, by any means, and draws its own scrollbar then. */
  useEffect(() => {
    const element = bar.current;
    if (!element) return;
    let timer = 0;
    const scroll = () => {
      element.classList.add("image-results--scrolling");
      window.clearTimeout(timer);
      timer = window.setTimeout(() => element.classList.remove("image-results--scrolling"), 900);
    };
    element.addEventListener("scroll", scroll, { passive: true });
    return () => { element.removeEventListener("scroll", scroll); window.clearTimeout(timer); };
  }, []);

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
    onContextMenu={onMenu && ((event) => { event.preventDefault(); onMenu(null, event.clientX, event.clientY, inFamily); })}
    onKeyDown={(event) => {
      if (arrowKey(event)) return;
      if (!onMenu || event.target !== event.currentTarget || !menuKey(event)) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onMenu(null, bounds.left, bounds.top, inFamily);
    }}>
    {inFamily && <button type="button" className="image-results__back" aria-label="Back to all images" data-tooltip="All images"
      onClick={() => { setShowAll(true); bar.current?.focus(); }}><ChevronLeft16 aria-hidden="true" /></button>}
    {shown.map((asset) => <button key={asset.id} type="button" data-image-asset={asset.id} data-tooltip={asset.name}
      aria-label={`View ${asset.name}${!inFamily && childCount(asset.id) ? `, ${childCount(asset.id) + 1} versions` : ""}`} aria-pressed={asset.id === pressed}
      onContextMenu={onMenu && ((event) => { event.preventDefault(); event.stopPropagation(); onMenu(asset.id, event.clientX, event.clientY, inFamily); })}
      onKeyDown={onMenu && ((event) => {
        if (!menuKey(event)) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        onMenu(asset.id, bounds.left, bounds.bottom, inFamily);
      })}
      onClick={() => { setShowAll(false); onSelect(asset.id); }}>
      {asset.relativePath || asset.sourcePath ? <ReferenceImage folderPath={folderPath} relativePath={asset.relativePath} sourcePath={asset.sourcePath} alt={asset.name} /> : <Image24 aria-hidden="true" />}
      {!inFamily && childCount(asset.id) > 0 && <span className="image-family-badge" aria-hidden="true">{childCount(asset.id) + 1}</span>}
      {asset.imageDraft && <span className="image-draft-badge"><Edit11 aria-hidden="true" />{asset.imageGeneration?.scene.rootType === "image" ? "Editing" : "Draft"}</span>}
    </button>)}
  </div>;
});
