import type { CropRect, EditRecipe } from '@zephyr/shared/client';
import { developParams } from './develop';
import { fitLongEdge, type Mat3, outputToSource, type Size } from './geometry';
import { BLUR, DENOISE, DEVELOP, GEOMETRY, LUM, SHARPEN, VERT } from './shaders';

/**
 * The editor's WebGL 2 pipeline: geometry → (luminance mask) → develop → denoise → sharpen. One instance
 * renders the live view, thumbnails and exports, so a photo looks the same everywhere.
 *
 * The geometry result and luminance mask are cached per crop and size, so dragging a light or colour slider
 * only re-runs the develop and detail passes.
 */
export type Source =
  | {
      kind: 'bitmap';
      bitmap: ImageBitmap | HTMLCanvasElement | OffscreenCanvas;
      width: number;
      height: number;
    }
  /** Linear RGBA half floats (RAW), top row first. */
  | { kind: 'half'; data: Uint16Array; width: number; height: number };

export interface RenderOptions {
  recipe: EditRecipe | null;
  /** Output size in pixels (the crop is scaled to fit it). */
  width: number;
  height: number;
  /** Show the whole transformed image (crop tool) instead of the crop. */
  ignoreRect?: boolean;
  /** Original on the left of this output x (0–1); off when undefined. */
  split?: number;
  /** Develop nothing (the "Before" view still applies no geometry either when `raw` is set). */
  before?: boolean;
  /** Exposure added for RAW sources (their linear data has no camera tone curve). */
  baselineEv?: number;
}

const LUM_EDGE = 64;
const MAX_TILE = 2048;
const PAD = 8;

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
  format: 'float' | 'srgb' | 'rgba8';
}

/** Whether this browser can run the editor (WebGL 2). */
export function supportsEditor(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    const ok = Boolean(gl);
    (gl?.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
    return ok;
  } catch {
    return false;
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private floatTargets: boolean;
  private progs = new Map<string, WebGLProgram>();
  private uniformCache = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private vbo: WebGLBuffer;
  private src: WebGLTexture | null = null;
  private srcSize: Size = { width: 1, height: 1 };
  private srcMipmapped = false;
  private targets = new Map<string, Target>();
  private geomKey = '';
  private lost = false;
  readonly maxTexture: number;

  constructor(canvas?: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas =
      canvas ??
      (typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas'));
    const gl = this.canvas.getContext('webgl2', {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error('WebGL 2 is not available');
    this.gl = gl;
    this.floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'));
    gl.getExtension('OES_texture_float_linear');
    this.maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const vbo = gl.createBuffer();
    if (!vbo) throw new Error('WebGL buffer');
    this.vbo = vbo;
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    if ('addEventListener' in this.canvas) {
      (this.canvas as HTMLCanvasElement).addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        this.lost = true;
      });
    }
  }

  get isLost(): boolean {
    return this.lost || this.gl.isContextLost();
  }
  get sourceSize(): Size {
    return this.srcSize;
  }

  // ------------------------------------------------------------ programs
  private program(name: string, frag: string): WebGLProgram {
    const have = this.progs.get(name);
    if (have) return have;
    const gl = this.gl;
    const sh = (type: number, text: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error('shader');
      gl.shaderSource(s, text);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`${name}: ${gl.getShaderInfoLog(s)}`);
      return s;
    };
    const p = gl.createProgram();
    if (!p) throw new Error('program');
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`${name}: ${gl.getProgramInfoLog(p)}`);
    this.progs.set(name, p);
    this.uniformCache.set(p, new Map());
    return p;
  }
  private u(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    const cache = this.uniformCache.get(p) as Map<string, WebGLUniformLocation | null>;
    if (!cache.has(name)) cache.set(name, this.gl.getUniformLocation(p, name));
    return cache.get(name) ?? null;
  }
  private draw(
    p: WebGLProgram,
    target: Target | null,
    w: number,
    h: number,
    setup: (p: WebGLProgram) => void,
  ) {
    const gl = this.gl;
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
    gl.useProgram(p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.uniform2f(this.u(p, 'u_size'), w, h);
    setup(p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
  private bindTex(p: WebGLProgram, name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.u(p, name), unit);
  }

  // ------------------------------------------------------------ textures
  private target(key: string, w: number, h: number, format: Target['format'], mip = false): Target {
    const have = this.targets.get(key);
    if (have && have.w === w && have.h === h && have.format === format) return have;
    const gl = this.gl;
    if (have) {
      gl.deleteFramebuffer(have.fb);
      gl.deleteTexture(have.tex);
    }
    const tex = gl.createTexture();
    const fb = gl.createFramebuffer();
    if (!tex || !fb) throw new Error('WebGL target');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mip ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    const internal = format === 'float' ? gl.RGBA16F : format === 'srgb' ? gl.SRGB8_ALPHA8 : gl.RGBA8;
    gl.texStorage2D(gl.TEXTURE_2D, levels, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const t = { fb, tex, w, h, format };
    this.targets.set(key, t);
    return t;
  }
  /** Linear-light intermediate: half float where renderable, else sRGB-encoded 8-bit. */
  private linearFormat(): Target['format'] {
    return this.floatTargets ? 'float' : 'srgb';
  }

  /** Uploads the photo. Replaces any previous source and drops cached results. */
  setSource(s: Source): void {
    const gl = this.gl;
    if (this.src) gl.deleteTexture(this.src);
    const tex = gl.createTexture();
    if (!tex) throw new Error('WebGL texture');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const levels = Math.floor(Math.log2(Math.max(s.width, s.height))) + 1;
    if (s.kind === 'bitmap') {
      gl.texStorage2D(gl.TEXTURE_2D, levels, gl.SRGB8_ALPHA8, s.width, s.height);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, s.bitmap as TexImageSource);
      gl.generateMipmap(gl.TEXTURE_2D);
      this.srcMipmapped = true;
    } else {
      // Half-float mipmaps need float render targets.
      const mip = this.floatTargets;
      gl.texStorage2D(gl.TEXTURE_2D, mip ? levels : 1, gl.RGBA16F, s.width, s.height);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, s.width, s.height, gl.RGBA, gl.HALF_FLOAT, s.data);
      if (mip) gl.generateMipmap(gl.TEXTURE_2D);
      this.srcMipmapped = mip;
    }
    gl.texParameteri(
      gl.TEXTURE_2D,
      gl.TEXTURE_MIN_FILTER,
      this.srcMipmapped ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
    );
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.src = tex;
    this.srcSize = { width: s.width, height: s.height };
    this.geomKey = '';
  }
  get hasSource(): boolean {
    return Boolean(this.src);
  }

  // ------------------------------------------------------------ passes
  private geometry(target: Target, m: Mat3) {
    const p = this.program('geom', GEOMETRY);
    this.draw(p, target, target.w, target.h, (p) => {
      this.bindTex(p, 'u_src', 0, this.src as WebGLTexture);
      // mat3 uniforms are column-major: transpose our row-major matrix.
      this.gl.uniformMatrix3fv(this.u(p, 'u_m'), true, new Float32Array(m));
    });
  }
  /** Low-resolution blurred luminance of a geometry result. */
  private lumMask(geom: Target, key: string): Target {
    const gl = this.gl;
    const size = fitLongEdge({ width: geom.w, height: geom.h }, LUM_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, geom.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    const fmt = this.linearFormat();
    const a = this.target(`${key}:lumA`, size.width, size.height, fmt);
    const b = this.target(`${key}:lumB`, size.width, size.height, fmt);
    const lod = Math.max(0, Math.log2(Math.max(geom.w / size.width, geom.h / size.height)));
    this.draw(this.program('lum', LUM), a, a.w, a.h, (p) => {
      this.bindTex(p, 'u_src', 0, geom.tex);
      gl.uniform1f(this.u(p, 'u_lod'), lod);
    });
    const blur = this.program('blur', BLUR);
    for (const [from, to, dir] of [
      [a, b, [1, 0]],
      [b, a, [0, 1]],
      [a, b, [1.6, 0]],
      [b, a, [0, 1.6]],
    ] as [Target, Target, [number, number]][]) {
      this.draw(blur, to, to.w, to.h, (p) => {
        this.bindTex(p, 'u_src', 0, from.tex);
        gl.uniform2f(this.u(p, 'u_dir'), dir[0], dir[1]);
      });
    }
    return a;
  }

  private develop(
    geom: Target,
    lum: Target,
    out: Target,
    recipe: EditRecipe | null,
    region: CropRect,
    aspect: number,
    split: number,
    baselineEv: number,
  ) {
    const gl = this.gl;
    const d = developParams(recipe, aspect, baselineEv);
    this.draw(this.program('develop', DEVELOP), out, out.w, out.h, (p) => {
      this.bindTex(p, 'u_src', 0, geom.tex);
      this.bindTex(p, 'u_lum', 1, lum.tex);
      gl.uniform1f(this.u(p, 'u_gain'), d.gain);
      gl.uniform3f(this.u(p, 'u_wb'), d.wb[0], d.wb[1], d.wb[2]);
      gl.uniform1f(this.u(p, 'u_highlights'), d.highlights);
      gl.uniform1f(this.u(p, 'u_shadows'), d.shadows);
      gl.uniform1f(this.u(p, 'u_whites'), d.whites);
      gl.uniform1f(this.u(p, 'u_blacks'), d.blacks);
      gl.uniform1f(this.u(p, 'u_contrast'), d.contrast);
      gl.uniform1f(this.u(p, 'u_vibrance'), d.vibrance);
      gl.uniform1f(this.u(p, 'u_saturation'), d.saturation);
      gl.uniform1f(this.u(p, 'u_vignette'), d.vignette);
      gl.uniform3fv(this.u(p, 'u_mixer'), new Float32Array(d.mixer.flat()));
      gl.uniform1i(this.u(p, 'u_useMixer'), d.mixer.some(([a, s, l]) => a || s || l) ? 1 : 0);
      gl.uniform4f(this.u(p, 'u_region'), region.x, region.y, region.w, region.h);
      gl.uniform1f(this.u(p, 'u_split'), split);
    });
  }

  /** Denoise and sharpen in place (ping-pong between two 8-bit targets). Returns the result target. */
  private detail(src: Target, key: string, recipe: EditRecipe | null, scale: number, split: number): Target {
    const gl = this.gl;
    const nr = (recipe?.detail?.noiseReduction ?? 0) / 100;
    const sh = (recipe?.detail?.sharpening ?? 0) / 100;
    let cur = src;
    if (nr > 0) {
      const t = this.target(`${key}:dn`, src.w, src.h, 'rgba8');
      this.draw(this.program('denoise', DENOISE), t, t.w, t.h, (p) => {
        this.bindTex(p, 'u_src', 0, cur.tex);
        gl.uniform1f(this.u(p, 'u_amount'), nr);
        gl.uniform1f(this.u(p, 'u_scale'), scale);
        gl.uniform1f(this.u(p, 'u_split'), split);
      });
      cur = t;
    }
    if (sh > 0) {
      const t = this.target(cur === src ? `${key}:dn` : `${key}:sh`, src.w, src.h, 'rgba8');
      const from = cur;
      this.draw(this.program('sharpen', SHARPEN), t, t.w, t.h, (p) => {
        this.bindTex(p, 'u_src', 0, from.tex);
        gl.uniform1f(this.u(p, 'u_amount'), sh);
        gl.uniform1f(this.u(p, 'u_scale'), scale);
        gl.uniform1f(this.u(p, 'u_split'), split);
      });
      cur = t;
    }
    return cur;
  }

  /**
   * Renders into an 8-bit target (rows top-first) and returns it. The geometry pass and mask are reused
   * when only develop settings changed.
   */
  private renderTo(key: string, o: RenderOptions): Target {
    if (!this.src) throw new Error('No source');
    const recipe = o.before ? null : o.recipe;
    const crop = o.before ? undefined : o.recipe?.crop;
    const gk = `${key}|${o.width}x${o.height}|${o.ignoreRect ? 1 : 0}|${JSON.stringify(crop ?? null)}`;
    const geom = this.target(`${key}:geom`, o.width, o.height, this.linearFormat(), true);
    if (gk !== this.geomKey || key !== 'view') {
      this.geometry(geom, outputToSource(crop, this.srcSize, { ignoreRect: o.ignoreRect }));
      this.lumMask(geom, key);
      if (key === 'view') this.geomKey = gk;
    }
    const lum = this.targets.get(`${key}:lumA`) as Target;
    const out = this.target(`${key}:out`, o.width, o.height, 'rgba8');
    const split = o.split === undefined ? -1 : o.split;
    this.develop(
      geom,
      lum,
      out,
      recipe,
      { x: 0, y: 0, w: 1, h: 1 },
      o.width / o.height,
      split,
      o.baselineEv ?? 0,
    );
    const scale = Math.max(o.width, o.height) / 2048;
    return this.detail(out, key, recipe, scale, split);
  }

  /** Draws to the visible canvas (resizing it) and returns the 8-bit result for the histogram. */
  renderView(o: RenderOptions): void {
    const gl = this.gl;
    const t = this.renderTo('view', o);
    const c = this.canvas;
    if (c.width !== o.width || c.height !== o.height) {
      c.width = o.width;
      c.height = o.height;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    // Flip: our targets store the top row first, the canvas shows row 0 at the bottom.
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, t.h, t.w, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    this.lastView = t;
  }
  private lastView: Target | null = null;

  /** 64-bin RGB + luminance histogram of the last view render (sampled at ≤ 160 px). */
  histogram(): { r: Uint32Array; g: Uint32Array; b: Uint32Array; l: Uint32Array } | null {
    const t = this.lastView;
    if (!t) return null;
    const gl = this.gl;
    const s = fitLongEdge({ width: t.w, height: t.h }, 160);
    const small = this.target('hist', s.width, s.height, 'rgba8');
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, t.fb);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, small.fb);
    gl.blitFramebuffer(0, 0, t.w, t.h, 0, 0, s.width, s.height, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    const px = new Uint8Array(s.width * s.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, small.fb);
    gl.readPixels(0, 0, s.width, s.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const r = new Uint32Array(64);
    const g = new Uint32Array(64);
    const b = new Uint32Array(64);
    const l = new Uint32Array(64);
    for (let i = 0; i < px.length; i += 4) {
      const R = px[i] as number;
      const G = px[i + 1] as number;
      const B = px[i + 2] as number;
      (r[R >> 2] as number)++;
      (g[G >> 2] as number)++;
      (b[B >> 2] as number)++;
      (l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B) >> 2] as number)++;
    }
    return { r, g, b, l };
  }

  /** Renders off-screen and reads back RGBA8 pixels (top row first). For thumbnails and small outputs. */
  renderPixels(o: RenderOptions): Uint8Array {
    if (Math.max(o.width, o.height) > MAX_TILE) return this.renderTiled(o);
    const gl = this.gl;
    const t = this.renderTo('px', o);
    const px = new Uint8Array(t.w * t.h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  }

  /**
   * Full-size export in tiles of ≤ 2048 px, each with an 8 px border so denoise and sharpen see their
   * neighbours. The luminance mask comes from one low-resolution pass over the whole crop.
   */
  renderTiled(o: RenderOptions): Uint8Array {
    if (!this.src) throw new Error('No source');
    const gl = this.gl;
    const recipe = o.recipe;
    const crop = recipe?.crop;
    const W = o.width;
    const H = o.height;
    const out = new Uint8Array(W * H * 4);
    // Global mask from a modest whole-image geometry render.
    const gsz = fitLongEdge({ width: W, height: H }, 1024);
    const ggeom = this.target('tile:global', gsz.width, gsz.height, this.linearFormat(), true);
    this.geometry(ggeom, outputToSource(crop, this.srcSize, { ignoreRect: o.ignoreRect }));
    const lum = this.lumMask(ggeom, 'tile:global');
    const scale = Math.max(W, H) / 2048;
    const step = MAX_TILE - 2 * PAD;
    for (let y0 = 0; y0 < H; y0 += step) {
      for (let x0 = 0; x0 < W; x0 += step) {
        const iw = Math.min(step, W - x0);
        const ih = Math.min(step, H - y0);
        const px0 = Math.max(0, x0 - PAD);
        const py0 = Math.max(0, y0 - PAD);
        const px1 = Math.min(W, x0 + iw + PAD);
        const py1 = Math.min(H, y0 + ih + PAD);
        const tw = px1 - px0;
        const th = py1 - py0;
        const region = { x: px0 / W, y: py0 / H, w: tw / W, h: th / H };
        const geom = this.target('tile:geom', tw, th, this.linearFormat());
        this.geometry(geom, outputToSource(crop, this.srcSize, { ignoreRect: o.ignoreRect, region }));
        // The mask is sampled by tile uv: give develop a mask cut to this tile.
        const tileLum = this.target(
          'tile:lum',
          Math.max(2, Math.round(lum.w * region.w)),
          Math.max(2, Math.round(lum.h * region.h)),
          this.linearFormat(),
        );
        this.draw(this.program('geom', GEOMETRY), tileLum, tileLum.w, tileLum.h, (p) => {
          this.bindTex(p, 'u_src', 0, lum.tex);
          gl.uniformMatrix3fv(
            this.u(p, 'u_m'),
            true,
            new Float32Array([region.w, 0, region.x, 0, region.h, region.y, 0, 0, 1]),
          );
        });
        const dev = this.target('tile:out', tw, th, 'rgba8');
        this.develop(geom, tileLum, dev, recipe, region, W / H, -1, o.baselineEv ?? 0);
        const fin = this.detail(dev, 'tile', recipe, scale, -1);
        const buf = new Uint8Array(tw * th * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fin.fb);
        gl.readPixels(0, 0, tw, th, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const ox = x0 - px0;
        const oy = y0 - py0;
        for (let row = 0; row < ih; row++) {
          const s = ((oy + row) * tw + ox) * 4;
          out.set(buf.subarray(s, s + iw * 4), ((y0 + row) * W + x0) * 4);
        }
      }
    }
    return out;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of this.targets.values()) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.targets.clear();
    if (this.src) gl.deleteTexture(this.src);
    this.src = null;
    for (const p of this.progs.values()) gl.deleteProgram(p);
    this.progs.clear();
    gl.deleteBuffer(this.vbo);
    (gl.getExtension('WEBGL_lose_context') as { loseContext?: () => void } | null)?.loseContext?.();
  }
}
