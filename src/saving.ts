/**
 * The save of one open copy: the rules, with the store and the write passed
 * in (App passes `loadedFiles` and `saveFileText`). DESIGN.md「状态机清单」#4.
 */
import { canSaveFile, type LoadedFile } from "./workspace";

/** Where App keeps its open copies, by path (`loadedFiles`). */
export interface FileStore {
  get(filePath: string): LoadedFile | undefined;
  set(filePath: string, file: LoadedFile): void;
}

/** Writes `text` for `file` and returns the saved copy; throws when the write fails. */
export type SaveWriter = (file: LoadedFile, text: string) => Promise<LoadedFile>;

/** `skipped`: nothing to write (clean, closed, or a copy that may never be saved). */
export type SaveOutcome = "saved" | "skipped" | "failed";

/** The message a failed save or open shows: what failed, on which file. */
export function describeFailure(action: "save" | "open", file: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Could not ${action} ${file}: ${reason}`;
}

/**
 * The copy after its save finished, from the copy the store holds now: typing
 * during the write stays (newest text, still dirty against what was written),
 * and so does the mode.
 */
export function settleSavedCopy(latest: LoadedFile, saved: LoadedFile): LoadedFile {
  return {
    ...saved,
    mode: latest.mode,
    text: latest.text,
    dirty: latest.text !== saved.savedText,
  };
}

/**
 * Save the copy at `filePath` when it has unsaved edits and may be saved. A
 * failure is kept on the copy (`saveError`), which stays dirty; a copy closed
 * while its write was in flight is not put back. Never throws.
 */
export async function saveInStore(
  store: FileStore,
  filePath: string,
  write: SaveWriter
): Promise<SaveOutcome> {
  const file = store.get(filePath);
  if (!file || !file.dirty || !canSaveFile(file)) return "skipped";
  let saved: LoadedFile;
  try {
    saved = await write(file, file.text);
  } catch (error) {
    const latest = store.get(filePath);
    if (latest) store.set(filePath, { ...latest, saveError: describeFailure("save", filePath, error) });
    return "failed";
  }
  const latest = store.get(filePath);
  if (latest) store.set(filePath, settleSavedCopy(latest, saved));
  return "saved";
}
