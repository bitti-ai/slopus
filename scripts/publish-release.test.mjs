import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createManifest } from './updater-manifest.mjs';
import { checkReleaseOrder, publishRelease, releaseFiles } from './publish-release.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('slopus-publish-')) throw new Error('Unexpected temporary path.');
    rmSync(directory, { recursive: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slopus-publish-'));
  directories.push(root);
  mkdirSync(join(root, 'src-tauri'));
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), 'version = "0.2.0"');
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({
    version: '0.2.0', bundle: { createUpdaterArtifacts: true },
    plugins: { updater: { pubkey: 'public key', endpoints: ['https://github.com/bitti-ai/slopus/releases/latest/download/latest.json'] } },
  }));
  const setupPath = join(root, 'artifacts/Slopus-0.2.0-windows-x64-setup.exe');
  const msiPath = join(root, 'artifacts/Slopus-0.2.0-windows-x64.msi');
  for (const path of [setupPath, msiPath]) {
    writeFileSync(path, 'installer');
    writeFileSync(`${path}.sig`, 'signature\n');
  }
  writeFileSync(join(root, 'artifacts/Slopus-0.2.0-windows-x64-portable.zip'), 'zip');
  // Unrelated artifacts and secrets must never be included by a wildcard upload.
  writeFileSync(join(root, 'artifacts/private.key'), 'secret');
  writeFileSync(join(root, 'artifacts/Slopus-0.1.0-windows-x64-setup.exe'), 'old');
  const manifest = createManifest({ version: '0.2.0', arch: 'x64', setupPath, msiPath, notes: 'First line\nSecond line `literal` $(literal)' });
  const manifestPath = join(root, 'artifacts/latest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const state = { releases: [], uploaded: [], dirty: false, sha: 'head', failUpload: false, failManifest: false, corrupt: false, private: false };
  const run = vi.fn((exe, args) => {
    if (exe === 'git') return args[0] === 'status' ? (state.dirty ? ' M file' : '') : 'head';
    if (args[0] === 'api') {
      const path = args[1].replace('repos/bitti-ai/slopus', '');
      if (!path) return JSON.stringify({ private: state.private, permissions: { push: true } });
      if (path === '/git/ref/tags/v0.2.0') return JSON.stringify({ object: { type: 'commit', sha: state.sha } });
      if (path.startsWith('/releases?')) return JSON.stringify([state.releases]);
      if (path.includes('/assets?')) return JSON.stringify([state.uploaded]);
    }
    if (args[0] === 'release' && args[1] === 'create') state.releases.push({ id: 1, tag_name: 'v0.2.0', draft: true, prerelease: false });
    else if (args[0] === 'release' && args[1] === 'upload') {
      if (state.failUpload) throw new Error('Network failed');
      if (state.failManifest && args.some((arg) => basename(arg) === 'latest.json')) throw new Error('Manifest upload failed');
      for (const path of args.slice(3, args.indexOf('--repo'))) {
        const name = basename(path);
        state.uploaded = state.uploaded.filter((asset) => asset.name !== name);
        state.uploaded.push({ name, state: 'uploaded', size: state.corrupt ? 0 : readFileSync(path).length });
      }
    } else if (args[0] !== 'release' || args[1] !== 'edit') throw new Error(`Unexpected command: ${exe} ${args}`);
    return '';
  });
  return { root, manifest, manifestPath, state, run };
}

const mutations = (run) => run.mock.calls.filter(([exe, args]) => exe === 'gh' && args[0] === 'release');
const published = (run) => mutations(run).some(([, args]) => args.includes('--draft=false'));

it('uploads only current artifacts, puts the manifest last, and publishes after verification', () => {
  const { root, run, manifest } = fixture();
  expect(publishRelease(root, { run })).toContain('/releases/tag/v0.2.0');
  const calls = mutations(run);
  expect(calls[0][1]).toContain('--draft');
  expect(calls[0][2]).toBe(manifest.notes);
  const uploads = calls.filter(([, args]) => args[1] === 'upload');
  expect(uploads).toHaveLength(2);
  expect(uploads[0][1]).not.toContain(join(root, 'artifacts/latest.json'));
  expect(uploads[1][1][3]).toBe(join(root, 'artifacts/latest.json'));
  expect(JSON.stringify(uploads)).not.toMatch(/private\.key|0\.1\.0/);
  expect(calls.at(-1)[1]).toEqual(expect.arrayContaining(['--draft=false', '--latest', '--verify-tag']));
});

it('checks prerequisites without creating or uploading a release', () => {
  const { root, run } = fixture();
  publishRelease(root, { run, checkOnly: true });
  expect(mutations(run)).toEqual([]);
});

it.each(['failUpload', 'failManifest', 'corrupt'])('keeps the release in draft when %s occurs', (failure) => {
  const { root, run, state } = fixture();
  state[failure] = true;
  expect(() => publishRelease(root, { run })).toThrow();
  expect(published(run)).toBe(false);
  expect(state.releases[0].draft).toBe(true);
  state[failure] = false;
  publishRelease(root, { run });
  expect(mutations(run).filter(([, args]) => args[1] === 'create')).toHaveLength(1);
  expect(published(run)).toBe(true);
});

it('refuses to mix existing draft assets from another build or architecture', () => {
  const { root, run, state } = fixture();
  state.releases.push({ id: 1, tag_name: 'v0.2.0', draft: true, prerelease: false });
  state.uploaded.push({ name: 'Slopus-0.2.0-windows-arm64-setup.exe', size: 10, state: 'uploaded' });
  expect(() => publishRelease(root, { run })).toThrow('unexpected assets');
  expect(mutations(run)).toEqual([]);
});

it.each(['version', 'url', 'signature', 'platform'])('rejects a mismatched manifest %s before writing to GitHub', (field) => {
  const { root, run, manifest, manifestPath } = fixture();
  if (field === 'version') manifest.version = '0.1.0';
  if (field === 'url') manifest.platforms['windows-x86_64'].url = 'https://github.com/other/repo/releases/download/v0.2.0/setup.exe';
  if (field === 'signature') manifest.platforms['windows-x86_64'].signature = 'wrong';
  if (field === 'platform') manifest.platforms['windows-aarch64'] = manifest.platforms['windows-x86_64'];
  writeFileSync(manifestPath, JSON.stringify(manifest));
  expect(() => publishRelease(root, { run })).toThrow();
  expect(mutations(run)).toEqual([]);
});

it('rejects missing artifacts', () => {
  const { root } = fixture();
  writeFileSync(join(root, 'artifacts/Slopus-0.2.0-windows-x64-portable.zip'), '');
  expect(() => releaseFiles(root, '0.2.0')).toThrow('empty');
});

it.each(['dirty', 'tag', 'private', 'published'])('blocks %s releases before mutation', (failure) => {
  const { root, run, state } = fixture();
  if (failure === 'dirty') state.dirty = true;
  if (failure === 'tag') state.sha = 'other';
  if (failure === 'private') state.private = true;
  if (failure === 'published') state.releases.push({ tag_name: 'v0.2.0', draft: false, prerelease: false });
  expect(() => publishRelease(root, { run })).toThrow();
  expect(mutations(run)).toEqual([]);
});

it('compares versions numerically and excludes prereleases from the stable channel', () => {
  const releases = [{ tag_name: 'v0.9.0', draft: false, prerelease: false }];
  expect(() => checkReleaseOrder('0.10.0', releases)).not.toThrow();
  expect(() => checkReleaseOrder('0.8.0', releases)).toThrow('newer');
  expect(() => checkReleaseOrder('0.9.0', releases)).toThrow('newer');
  expect(() => checkReleaseOrder('1.0.0-beta.1', releases)).toThrow('stable');
  expect(() => checkReleaseOrder('0.10.0', [{ tag_name: 'v1.0.0-beta.1', prerelease: true }])).not.toThrow();
});
