// Desktop integration. Runs only inside the Electron shell, where preload.cjs provides `cutlineDesktop`.
// Swaps browser file handling for native dialogs and real paths, and finds a project's media again by path.
import { UrlSource } from '../engine/sourceSpec.ts';
import type { App } from './app.ts';
import type { OpenedFile, ProjectFiles } from './storage.ts';

interface DesktopApi {
  openProject(): Promise<OpenedFile | null>;
  readProject(ref: string): Promise<OpenedFile>;
  writeProject(ref: string, text: string): Promise<void>;
  saveProjectAs(name: string, text: string): Promise<{ name: string; ref: string } | null>;
  pathForFile(file: File): string;
  mediaInfo(path: string): Promise<{ size: number } | null>;
  pendingFile(): Promise<string | null>;
  onAction(fn: (id: string) => void): void;
  onOpenFile(fn: (path: string) => void): void;
  onRequestClose(fn: () => void): void;
  closeNow(): void;
}

export interface ProjectHooks {
  /** Ask about unsaved changes; false means the user wants to stay. */
  mayDiscard(): Promise<boolean>;
  /** Open a project by its ref (a path on desktop). */
  openRef(ref: string): Promise<void>;
}

export const desktopApi = (): DesktopApi | null => (window as unknown as { cutlineDesktop?: DesktopApi }).cutlineDesktop ?? null;

/** URL the shell serves a local media file under (it only serves paths it has been asked about). */
export const mediaUrl = (path: string): string => `${location.origin}/__media__/${encodeURIComponent(path)}`;

export function installDesktop(app: App, hooks: ProjectHooks): boolean {
  const api = desktopApi();
  if (!api) return false;
  const files: ProjectFiles = { open: () => api.openProject(), openRef: (ref) => api.readProject(ref), save: (ref, text) => api.writeProject(ref, text), saveAs: (name, text) => api.saveProjectAs(name, text) };
  app.files = files;
  app.pathOf = (file) => api.pathForFile(file) || file.name;
  // The shell asks before closing (below), so the browser's own leave-page prompt must stay out of the way.
  app.skipUnloadPrompt = true;
  // After a project is opened: bring back every media file that is still where the project says it is.
  app.resolveMedia = async () => {
    for (const asset of app.session.project.media) {
      const info = await api.mediaInfo(asset.path).catch(() => null);
      if (!info) continue;
      const url = mediaUrl(asset.path);
      const offline = await app.library.resolve([asset], async () => new UrlSource(url, info.size));
      if (offline.length === 0) app.attachUrl(asset.id, url, info.size);
    }
  };
  api.onAction((id) => app.run(id));
  const openPath = async (path: string): Promise<void> => {
    if (await hooks.mayDiscard()) await hooks.openRef(path);
  };
  api.onOpenFile((path) => void openPath(path));
  api.onRequestClose(() => void hooks.mayDiscard().then((ok) => ok && api.closeNow()));
  void api.pendingFile().then((path) => {
    if (path) void openPath(path);
  });
  return true;
}
