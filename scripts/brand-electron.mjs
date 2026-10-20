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
const NAME = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).productName || 'poney';

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
 * Renames <pkg>/dist/Electron.app to <name>.app and points the electron package
 * at it (path.txt). Not while it runs: its helper processes start from that path.
 * Returns the bundle to use.
 */
export function renameBundle(pkg, name = NAME) {
  const dist = path.join(pkg, 'dist');
  const from = path.join(dist, 'Electron.app');
  const to = path.join(dist, `${name}.app`);
  const pathTxt = path.join(pkg, 'path.txt');
  if (fs.existsSync(from)) {
    let running = '';
    try { running = execFileSync('pgrep', ['-f', `${from}/Contents/MacOS/`], { encoding: 'utf8' }).trim(); } catch {}
    if (running) {
      console.warn(`${name}: Electron.app is in use (an app is open), it will be renamed at the next start.`);
      return from;
    }
    fs.rmSync(to, { recursive: true, force: true }); // left by an earlier install of electron
    fs.renameSync(from, to);
  }
  if (fs.existsSync(to)) fs.writeFileSync(pathTxt, `${name}.app/Contents/MacOS/Electron`);
  return fs.existsSync(to) ? to : from;
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
