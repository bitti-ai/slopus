import { invoke } from "@tauri-apps/api/core";
import { Info } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CudaDownload } from "../lib/cudaSupport";

export function CudaSetupDialog({ download, onContinue }: { download: CudaDownload; onContinue: () => void }) {
  const dialog = useRef<HTMLDivElement>(null);
  const proceed = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    proceed.current?.focus();
    return () => opener?.focus?.();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        onContinue();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const stops = Array.from(dialog.current.querySelectorAll<HTMLElement>("a[href], button"));
      const first = stops[0], last = stops[stops.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (!event.shiftKey && (active === last || !dialog.current.contains(active))) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && (active === first || !dialog.current.contains(active))) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onContinue]);

  const openDownload = async () => {
    setError(null);
    try {
      await invoke("open_cuda_download", { version: download.version });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return <div className="exit-guard-backdrop">
    <div className="exit-guard" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="cuda-setup-title" aria-describedby="cuda-setup-description">
      <div className="exit-guard__head">
        <span className="exit-guard__mark" aria-hidden="true"><Info size={20} /></span>
        <h2 id="cuda-setup-title">Install CUDA for faster generation</h2>
      </div>
      <div className="exit-guard__body" id="cuda-setup-description">
        <p>Slopus detected your {download.gpuName}, but could not find a usable CUDA installation.</p>
        <p>You can continue using the Vulkan fallback backend, with longer generation times.</p>
        <p>For faster generation, install {download.version === "12.8" ? "CUDA 12.8" : "CUDA"} and restart Slopus.</p>
        <p><a className="cuda-setup-download" href={download.url} target="_blank" rel="noreferrer" onClick={(event) => { event.preventDefault(); void openDownload(); }}>Download {download.version === "12.8" ? "CUDA 12.8" : "CUDA"} from NVIDIA</a></p>
        {error && <p role="alert">{error}</p>}
      </div>
      <div className="exit-guard__actions">
        <button className="primary-button" type="button" ref={proceed} onClick={onContinue}>Continue with Vulkan</button>
      </div>
    </div>
  </div>;
}
