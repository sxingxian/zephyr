/**
 * GLSL ES 3.00 for the editor. The develop shader mirrors develop.ts line for line; keep them in step (a
 * browser test compares the two).
 *
 * Convention: every off-screen pass maps fragment row 0 to the TOP of the image (uv.y grows downwards), so
 * readPixels returns rows top-first and textures read back the right way up. Only the blit to the visible
 * canvas flips.
 */
export const VERT = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform vec2 u_size;
out vec4 o;
vec2 fragUv() { return gl_FragCoord.xy / u_size; }
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
float luma(vec3 c) { return dot(c, LUMA); }
float encG(float x) { return pow(max(x, 0.0), 1.0 / 2.2); }
float decG(float x) { return pow(max(x, 0.0), 2.2); }
vec3 encG3(vec3 c) { return pow(max(c, vec3(0.0)), vec3(1.0 / 2.2)); }
vec3 decG3(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }
vec3 toSrgb(vec3 x) {
  vec3 c = clamp(x, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
vec3 fromSrgb(vec3 x) {
  return mix(x / 12.92, pow((x + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), x));
}
`;

/** Source → output geometry. Writes linear light. `u_m` maps output uv to source uv (projective). */
export const GEOMETRY = `${HEAD}
uniform sampler2D u_src;
uniform mat3 u_m;
void main() {
  vec2 uv = fragUv();
  vec3 p = u_m * vec3(uv, 1.0);
  vec2 s = clamp(p.xy / p.z, vec2(0.0), vec2(1.0));
  o = vec4(texture(u_src, s).rgb, 1.0);
}`;

/** Luminance of the geometry output at low resolution (mip level chosen by the caller). */
export const LUM = `${HEAD}
uniform sampler2D u_src;
uniform float u_lod;
void main() {
  float l = luma(textureLod(u_src, fragUv(), u_lod).rgb);
  o = vec4(l, l, l, 1.0);
}`;

/** Separable Gaussian blur, 9 taps with linear sampling. */
export const BLUR = `${HEAD}
uniform sampler2D u_src;
uniform vec2 u_dir;
void main() {
  vec2 uv = fragUv();
  vec2 px = u_dir / u_size;
  vec3 c = texture(u_src, uv).rgb * 0.2270270270;
  c += texture(u_src, uv + px * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_src, uv - px * 1.3846153846).rgb * 0.3162162162;
  c += texture(u_src, uv + px * 3.2307692308).rgb * 0.0702702703;
  c += texture(u_src, uv - px * 3.2307692308).rgb * 0.0702702703;
  o = vec4(c, 1.0);
}`;

/** Develop: exposure, white balance, tone, vibrance/saturation, colour mixer, vignette → sRGB 8-bit. */
export const DEVELOP = `${HEAD}
uniform sampler2D u_src;
uniform sampler2D u_lum;
uniform float u_gain;
uniform vec3 u_wb;
uniform float u_highlights, u_shadows, u_whites, u_blacks, u_contrast;
uniform float u_vibrance, u_saturation, u_vignette;
uniform vec3 u_mixer[8];
uniform bool u_useMixer;
uniform vec4 u_region; // this render's part of the whole output (x, y, w, h)
uniform float u_split; // < 0: off; else output-uv x below which the original is shown

const float BH[8] = float[8](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0);

float tone(float y, float base) {
  float m = 0.7 * base + 0.3 * y;
  float wH = smoothstep(0.45, 0.95, m);
  float wS = 1.0 - smoothstep(0.05, 0.55, m);
  float stops = 1.2 * (u_highlights * wH + u_shadows * wS);
  float outv = encG(decG(y) * exp2(stops));
  outv += 0.22 * u_whites * smoothstep(0.55, 1.0, outv);
  outv += 0.16 * u_blacks * (1.0 - smoothstep(0.0, 0.4, outv));
  float pivot = 0.4587;
  float k = 1.0 + 0.6 * u_contrast;
  outv = pivot + (outv - pivot) * k;
  return max(outv, 0.0);
}

vec3 rgbToHsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  float h = 0.0;
  if (d > 1e-6) {
    if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h *= 60.0;
    if (h < 0.0) h += 360.0;
  }
  return vec3(h, mx > 1e-6 ? d / mx : 0.0, mx);
}
vec3 hsvToRgb(vec3 hsv) {
  float hh = mod(mod(hsv.x, 360.0) + 360.0, 360.0) / 60.0;
  float c = hsv.z * hsv.y;
  float x = c * (1.0 - abs(mod(hh, 2.0) - 1.0));
  float m = hsv.z - c;
  int i = int(min(floor(hh), 5.0));
  vec3 t;
  if (i == 0) t = vec3(c, x, 0.0);
  else if (i == 1) t = vec3(x, c, 0.0);
  else if (i == 2) t = vec3(0.0, c, x);
  else if (i == 3) t = vec3(0.0, x, c);
  else if (i == 4) t = vec3(x, 0.0, c);
  else t = vec3(c, 0.0, x);
  return t + m;
}
float bandWeight(float h, int i) {
  float c = BH[i];
  float prev = BH[(i + 7) % 8];
  float next = BH[(i + 1) % 8];
  float d = h - c;
  d = mod(mod(d + 180.0, 360.0) + 360.0, 360.0) - 180.0;
  float sn = mod(next - c + 360.0, 360.0); if (sn == 0.0) sn = 360.0;
  float sp = mod(c - prev + 360.0, 360.0); if (sp == 0.0) sp = 360.0;
  float span = d >= 0.0 ? sn : sp;
  float x = abs(d) / span;
  return x < 1.0 ? 0.5 + 0.5 * cos(3.14159265358979 * x) : 0.0;
}

void main() {
  vec2 uv = fragUv();
  vec3 src = texture(u_src, uv).rgb;
  if (u_split >= 0.0 && uv.x < u_split) { o = vec4(toSrgb(src), 1.0); return; }
  vec3 c = src * u_gain * u_wb;
  float lin = luma(c);
  float y = encG(lin);
  float base = encG(texture(u_lum, uv).r * u_gain);
  float y2 = tone(y, base);
  if (lin > 1e-5) c *= decG(y2) / lin; else c = vec3(decG(y2));
  float Y = luma(c);
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float sat = mx > 1e-5 ? (mx - mn) / mx : 0.0;
  float k = max(0.0, (1.0 + u_saturation) * (1.0 + u_vibrance * (1.0 - sat)));
  c = Y + (c - Y) * k;
  if (u_useMixer) {
    vec3 hsv = rgbToHsv(encG3(c));
    float dh = 0.0, ds = 0.0, dl = 0.0;
    for (int i = 0; i < 8; i++) {
      float w = bandWeight(hsv.x, i);
      dh += w * u_mixer[i].x; ds += w * u_mixer[i].y; dl += w * u_mixer[i].z;
    }
    float s2 = clamp(hsv.y * (1.0 + ds), 0.0, 1.0);
    float v2 = max(0.0, hsv.z * (1.0 + 0.5 * dl * hsv.y));
    c = decG3(hsvToRgb(vec3(hsv.x + 30.0 * dh, s2, v2)));
  }
  if (u_vignette != 0.0) {
    vec2 g = u_region.xy + uv * u_region.zw;
    vec2 dd = (g - 0.5) * 2.0;
    float d = length(dd) / 1.41421356;
    c *= 1.0 + 0.85 * u_vignette * smoothstep(0.35, 1.0, d);
  }
  o = vec4(toSrgb(max(c, vec3(0.0))), 1.0);
}`;

/** Edge-preserving noise reduction (5×5 bilateral) on the sRGB image. Radius scales with output size. */
export const DENOISE = `${HEAD}
uniform sampler2D u_src;
uniform float u_amount; // 0…1
uniform float u_scale;  // output long edge / 2048
uniform float u_split;
void main() {
  vec2 uv = fragUv();
  vec4 c0 = texture(u_src, uv);
  if (u_split >= 0.0 && uv.x < u_split) { o = c0; return; }
  vec2 px = max(0.5, u_scale) / u_size;
  float sr = 0.02 + 0.10 * u_amount;
  vec3 acc = vec3(0.0); float wsum = 0.0;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    vec3 s = texture(u_src, uv + vec2(float(i), float(j)) * px).rgb;
    vec3 d = s - c0.rgb;
    float w = exp(-float(i * i + j * j) / 4.5) * exp(-dot(d, d) / (2.0 * sr * sr));
    acc += s * w; wsum += w;
  }
  o = vec4(mix(c0.rgb, acc / wsum, clamp(u_amount * 1.2, 0.0, 1.0)), 1.0);
}`;

/** Unsharp mask on luminance. */
export const SHARPEN = `${HEAD}
uniform sampler2D u_src;
uniform float u_amount; // 0…1.5
uniform float u_scale;
uniform float u_split;
void main() {
  vec2 uv = fragUv();
  vec4 c0 = texture(u_src, uv);
  if (u_split >= 0.0 && uv.x < u_split) { o = c0; return; }
  vec2 px = max(0.5, u_scale) / u_size;
  vec3 b = c0.rgb * 0.25;
  b += texture(u_src, uv + vec2(px.x, 0.0)).rgb * 0.125;
  b += texture(u_src, uv - vec2(px.x, 0.0)).rgb * 0.125;
  b += texture(u_src, uv + vec2(0.0, px.y)).rgb * 0.125;
  b += texture(u_src, uv - vec2(0.0, px.y)).rgb * 0.125;
  b += texture(u_src, uv + px).rgb * 0.0625;
  b += texture(u_src, uv - px).rgb * 0.0625;
  b += texture(u_src, uv + vec2(px.x, -px.y)).rgb * 0.0625;
  b += texture(u_src, uv + vec2(-px.x, px.y)).rgb * 0.0625;
  float detail = luma(c0.rgb) - luma(b);
  o = vec4(clamp(c0.rgb + u_amount * 1.4 * detail, 0.0, 1.0), 1.0);
}`;
