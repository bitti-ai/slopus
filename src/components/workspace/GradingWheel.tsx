import { useRef, type PointerEvent } from "react";

export function GradingWheel({ label, x, y, disabled, onChange }: { label: string; x: number; y: number; disabled: boolean; onChange: (x: number, y: number) => void }) {
  const dragging = useRef(false);
  const set = (nextX: number, nextY: number) => {
    if (disabled) return;
    const radius = Math.max(1, Math.hypot(nextX, nextY));
    onChange(nextX / radius, nextY / radius);
  };
  const point = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    set((event.clientX - bounds.left) / bounds.width * 2 - 1, 1 - (event.clientY - bounds.top) / bounds.height * 2);
  };
  return <div className="grading-wheel" role="slider" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={`${label} color`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(Math.hypot(x, y) * 100)}
    aria-valuetext={`Horizontal ${Math.round(x * 100)}, vertical ${Math.round(y * 100)}`} title="Drag to tint. Arrow keys adjust; Home resets color."
    onPointerDown={(event) => { if (disabled || event.button !== 0) return; dragging.current = true; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.focus(); point(event); }}
    onPointerMove={(event) => { if (dragging.current) point(event); }} onPointerUp={() => { dragging.current = false; }} onPointerCancel={() => { dragging.current = false; }} onLostPointerCapture={() => { dragging.current = false; }}
    onDoubleClick={() => set(0, 0)} onKeyDown={(e) => {
      const step = e.shiftKey ? .1 : .02;
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(e.key)) {
        e.preventDefault(); e.stopPropagation();
        if (e.key === "Home") set(0, 0);
        else set(x + (e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0), y + (e.key === "ArrowUp" ? step : e.key === "ArrowDown" ? -step : 0));
      }
    }}>
    <span className="grading-wheel__center" />
    <span className="grading-wheel__handle" style={{ left: `${(x + 1) * 50}%`, top: `${(1 - y) * 50}%` }} />
  </div>;
}
