import { readFile } from 'node:fs/promises';

const [tag] = process.argv.slice(2);
if (!tag) throw new Error('Usage: node scripts/validate-release-version.mjs <tag>');

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const rootPackage = await readJson('../package.json');
const desktopPackage = await readJson('../packages/desktop/package.json');
const npmLock = await readJson('../package-lock.json');
const tauriConfig = await readJson('../packages/desktop/src-tauri/tauri.conf.json');
const cargoToml = await readFile(new URL('../packages/desktop/src-tauri/Cargo.toml', import.meta.url), 'utf8');
const cargoLock = await readFile(new URL('../packages/desktop/src-tauri/Cargo.lock', import.meta.url), 'utf8');
const lockPackage = cargoLock.match(/\[\[package\]\]\r?\nname = "vagus-desktop"\r?\nversion = "([^"]+)"/);
const cargoVersion = cargoToml.match(/^version = "([^"]+)"$/m)?.[1];
const expected = tag.replace(/^v/, '');
const versions = {
  'root package.json': rootPackage.version,
  'root package-lock.json': npmLock.packages?.['']?.version,
  'desktop package.json': desktopPackage.version,
  'desktop package-lock.json': npmLock.packages?.['packages/desktop']?.version,
  'tauri.conf.json': tauriConfig.version,
  'Cargo.toml': cargoVersion,
  'Cargo.lock': lockPackage?.[1],
};

const mismatches = Object.entries(versions).filter(([, version]) => version !== expected);
if (mismatches.length) {
  const details = Object.entries(versions).map(([name, version]) => `${name}: ${version ?? 'missing'}`).join('\n');
  throw new Error(`Release tag ${tag} must match every release version.\n${details}`);
}

console.log(`Release tag ${tag} matches all release version declarations.`);
