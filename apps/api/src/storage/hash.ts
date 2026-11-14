/**
 * SHA-256 of a stream while it flows: Workers' crypto.DigestStream where it exists (no buffering), and a
 * buffering fallback with subtle.digest elsewhere (tests under Node).
 */

interface DigestStreamLike extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}
type DigestCtor = new (algorithm: string) => DigestStreamLike;
const DigestStreamCtor = (crypto as unknown as { DigestStream?: DigestCtor }).DigestStream;

function sink(): { write(chunk: Uint8Array): Promise<void>; finish(): Promise<string>; abort(): void } {
  if (DigestStreamCtor) {
    const ds = new DigestStreamCtor('SHA-256');
    const w = ds.getWriter();
    return {
      write: (chunk) => w.write(chunk),
      finish: async () => {
        await w.close();
        return hex(await ds.digest);
      },
      abort: () => {
        w.abort().catch(() => undefined);
      },
    };
  }
  const chunks: Uint8Array[] = [];
  let n = 0;
  return {
    write: async (chunk) => {
      chunks.push(chunk.slice());
      n += chunk.byteLength;
    },
    finish: async () => {
      const all = new Uint8Array(n);
      let o = 0;
      for (const c of chunks) {
        all.set(c, o);
        o += c.byteLength;
      }
      return hex(await crypto.subtle.digest('SHA-256', all));
    },
    abort: () => undefined,
  };
}

export const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Passes `src` through unchanged and resolves `digest` (hex) and `bytes` once it has been read to the end.
 * The digest rejects if the stream errors or is cancelled.
 */
export function hashing(src: ReadableStream<Uint8Array>): {
  stream: ReadableStream<Uint8Array>;
  result: Promise<{ digest: string; bytes: number }>;
} {
  const h = sink();
  let bytes = 0;
  let settle!: (v: { digest: string; bytes: number }) => void;
  let fail!: (e: unknown) => void;
  const result = new Promise<{ digest: string; bytes: number }>((res, rej) => {
    settle = res;
    fail = rej;
  });
  result.catch(() => undefined);
  const stream = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, ctrl) {
        await h.write(chunk);
        bytes += chunk.byteLength;
        ctrl.enqueue(chunk);
      },
      async flush() {
        try {
          settle({ digest: await h.finish(), bytes });
        } catch (err) {
          fail(err);
        }
      },
      cancel(reason) {
        h.abort();
        fail(reason ?? new Error('cancelled'));
      },
    }),
  );
  return { stream, result };
}

/** Reads a stream to the end and returns its SHA-256 (hex) and length. */
export async function digestOf(src: ReadableStream<Uint8Array>): Promise<{ digest: string; bytes: number }> {
  const h = sink();
  let bytes = 0;
  const reader = src.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        await h.write(value);
        bytes += value.byteLength;
      }
    }
  } catch (err) {
    h.abort();
    throw err;
  }
  return { digest: await h.finish(), bytes };
}
