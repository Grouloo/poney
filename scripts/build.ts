// Compiles src/ to dist/ for Electron, with the files that are not code. tsc is the
// only build step: dist/ has the same depth as src/, so relative paths stay valid.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const COPIED = ['renderer/index.html', 'renderer/style.css', 'skills'];

fs.rmSync(dist, { recursive: true, force: true });
execFileSync(path.join(root, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
for (const file of COPIED) fs.cpSync(path.join(root, 'src', file), path.join(dist, file), { recursive: true });
