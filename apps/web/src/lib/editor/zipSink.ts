/** Where a batch export's .zip is written as it's made: a file the member picked on disk. */
export interface ZipSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
interface WritableLike {
  write(c: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}
type Picker = (o: unknown) => Promise<{ createWritable(): Promise<WritableLike> }>;

/**
 * Asks where to save the zip, on browsers that can write straight to disk (Chrome and Edge on desktop), so
 * a big export never has to fit in memory. Returns null where that isn't possible. Call it first thing in
 * the click handler: the picker needs the click's user activation. Cancelling throws an AbortError.
 */
export async function pickZipSink(name: string): Promise<ZipSink | null> {
  const pick = (window as unknown as { showSaveFilePicker?: Picker }).showSaveFilePicker;
  if (typeof pick !== 'function') return null;
  const handle = await pick.call(window, {
    suggestedName: name,
    types: [{ description: 'Zip archive', accept: { 'application/zip': ['.zip'] } }],
  });
  const w = await handle.createWritable();
  return { write: (c) => w.write(c), close: () => w.close(), abort: () => w.abort() };
}
