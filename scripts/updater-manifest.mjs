import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseVersion(root) {
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const config = JSON.parse(readFileSync(resolve(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargoVersion = readFileSync(resolve(root, 'src-tauri/Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (version !== config.version || version !== cargoVersion) {
    throw new Error('Release versions must match in package.json, src-tauri/tauri.conf.json and src-tauri/Cargo.toml.');
  }
  if (!config.bundle.createUpdaterArtifacts || !config.plugins?.updater?.pubkey || !config.plugins?.updater?.endpoints?.length) {
    throw new Error('Configure signed updater artifacts, a public key and an endpoint in tauri.conf.json first.');
  }
  return version;
}

export function createManifest({ version, arch, setupPath, msiPath, notes = '', repository = 'bitti-ai/slopus', date = new Date() }) {
  const targetArch = { x64: 'x86_64', arm64: 'aarch64', x86: 'i686' }[arch];
  if (!targetArch) throw new Error(`Unsupported release architecture: ${arch}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version.');
  const base = `https://github.com/${repository}/releases/download/v${version}/`;
  const artifact = (path) => {
    // Read both files so a signature without its installer cannot be published.
    if (readFileSync(path).length === 0) throw new Error(`Empty installer: ${path}`);
    const signature = readFileSync(`${path}.sig`, 'utf8').trim();
    if (!signature) throw new Error(`Empty signature: ${path}.sig`);
    return { signature, url: base + encodeURIComponent(basename(path)) };
  };
  const setup = artifact(setupPath);
  const platforms = { [`windows-${targetArch}`]: setup, [`windows-${targetArch}-nsis`]: setup };
  if (msiPath) platforms[`windows-${targetArch}-msi`] = artifact(msiPath);
  return { version, notes, pub_date: date.toISOString(), platforms };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const root = resolve(import.meta.dirname, '..');
    const version = releaseVersion(root);
    if (process.argv.includes('--check')) {
      console.log(`Updater release configuration is ready for ${version}.`);
    } else {
      const { PACKAGE_ARCH: arch, OUTPUT_SETUP: setupPath, OUTPUT_MSI: outputMsi, MSI_SRC: msiSource, ARTIFACTS_DIR: outputDir, UPDATE_NOTES_FILE: notesFile } = process.env;
      if (!arch || !setupPath || !outputDir) throw new Error('Run this script through release.cmd.');
      const manifest = createManifest({ version, arch, setupPath, msiPath: msiSource ? outputMsi : undefined, notes: notesFile ? readFileSync(notesFile, 'utf8') : '' });
      const outputPath = resolve(outputDir, 'latest.json');
      writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + '\n');
      console.log(`Updater manifest: ${outputPath}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
