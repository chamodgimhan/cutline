// Persistent storage for the app: a tiny key-value store (IndexedDB) and project file access.
// The desktop shell replaces `projectFiles` with native dialogs and paths.

const DB = 'cutline';
const STORE = 'kv';

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return db().then((d) => new Promise<T>((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    t.oncomplete = () => {
      d.close();
      resolve(req.result);
    };
    t.onerror = t.onabort = () => {
      d.close();
      reject(t.error);
    };
  }));
}

/** Values survive restarts and crashes. Failures (private mode, full disk) resolve to "nothing stored". */
export const kv = {
  get: <T>(key: string): Promise<T | undefined> => tx<T | undefined>('readonly', (s) => s.get(key) as IDBRequest<T | undefined>).catch(() => undefined),
  set: (key: string, value: unknown): Promise<boolean> => tx('readwrite', (s) => s.put(value, key)).then(() => true, () => false),
  del: (key: string): Promise<void> => tx('readwrite', (s) => s.delete(key)).then(() => undefined, () => undefined),
};

export interface OpenedFile {
  name: string;
  text: string;
  /** Key under which this file can be reopened and saved to again; null when it can only be downloaded. */
  ref: string | null;
}

export interface ProjectFiles {
  /** Show an open dialog. Null when cancelled. */
  open(): Promise<OpenedFile | null>;
  /** Reopen a recent file. Throws when it is gone or access is refused. */
  openRef(ref: string): Promise<OpenedFile>;
  /** Write to a file opened or saved before. */
  save(ref: string, text: string): Promise<void>;
  /** Show a save dialog. Returns the new file's name and ref, or null when cancelled. */
  saveAs(suggestedName: string, text: string): Promise<{ name: string; ref: string | null } | null>;
}

type Picker = { showOpenFilePicker?: (o: object) => Promise<FileSystemFileHandle[]>; showSaveFilePicker?: (o: object) => Promise<FileSystemFileHandle> };
const TYPES = [{ description: 'Cutline project', accept: { 'application/json': ['.cutline'] } }];
const cancelled = (e: unknown): boolean => e instanceof DOMException && e.name === 'AbortError';
const handleKey = (ref: string): string => `handle:${ref}`;

async function write(handle: FileSystemFileHandle, text: string): Promise<void> {
  const w = await handle.createWritable();
  await w.write(text);
  await w.close();
}

/** Browser implementation: File System Access where available, otherwise upload and download. */
export const webProjectFiles: ProjectFiles = {
  async open() {
    const w = window as unknown as Picker;
    if (!w.showOpenFilePicker) {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.cutline,application/json';
        input.dataset.role = 'project-open';
        input.style.display = 'none';
        input.onchange = async () => {
          const f = input.files?.[0];
          input.remove();
          resolve(f ? { name: f.name, text: await f.text(), ref: null } : null);
        };
        input.oncancel = () => {
          input.remove();
          resolve(null);
        };
        document.body.append(input);
        input.click();
      });
    }
    try {
      const [handle] = await w.showOpenFilePicker({ types: TYPES });
      if (!handle) return null;
      const ref = `${handle.name}:${Date.now()}`;
      await kv.set(handleKey(ref), handle);
      return { name: handle.name, text: await (await handle.getFile()).text(), ref };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },
  async openRef(ref) {
    const handle = await kv.get<FileSystemFileHandle>(handleKey(ref));
    if (!handle) throw new Error('missing');
    const h = handle as FileSystemFileHandle & { requestPermission?: (o: object) => Promise<string> };
    if (h.requestPermission && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('denied');
    return { name: handle.name, text: await (await handle.getFile()).text(), ref };
  },
  async save(ref, text) {
    const handle = await kv.get<FileSystemFileHandle>(handleKey(ref));
    if (!handle) throw new Error('missing');
    await write(handle, text);
  },
  async saveAs(suggestedName, text) {
    const w = window as unknown as Picker;
    if (!w.showSaveFilePicker) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = suggestedName;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { name: suggestedName, ref: null };
    }
    try {
      const handle = await w.showSaveFilePicker({ suggestedName, types: TYPES });
      await write(handle, text);
      const ref = `${handle.name}:${Date.now()}`;
      await kv.set(handleKey(ref), handle);
      return { name: handle.name, ref };
    } catch (e) {
      if (cancelled(e)) return null;
      throw e;
    }
  },
};
