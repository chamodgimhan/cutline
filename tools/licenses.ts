// Licence audit and THIRD_PARTY_LICENSES.txt generator.
//   node tools/licenses.ts          writes THIRD_PARTY_LICENSES.txt
//   node tools/licenses.ts --check  exits 1 if the audit fails or the file is out of date
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICE_FILE = path.join(ROOT, 'THIRD_PARTY_LICENSES.txt');

export interface Pkg {
  name: string;
  version: string;
  license: string;
  /** Part of the installed app (a runtime dependency), as opposed to a tool used only to build and test it. */
  shipped: boolean;
}

/** Licences allowed for anything that ships in the app. */
const SHIPPED_OK = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0']);
/** Further permissive licences accepted for build and test tools, which are not distributed. */
const TOOLS_OK = new Set([...SHIPPED_OK, 'BlueOak-1.0.0', '0BSD', 'MIT-0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0', 'WTFPL']);

/** Is an SPDX expression acceptable? "A OR B" needs one acceptable side, "A AND B" needs both. */
export function licenseAllowed(expr: string, allowed: ReadonlySet<string>): boolean {
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (/ OR /.test(e)) return e.split(/ OR /).some((p) => licenseAllowed(p, allowed));
  if (/ AND /.test(e)) return e.split(/ AND /).every((p) => licenseAllowed(p, allowed));
  return allowed.has(e);
}

/** Problems with a set of packages; empty means the audit passes. */
export function auditLicenses(pkgs: readonly Pkg[]): string[] {
  const problems: string[] = [];
  for (const p of pkgs) {
    const id = `${p.name}@${p.version}`;
    if (!p.license || p.license === 'UNKNOWN') problems.push(`${id}: no licence stated`);
    else if (/\bA?GPL\b|\bLGPL\b|GPL-/i.test(p.license) && !licenseAllowed(p.license, TOOLS_OK)) problems.push(`${id}: ${p.license} is a copyleft licence and is not allowed`);
    else if (!licenseAllowed(p.license, p.shipped ? SHIPPED_OK : TOOLS_OK)) problems.push(`${id}: licence "${p.license}" is not on the ${p.shipped ? 'shipped-code' : 'build-tool'} allow-list`);
  }
  return problems;
}

function licenseOf(json: Record<string, unknown>): string {
  const l = json.license ?? json.licenses;
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => (typeof x === 'string' ? x : String((x as { type?: string }).type ?? ''))).filter(Boolean).join(' OR ') || 'UNKNOWN';
  if (l && typeof l === 'object') return String((l as { type?: string }).type ?? 'UNKNOWN');
  return 'UNKNOWN';
}

/** Every package installed under a project folder. Runtime dependencies (and theirs) are marked as shipped. */
export function scanPackages(projectDir: string): Pkg[] {
  const manifest = path.join(projectDir, 'package.json');
  const modules = path.join(projectDir, 'node_modules');
  if (!fs.existsSync(manifest) || !fs.existsSync(modules)) return [];
  const all = new Map<string, { pkg: Pkg; deps: string[] }>();
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.name.startsWith('@')) {
        walk(p);
        continue;
      }
      const file = path.join(p, 'package.json');
      if (fs.existsSync(file)) {
        const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
        if (typeof json.name === 'string' && typeof json.version === 'string') {
          all.set(`${json.name}@${json.version}`, { pkg: { name: json.name, version: json.version, license: licenseOf(json), shipped: false }, deps: Object.keys((json.dependencies as object) ?? {}) });
        }
      }
      if (fs.existsSync(path.join(p, 'node_modules'))) walk(path.join(p, 'node_modules'));
    }
  };
  walk(modules);
  // Mark what the app's runtime dependencies pull in.
  const byName = new Map<string, { pkg: Pkg; deps: string[] }[]>();
  for (const v of all.values()) byName.set(v.pkg.name, [...(byName.get(v.pkg.name) ?? []), v]);
  const queue = Object.keys(((JSON.parse(fs.readFileSync(manifest, 'utf8')) as Record<string, unknown>).dependencies as object) ?? {});
  const seen = new Set<string>();
  while (queue.length) {
    const name = queue.pop() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const v of byName.get(name) ?? []) {
      v.pkg.shipped = true;
      queue.push(...v.deps);
    }
  }
  return [...all.values()].map((v) => v.pkg).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export const allPackages = (): Pkg[] => [...scanPackages(ROOT), ...scanPackages(path.join(ROOT, 'desktop'))];

/** Text of THIRD_PARTY_LICENSES.txt for the current tree. */
export function noticeText(pkgs: readonly Pkg[]): string {
  const fonts = fs.readdirSync(path.join(ROOT, 'assets/fonts')).filter((f) => f.startsWith('LICENSE-')).sort();
  const shipped = pkgs.filter((p) => p.shipped);
  const tools = pkgs.filter((p) => !p.shipped);
  const line = (p: Pkg): string => `  ${p.name} ${p.version}  (${p.license})`;
  const out = [
    'CUTLINE - THIRD-PARTY NOTICES',
    '',
    'Cutline is (c) Chamod Gimhan. All rights reserved. This file lists software and fonts by other',
    'authors that are distributed with Cutline or used to build it, with their licences.',
    'Generated by tools/licenses.ts. Do not edit by hand.',
    '',
    '== Distributed with the app ==',
    '',
    'Electron (MIT) and the Chromium and Node.js components inside it form the desktop runtime.',
    'Their own notices are installed next to the application as LICENSE.electron.txt and LICENSES.chromium.html.',
    '',
    shipped.length ? 'JavaScript packages bundled into the app:' : 'No third-party JavaScript packages are bundled into the app.',
    ...shipped.map(line),
    '',
    'Fonts (in assets/fonts): Roboto and Roboto Mono (SIL Open Font License 1.1), Roboto Slab (Apache License 2.0).',
    'Their full licence texts follow at the end of this file.',
    '',
    '== Used to build and test (not distributed) ==',
    '',
    ...tools.map(line),
    '',
    ...fonts.flatMap((f) => [`== ${f.replace('LICENSE-', 'Font licence: ').replace('.txt', '')} ==`, '', fs.readFileSync(path.join(ROOT, 'assets/fonts', f), 'utf8').replace(/\r\n/g, '\n').trim(), '']),
  ];
  return out.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pkgs = allPackages();
  const problems = auditLicenses(pkgs);
  const text = noticeText(pkgs);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(NOTICE_FILE) || fs.readFileSync(NOTICE_FILE, 'utf8') !== text) problems.push('THIRD_PARTY_LICENSES.txt is out of date: run node tools/licenses.ts');
  } else fs.writeFileSync(NOTICE_FILE, text);
  for (const p of problems) console.error(p);
  console.log(`licences: ${pkgs.length} packages, ${pkgs.filter((p) => p.shipped).length} shipped, ${problems.length} problems`);
  process.exit(problems.length ? 1 : 0);
}
