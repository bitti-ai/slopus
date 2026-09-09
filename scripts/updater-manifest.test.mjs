import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createManifest, releaseVersion } from './updater-manifest.mjs';

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('slopus-updater-')) {
      throw new Error('Refusing to remove a path outside the test temporary directory.');
    }
    rmSync(directory, { recursive: true });
  }
});
const fixture = () => {
  const directory = mkdtempSync(join(tmpdir(), 'slopus-updater-'));
  directories.push(directory);
  const setupPath = join(directory, 'Slopus-0.2.0-windows-x64-setup.exe');
  writeFileSync(setupPath, 'installer fixture');
  writeFileSync(setupPath + '.sig', 'signed installer\n');
  return { version: '0.2.0', arch: 'x64', setupPath };
};

describe('GitHub updater manifest', () => {
  it('uses the uploaded filename and embeds signature contents with matching version tags', () => {
    const manifest = createManifest({ ...fixture(), notes: 'Changes', date: new Date('2026-09-09T12:00:00Z') });
    expect(manifest).toMatchObject({ version: '0.2.0', notes: 'Changes', pub_date: '2026-09-09T12:00:00.000Z' });
    expect(manifest.platforms['windows-x86_64']).toEqual({
      signature: 'signed installer', url: 'https://github.com/bitti-ai/slopus/releases/download/v0.2.0/Slopus-0.2.0-windows-x64-setup.exe',
    });
    expect(manifest.platforms['windows-x86_64-nsis']).toEqual(manifest.platforms['windows-x86_64']);
  });
  it('includes a separate MSI target when an MSI was produced', () => {
    const input = fixture();
    const msiPath = input.setupPath.replace('.exe', '.msi');
    writeFileSync(msiPath, 'msi fixture');
    writeFileSync(msiPath + '.sig', 'signed msi');
    expect(createManifest({ ...input, msiPath }).platforms['windows-x86_64-msi'].signature).toBe('signed msi');
  });
  it('fails instead of publishing an unsigned installer or unknown architecture', () => {
    const input = fixture();
    writeFileSync(input.setupPath + '.sig', '');
    expect(() => createManifest(input)).toThrow('Empty signature');
    expect(() => createManifest({ ...input, arch: 'unknown' })).toThrow('Unsupported release architecture');
  });
  it('accepts the configured repository release version', () => {
    expect(releaseVersion(resolve(import.meta.dirname, '..'))).toMatch(/^\d+\.\d+\.\d+/);
  });
});
