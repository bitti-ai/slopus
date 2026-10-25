import { useRef } from "react";
import { motionOverride, type Motion, type MotionNode } from "../../lib/motion";

/** Editor chrome uses the evaluated positions, while gestures change only
 * persistent offsets/scales. Scripts and original scene elements stay intact. */
export function MotionHandles({ motion, nodes, selectedId, onSelect, onChange }: {
  motion: Motion; nodes: MotionNode[]; selectedId: string | null; onSelect: (id: string) => void; onChange: (motion: Motion) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLSpanElement>(null), horizontal = useRef<HTMLSpanElement>(null), vertical = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ inverse: DOMMatrix; angle: number; id: string; x: number; y: number; width: number; height: number; resize: boolean; initial: Motion } | null>(null);
  return <div ref={root} className="motion-handles" onClick={(e) => e.stopPropagation()}
    onPointerMove={(e) => {
      const g = drag.current; if (!g) return;
      const delta = g.inverse.transformPoint(new DOMPoint(e.clientX - g.x, e.clientY - g.y));
      const dx = delta.x, dy = delta.y;
      const localX = dx * Math.cos(g.angle) + dy * Math.sin(g.angle);
      const localY = -dx * Math.sin(g.angle) + dy * Math.cos(g.angle);
      const edit = motionOverride(g.initial, g.id);
      const next = g.resize ? { ...edit, scale: [Math.max(0.01, edit.scale[0] * (g.width + localX) / (g.width || 1)), Math.max(0.01, edit.scale[1] * (g.height + localY) / (g.height || 1)), edit.scale[2]] as [number, number, number] }
        : { ...edit, offset: [edit.offset[0] + dx, edit.offset[1] + dy, edit.offset[2]] as [number, number, number] };
      next.offset = next.offset.map((v) => Math.round(v * 100) / 100) as [number, number, number];
      next.scale = next.scale.map((v) => Math.round(v * 1000) / 1000) as [number, number, number];
      onChange({ ...g.initial, overrides: { ...g.initial.overrides, [g.id]: next } });
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
    <span ref={origin} style={{ position: "absolute", left: 0, top: 0 }} />
    <span ref={horizontal} style={{ position: "absolute", left: "100%", top: 0 }} />
    <span ref={vertical} style={{ position: "absolute", left: 0, top: "100%" }} />
    {nodes.filter((node) => node.visible && motion.nodes.some((n) => n.id === node.id)).map((node) => <button key={node.id} type="button"
      className={`motion-element${selectedId === node.id ? " is-selected" : ""}`} aria-label={`Select Motion element ${node.name}`}
      style={{ left: `${node.position[0] / motion.width * 100}%`, top: `${node.position[1] / motion.height * 100}%`,
        width: `${Math.abs(node.width * node.scale[0]) / motion.width * 100}%`, height: `${Math.abs(node.height * node.scale[1]) / motion.height * 100}%`, transform: `rotate(${node.rotation[2]}deg) scale(${Math.sign(node.width * node.scale[0]) || 1}, ${Math.sign(node.height * node.scale[1]) || 1})` }}
      onPointerDown={(e) => {
        if (e.button !== 0) return; e.stopPropagation(); e.preventDefault(); onSelect(node.id);
        const o = origin.current!.getBoundingClientRect(), x = horizontal.current!.getBoundingClientRect(), y = vertical.current!.getBoundingClientRect();
        const matrix = new DOMMatrix([(x.x - o.x) / motion.width, (x.y - o.y) / motion.width, (y.x - o.x) / motion.height, (y.y - o.y) / motion.height, 0, 0]);
        if (Math.abs(matrix.a * matrix.d - matrix.b * matrix.c) < 1e-10) return;
        root.current!.setPointerCapture(e.pointerId);
        drag.current = { inverse: matrix.inverse(), angle: node.rotation[2] * Math.PI / 180, id: node.id, x: e.clientX, y: e.clientY, width: node.width * node.scale[0], height: node.height * node.scale[1],
          resize: (e.target as HTMLElement).dataset.resize === "true", initial: motion };
      }}>
      {selectedId === node.id && <span className="motion-resize" data-resize="true" aria-label="Resize Motion element" />}
    </button>)}
  </div>;
}
