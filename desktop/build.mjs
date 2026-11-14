// One-step desktop build:   node desktop/build.mjs [--dir] [--mac] [--linux]
// Builds the web app, copies it into desktop/app, installs Electron and the packager if needed,
// then makes the installers (Windows installer and portable by default). --dir stops after an
// unpacked app folder, which is quick and enough to run the desktop smoke test.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const run = (cmd, cwd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

if (!fs.existsSync(path.join(root, 'node_modules'))) run('npm install --no-fund --no-audit', root);
run('node tools/icon.ts', root);
run('node tools/licenses.ts', root);
run('npx vite build', root);
fs.rmSync(path.join(here, 'app'), { recursive: true, force: true });
fs.cpSync(path.join(root, 'dist'), path.join(here, 'app'), { recursive: true });
if (!fs.existsSync(path.join(here, 'node_modules', 'electron'))) run('npm install --no-fund --no-audit', here);

const args = process.argv.slice(2);
if (args.includes('--dir')) run('npx electron-builder --dir', here);
else if (args.includes('--mac')) run('npx electron-builder --mac', here);
else if (args.includes('--linux')) run('npx electron-builder --linux', here);
else run('npx electron-builder --win nsis portable', here);
console.log(`Done. Output is in ${path.join(here, 'dist')}`);
