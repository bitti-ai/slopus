import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it } from 'vitest';
import { createGeneratorTemplate } from '../src/lib/settings';
import { checkDownloadUrl, generationDownloads } from './release-downloads';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
  }));
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  return `http://127.0.0.1:${address.port}/file`;
}

it('follows redirects and checks large files using HEAD without a GET', async () => {
  const methods: string[] = [];
  const url = await serve((request, response) => {
    methods.push(request.method!);
    if (request.url === '/redirect') response.writeHead(302, { Location: '/file' });
    else response.writeHead(200, { 'Content-Length': '15000000000', 'Content-Type': 'application/octet-stream' });
    response.end();
  });
  await checkDownloadUrl(url.replace('/file', '/redirect'));
  expect(methods).toEqual(['HEAD', 'HEAD']);
});

it.each([
  [404, {}, 'HTTP 404'],
  [403, {}, 'HTTP 403'],
  [200, { 'Content-Length': '100', 'Content-Type': 'text/html' }, 'HTML page'],
  [200, { 'Content-Length': '0' }, 'empty file'],
] as const)('rejects inaccessible, HTML and empty files (%s)', async (status, headers, message) => {
  let requests = 0;
  const url = await serve((_request, response) => {
    requests++;
    response.writeHead(status, headers);
    response.end();
  });
  await expect(checkDownloadUrl(url)).rejects.toThrow(message);
  expect(requests).toBe(1);
});

it.each([405, 501, 200])('requests one byte when HEAD is unsupported or has no size (%s)', async (headStatus) => {
  const requests: Array<[string, string | undefined]> = [];
  const url = await serve((request, response) => {
    requests.push([request.method!, request.headers.range]);
    if (request.method === 'HEAD') { response.writeHead(headStatus); response.end(); }
    else {
      response.writeHead(206, { 'Content-Range': 'bytes 0-0/15000000000', 'Content-Length': '1' });
      response.end('x');
    }
  });
  await checkDownloadUrl(url);
  expect(requests).toEqual([['HEAD', undefined], ['GET', 'bytes=0-0']]);
});

it('cancels a streaming response when the server ignores Range', async () => {
  let sent = 0;
  let markClosed!: () => void;
  const closed = new Promise<void>((resolve) => { markClosed = resolve; });
  const url = await serve((request, response) => {
    if (request.method === 'HEAD') { response.writeHead(405); response.end(); return; }
    response.writeHead(200, { 'Content-Length': '15000000000' });
    const send = () => { sent += 1024; response.write(Buffer.alloc(1024)); };
    send();
    const timer = setInterval(send, 10);
    response.on('close', () => { clearInterval(timer); markClosed(); });
  });
  await checkDownloadUrl(url);
  await closed;
  expect(sent).toBeGreaterThan(0);
  expect(sent).toBeLessThan(15_000_000_000);
});

it('rejects an empty streamed response even when the size is unknown', async () => {
  const url = await serve((_request, response) => { response.writeHead(200); response.end(); });
  await expect(checkDownloadUrl(url)).rejects.toThrow('empty file');
});

it.each([429, 503])('retries a transient HTTP error once (%s)', async (status) => {
  let requests = 0;
  const url = await serve((_request, response) => {
    requests++;
    response.writeHead(requests === 1 ? status : 200, { 'Content-Length': '1024' });
    response.end();
  });
  await checkDownloadUrl(url, { retryDelayMs: 0 });
  expect(requests).toBe(2);
});

it('blocks a release when a server error persists after the retry', async () => {
  let requests = 0;
  const url = await serve((_request, response) => {
    requests++;
    response.writeHead(503);
    response.end();
  });
  await expect(checkDownloadUrl(url, { retryDelayMs: 0 })).rejects.toThrow(`${url}: HTTP 503`);
  expect(requests).toBe(2);
});

it('fails with the URL after bounded timeouts instead of hanging a release', async () => {
  const url = await serve(() => {});
  await expect(checkDownloadUrl(url, { timeoutMs: 30, retryDelayMs: 0 })).rejects.toThrow(`${url}: Timed out`);
});

it('collects all variants, conditioning files and LoRAs, deduplicating normalized URLs', () => {
  const template = createGeneratorTemplate('Fixture');
  template.paths.transformer = 'https://huggingface.co/owner/model/blob/main/model.safetensors';
  template.sources = { transformer: [
    { url: template.paths.transformer.replace('/blob/', '/resolve/'), gpuModel: '', minVramGb: 24 },
    { url: 'https://example.com/small.safetensors', gpuModel: '', minVramGb: 0 },
  ] };
  template.additionalSafetensors = [{ id: 'conditioning', name: 'Conditioning', url: 'https://example.com/conditioning.safetensors' }];
  template.loras = [{ loraId: 'adapter', enabled: false, strength: 0 }];
  const loras = [
    { id: 'adapter', name: 'Adapter', path: '', url: 'https://example.com/adapter.safetensors' },
    { id: 'optional', name: 'Optional', path: '', url: 'https://example.com/optional.safetensors' },
  ];
  const downloads = generationDownloads([template], loras);
  expect(downloads.map(({ url }) => url)).toEqual([
    template.paths.transformer.replace('/blob/', '/resolve/'),
    'https://example.com/small.safetensors',
    'https://example.com/conditioning.safetensors',
    loras[0].url, loras[1].url,
  ]);
  expect(downloads[0].labels).toContain('transformer variant');
  expect(() => generationDownloads([template], [])).toThrow('missing bundled LoRA URL');
});
