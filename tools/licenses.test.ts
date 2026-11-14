import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { allPackages, auditLicenses, licenseAllowed, NOTICE_FILE, noticeText, type Pkg } from './licenses.ts';

const pkg = (license: string, shipped = false): Pkg => ({ name: 'x', version: '1.0.0', license, shipped });

describe('licence audit', () => {
  it('passes for everything installed in this project', () => {
    const pkgs = allPackages();
    expect(pkgs.length).toBeGreaterThan(50);
    expect(auditLicenses(pkgs)).toEqual([]);
  });

  it('fails on GPL, AGPL, LGPL, unknown and missing licences', () => {
    for (const bad of ['GPL-3.0', 'GPL-2.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'GPL', 'UNKNOWN', '', 'SEE LICENSE IN LICENSE.md', 'Proprietary', 'MIT AND GPL-3.0']) {
      expect(auditLicenses([pkg(bad)]), bad).toHaveLength(1);
    }
    expect(auditLicenses([pkg('GPL-3.0')])[0]).toMatch(/copyleft/);
    expect(auditLicenses([pkg('')])[0]).toMatch(/no licence stated/);
  });

  it('accepts the allowed licences and dual licences with an allowed option', () => {
    for (const ok of ['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', '(MIT OR GPL-3.0)', 'MIT OR Apache-2.0', '(BSD-3-Clause AND MIT)']) {
      expect(auditLicenses([pkg(ok, true)]), ok).toEqual([]);
    }
    expect(licenseAllowed('(MIT AND GPL-3.0)', new Set(['MIT']))).toBe(false);
  });

  it('holds shipped code to the strict list', () => {
    expect(auditLicenses([pkg('BlueOak-1.0.0', false)])).toEqual([]);
    expect(auditLicenses([pkg('BlueOak-1.0.0', true)])[0]).toMatch(/shipped-code allow-list/);
    expect(auditLicenses([pkg('CC-BY-4.0', true)])).toHaveLength(1);
  });

  it('keeps THIRD_PARTY_LICENSES.txt in step with what is installed', () => {
    const text = noticeText(allPackages());
    expect(fs.readFileSync(NOTICE_FILE, 'utf8')).toBe(text);
    expect(text).toContain('SIL Open Font License');
    expect(text).toContain('Apache License');
    expect(text).toContain('(c) Chamod Gimhan');
  });
});
