// electron-builder hook, after the app is packed and before it is signed and put
// in a dmg/zip. macOS: electron-builder changes the Electron bundle (name, icon,
// Info.plist), which breaks Electron's own ad hoc signature, and Apple Silicon
// refuses to start a bundle whose signature does not match ("damaged"). So the
// bundle is signed again, ad hoc. With a real certificate (CSC_LINK, see the
// README), electron-builder signs it after this and replaces that signature.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

interface PackContext {
  electronPlatformName: string;
  appOutDir: string;
  packager: { appInfo: { productFilename: string } };
}

export default function afterPack(context: PackContext): void {
  if (context.electronPlatformName !== 'darwin') return;
  const bundle = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
}
