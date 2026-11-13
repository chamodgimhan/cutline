import { describe, expect, it } from 'vitest';
import { applyOps, Command } from './command.ts';
import { moveClips, splitClips } from './commands/clips.ts';
import { addMarker } from './commands/tracks.ts';
import { History } from './history.ts';
import { ctxFor, layout, project } from './testkit.ts';

const start = () => project({ V1: [['a', 0, 10], ['b', 20, 10]] });

describe('History', () => {
  it('undoes and redoes to deep-equal states', () => {
    const p0 = start();
    const h = new History(p0);
    const ctx = ctxFor();
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 5 }));
    const p1 = h.project;
    h.execute(splitClips(h.project, ctx, { ids: ['b'], at: 25 }));
    const p2 = h.project;
    expect(h.undoLabel).toBe('Split');
    expect(h.undo()).toBe(true);
    expect(h.project).toEqual(p1);
    expect(h.redoLabel).toBe('Split');
    expect(h.undo()).toBe(true);
    expect(h.project).toEqual(p0);
    expect(h.undo()).toBe(false);
    expect(h.redo() && h.redo()).toBe(true);
    expect(h.project).toEqual(p2);
    expect(h.redo()).toBe(false);
  });

  it('drops the redo stack on a new command and ignores empty commands', () => {
    const h = new History(start());
    const ctx = ctxFor();
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 5 }));
    h.undo();
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 0 }));
    expect(h.canRedo).toBe(true);
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 2 }));
    expect(h.canRedo).toBe(false);
    expect(h.appliedCount).toBe(1);
  });

  it('groups several commands into one undo step, including nested groups', () => {
    const p0 = start();
    const h = new History(p0);
    const ctx = ctxFor();
    h.group('Drag', () => {
      h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 1 }));
      h.group('inner', () => h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 1 })));
      h.execute(addMarker(h.project, ctx, { time: 3 }));
      expect(h.canUndo).toBe(false);
    });
    expect(h.entries()).toEqual([{ label: 'Drag', applied: true }]);
    expect(layout(h.project).V1?.[0]).toEqual(['a', 2, 10, 0]);
    h.undo();
    expect(h.project).toEqual(p0);
    h.redo();
    expect(h.project.sequences[0]!.markers).toHaveLength(1);
  });

  it('rolls back a group that throws or is cancelled', () => {
    const p0 = start();
    const h = new History(p0);
    const ctx = ctxFor();
    expect(() =>
      h.group('Bad', () => {
        h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 3 }));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(h.project).toEqual(p0);
    expect(h.canUndo).toBe(false);
    h.beginGroup('x');
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 3 }));
    h.cancelGroup();
    expect(h.project).toEqual(p0);
    h.beginGroup('empty');
    h.endGroup();
    expect(h.appliedCount).toBe(0);
  });

  it('tracks unsaved changes across undo and redo', () => {
    const h = new History(start());
    const ctx = ctxFor();
    expect(h.dirty).toBe(false);
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 5 }));
    expect(h.dirty).toBe(true);
    h.markSaved();
    expect(h.dirty).toBe(false);
    h.undo();
    expect(h.dirty).toBe(true);
    h.redo();
    expect(h.dirty).toBe(false);
    h.undo();
    h.execute(moveClips(h.project, ctx, { ids: ['a'], delta: 5 }));
    expect(h.dirty).toBe(true); // same content, but a different history branch
    h.reset(start());
    expect([h.dirty, h.canUndo]).toEqual([false, false]);
    h.reset(start(), true);
    expect(h.dirty).toBe(true);
  });

  it('jumps to any point for the history panel, notifies listeners and caps its length', () => {
    const h = new History(start(), 3);
    const ctx = ctxFor();
    let calls = 0;
    const off = h.subscribe(() => calls++);
    for (let i = 0; i < 5; i++) h.execute(moveClips(h.project, ctx, { ids: ['b'], delta: 1 }));
    expect(h.appliedCount).toBe(3);
    h.jumpTo(1);
    expect(h.entries().map((e) => e.applied)).toEqual([true, false, false]);
    expect(layout(h.project).V1?.[1]).toEqual(['b', 23, 10, 0]);
    h.jumpTo(3);
    expect(layout(h.project).V1?.[1]).toEqual(['b', 25, 10, 0]);
    expect(calls).toBeGreaterThanOrEqual(9);
    off();
    const before = calls;
    h.undo();
    expect(calls).toBe(before);
  });

  it('refuses a command built for a different project state', () => {
    const p = start();
    const cmd = moveClips(p, ctxFor(), { ids: ['a'], delta: 5 });
    const other = project({ V1: [['zzz', 0, 10]] });
    expect(() => cmd.apply(other)).toThrow(/does not match/);
    expect(() => applyOps(p, [{ t: 'seqProps', seq: 'nope', before: {}, after: {} }])).toThrow(/does not match/);
    expect(Command.group('g', [cmd, cmd.invert()]).apply(p)).toEqual(p);
  });
});
