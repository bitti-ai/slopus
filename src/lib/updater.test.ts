import { describe, expect, it, vi } from "vitest";
import type { DownloadEvent } from "@tauri-apps/plugin-updater";
import { AppUpdater } from "./updater";

function setup(enabled = true) {
  const update = {
    version: "0.2.0", body: "A better editor",
    download: vi.fn(async (_listener?: (event: DownloadEvent) => void) => {}),
    install: vi.fn(async () => {}), close: vi.fn(async () => {}),
  };
  const dependencies = { enabled: vi.fn(async () => enabled), check: vi.fn(async () => update as typeof update | null), relaunch: vi.fn(async () => {}) };
  return { updater: new AppUpdater(dependencies), update, dependencies };
}

describe("app updates", () => {
  it("checks once on startup and waits for explicit installation", async () => {
    const { updater, update, dependencies } = setup();
    await Promise.all([updater.start(), updater.start()]);
    expect(dependencies.check).toHaveBeenCalledTimes(1);
    expect(updater.getSnapshot()).toMatchObject({ stage: "available", version: "0.2.0", notes: "A better editor" });
    expect(update.download).not.toHaveBeenCalled();
    expect(dependencies.relaunch).not.toHaveBeenCalled();
  });

  it("does not check in a browser, debug build or portable distribution", async () => {
    const { updater, dependencies } = setup(false);
    await updater.start();
    await updater.check();
    expect(dependencies.check).not.toHaveBeenCalled();
    expect(updater.getSnapshot().stage).toBe("disabled");
  });

  it("reports no update and releases old native resources when checking again", async () => {
    const { updater, update, dependencies } = setup();
    await updater.start();
    dependencies.check.mockResolvedValueOnce(null);
    await updater.check();
    expect(update.close).toHaveBeenCalledOnce();
    expect(updater.getSnapshot()).toMatchObject({ stage: "current", version: null, notes: "" });
  });

  it("recovers from an offline check", async () => {
    const { updater, dependencies } = setup();
    dependencies.check.mockRejectedValueOnce(new Error("Offline"));
    await updater.start();
    expect(updater.getSnapshot().error).toContain("Offline");
    await updater.check();
    expect(updater.getSnapshot()).toMatchObject({ stage: "available", error: null });
  });

  it("blocks installation while a project or background work needs attention", async () => {
    const { updater, update } = setup();
    await updater.start();
    await updater.install(() => "Save your work first.");
    expect(update.download).not.toHaveBeenCalled();
    expect(updater.getSnapshot().error).toBe("Save your work first.");
  });

  it("tracks downloads and installs before restarting, ignoring concurrent actions", async () => {
    const { updater, update, dependencies } = setup();
    await updater.start();
    update.download.mockImplementationOnce(async (listener) => {
      listener?.({ event: "Started", data: { contentLength: 100 } });
      listener?.({ event: "Progress", data: { chunkLength: 40 } });
      listener?.({ event: "Progress", data: { chunkLength: 60 } });
      expect(updater.getSnapshot()).toMatchObject({ stage: "downloading", downloaded: 100, total: 100 });
      await updater.check();
      await updater.install(() => null);
      expect(update.install).not.toHaveBeenCalled();
    });
    await updater.install(() => null);
    expect(update.download).toHaveBeenCalledOnce();
    expect(dependencies.check).toHaveBeenCalledOnce();
    expect(update.install).toHaveBeenCalledOnce();
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(dependencies.relaunch.mock.invocationCallOrder[0]);
    expect(updater.getSnapshot().stage).toBe("restart");
  });

  it("rechecks work before launching the installer", async () => {
    const { updater, update, dependencies } = setup();
    await updater.start();
    const guard = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue("Work started during download.");
    await updater.install(guard);
    expect(update.install).not.toHaveBeenCalled();
    expect(dependencies.relaunch).not.toHaveBeenCalled();
    expect(updater.getSnapshot()).toMatchObject({ stage: "available", error: "Work started during download." });
  });

  it("never installs or restarts on a download or signature verification failure", async () => {
    const { updater, update, dependencies } = setup();
    await updater.start();
    update.download.mockRejectedValueOnce(new Error("Invalid signature"));
    await updater.install(() => null);
    expect(update.install).not.toHaveBeenCalled();
    expect(dependencies.relaunch).not.toHaveBeenCalled();
    expect(updater.getSnapshot()).toMatchObject({ stage: "available", error: "Invalid signature" });
    await updater.install(() => null);
    expect(update.install).toHaveBeenCalledOnce();
  });

  it("allows restart retry without reinstalling an already installed update", async () => {
    const { updater, update, dependencies } = setup();
    await updater.start();
    dependencies.relaunch.mockRejectedValueOnce(new Error("Restart failed"));
    await updater.install(() => null);
    expect(updater.getSnapshot()).toMatchObject({ stage: "restart", error: "Restart failed" });
    await updater.restart(() => null);
    expect(update.install).toHaveBeenCalledOnce();
    expect(dependencies.relaunch).toHaveBeenCalledTimes(2);
    expect(updater.getSnapshot().error).toBeNull();
  });
});
