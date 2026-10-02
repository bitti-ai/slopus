import type { GeneratorTemplate } from "../src/lib/settings";
import type { Lora } from "../src/lib/loras";

export function downloadUrl(value: string): string {
  const url = new URL(value.trim());
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`Expected a public HTTP(S) file URL: ${value}`);
  }
  // Match the application's download URL normalization.
  if (url.hostname === 'huggingface.co') url.pathname = url.pathname.replace('/blob/', '/resolve/');
  url.hash = '';
  return url.href;
}

export function generationDownloads(templates: GeneratorTemplate[], loras: Lora[]) {
  const downloads = new Map<string, Set<string>>();
  const add = (value: string, label: string) => {
    const url = downloadUrl(value);
    const labels = downloads.get(url) ?? new Set<string>();
    labels.add(label);
    downloads.set(url, labels);
  };
  for (const template of templates) {
    for (const [field, path] of Object.entries(template.paths)) {
      if (/^https?:\/\//i.test(path.trim())) add(path, `${template.name}: ${field}`);
    }
    for (const [field, variants] of Object.entries(template.sources ?? {})) {
      for (const variant of variants ?? []) add(variant.url, `${template.name}: ${field} variant`);
    }
    for (const file of template.additionalSafetensors ?? []) add(file.url, `${template.name}: ${file.name}`);
    for (const selection of template.loras ?? []) {
      const lora = loras.find(({ id }) => id === selection.loraId);
      if (!lora?.url) throw new Error(`${template.name}: missing bundled LoRA URL for ${selection.loraId}`);
      add(lora.url, `${template.name}: ${lora.name}`);
    }
  }
  // Also cover adapters offered in the library, even when no template enables them yet.
  for (const lora of loras) if (lora.url) add(lora.url, `LoRA: ${lora.name}`);
  return [...downloads].map(([url, labels]) => ({ url, labels: [...labels].join('; ') }));
}

class ProbeError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

function checkHeaders(response: Response) {
  if (!response.ok) {
    throw new ProbeError(`HTTP ${response.status}`, response.status === 429 || response.status >= 500);
  }
  const type = response.headers.get('content-type') ?? '';
  if (/text\/html|application\/xhtml\+xml/i.test(type)) throw new ProbeError('URL returned an HTML page instead of a file');
  const size = response.headers.get('content-length');
  if (size !== null && Number(size) === 0) throw new ProbeError('URL returned an empty file');
}

async function probeOnce(url: string, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const head = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: controller.signal });
    try {
      if (head.status !== 405 && head.status !== 501) {
        checkHeaders(head);
        if (Number(head.headers.get('content-length')) > 0) return;
      }
    } finally {
      await head.body?.cancel();
    }
    // HEAD can be unsupported or omit the length. Never buffer a full response,
    // including when a server ignores Range and returns HTTP 200.
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-0', 'Accept-Encoding': 'identity' },
      redirect: 'follow', signal: controller.signal,
    });
    const reader = response.body?.getReader();
    try {
      checkHeaders(response);
      const first = await reader?.read();
      if (!first?.value?.byteLength) throw new ProbeError('URL returned an empty file');
    } finally {
      await reader?.cancel();
    }
  } catch (error) {
    if (controller.signal.aborted) throw new ProbeError(`Timed out after ${timeoutMs} ms`, true);
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export async function checkDownloadUrl(value: string, { timeoutMs = 20_000, retryDelayMs = 500 } = {}) {
  const url = downloadUrl(value);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await probeOnce(url, timeoutMs);
      return;
    } catch (error) {
      if (attempt === 1 || (error instanceof ProbeError && !error.retryable)) {
        throw new Error(`${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
