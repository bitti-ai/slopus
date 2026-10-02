import { describe, expect, it, vi } from "vitest";
import { loadGeneratorTemplateSettings } from "../../src/lib/settings";
import { loadLoras } from "../../src/lib/loras";
import { checkDownloadUrl, generationDownloads } from "../../scripts/release-downloads";

// Read the same fresh-install catalog as the app, independent of machine settings.
vi.stubGlobal('localStorage', { getItem: () => null });
const downloads = generationDownloads(loadGeneratorTemplateSettings().templates, loadLoras());
vi.unstubAllGlobals();

it('has bundled generation downloads to check', () => {
  expect(downloads.length).toBeGreaterThan(0);
});

describe('public generation files', () => {
  it.concurrent.each(downloads)('$labels — $url', async ({ url }) => {
    await checkDownloadUrl(url);
  });
});
