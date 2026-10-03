import { describe, expect, it } from "vitest";
import { fileManagerName, hostPlatform, runtimeLocationHint } from "./platform";

const WEBVIEW2 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0";
const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

describe("hostPlatform", () => {
  it("tells WebView2 from WebKitGTK", () => {
    expect(hostPlatform(WEBVIEW2)).toBe("windows");
    expect(hostPlatform(WEBKITGTK)).toBe("linux");
    expect(hostPlatform("")).toBe("windows");
  });

  it("names the file manager and runtime for each platform", () => {
    expect(fileManagerName("windows")).toBe("File Explorer");
    expect(fileManagerName("linux")).toBe("Files");
    expect(runtimeLocationHint("windows")).toBe("slopfab.dll should be next to Slopus.exe.");
    expect(runtimeLocationHint("linux")).toContain("libslopfab.so");
  });
});
