import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releaseVersion } from './updater-manifest.mjs';

const repository = 'bitti-ai/slopus';
const endpoint = `https://github.com/${repository}/releases/latest/download/latest.json`;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function command(root, executable, args, input) {
  const result = spawnSync(executable, args, {
    cwd: root, encoding: 'utf8', input, windowsHide: true,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
  });
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${executable} ${args.slice(0, 2).join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
  return result.stdout.trim();
}

export function checkReleaseOrder(version, releases) {
  if (!stableVersion.test(version)) throw new Error('Automatic publishing requires a stable X.Y.Z version.');
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const previous = release.tag_name.replace(/^v/, '');
    if (!stableVersion.test(previous)) throw new Error(`Cannot compare published version ${release.tag_name}.`);
    const a = version.split('.').map(BigInt), b = previous.split('.').map(BigInt);
    const differing = a.findIndex((part, index) => part !== b[index]);
    if (differing === -1 || a[differing] < b[differing]) {
      throw new Error(`Version ${version} must be newer than published release ${release.tag_name}. Bump the version before publishing.`);
    }
  }
}

export function releaseFiles(root, version) {
  const directory = resolve(root, 'artifacts');
  const manifestPath = resolve(directory, 'latest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.version !== version) throw new Error('latest.json does not match the release version. Rebuild with release.cmd.');
  if (typeof manifest.notes !== 'string' || !Number.isFinite(Date.parse(manifest.pub_date))) throw new Error('Invalid updater notes or publication date.');
  const platforms = Object.entries(manifest.platforms ?? {});
  const generic = platforms.filter(([key]) => /^windows-(x86_64|aarch64|i686)$/.test(key));
  if (generic.length !== 1) throw new Error('Automatic publishing requires a single Windows architecture.');
  const target = generic[0][0];
  const arch = { 'windows-x86_64': 'x64', 'windows-aarch64': 'arm64', 'windows-i686': 'x86' }[target];
  const stem = `Slopus-${version}-windows-${arch}`;
  const names = new Set();
  for (const [key, entry] of platforms) {
    if (![target, `${target}-nsis`, `${target}-msi`].includes(key)) throw new Error(`Unexpected updater target: ${key}`);
    const name = key.endsWith('-msi') ? `${stem}.msi` : `${stem}-setup.exe`;
    const expected = `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(name)}`;
    if (entry.url !== expected) throw new Error(`Updater URL does not match this release: ${key}`);
    const signature = readFileSync(resolve(directory, `${name}.sig`), 'utf8').trim();
    if (!signature || entry.signature !== signature) throw new Error(`Updater signature mismatch: ${name}`);
    names.add(name); names.add(`${name}.sig`);
  }
  if (!manifest.platforms[`${target}-nsis`]) throw new Error('Missing NSIS updater target.');
  names.add(`${stem}-portable.zip`);
  // Upload the manifest last. Only this explicit list can become release assets.
  names.add('latest.json');
  const files = [...names].map((name) => {
    const path = resolve(directory, name);
    const stat = statSync(path);
    if (!stat.isFile() || !stat.size) throw new Error(`Missing or empty release artifact: ${name}`);
    return { name, path, size: stat.size };
  });
  return { manifest, files };
}

export function publishRelease(root, { checkOnly = false, run = (exe, args, input) => command(root, exe, args, input) } = {}) {
  const version = releaseVersion(root), tag = `v${version}`;
  if (!stableVersion.test(version)) throw new Error('Automatic publishing requires a stable X.Y.Z version.');
  const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (config.plugins.updater.endpoints.length !== 1 || config.plugins.updater.endpoints[0] !== endpoint) {
    throw new Error('The updater endpoint must point to this repository’s latest.json.');
  }
  const gh = (args, input) => run('gh', args, input);
  const api = (path, ...args) => JSON.parse(gh(['api', `repos/${repository}${path}`, ...args]));
  const releases = () => api('/releases?per_page=100', '--paginate', '--slurp').flat();
  const check = () => {
    if (run('git', ['status', '--porcelain']).trim()) throw new Error('Commit your changes before publishing so the release matches its tag.');
    const head = run('git', ['rev-parse', 'HEAD']).trim();
    let object = api(`/git/ref/tags/${tag}`).object;
    for (let depth = 0; object.type === 'tag' && depth < 10; depth++) object = api(`/git/tags/${object.sha}`).object;
    if (object.type !== 'commit' || object.sha !== head) throw new Error(`Push tag ${tag} pointing to the current commit before publishing.`);
    const all = releases();
    checkReleaseOrder(version, all);
    const existing = all.find((release) => release.tag_name === tag);
    if (existing && (!existing.draft || existing.prerelease)) throw new Error(`${tag} must be an unpublished stable draft.`);
    return existing;
  };
  // Check GitHub access before the expensive build. Never read or upload the signing key.
  const repo = api('');
  if (repo.private) throw new Error('The updater requires publicly downloadable releases.');
  if (!repo.permissions?.push) throw new Error('GitHub write access is required. Sign in with gh auth login.');
  let draft = check();
  if (checkOnly) return `Ready to publish ${tag} to ${repository}.`;
  const { manifest, files } = releaseFiles(root, version);
  if (!draft) {
    gh(['release', 'create', tag, '--repo', repository, '--draft', '--verify-tag', '--title', `Slopus ${version}`, '--notes-file', '-'], manifest.notes);
    draft = check();
  }
  if (!draft?.draft) throw new Error('Could not find the draft release.');
  const assets = () => api(`/releases/${draft.id}/assets?per_page=100`, '--paginate', '--slurp').flat();
  const expected = new Set(files.map(({ name }) => name));
  if (assets().some((asset) => !expected.has(asset.name))) throw new Error('The draft contains unexpected assets. Review it before retrying.');
  gh(['release', 'edit', tag, '--repo', repository, '--notes-file', '-'], manifest.notes);
  // Replacement is allowed only while the release is a draft, making interrupted uploads retryable.
  gh(['release', 'upload', tag, ...files.slice(0, -1).map(({ path }) => path), '--repo', repository, '--clobber']);
  gh(['release', 'upload', tag, files.at(-1).path, '--repo', repository, '--clobber']);
  const uploaded = assets();
  for (const file of files) {
    const asset = uploaded.find(({ name }) => name === file.name);
    if (!asset || asset.state !== 'uploaded' || asset.size !== file.size) throw new Error(`Upload verification failed: ${file.name}. Release remains a draft.`);
  }
  if (!check()?.draft) throw new Error('The release is no longer a draft.');
  // This is the only step that makes the new manifest visible to installed apps.
  gh(['release', 'edit', tag, '--repo', repository, '--draft=false', '--prerelease=false', '--latest', '--verify-tag']);
  return `Published https://github.com/${repository}/releases/tag/${tag}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !['--check', '--publish'].includes(args[0])) throw new Error('Usage: node scripts/publish-release.mjs --check|--publish');
    console.log(publishRelease(resolve(import.meta.dirname, '..'), { checkOnly: args[0] === '--check' }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
