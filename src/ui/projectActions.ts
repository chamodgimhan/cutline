// Project safety: new, open, save, recent projects, unsaved-changes prompt, autosave and crash recovery, error log.
import type { Action } from '../core/editor/actions.ts';
import { parseProject, ProjectFileError, serializeProject } from '../core/projectFile.ts';
import { addRecent, ErrorLog, type LogEntry, type Recent, type Recovery } from '../core/projectState.ts';
import { newProject, type App } from './app.ts';
import type { ProjectHooks } from './desktop.ts';
import { h } from './dom.ts';
import { kv } from './storage.ts';
import { saveTextFile } from './textUi.ts';

/** A small modal question. Resolves with the label of the button pressed; Escape picks the last button. */
export function ask(title: string, message: string, buttons: string[], extra: HTMLElement[] = []): Promise<string> {
  return new Promise((resolve) => {
    const done = (answer: string): void => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(answer);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') done(buttons[buttons.length - 1] as string);
      e.stopPropagation();
    };
    const back = h('div', { class: 'dialog-back' },
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title, style: 'width:min(480px,92vw);grid-template-rows:auto auto auto auto' },
        h('h2', {}, title), h('div', {}, message), h('div', {}, ...extra),
        h('div', { class: 'foot' }, ...buttons.map((b, i) => h('button', { class: i === 0 ? 'on' : '', 'data-answer': b, onclick: () => done(b) }, b)))));
    window.addEventListener('keydown', onKey, true);
    document.body.append(back);
    (back.querySelector('button') as HTMLButtonElement).focus();
  });
}

const fileName = (name: string): string => `${name.replace(/\.cutline$/i, '') || 'Untitled'}.cutline`;

export async function installProject(app: App): Promise<{ actions: Action[]; hooks: ProjectHooks }> {
  const s = app.session;
  app.log = new ErrorLog((await kv.get<LogEntry[]>('log')) ?? []);
  app.log.onChange = (entries) => void kv.set('log', entries.slice());
  let recents = (await kv.get<Recent[]>('recents')) ?? [];
  let lastAutosaved: unknown = null;

  const fail = (message: string, e: unknown): void => {
    app.log.add('error', message, e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    s.notify(message);
  };
  const remember = async (name: string, ref: string | null): Promise<void> => {
    app.fileRef = ref;
    if (!ref) return;
    recents = addRecent(recents, { name, ref, openedAt: Date.now() });
    await kv.set('recents', recents);
  };

  /** Replace the open project. Returns false (and changes nothing) when the file cannot be used. */
  const load = async (text: string, name: string, ref: string | null, dirty = false): Promise<boolean> => {
    try {
      app.loadProject(parseProject(text), dirty);
    } catch (e) {
      if (!(e instanceof ProjectFileError)) throw e;
      fail(`"${name}" could not be opened. ${e.message}`, e);
      return false;
    }
    await remember(name, ref);
    if (!dirty) await kv.del('recovery');
    await app.resolveMedia?.();
    const offline = s.project.media.filter((m) => app.library.status(m.id) === 'offline').length;
    if (offline) s.notify(`${offline} media file${offline === 1 ? ' is' : 's are'} offline. Import the files again, or use Relink in the media bin.`);
    return true;
  };

  const saveAs = async (): Promise<boolean> => {
    try {
      const out = await app.files.saveAs(fileName(s.project.name === 'Untitled' ? s.seq.name : s.project.name), serializeProject(s.project));
      if (!out) return false;
      await remember(out.name, out.ref);
      s.history.markSaved();
      await kv.del('recovery');
      return true;
    } catch (e) {
      fail('The project could not be saved there. Your work is still open; try another location.', e);
      return false;
    }
  };
  const save = async (): Promise<boolean> => {
    if (!app.fileRef) return saveAs();
    try {
      await app.files.save(app.fileRef, serializeProject(s.project));
      s.history.markSaved();
      await kv.del('recovery');
      return true;
    } catch (e) {
      fail('The project could not be saved to its file (it may have been moved, or the disk is full). Use Save As to save it somewhere else.', e);
      return false;
    }
  };
  /** Before throwing away the open project. False = the user wants to stay. */
  const mayDiscard = async (): Promise<boolean> => {
    if (!s.history.dirty) return true;
    const answer = await ask('Unsaved changes', `Save the changes to "${s.project.name}" first?`, ['Save', "Don't Save", 'Cancel']);
    return answer === 'Save' ? save() : answer === "Don't Save";
  };

  const openRecent = async (): Promise<void> => {
    if (recents.length === 0) return s.notify('No recent projects yet.');
    const list = recents.map((r) => h('button', { style: 'display:block;width:100%;text-align:left;margin-bottom:4px', 'data-recent': r.ref, onclick: () => {
      chosen = r;
      (document.querySelector('.dialog [data-answer=Cancel]') as HTMLButtonElement | null)?.click();
    } }, `${r.name}  (${new Date(r.openedAt).toLocaleString()})`));
    let chosen: Recent | null = null;
    await ask('Recent projects', 'Choose a project to open.', ['Cancel'], list);
    const pick = chosen as Recent | null;
    if (!pick || !(await mayDiscard())) return;
    try {
      const f = await app.files.openRef(pick.ref);
      await load(f.text, f.name, f.ref);
    } catch (e) {
      recents = recents.filter((r) => r.ref !== pick.ref);
      await kv.set('recents', recents);
      fail(`"${pick.name}" could not be opened. It may have been moved or deleted, or access was not allowed.`, e);
    }
  };

  // Autosave: while there are unsaved changes, keep a recovery copy that outlives a crash.
  let autosavedAt = Date.now();
  const autosave = async (): Promise<void> => {
    if (Date.now() - autosavedAt < app.autosaveMs) return;
    autosavedAt = Date.now();
    if (s.history.dirty && s.project !== lastAutosaved) {
      lastAutosaved = s.project;
      const record: Recovery = { name: s.project.name, savedAt: Date.now(), text: serializeProject(s.project), ref: app.fileRef };
      if (!(await kv.set('recovery', record))) app.log.add('warning', 'Autosave could not be written.');
    }
  };
  window.setInterval(() => void autosave(), 1000);

  window.addEventListener('beforeunload', (e) => {
    if (s.history.dirty && !app.skipUnloadPrompt) e.preventDefault();
  });
  window.addEventListener('error', (e) => fail('Something went wrong. Your project is still open. Details are in the error log (Help, Export Error Log).', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => fail('Something went wrong. Your project is still open. Details are in the error log (Help, Export Error Log).', e.reason));
  let lastMessage: string | null = null;
  s.subscribe(() => {
    if (s.message && s.message !== lastMessage) app.log.add('warning', s.message);
    lastMessage = s.message;
    document.title = `${s.project.name}${s.history.dirty ? ' (unsaved)' : ''} - Cutline`;
  });
  const reported = new Set<number>();
  app.exports.subscribe(() => {
    for (const it of app.exports.items) {
      if (it.state !== 'failed' || reported.has(it.id)) continue;
      reported.add(it.id);
      app.log.add('error', `Export of ${it.job.fileName} failed.`, it.message ?? undefined);
    }
  });

  // Crash recovery: an autosave left behind means the last session did not end cleanly.
  const left = await kv.get<Recovery>('recovery');
  if (left) {
    const answer = await ask('Recover unsaved work?', `Cutline closed with unsaved changes to "${left.name}" (autosaved ${new Date(left.savedAt).toLocaleString()}).`, ['Recover', 'Discard']);
    if (answer === 'Recover') await load(left.text, left.name, left.ref, true);
    else await kv.del('recovery');
  }

  const openRef = async (ref: string): Promise<void> => {
    try {
      const f = await app.files.openRef(ref);
      await load(f.text, f.name, f.ref);
    } catch (e) {
      fail('That project could not be opened. It may have been moved or deleted.', e);
    }
  };
  const later = (job: () => Promise<unknown>) => (): void => void job().catch((e: unknown) => fail('That did not work. Your project is unchanged.', e));
  const actions: Action[] = [
    { id: 'file.new', label: 'New Project', menu: 'File', keys: ['Ctrl+Alt+N'], run: later(async () => (await mayDiscard()) && load(serializeProject(newProject()), 'Untitled', null)) },
    { id: 'file.open', label: 'Open Project…', menu: 'File', keys: ['Ctrl+O'], run: later(async () => {
      if (!(await mayDiscard())) return;
      const f = await app.files.open();
      if (f) await load(f.text, f.name, f.ref);
    }) },
    { id: 'file.recent', label: 'Open Recent…', menu: 'File', keys: ['Ctrl+Shift+O'], run: later(openRecent) },
    { id: 'file.save', label: 'Save', menu: 'File', keys: ['Ctrl+S'], run: later(save) },
    { id: 'file.saveAs', label: 'Save As…', menu: 'File', keys: ['Ctrl+Shift+S'], run: later(saveAs) },
    { id: 'help.exportLog', label: 'Export Error Log', menu: 'Help', keys: [], run: () => saveTextFile('cutline-log.txt', app.log.toText()) },
  ];
  return { actions, hooks: { mayDiscard, openRef } };
}
