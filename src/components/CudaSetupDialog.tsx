import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import type { CudaDownload } from "../lib/cudaSupport";
import { ContentDialog, InfoBar } from "./ui";

/* Shown once at startup when an NVIDIA card is present but no usable CUDA is.
   [Download CUDA] opens NVIDIA's page in the browser and closes the dialog;
   [Continue with Vulkan] (and Esc) just closes it. If the browser cannot be
   opened the dialog stays, with the reason, and the link as text. */
export function CudaSetupDialog({ download, onContinue }: { download: CudaDownload; onContinue: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const cuda = download.version === "12.8" ? "CUDA 12.8" : "CUDA";

  const openDownload = async () => {
    setError(null);
    try {
      await invoke("open_cuda_download", { version: download.version });
      onContinue();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <ContentDialog
      title="Install CUDA for faster generation"
      primaryText={`Download ${cuda}`}
      onPrimary={() => void openDownload()}
      closeText="Continue with Vulkan"
      onClose={onContinue}
      defaultButton="primary"
    >
      <p>Slopus found your {download.gpuName} but no usable CUDA installation.</p>
      <p>Slopus can use the Vulkan fallback backend, with longer generation times. For faster generation, install {cuda} from NVIDIA and restart Slopus.</p>
      {error && <InfoBar severity="error" title="Couldn’t open the browser" message={<>{error} Go to <span className="dialog-path">{download.url}</span></>} />}
    </ContentDialog>
  );
}
