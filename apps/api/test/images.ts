/**
 * In-memory stand-in for the Cloudflare Images binding: records each pipeline (transform and draw options,
 * output format) and returns small fake images with the right magic bytes. `fail` makes outputs throw.
 */
const enc = new TextEncoder();
const MAGIC: Record<string, number[]> = {
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
};

async function readAll(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function sniff(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (String.fromCharCode(...b.subarray(8, 12)) === 'WEBP') return 'image/webp';
  return null;
}

export interface Pipeline {
  inputBytes: number;
  ops: (['transform', unknown] | ['draw', unknown, Pipeline | null])[];
  output?: { format: string; quality?: number };
}

export const images = {
  pipelines: [] as Pipeline[],
  fail: false,
  /** What info() reports for any recognised image. */
  info: { width: 800, height: 600 },
  reset() {
    this.pipelines = [];
    this.fail = false;
    this.info = { width: 800, height: 600 };
  },
};

function transformer(input: ReadableStream<Uint8Array>) {
  const p: Pipeline = { inputBytes: 0, ops: [] };
  const t = {
    pipeline: p,
    transform(o: unknown) {
      p.ops.push(['transform', o]);
      return t;
    },
    draw(img: unknown, o: unknown) {
      const inner = (img as { pipeline?: Pipeline }).pipeline ?? null;
      p.ops.push(['draw', o, inner]);
      return t;
    },
    async output(o: { format: string; quality?: number }) {
      const bytes = await readAll(input);
      p.inputBytes = bytes.byteLength;
      if (images.fail || !sniff(bytes)) throw new Error('images: 9412 not an image');
      p.output = o;
      images.pipelines.push(p);
      const body = new Uint8Array([
        ...(MAGIC[o.format] ?? [0]),
        ...enc.encode(JSON.stringify({ ops: p.ops.length, n: images.pipelines.length })),
      ]);
      return {
        response: () => new Response(body, { headers: { 'Content-Type': o.format } }),
        contentType: () => o.format,
        image: () => new Response(body).body as ReadableStream<Uint8Array>,
      };
    },
  };
  return t;
}

export const imagesBinding = {
  async info(stream: ReadableStream<Uint8Array>) {
    const b = await readAll(stream);
    const format = sniff(b);
    if (!format) throw new Error('images: 9412 not an image');
    return { format, fileSize: b.byteLength, ...images.info };
  },
  input: (stream: ReadableStream<Uint8Array>) => transformer(stream),
} as unknown as ImagesBinding;
