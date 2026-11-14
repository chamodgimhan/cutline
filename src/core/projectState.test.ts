import { describe, expect, it } from 'vitest';
import { addRecent, ErrorLog, MAX_RECENTS } from './projectState.ts';

describe('recent projects', () => {
  it('puts the newest first, without duplicates, capped', () => {
    let list = addRecent([], { name: 'a', ref: '/a', openedAt: 1 });
    list = addRecent(list, { name: 'b', ref: '/b', openedAt: 2 });
    list = addRecent(list, { name: 'a again', ref: '/a', openedAt: 3 });
    expect(list.map((r) => [r.name, r.ref])).toEqual([['a again', '/a'], ['b', '/b']]);
    for (let i = 0; i < 20; i++) list = addRecent(list, { name: 'p' + i, ref: '/p' + i, openedAt: 10 + i });
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]!.name).toBe('p19');
  });
});

describe('ErrorLog', () => {
  it('keeps the newest entries up to its limit and tells its listener', () => {
    const log = new ErrorLog([{ time: 1, level: 'info', message: 'old' }], 3);
    const seen: number[] = [];
    log.onChange = (e) => seen.push(e.length);
    for (let i = 0; i < 5; i++) log.add('error', 'e' + i, undefined, 10 + i);
    expect(log.all.map((e) => e.message)).toEqual(['e2', 'e3', 'e4']);
    expect(seen).toEqual([2, 3, 3, 3, 3]);
  });

  it('exports readable text and trims huge details', () => {
    const log = new ErrorLog();
    log.add('warning', 'Clips would overlap.', undefined, Date.UTC(2026, 0, 2, 3, 4, 5));
    log.add('error', 'Export failed.', ['TypeError: x', '  at y'].join('\n'), Date.UTC(2026, 0, 2, 3, 4, 6));
    log.add('error', 'big', 'z'.repeat(9000), 0);
    const lines = log.toText().split('\n');
    expect(lines[1]).toBe('3 entries');
    expect(lines).toContain('2026-01-02T03:04:05.000Z WARNING Clips would overlap.');
    expect(lines).toContain('2026-01-02T03:04:06.000Z ERROR   Export failed.');
    expect(lines).toContain('    TypeError: x');
    expect(lines).toContain('      at y');
    expect(log.all[2]!.detail).toHaveLength(4000);
  });
});
