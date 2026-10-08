import { useEffect, useState } from "react";
import { usePaneSize } from "../components/ui";

export const agentPaneMax = (windowWidth: number) => Math.max(280, Math.min(640, Math.round(windowWidth * 0.35)));

export function useAgentPane(key: string) {
  const [width, setWidth] = useState(() => typeof window === "undefined" ? 1280 : window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return usePaneSize(key, 360, { min: 280, max: agentPaneMax(width) });
}
