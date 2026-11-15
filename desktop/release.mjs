// Builds everything and puts what a buyer gets in one folder, plus a zip of it:
//   node desktop/release.mjs [--linux]   ->  release/Cutline-<version>/  and  release/Cutline-<version>.zip
// The folder holds Cutline.exe (runs without installing) and the documents. The Windows installer is
// still built, in desktop/dist, for anyone who prefers it.
// Nothing secret goes in: the keygen tool and its private key stay out, and the script refuses to
// finish if anything like them appears in the folder.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const { version } = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const run = (cmd, cwd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('node desktop/build.mjs', root);
const name = `Cutline-${version}`;
const out = path.join(root, 'release', name);
const dist = (f) => path.join(here, 'dist', f);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
// The buyer's folder: one program file (the self-contained portable build) and the three documents.
fs.copyFileSync(dist(`Cutline-Portable-${version}.exe`), path.join(out, 'Cutline.exe'));
fs.copyFileSync(path.join(root, 'docs/READ-ME-FIRST.txt'), path.join(out, 'READ-ME-FIRST.txt'));
for (const f of ['EULA.txt', 'THIRD_PARTY_LICENSES.txt']) fs.copyFileSync(path.join(root, f), path.join(out, f));
// --linux: also a Linux archive next to the folder. Packed on Windows, electron-builder's archive loses
// the executable bit, so it is repacked with Linux permissions.
if (process.argv.includes('--linux')) {
  run('npx electron-builder --linux tar.gz --x64', here);
  writeTarGz(dist('linux-unpacked'), `Cutline-Linux-${version}`, path.join(root, 'release', `Cutline-Linux-${version}.tar.gz`), new Set(['cutline', 'chrome-sandbox', 'chrome_crashpad_handler']));
}

// Safety check: no source, no keys, nothing from the owner's tools.
const all = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? all(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const bad = all(out).filter((f) => /private|keygen|\.ts$|\.pem$|\.key$/i.test(path.relative(out, f)));
if (bad.length) throw new Error(`refusing to release, these must not ship: ${bad.join(', ')}`);

const zip = path.join(root, 'release', `${name}.zip`);
fs.rmSync(zip, { force: true });
// Windows' own tar writes zip files; elsewhere use zip.
if (process.platform === 'win32') run(`"${process.env.SystemRoot}\\System32\\tar.exe" -a -c -f "${zip}" "${name}"`, path.join(root, 'release'));
else run(`zip -r -q "${zip}" "${name}"`, path.join(root, 'release'));
console.log(`Release ready: ${out}\nZip: ${zip}`);

/** A gzipped ustar archive of `src` under `prefix/`: files 0644, `exec` names 0755, folders 0755. */
function writeTarGz(src, prefix, file, exec) {
  const blocks = [];
  const header = (name, size, mode, type) => {
    const h = Buffer.alloc(512);
    if (Buffer.byteLength(name) > 255) throw new Error(`path too long for tar: ${name}`);
    const cut = Buffer.byteLength(name) > 100 ? name.lastIndexOf('/', 155) : -1;
    h.write(cut > 0 ? name.slice(cut + 1) : name, 0, 100);
    if (cut > 0) h.write(name.slice(0, cut), 345, 155);
    h.write(mode.toString(8).padStart(7, '0'), 100);
    h.write('0000000', 108);
    h.write('0000000', 116);
    h.write(size.toString(8).padStart(11, '0'), 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0'), 136);
    h.write(type, 156);
    h.write('ustar\u000000', 257);
    h.fill(' ', 148, 156);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\u0000 ', 148);
    blocks.push(h);
  };
  const walk = (dir, rel) => {
    header(`${rel}/`, 0, 0o755, '5');
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}/${e.name}`);
      else {
        const data = fs.readFileSync(p);
        header(`${rel}/${e.name}`, data.length, exec.has(e.name) ? 0o755 : 0o644, '0');
        blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
      }
    }
  };
  walk(src, prefix);
  blocks.push(Buffer.alloc(1024));
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
}
