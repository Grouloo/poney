// macOS, development: the app runs inside node_modules/electron/dist/Electron.app,
// so the Dock and the menu bar show "Electron" and its icon. This gives that
// bundle the app's name (inside, for the menu bar, and as its folder name, which
// the Dock shows) and icon, then signs it again, ad hoc. Runs before `npm start`;
// does nothing when already done, or on other systems.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NAME = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).productName || 'Poney';

export function brandBundle(bundle, icns, name = NAME) {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  const get = (key) => execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  const target = path.join(bundle, 'Contents', 'Resources', get('CFBundleIconFile'));
  const sameIcon = fs.existsSync(target) && fs.readFileSync(target).equals(fs.readFileSync(icns));
  if (get('CFBundleName') === name && sameIcon) return false;
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${name}`, plist]); } catch {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${name}`, plist]);
    }
  }
  fs.copyFileSync(icns, target);
  // The Info.plist is part of the signature: sign again (ad hoc), or macOS may refuse to start it.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'ignore' });
  return true;
}

/**
 * Renames the bundle the electron package uses (<pkg>/dist/Electron.app, or an
 * earlier name such as poney.app) to <name>.app, and points the package at it
 * (path.txt). Not while it runs: its helper processes start from that path.
 * Returns the bundle to use.
 */
export function renameBundle(pkg, name = NAME) {
  const pathTxt = path.join(pkg, 'path.txt');
  const current = fs.readFileSync(pathTxt, 'utf8').trim().split('/')[0]; // "Electron.app"
  const from = path.join(pkg, 'dist', current);
  const to = path.join(pkg, 'dist', `${name}.app`);
  if (current === `${name}.app`) return from;
  let running = '';
  try { running = execFileSync('pgrep', ['-f', `${from}/Contents/MacOS/`], { encoding: 'utf8' }).trim(); } catch {}
  if (running) {
    console.warn(`${name}: ${current} is in use (the app is open), it will be renamed at the next start.`);
    return from;
  }
  // A bundle left by an earlier install of electron (not the same folder in another case).
  if (fs.existsSync(to) && fs.statSync(to).ino !== fs.statSync(from).ino) fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  fs.writeFileSync(pathTxt, `${name}.app/Contents/MacOS/Electron`);
  return to;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.platform === 'darwin') {
  const pkg = process.argv[2] || path.join(root, 'node_modules', 'electron');
  try {
    const bundle = renameBundle(pkg);
    const changed = brandBundle(bundle, path.join(root, 'assets', 'icon.icns'));
    // Tell the Dock / Finder that the bundle changed.
    try {
      execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle], { stdio: 'ignore' });
    } catch {}
    if (changed) console.log(`${NAME}: Electron bundle given the app's name and icon.`);
  } catch (e) {
    console.warn(`${NAME}: could not rename the Electron bundle (${e.message.split('\n')[0]}); the Dock will show "Electron".`);
  }
}
