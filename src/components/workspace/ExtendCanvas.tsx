import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { alignExtendBounds, extendSourceDimensions, EXTEND_GRID, EXTEND_MAX_EDGE, EXTEND_MAX_PIXELS, type ExtendBounds } from "../../lib/extendImage";
import type { ProjectAsset } from "../../lib/project";
import { ReferenceImage } from "./ReferenceImage";

function cameraFor(width: number, height: number, box: ExtendBounds) {
  const valid = Object.values(box).every(Number.isFinite) && box.width > 0 && box.height > 0;
  const left = Math.min(0, valid ? box.x : 0), top = Math.min(0, valid ? box.y : 0);
  const right = Math.max(width, valid ? box.x + box.width : width), bottom = Math.max(height, valid ? box.y + box.height : height);
  const margin = Math.max(width, height, right - left, bottom - top) * 0.2;
  return { x: left - margin, y: top - margin, width: right - left + margin * 2, height: bottom - top + margin * 2 };
}
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
const SNAP_DISTANCE = 6; // CSS pixels, independent of the image/canvas scale.

function snapAxis(start: number, size: number, sourceSize: number, tolerance: number, move: boolean, leading: boolean, trailing: boolean, maxSize: number) {
  const nearest = (deltas: number[]) => deltas.filter((delta) => Math.abs(delta) <= tolerance)
    .sort((a, b) => Math.abs(a) - Math.abs(b))[0] ?? 0;
  if (move) {
    // Translate the whole box to the closest border without changing its size.
    const delta = nearest([0, sourceSize].flatMap((edge) => [edge - start, edge - start - size])
      .filter((delta) => Math.abs(start + delta) <= 8192));
    return [start + delta, size];
  }
  let end = start + size;
  if (leading) start += nearest([0, sourceSize].map((edge) => edge - start)
    .filter((delta) => end - start - delta >= EXTEND_GRID && end - start - delta <= maxSize && (end - start - delta) % EXTEND_GRID === 0));
  if (trailing) end += nearest([0, sourceSize].map((edge) => edge - end)
    .filter((delta) => end + delta - start >= EXTEND_GRID && end + delta - start <= maxSize && (end + delta - start) % EXTEND_GRID === 0));
  return [start, end - start];
}

export function ExtendCanvas({ source, folderPath, bounds, onChange, disabled }: {
  source: ProjectAsset; folderPath: string; bounds: ExtendBounds; onChange: (bounds: ExtendBounds) => void; disabled: boolean;
}) {
  const { width, height } = extendSourceDimensions(source.width!, source.height!);
  const [camera, setCamera] = useState(() => cameraFor(width, height, bounds));
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; box: ExtendBounds; mode: string } | null>(null);
  useEffect(() => { if (!dragging) setCamera(cameraFor(width, height, bounds)); }, [bounds, width, height, dragging]);
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(camera.x + (event.clientX - rect.left) / rect.width * camera.width),
      y: Math.round(camera.y + (event.clientY - rect.top) / rect.height * camera.height) };
  };
  const snapPoint = (event: PointerEvent<SVGSVGElement>, at: { x: number; y: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const snap = (value: number, edge: number, tolerance: number) => [0, edge]
      .filter((border) => Math.abs(value - border) <= tolerance).sort((a, b) => Math.abs(a - value) - Math.abs(b - value))[0] ?? value;
    return { x: snap(at.x, width, SNAP_DISTANCE * camera.width / rect.width), y: snap(at.y, height, SNAP_DISTANCE * camera.height / rect.height) };
  };
  const finish = (event: PointerEvent<SVGSVGElement>, cancel = false) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    if (cancel) onChange(drag.current.box);
    drag.current = null; setDragging(false);
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const valid = Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0;
  const box = valid ? bounds : { x: 0, y: 0, width, height };
  const left = Math.max(0, box.x), top = Math.max(0, box.y), right = Math.min(width, box.x + box.width), bottom = Math.min(height, box.y + box.height);
  const outline = `M${box.x},${box.y}h${box.width}v${box.height}h${-box.width}Z`;
  const hole = right > left && bottom > top ? `M${left},${top}h${right - left}v${bottom - top}h${left - right}Z` : "";
  const handleSize = Math.max(camera.width, camera.height) / 65;
  return <div className="image-viewport extend-viewport">
    <div className="image-frame extend-frame" style={{ "--image-ratio": camera.width / camera.height, "--image-zoom": 1, "--image-pan-x": "0px", "--image-pan-y": "0px" } as CSSProperties}>
      <div className="extend-source" style={{ left: `${-camera.x / camera.width * 100}%`, top: `${-camera.y / camera.height * 100}%`, width: `${width / camera.width * 100}%`, height: `${height / camera.height * 100}%` }}>
        <ReferenceImage folderPath={folderPath} relativePath={source.relativePath} sourcePath={source.sourcePath} alt={source.name} />
      </div>
      <svg className="extend-overlay" viewBox={`${camera.x} ${camera.y} ${camera.width} ${camera.height}`} aria-label="Extend bounding box tool" aria-disabled={disabled}
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          let at = point(event); if (!Number.isFinite(at.x + at.y)) return;
          event.preventDefault();
          event.currentTarget.querySelector<SVGElement>('[data-handle="move"]')?.focus();
          const mode = (event.target as Element).getAttribute("data-handle") ?? "draw";
          if (mode === "draw") at = snapPoint(event, at);
          drag.current = { pointerId: event.pointerId, ...at, box: { ...box }, mode };
          setDragging(true); event.currentTarget.setPointerCapture?.(event.pointerId);
        }} onPointerMove={(event) => {
          const start = drag.current; if (!start || disabled || start.pointerId !== event.pointerId) return;
          const at = start.mode === "draw" ? snapPoint(event, point(event)) : point(event), dx = at.x - start.x, dy = at.y - start.y;
          if (!Number.isFinite(dx + dy)) return;
          let { x, y, width: w, height: h } = start.box;
          if (start.mode === "move") { x += dx; y += dy; }
          else if (start.mode === "draw") { x = Math.min(start.x, at.x); y = Math.min(start.y, at.y); w = Math.max(1, Math.abs(dx)); h = Math.max(1, Math.abs(dy)); }
          else {
            if (start.mode.includes("e")) w = Math.max(1, w + dx);
            if (start.mode.includes("s")) h = Math.max(1, h + dy);
            if (start.mode.includes("w")) { x = Math.min(x + dx, x + w - 1); w += start.box.x - x; }
            if (start.mode.includes("n")) { y = Math.min(y + dy, y + h - 1); h += start.box.y - y; }
          }
          const aligned = alignExtendBounds({ x, y, width: w, height: h }, start.mode);
          ({ x, y, width: w, height: h } = aligned);
          const rect = event.currentTarget.getBoundingClientRect();
          const move = start.mode === "move", draw = start.mode === "draw";
          [x, w] = snapAxis(Math.max(-8192, Math.min(8192, x)), w, width,
            SNAP_DISTANCE * camera.width / rect.width, move, draw || start.mode.includes("w"), draw || start.mode.includes("e"), Math.min(EXTEND_MAX_EDGE, EXTEND_MAX_PIXELS / h));
          [y, h] = snapAxis(Math.max(-8192, Math.min(8192, y)), h, height,
            SNAP_DISTANCE * camera.height / rect.height, move, draw || start.mode.includes("n"), draw || start.mode.includes("s"), Math.min(EXTEND_MAX_EDGE, EXTEND_MAX_PIXELS / w));
          onChange({ x, y, width: w, height: h });
        }} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)} onLostPointerCapture={(event) => finish(event)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !drag.current) return;
          event.preventDefault();
          const start = drag.current; drag.current = null; setDragging(false); onChange(start.box);
          if (event.currentTarget.hasPointerCapture?.(start.pointerId)) event.currentTarget.releasePointerCapture(start.pointerId);
        }}>
        <path className="extend-excluded" d={`M0,0h${width}v${height}h${-width}Z` + hole} fillRule="evenodd" pointerEvents="none" />
        <path className="extend-generated" d={outline + hole} fillRule="evenodd" pointerEvents="none" />
        <rect className="extend-original" x="0" y="0" width={width} height={height} vectorEffect="non-scaling-stroke" pointerEvents="none" />
        <rect className="extend-box" {...box} data-handle="move" vectorEffect="non-scaling-stroke" role="button" tabIndex={disabled ? -1 : 0} aria-label="Move Extend box"
          onKeyDown={(event) => {
            if (disabled || !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault(); const step = event.shiftKey ? 10 : 1;
            onChange({ ...box, x: box.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0), y: box.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
          }} />
        {handles.map((handle) => <rect key={handle} className="extend-handle" data-handle={handle} style={{ cursor: `${handle}-resize` }}
          x={(handle.includes("w") ? box.x : handle.includes("e") ? box.x + box.width : box.x + box.width / 2) - handleSize / 2}
          y={(handle.includes("n") ? box.y : handle.includes("s") ? box.y + box.height : box.y + box.height / 2) - handleSize / 2}
          width={handleSize} height={handleSize} vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
  </div>;
}
