// macOS, development: the app runs inside node_modules/electron/dist/Electron.app,
// so the Dock and the menu bar show "Electron" and its icon. This gives that
// bundle the app's name and icon (then signs it again, ad hoc). Runs before
// `npm start`; does nothing when already done, or on other systems.
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
  // Tell the Dock / Finder that the bundle changed.
  try {
    execFileSync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', bundle], { stdio: 'ignore' });
  } catch {}
  return true;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.platform === 'darwin') {
  const bundle = process.argv[2] || path.join(root, 'node_modules', 'electron', 'dist', 'Electron.app');
  try {
    if (brandBundle(bundle, path.join(root, 'assets', 'icon.icns'))) console.log(`${NAME}: Electron.app renamed and given the app icon.`);
  } catch (e) {
    console.warn(`${NAME}: could not rename Electron.app (${e.message.split('\n')[0]}); the Dock will show "Electron".`);
  }
}
