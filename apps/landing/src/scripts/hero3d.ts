/**
 * The hero's three.js scene: sample photos stream through a wind tunnel towards the viewer, drifting with
 * the pointer and speeding up as you scroll. It replaces the CSS tunnel poster only on capable devices,
 * after the page is idle, and stops rendering whenever the hero is off-screen or the tab is hidden.
 */
import {
  LinearMipmapLinearFilter,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Timer,
  WebGLRenderer,
} from 'three';

const KINDS = [
  'peaks',
  'sea',
  'couple',
  'city',
  'bloom',
  'product',
  'dunes',
  'interior',
  'portrait',
  'forest',
  'food',
  'dusk',
  'pet',
  'sneaker',
];
const COUNT = 34;
const FAR = -46;
const NEAR = 4.2;

const vertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
// Rounded-corner card with a soft fade in the distance and as it passes the camera.
const fragment = /* glsl */ `
  uniform sampler2D map;
  uniform float opacity;
  uniform vec2 size;
  varying vec2 vUv;
  float roundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  }
  void main() {
    vec2 p = (vUv - 0.5) * size;
    float d = roundedBox(p, size * 0.5, 0.08);
    float edge = 1.0 - smoothstep(-0.006, 0.006, d);
    vec4 c = texture2D(map, vUv);
    gl_FragColor = vec4(c.rgb, c.a * edge * opacity);
    #include <colorspace_fragment>
  }
`;

export function canRunHero3d(): boolean {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  const nav = navigator as Navigator & { connection?: { saveData?: boolean }; deviceMemory?: number };
  if (nav.connection?.saveData) return false;
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory < 4) return false;
  try {
    return Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    return false;
  }
}

export async function startHero3d(canvas: HTMLCanvasElement, hero: HTMLElement): Promise<void> {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 6);

  const loader = new TextureLoader();
  const textures = await Promise.all(
    KINDS.map(
      (k) =>
        new Promise<Texture>((resolve, reject) => {
          loader.load(`/brand/samples/${k}.svg`, resolve, undefined, reject);
        }),
    ),
  );
  for (const t of textures) {
    t.colorSpace = SRGBColorSpace;
    t.minFilter = LinearMipmapLinearFilter;
    t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  }

  const geo = new PlaneGeometry(1.5, 1.04);
  let seed = 7;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const cards = Array.from({ length: COUNT }, (_, i) => {
    const material = new ShaderMaterial({
      uniforms: {
        map: { value: textures[i % textures.length] },
        opacity: { value: 0 },
        size: { value: [1.5, 1.04] },
      },
      vertexShader: vertex,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
    });
    const mesh = new Mesh(geo, material);
    const angle = (i / COUNT) * Math.PI * 2 + rnd() * 0.5;
    const radius = 2.1 + rnd() * 2.2;
    mesh.userData = { angle, radius, spin: (rnd() - 0.5) * 0.3, tilt: (rnd() - 0.5) * 0.4 };
    mesh.position.set(
      Math.cos(angle) * radius * 1.45,
      Math.sin(angle) * radius * 0.8,
      FAR + (i / COUNT) * (NEAR - FAR),
    );
    mesh.rotation.z = mesh.userData.tilt;
    scene.add(mesh);
    return mesh;
  });

  const resize = () => {
    const w = hero.clientWidth;
    const h = hero.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  new ResizeObserver(resize).observe(hero);

  // Pointer drift and scroll boost
  const pointer = { x: 0, y: 0 };
  window.addEventListener(
    'pointermove',
    (e) => {
      pointer.x = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.y = (e.clientY / window.innerHeight - 0.5) * 2;
    },
    { passive: true },
  );
  let lastY = window.scrollY;
  let boost = 0;

  let visible = true;
  new IntersectionObserver(([e]) => {
    visible = Boolean(e?.isIntersecting);
    if (visible) loop();
  }).observe(hero);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loop();
  });

  const timer = new Timer();
  timer.connect(document);
  let raf = 0;
  let first = true;
  function frame(now: number) {
    raf = 0;
    if (!visible || document.hidden) return;
    timer.update(now);
    const dt = Math.min(timer.getDelta(), 0.05);
    const y = window.scrollY;
    boost = boost * 0.92 + Math.min(Math.abs(y - lastY) * 0.02, 6) * 0.08;
    lastY = y;
    const speed = 3.2 + boost * 6;
    for (const m of cards) {
      m.position.z += speed * dt;
      if (m.position.z > NEAR) m.position.z = FAR;
      m.rotation.z += m.userData.spin * dt * 0.2;
      const t = (m.position.z - FAR) / (NEAR - FAR);
      const fade = Math.min(1, t / 0.18) * Math.min(1, (1 - t) / 0.12);
      const u = (m.material as ShaderMaterial).uniforms.opacity;
      if (u) u.value = 0.92 * Math.max(0, fade);
    }
    camera.position.x += (pointer.x * 0.45 - camera.position.x) * 0.05;
    camera.position.y += (-pointer.y * 0.3 - camera.position.y) * 0.05;
    camera.lookAt(0, 0, FAR / 2);
    renderer.render(scene, camera);
    if (first) {
      first = false;
      document.documentElement.classList.add('gl-ready');
    }
    loop();
  }
  function loop() {
    if (!raf) raf = requestAnimationFrame(frame);
  }
  loop();
}
