// Zephyr shared design kit: tokens, icons, mascot, logo, sample photos, components, page wrapper.
// Every artboard in every Zephyr canvas is generated from these parts so the system stays consistent.
'use strict';

const FONT = "'Geist', -apple-system, 'SF Pro Text', system-ui, sans-serif";
const MONO = "'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace";
const FONT_LINK = '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&amp;family=Geist+Mono:wght@400;500;600&amp;display=swap">';

// ---------- Colour tokens (UI) ----------
const LIGHT = {
  bg: '#F4F6F9', bg2: '#ECEFF4', surf: '#FFFFFF', surf2: '#F7F8FB', ink: '#0D1117', ink2: '#2A313C', muted: '#566070',
  line: 'rgba(13,17,23,0.09)', line2: 'rgba(13,17,23,0.16)', hover: 'rgba(13,17,23,0.05)',
  acc: '#2D5FD3', accInk: '#1F4BB5', accTint: '#E5ECFB', pri: '#0D1117', onPri: '#FFFFFF',
  good: '#1F7A4D', goodTint: '#E3F2EA', warn: '#A0461C', warnTint: '#FBEAE0', bad: '#B4232F', badTint: '#FBE4E6',
  canvas: '#E3E5E9', scrim: 'rgba(13,17,23,0.42)', shadow: '0 1px 2px rgba(13,17,23,0.05), 0 10px 30px rgba(13,17,23,0.07)',
  glass: 'rgba(255,255,255,0.78)'
};
const DARK = {
  bg: '#0A0C10', bg2: '#101319', surf: '#14181F', surf2: '#1A1F28', ink: '#F1F3F7', ink2: '#D3D8E0', muted: '#9BA4B3',
  line: 'rgba(241,243,247,0.08)', line2: 'rgba(241,243,247,0.16)', hover: 'rgba(241,243,247,0.06)',
  acc: '#8DB0FF', accInk: '#A9C3FF', accTint: '#1B2540', pri: '#F1F3F7', onPri: '#0A0C10',
  good: '#7FD3A6', goodTint: '#13291F', warn: '#F2A47C', warnTint: '#33201A', bad: '#FF8A94', badTint: '#3A1A1F',
  canvas: '#1B1D22', scrim: 'rgba(0,0,0,0.6)', shadow: '0 1px 2px rgba(0,0,0,0.4), 0 12px 32px rgba(0,0,0,0.35)',
  glass: 'rgba(20,24,31,0.78)'
};
// Mascot / illustration palette (pastel, flat — Zeno's style, Zephyr's own colours)
const M = {
  fur: '#F4F1EC', shade: '#E2DBD0', belly: '#FCFBF8', ear: '#F3C6C8', nose: '#E8979D', eye: '#23252B', mouth: '#9A6A6E',
  blush: '#F0A7AE', scarf: '#9FBDEB', scarfLt: '#C8DAF6', scarfDk: '#7F9FD6', cam: '#3A3F4A', camLt: '#596172', lens: '#7D93C2',
  sky: '#DCE6F4', mint: '#DDEBE3', blossom: '#F6E3E6', lilac: '#E6E1F3', sand: '#F1E9DB', dusk: '#2B3346', mist: '#E9EDF3'
};

function cssVars(t) { return Object.entries(t).map(([k, v]) => `--${k}:${v}`).join(';'); }

const BASE_CSS = `body{margin:0}
a{color:var(--acc)}a:hover{color:var(--accInk)}
.zr{${cssVars(LIGHT)};color-scheme:light}
.zr[data-theme=dark]{${cssVars(DARK)};color-scheme:dark}
.zr *{box-sizing:border-box}
.zr button,.zr input,.zr select,.zr textarea{font:inherit;color:inherit}
.zr input::placeholder{color:var(--muted);opacity:1}
.zb{cursor:pointer;transition:transform 160ms cubic-bezier(.23,1,.32,1),background-color 160ms ease,box-shadow 160ms ease}
.zb:active{transform:scale(.97)}
.zr :focus-visible{outline:2px solid var(--acc);outline-offset:2px}
@media (hover:hover) and (pointer:fine){.zh:hover{background-color:var(--hover)!important}}
.m-only{display:none!important}
@container zr (max-width: 820px){.d-only{display:none!important}.m-only{display:flex!important}}
.zsw{appearance:none;-webkit-appearance:none;width:40px;height:24px;border-radius:99px;background:var(--line2);position:relative;margin:0;flex-shrink:0;cursor:pointer;transition:background-color 160ms ease}
.zsw::before{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform 200ms cubic-bezier(.23,1,.32,1)}
.zsw:checked{background:var(--acc)}
.zsw:checked::before{transform:translateX(16px)}
.zsw:disabled{opacity:.45;cursor:not-allowed}
.zrange{appearance:none;-webkit-appearance:none;width:100%;height:20px;background:transparent;margin:0;cursor:pointer}
.zrange::-webkit-slider-runnable-track{height:3px;border-radius:3px;background:var(--line2)}
.zrange::-webkit-slider-thumb{-webkit-appearance:none;width:16px;height:16px;border-radius:50%;background:#fff;border:1px solid rgba(13,17,23,.18);box-shadow:0 1px 3px rgba(0,0,0,.25);margin-top:-6.5px}
.zrange::-moz-range-track{height:3px;border-radius:3px;background:var(--line2)}
.zrange::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:#fff;border:1px solid rgba(13,17,23,.18)}
@keyframes zFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
@keyframes zSway{0%,100%{transform:rotate(0deg)}50%{transform:rotate(-6deg)}}
@keyframes zBlow{0%{opacity:0;transform:translateX(-10px)}30%{opacity:.9}100%{opacity:0;transform:translateX(26px)}}
@keyframes zZ{0%{opacity:0;transform:translate(0,6px)}35%{opacity:1}100%{opacity:0;transform:translate(10px,-22px)}}
@keyframes zSpin{to{transform:rotate(360deg)}}
@keyframes zBar{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
@media (prefers-reduced-motion:reduce){.zr *{animation:none!important;transition:none!important}}`;

// ---------- Icons (24px grid, 1.75 stroke, round) ----------
const IC = {
  search: '<circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path>',
  upload: '<path d="M12 15V4"></path><path d="m7 9 5-5 5 5"></path><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"></path>',
  download: '<path d="M12 4v11"></path><path d="m7 10 5 5 5-5"></path><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"></path>',
  image: '<rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="m21 16-5-5-9 9"></path>',
  library: '<rect x="7" y="3" width="14" height="14" rx="2.5"></rect><path d="M17 21H6a3 3 0 0 1-3-3V7"></path><path d="m21 13-3.5-3.5L10 17"></path>',
  folder: '<path d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"></path>',
  people: '<circle cx="9" cy="8" r="3.5"></circle><path d="M2.5 20a6.5 6.5 0 0 1 13 0"></path><path d="M16 4.5a3.5 3.5 0 0 1 0 7"></path><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"></path>',
  user: '<circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path>',
  heart: '<path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z"></path>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"></path>',
  share: '<path d="M12 3v12"></path><path d="m8 7 4-4 4 4"></path><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"></path>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"></path><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"></path>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"></path>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"></rect><path d="M8 10.5V7a4 4 0 0 1 7.7-1.5"></path>',
  key: '<circle cx="8" cy="15" r="4"></circle><path d="m11 12 9-9"></path><path d="m17 6 3 3"></path><path d="m15 8 2 2"></path>',
  shield: '<path d="M12 3 5 6v5c0 4.6 3 8.4 7 10 4-1.6 7-5.4 7-10V6z"></path>',
  shieldCheck: '<path d="M12 3 5 6v5c0 4.6 3 8.4 7 10 4-1.6 7-5.4 7-10V6z"></path><path d="m9 12 2 2 4-4"></path>',
  breeze: '<path d="M3 8h10a3 3 0 1 0-3-3"></path><path d="M3 12h15a3 3 0 1 1-3 3"></path><path d="M3 16h7"></path>',
  settings: '<circle cx="12" cy="12" r="3"></circle><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"></path><circle cx="12" cy="12" r="6.5"></circle>',
  sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"></path>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"></path>',
  plus: '<path d="M12 5v14M5 12h14"></path>',
  x: '<path d="M6 6l12 12M18 6 6 18"></path>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"></path>',
  chevD: '<path d="m6 9 6 6 6-6"></path>', chevR: '<path d="m9 6 6 6-6 6"></path>', chevL: '<path d="m15 6-6 6 6 6"></path>', chevU: '<path d="m6 15 6-6 6 6"></path>',
  more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"></circle><circle cx="12" cy="12" r="1.3" fill="currentColor"></circle><circle cx="19" cy="12" r="1.3" fill="currentColor"></circle>',
  grid: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"></rect><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"></rect><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"></rect>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"></path><path d="M3.5 6h.5M3.5 12h.5M3.5 18h.5"></path>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"></path><path d="M18 22V8a2 2 0 0 0-2-2H2"></path>',
  sliders: '<path d="M4 6h9M19 6h1M4 12h3M13 12h7M4 18h11M21 18h-1"></path><circle cx="16" cy="6" r="2.2"></circle><circle cx="10" cy="12" r="2.2"></circle><circle cx="18" cy="18" r="2.2"></circle>',
  undo: '<path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path>',
  redo: '<path d="m15 14 5-5-5-5"></path><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"></path>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2.5"></rect><path d="M16 8V5.5A2.5 2.5 0 0 0 13.5 3h-8A2.5 2.5 0 0 0 3 5.5v8A2.5 2.5 0 0 0 5.5 16H8"></path>',
  paste: '<rect x="8" y="2.5" width="8" height="4" rx="1"></rect><path d="M16 4.5h2a2 2 0 0 1 2 2V20a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2h2"></path>',
  trash: '<path d="M4 7h16"></path><path d="M10 11v6M14 11v6"></path><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path><path d="M9 7V4h6v3"></path>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"></path><circle cx="12" cy="12" r="3"></circle>',
  eyeOff: '<path d="M3 3l18 18"></path><path d="M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3 3.9M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path>',
  clock: '<circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"></rect><path d="M3.5 10h17M8 3v4M16 3v4"></path>',
  filter: '<path d="M3 5h18l-7 8.5V19l-4 2v-7.5z"></path>',
  home: '<path d="M3 11 12 4l9 7"></path><path d="M5 9.5V20h14V9.5"></path>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"></path><path d="M10 20.5a2 2 0 0 0 4 0"></path>',
  card: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"></rect><path d="M2.5 10h19M6 15h4"></path>',
  chart: '<path d="M4 20V11M10 20V5M16 20v-7M21 20H3"></path>',
  alert: '<path d="M12 3.5 2.5 20h19z"></path><path d="M12 10v4M12 17v.01"></path>',
  flag: '<path d="M5 21V4M5 4h11l-2 4 2 4H5"></path>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"></rect><rect x="9.5" y="9.5" width="5" height="5" rx="1"></rect><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"></path>',
  megaphone: '<path d="M3 10v4a1 1 0 0 0 1 1h3l8 5V4L7 9H4a1 1 0 0 0-1 1z"></path><path d="M19 9a4 4 0 0 1 0 6"></path>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"></path><path d="M14 3v5h5M9 13h6M9 17h6"></path>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"></path><path d="M10 17l-5-5 5-5M5 12h11"></path>',
  globe: '<circle cx="12" cy="12" r="9"></circle><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"></path>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"></rect><path d="M11 18.5h2"></path>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.7-4.3L3 9"></path><path d="M3 4v5h5"></path><path d="M4 13a8 8 0 0 0 14.7 4.3L21 15"></path><path d="M21 20v-5h-5"></path>',
  face: '<path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"></path><path d="M9 9.5v1M15 9.5v1M9.5 15a3.5 3.5 0 0 0 5 0"></path>',
  mountain: '<path d="m3 20 7-12 4 6 2-3 5 9z"></path>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"></path><path d="m3 13 9 5 9-5"></path>',
  blur: '<circle cx="12" cy="12" r="3"></circle><circle cx="12" cy="12" r="7.5" stroke-dasharray="2 3"></circle>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="m3.5 7 8.5 6 8.5-6"></path>',
  passkey: '<circle cx="9" cy="8" r="4"></circle><path d="M2.5 20a6.5 6.5 0 0 1 10-5.5"></path><circle cx="17.5" cy="14.5" r="2.5"></circle><path d="M17.5 17v4.5M17.5 19.5h2"></path>',
  play: '<path d="M7 4.5v15l12-7.5z"></path>',
  pause: '<path d="M8 5v14M16 5v14"></path>',
  arrowR: '<path d="M5 12h14M13 6l6 6-6 6"></path>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"></path><circle cx="7.5" cy="8.5" r="1.3"></circle>',
  compare: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M12 4v16"></path>',
  scissors: '<circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M8.1 8.1 20 20M8.1 15.9 20 4"></path>',
  palette: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.8-.8 1.8-1.8 0-.5-.2-.9-.5-1.2-.3-.3-.5-.7-.5-1.2 0-1 .8-1.8 1.8-1.8H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"></path><circle cx="7.5" cy="11" r="1"></circle><circle cx="10" cy="7" r="1"></circle><circle cx="14.5" cy="7" r="1"></circle>',
  ban: '<circle cx="12" cy="12" r="9"></circle><path d="M5.6 5.6l12.8 12.8"></path>',
  install: '<rect x="5" y="2.5" width="14" height="19" rx="2.5"></rect><path d="M12 7v7M9 11l3 3 3-3"></path>',
  wand: '<path d="M4 20 15 9"></path><path d="M17 3v3M15.5 4.5h3M20 8v2M19 9h2M12 4v1.5M11.25 4.75h1.5"></path>',
  hdr: '<rect x="3" y="5" width="18" height="14" rx="2.5"></rect><path d="M7 9v6M10 9v6M7 12h3M13 9v6h1.5a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2z"></path>',
  rotate: '<path d="M4 12a8 8 0 1 0 2.3-5.6"></path><path d="M4 4v4h4"></path>',
  perspective: '<path d="M6 4h12l3 16H3z"></path><path d="M12 4v16M4.5 12h15"></path>',
  stack: '<rect x="3" y="7" width="14" height="14" rx="2.5"></rect><path d="M7 3h12a2 2 0 0 1 2 2v12"></path>',
  external: '<path d="M14 4h6v6"></path><path d="M20 4 11 13"></path><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"></path>',
  sparkGrid: '<rect x="3" y="3" width="7" height="7" rx="1.5"></rect><rect x="14" y="3" width="7" height="7" rx="1.5"></rect><rect x="3" y="14" width="7" height="7" rx="1.5"></rect><path d="M17.5 14v7M14 17.5h7"></path>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"></path>',
  info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 11v5M12 8v.01"></path>',
  dollar: '<path d="M12 3v18"></path><path d="M16.5 7.5A3.5 3.5 0 0 0 13 5h-2a3 3 0 0 0 0 6h2a3 3 0 0 1 0 6h-2a3.5 3.5 0 0 1-3.5-2.5"></path>',
  database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"></ellipse><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"></path><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"></path>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"></rect><rect x="3" y="13" width="18" height="7" rx="2"></rect><path d="M7 7.5h.01M7 16.5h.01"></path>',
  toggle: '<rect x="2.5" y="7" width="19" height="10" rx="5"></rect><circle cx="16.5" cy="12" r="3"></circle>',
  pin: '<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21z"></path><circle cx="12" cy="10" r="2.3"></circle>',
  camera: '<rect x="2.5" y="6.5" width="19" height="14" rx="3"></rect><path d="M8 6.5 9.5 4h5L16 6.5"></path><circle cx="12" cy="13.5" r="3.6"></circle>',
  watermark: '<rect x="3" y="4" width="18" height="16" rx="2.5"></rect><path d="M7 15l2.5-6 2.5 6 2.5-6 2.5 6"></path>'
};
function icon(name, size = 18, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="flex-shrink: 0${extra ? '; ' + extra : ''}">${IC[name] || ''}</svg>`;
}

// ---------- unique ids for SVG defs ----------
let UID = 0;
function uid(p) { UID += 1; return `${p}${UID}`; }

// ---------- Logo ----------
// Recommended mark "Breeze": round head, one upright ear, one ear swept back by the wind.
function markBreeze(fill = 'currentColor', size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" aria-hidden="true" style="flex-shrink: 0"><g transform="translate(-8 2)"><circle cx="100" cy="128" r="54" fill="${fill}"></circle><g fill="none" stroke="${fill}" stroke-width="30" stroke-linecap="round"><path d="M80 92 L72 26"></path><path d="M118 90 C120 58 132 38 168 30"></path></g></g></svg>`;
}
// Direction B — aperture head
function markAperture(fill = 'currentColor', bg = '#fff', size = 24) {
  const blades = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * 60) * Math.PI / 180;
    const x1 = 100 + 18 * Math.cos(a), y1 = 128 + 18 * Math.sin(a);
    const x2 = 100 + 54 * Math.cos(a + 0.9), y2 = 128 + 54 * Math.sin(a + 0.9);
    blades.push(`M${x1.toFixed(1)} ${y1.toFixed(1)} L${x2.toFixed(1)} ${y2.toFixed(1)}`);
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" aria-hidden="true" style="flex-shrink: 0"><circle cx="100" cy="128" r="56" fill="${fill}"></circle><path d="${blades.join(' ')}" stroke="${bg}" stroke-width="7" stroke-linecap="round"></path><circle cx="100" cy="128" r="12" fill="${bg}"></circle><g fill="none" stroke="${fill}" stroke-width="26" stroke-linecap="round"><path d="M80 78 L74 22"></path><path d="M120 78 L126 22"></path></g></svg>`;
}
// Direction C — Z monogram whose top bar grows two ears
function markZ(fill = 'currentColor', size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" aria-hidden="true" style="flex-shrink: 0"><g fill="none" stroke="${fill}" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"><path d="M52 92 H146 L54 168 H150"></path><path d="M78 92 L70 30"></path><path d="M112 92 C114 62 126 44 158 38"></path></g></svg>`;
}
// Direction D — lens ring with a hopping rabbit inside (negative space)
function markLens(fill = 'currentColor', bg = '#fff', size = 24) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 200 200" aria-hidden="true" style="flex-shrink: 0"><circle cx="100" cy="100" r="84" fill="${fill}"></circle><circle cx="100" cy="100" r="64" fill="none" stroke="${bg}" stroke-width="6" opacity="0.35"></circle><g fill="${bg}"><ellipse cx="96" cy="122" rx="34" ry="26"></ellipse><circle cx="128" cy="98" r="18"></circle><circle cx="62" cy="116" r="9"></circle></g><g fill="none" stroke="${bg}" stroke-width="12" stroke-linecap="round"><path d="M126 84 L118 50"></path><path d="M136 84 C140 62 152 52 166 50"></path></g><circle cx="134" cy="96" r="3.4" fill="${fill}"></circle></svg>`;
}
function wordmark(size = 22, color = 'var(--ink)') {
  return `<span style="display: inline-flex; align-items: center; gap: ${Math.round(size * 0.36)}px; color: ${color}">${markBreeze('currentColor', Math.round(size * 1.25))}<span style="font-family: ${FONT}; font-weight: 600; font-size: ${size}px; letter-spacing: -0.035em; line-height: 1">zephyr</span></span>`;
}

// ---------- Mascot: Zephyr the rabbit ----------
// Head drawn in a 200x200 space. opts: eyes closed|open|wink|sleep|focus, ear breeze|up, scarf bool, mouth smile|open|flat|o
function rabbitHead(o = {}) {
  const eyes = o.eyes || 'closed', ear = o.ear || 'breeze', mouth = o.mouth || 'smile';
  const scarf = o.scarf !== false;
  const earL = `<path d="M66 82 C54 52 56 14 73 8 C90 3 94 44 90 82 Z" fill="${M.fur}"></path><path d="M70 74 C62 50 64 22 74 17 C84 14 86 46 84 74 Z" fill="${M.ear}"></path>`;
  const earR = ear === 'up'
    ? `<path d="M110 82 C106 44 110 6 127 8 C144 12 146 52 134 82 Z" fill="${M.fur}"></path><path d="M116 74 C114 48 116 18 126 17 C136 18 136 50 130 74 Z" fill="${M.ear}"></path>`
    : `<path d="M110 84 C106 54 116 30 136 22 C156 15 180 22 186 34 C190 44 178 47 166 43 C150 38 140 52 136 84 Z" fill="${M.fur}"></path><path d="M117 76 C115 56 122 38 138 31 C152 25 168 28 174 35 C162 33 148 38 140 52 C135 60 132 68 131 76 Z" fill="${M.ear}"></path>`;
  const head = `<path d="M100 64 C142 64 164 94 164 126 C164 162 136 184 100 184 C64 184 36 162 36 126 C36 94 58 64 100 64 Z" fill="${M.fur}"></path><path d="M44 146 C40 160 52 176 66 180 C56 170 50 158 52 146 Z" fill="${M.shade}" opacity="0.7"></path>`;
  let eye;
  if (eyes === 'open') eye = `<circle cx="80" cy="124" r="6.5" fill="${M.eye}"></circle><circle cx="120" cy="124" r="6.5" fill="${M.eye}"></circle><circle cx="82.4" cy="121.6" r="2" fill="#FFFFFF"></circle><circle cx="122.4" cy="121.6" r="2" fill="#FFFFFF"></circle>`;
  else if (eyes === 'wink') eye = `<path d="M72 124 Q80 131 88 124" stroke="${M.eye}" stroke-width="3.6" fill="none" stroke-linecap="round"></path><circle cx="120" cy="124" r="6.5" fill="${M.eye}"></circle><circle cx="122.4" cy="121.6" r="2" fill="#FFFFFF"></circle>`;
  else if (eyes === 'sleep') eye = `<path d="M72 126 Q80 121 88 126 M112 126 Q120 121 128 126" stroke="${M.eye}" stroke-width="3.6" fill="none" stroke-linecap="round"></path>`;
  else if (eyes === 'focus') eye = `<circle cx="80" cy="124" r="5" fill="${M.eye}"></circle><path d="M112 124 H128" stroke="${M.eye}" stroke-width="3.6" stroke-linecap="round"></path>`;
  else eye = `<path d="M72 122 Q80 130 88 122 M112 122 Q120 130 128 122" stroke="${M.eye}" stroke-width="3.6" fill="none" stroke-linecap="round"></path>`;
  const nose = `<path d="M94.5 139 Q100 135.5 105.5 139 Q103.5 144.5 100 145.5 Q96.5 144.5 94.5 139 Z" fill="${M.nose}"></path>`;
  let mth;
  if (mouth === 'open') mth = `<path d="M92 150 Q100 161 108 150 Z" fill="#D9878E" stroke="${M.mouth}" stroke-width="2" stroke-linejoin="round"></path>`;
  else if (mouth === 'flat') mth = `<path d="M94 152 H106" stroke="${M.mouth}" stroke-width="2.4" stroke-linecap="round"></path>`;
  else if (mouth === 'o') mth = `<ellipse cx="100" cy="153" rx="3.6" ry="4.4" fill="${M.mouth}"></ellipse>`;
  else mth = `<path d="M100 145.5 Q97 152 91 150 M100 145.5 Q103 152 109 150" stroke="${M.mouth}" stroke-width="2.2" fill="none" stroke-linecap="round"></path>`;
  const blush = `<ellipse cx="66" cy="142" rx="9" ry="5" fill="${M.blush}" opacity="0.45"></ellipse><ellipse cx="134" cy="142" rx="9" ry="5" fill="${M.blush}" opacity="0.45"></ellipse>`;
  const sc = scarf ? `<path d="M56 170 Q100 190 144 170 L149 184 Q100 206 51 184 Z" fill="${M.scarf}"></path><path d="M60 177 Q100 195 140 177" stroke="${M.scarfLt}" stroke-width="3" fill="none" stroke-linecap="round"></path>` : '';
  return `${earL}${earR}${head}${eye}${nose}${mth}${blush}${sc}`;
}
// scarf tail that flows in the breeze (draw behind body, in 200-space with head at 0,0)
function scarfTail(anim = true) {
  return `<g style="transform-origin: 140px 184px; transform-box: view-box;${anim ? ' animation: zSway 3.2s ease-in-out infinite' : ''}"><path d="M136 182 C160 186 182 174 204 182 C196 192 178 198 160 196 C172 202 188 204 200 200 C182 214 152 208 134 194 Z" fill="${M.scarf}"></path><path d="M150 190 C166 192 182 186 196 188" stroke="${M.scarfLt}" stroke-width="3" fill="none" stroke-linecap="round"></path></g>`;
}
function windLines(color = '#FFFFFF', anim = true) {
  const a = (d) => anim ? `animation: zBlow 3s ease-out ${d}s infinite` : '';
  return `<g fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"><path d="M14 60 H52 a8 8 0 1 0 -8 -8" style="${a(0)}"></path><path d="M8 84 H40" style="${a(1.1)}"></path><path d="M20 106 H58 a8 8 0 1 1 -8 8" style="${a(2)}"></path></g>`;
}
function body(o = {}) {
  // full-body: head scaled .74 sitting on an oval body, in 220x250 space
  const tail = `<circle cx="160" cy="214" r="13" fill="${M.belly}"></circle>`;
  const b = `<ellipse cx="110" cy="200" rx="54" ry="46" fill="${M.fur}"></ellipse><ellipse cx="110" cy="210" rx="33" ry="30" fill="${M.belly}"></ellipse><ellipse cx="80" cy="242" rx="22" ry="9" fill="${M.shade}"></ellipse><ellipse cx="140" cy="242" rx="22" ry="9" fill="${M.shade}"></ellipse>`;
  return `${tail}${b}`;
}
function headAt(x, y, s, o) { return `<g transform="translate(${x} ${y}) scale(${s})">${rabbitHead(o)}</g>`; }

function mascotPose(pose, w = 220, h = 250) {
  const vb = `0 0 220 250`;
  let g = '';
  switch (pose) {
    case 'breeze':
      g = `${windLines('#FFFFFF')}<g transform="translate(14 22) scale(0.96)">${scarfTail()}</g>${headAt(14, 22, 0.96, { eyes: 'closed', ear: 'breeze' })}`;
      break;
    case 'peek': // looking through a little camera
      g = `${headAt(22, 6, 0.88, { eyes: 'wink', ear: 'breeze', mouth: 'flat', scarf: true })}
        <g style="animation: zFloat 4.5s ease-in-out infinite"><rect x="58" y="146" width="104" height="70" rx="16" fill="${M.cam}"></rect><rect x="72" y="136" width="30" height="14" rx="5" fill="${M.cam}"></rect><circle cx="110" cy="181" r="25" fill="${M.camLt}"></circle><circle cx="110" cy="181" r="16" fill="${M.lens}"></circle><circle cx="104" cy="175" r="5" fill="#FFFFFF" opacity="0.7"></circle><circle cx="146" cy="160" r="4" fill="#F3C6C8"></circle>
        <ellipse cx="60" cy="182" rx="12" ry="10" fill="${M.fur}"></ellipse><ellipse cx="160" cy="182" rx="12" ry="10" fill="${M.fur}"></ellipse></g>`;
      break;
    case 'hold': // holding a print
      g = `${body()}${headAt(36, 30, 0.74, { eyes: 'closed', ear: 'breeze', mouth: 'open' })}
        <g transform="rotate(-6 110 200)"><rect x="76" y="166" width="68" height="78" rx="4" fill="#FFFFFF"></rect><rect x="82" y="172" width="56" height="50" rx="2" fill="${M.sky}"></rect><circle cx="122" cy="186" r="7" fill="#F6D9A8"></circle><path d="M82 222 L100 200 L112 212 L122 204 L138 222 Z" fill="#A9C1A0"></path></g>
        <ellipse cx="78" cy="196" rx="11" ry="9" fill="${M.fur}"></ellipse><ellipse cx="142" cy="192" rx="11" ry="9" fill="${M.fur}"></ellipse>`;
      break;
    case 'wave':
      g = `${body()}<g style="transform-origin: 150px 176px; transform-box: view-box; animation: zSway 1.6s ease-in-out infinite"><path d="M150 178 L176 132" stroke="${M.fur}" stroke-width="18" stroke-linecap="round"></path><ellipse cx="179" cy="126" rx="11" ry="10" fill="${M.fur}"></ellipse></g><ellipse cx="74" cy="200" rx="11" ry="9" fill="${M.shade}"></ellipse>${headAt(36, 30, 0.74, { eyes: 'open', ear: 'breeze', mouth: 'open' })}`;
      break;
    case 'nap':
      g = `<ellipse cx="110" cy="214" rx="78" ry="30" fill="${M.shade}" opacity="0.5"></ellipse><ellipse cx="116" cy="196" rx="70" ry="40" fill="${M.fur}"></ellipse><circle cx="182" cy="196" r="12" fill="${M.belly}"></circle>
        <g transform="translate(24 104) scale(0.56) rotate(-10 100 120)">${rabbitHead({ eyes: 'sleep', ear: 'up', mouth: 'flat' })}</g>
        <text x="150" y="96" font-family="${FONT.replace(/'/g, '')}" font-weight="600" font-size="26" fill="#FFFFFF" style="animation: zZ 3.2s ease-out infinite">z</text><text x="168" y="74" font-family="${FONT.replace(/'/g, '')}" font-weight="600" font-size="18" fill="#FFFFFF" style="animation: zZ 3.2s ease-out 1.2s infinite">z</text>`;
      break;
    case 'guard': // passcode / security — holding a key, padlock badge on scarf
      g = `${body()}${headAt(36, 30, 0.74, { eyes: 'open', ear: 'up', mouth: 'smile' })}
        <g transform="translate(96 166)"><rect x="0" y="10" width="28" height="22" rx="6" fill="#F6D9A8"></rect><path d="M6 10 V5 a8 8 0 0 1 16 0 V10" fill="none" stroke="#E2B978" stroke-width="4"></path><circle cx="14" cy="21" r="3" fill="#B98A45"></circle></g>
        <g transform="rotate(-24 150 196)"><circle cx="150" cy="186" r="11" fill="none" stroke="#E2B978" stroke-width="6"></circle><path d="M150 197 V226 M150 214 H158 M150 222 H156" stroke="#E2B978" stroke-width="6" stroke-linecap="round"></path></g>
        <ellipse cx="146" cy="196" rx="11" ry="9" fill="${M.fur}"></ellipse><ellipse cx="74" cy="198" rx="11" ry="9" fill="${M.shade}"></ellipse>`;
      break;
    case 'ponder':
      g = `<circle cx="184" cy="40" r="17" fill="#FFFFFF"></circle><text x="184" y="48" text-anchor="middle" font-family="${FONT.replace(/'/g, '')}" font-weight="600" font-size="22" fill="${M.mouth}">?</text><circle cx="166" cy="70" r="6" fill="#FFFFFF"></circle>
        ${body()}<path d="M146 176 L126 152" stroke="${M.fur}" stroke-width="18" stroke-linecap="round"></path>
        <g style="transform-origin: 110px 150px; transform-box: view-box; transform: rotate(-8deg)">${headAt(36, 30, 0.74, { eyes: 'focus', ear: 'breeze', mouth: 'o' })}</g><ellipse cx="124" cy="148" rx="11" ry="9" fill="${M.fur}"></ellipse>`;
      break;
    case 'hop': // loading / processing
      g = `<ellipse cx="110" cy="240" rx="46" ry="7" fill="#000000" opacity="0.07"></ellipse><g style="animation: zFloat 0.9s cubic-bezier(.45,0,.55,1) infinite">${body()}${headAt(36, 30, 0.74, { eyes: 'closed', ear: 'breeze', mouth: 'open' })}</g>${windLines('#FFFFFF')}`;
      break;
    case 'face':
    default:
      g = `${headAt(10, 18, 1, { eyes: 'closed', ear: 'breeze' })}`;
  }
  return `<svg viewBox="${vb}" width="${w}" height="${h}" aria-hidden="true" style="overflow: visible">${g}</svg>`;
}
// Small round avatar of the mascot face (for empty states, menus)
function mascotFace(size = 40, bg = M.sky) {
  return `<span style="width: ${size}px; height: ${size}px; border-radius: 50%; background: ${bg}; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex-shrink: 0"><svg viewBox="20 0 160 200" width="${size * 0.92}" height="${size * 1.1}" aria-hidden="true" style="margin-top: ${size * 0.18}px">${rabbitHead({ eyes: 'closed', ear: 'breeze', scarf: false })}</svg></span>`;
}

// ---------- Sample photo placeholders (flat illustrated scenes; real images replace these) ----------
function photo(kind, opts = {}) {
  const id = uid('p');
  const lab = opts.label || `Sample photo: ${kind}`;
  const filter = opts.filter ? ` filter: ${opts.filter};` : '';
  const S = (inner, defs = '') => `<svg viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" width="100%" height="100%" role="img" aria-label="${lab}" style="display: block;${filter}"><defs>${defs}</defs>${inner}</svg>`;
  const lg = (n, a, b, x2 = 0, y2 = 1) => `<linearGradient id="${id}${n}" x1="0" y1="0" x2="${x2}" y2="${y2}"><stop offset="0" stop-color="${a}"></stop><stop offset="1" stop-color="${b}"></stop></linearGradient>`;
  switch (kind) {
    case 'dunes': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><circle cx="290" cy="110" r="34" fill="#FFE7C2"></circle><path d="M0 200 C80 160 160 170 240 200 S360 210 400 190 V300 H0Z" fill="#E7B98A"></path><path d="M0 240 C100 200 200 220 300 250 S380 250 400 240 V300 H0Z" fill="#D49A68"></path><path d="M120 300 C180 250 260 250 400 270 V300Z" fill="#B97C4E"></path>`, lg('s', '#F6C9A6', '#FBE8D5'));
    case 'sea': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><rect y="170" width="400" height="130" fill="url(#${id}w)"></rect><path d="M0 170 H400" stroke="#FFFFFF" stroke-opacity="0.5"></path><path d="M250 150 L262 110 L262 152 Z" fill="#FFFFFF"></path><path d="M240 154 H272 L266 162 H246Z" fill="#2E3E58"></path><path d="M30 210 q20 -6 40 0 M200 240 q20 -6 40 0 M320 205 q16 -5 32 0" stroke="#FFFFFF" stroke-opacity="0.5" stroke-width="3" fill="none" stroke-linecap="round"></path>`, lg('s', '#9CC0EA', '#E4EEF9') + lg('w', '#4C7BB7', '#2C527F'));
    case 'peaks': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><path d="M0 220 L90 110 L150 170 L230 80 L320 180 L400 120 V300 H0Z" fill="#7F93B5"></path><path d="M230 80 L256 110 L240 108 L226 120 L212 100Z" fill="#FFFFFF"></path><path d="M0 250 L110 170 L200 230 L300 160 L400 230 V300 H0Z" fill="#53668A"></path><path d="M0 280 C120 250 260 260 400 280 V300 H0Z" fill="#33445F"></path>`, lg('s', '#C9D7EE', '#F3F0EA'));
    case 'city': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><circle cx="320" cy="70" r="18" fill="#F6E7C8"></circle><g fill="#1D2436"><rect x="20" y="140" width="50" height="160"></rect><rect x="76" y="100" width="40" height="200"></rect><rect x="122" y="160" width="60" height="140"></rect><rect x="190" y="80" width="46" height="220"></rect><rect x="242" y="130" width="58" height="170"></rect><rect x="306" y="170" width="40" height="130"></rect><rect x="350" y="120" width="50" height="180"></rect></g><g fill="#F6D58E"><rect x="86" y="120" width="6" height="8"></rect><rect x="100" y="150" width="6" height="8"></rect><rect x="200" y="100" width="6" height="8"></rect><rect x="214" y="140" width="6" height="8"></rect><rect x="254" y="150" width="6" height="8"></rect><rect x="276" y="190" width="6" height="8"></rect><rect x="362" y="140" width="6" height="8"></rect><rect x="34" y="170" width="6" height="8"></rect><rect x="136" y="190" width="6" height="8"></rect></g>`, lg('s', '#2B3A66', '#7A6C9C'));
    case 'bloom': return S(`<rect width="400" height="300" fill="#A8C49B"></rect><circle cx="80" cy="60" r="60" fill="#94B487"></circle><circle cx="350" cy="250" r="80" fill="#8DAE80"></circle><g transform="translate(200 150)"><g fill="#F4B8C4"><ellipse cx="0" cy="-54" rx="34" ry="52"></ellipse><ellipse cx="0" cy="54" rx="34" ry="52"></ellipse><ellipse cx="-54" cy="0" rx="52" ry="34"></ellipse><ellipse cx="54" cy="0" rx="52" ry="34"></ellipse></g><g fill="#F8CCD5" transform="rotate(45)"><ellipse cx="0" cy="-46" rx="28" ry="42"></ellipse><ellipse cx="0" cy="46" rx="28" ry="42"></ellipse><ellipse cx="-46" cy="0" rx="42" ry="28"></ellipse><ellipse cx="46" cy="0" rx="42" ry="28"></ellipse></g><circle r="22" fill="#F2C76A"></circle></g>`);
    case 'product': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><ellipse cx="200" cy="252" rx="78" ry="12" fill="#000000" opacity="0.12"></ellipse><rect x="168" y="96" width="64" height="156" rx="18" fill="#2F4A3A"></rect><rect x="184" y="70" width="32" height="30" rx="6" fill="#C9B37A"></rect><rect x="176" y="150" width="48" height="56" rx="6" fill="#F4F1EC"></rect><path d="M184 168 H216 M184 180 H208" stroke="#2F4A3A" stroke-width="4" stroke-linecap="round"></path><rect x="174" y="104" width="8" height="140" rx="4" fill="#FFFFFF" opacity="0.18"></rect>`, lg('s', '#F4F1EC', '#E2DCD2'));
    case 'sneaker': return S(`<rect width="400" height="300" fill="#E7EBF2"></rect><ellipse cx="200" cy="232" rx="120" ry="12" fill="#000000" opacity="0.1"></ellipse><path d="M90 220 C90 180 120 150 160 140 L200 130 C210 160 250 170 300 176 C320 180 320 210 316 222 Z" fill="#F4F1EC"></path><path d="M86 216 H318 V230 H86Z" fill="#2D5FD3"></path><path d="M160 140 L200 130 C206 150 220 160 240 166 L180 172Z" fill="#E36A4E"></path>`);
    case 'interior': return S(`<rect width="400" height="300" fill="#E9E2D6"></rect><rect x="230" y="40" width="130" height="150" rx="4" fill="#DCEAF7"></rect><path d="M295 40 V190 M230 115 H360" stroke="#FFFFFF" stroke-width="6"></path><rect y="230" width="400" height="70" fill="#C9B79C"></rect><rect x="40" y="170" width="160" height="60" rx="14" fill="#7E8E78"></rect><rect x="50" y="150" width="140" height="40" rx="12" fill="#93A28C"></rect><rect x="250" y="210" width="70" height="24" rx="6" fill="#B08D6A"></rect><circle cx="110" cy="70" r="16" fill="#F6E3B6"></circle><path d="M110 0 V54" stroke="#9C8B70" stroke-width="2"></path>`);
    case 'forest': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><g fill="#6E8E77"><path d="M40 260 L80 120 L120 260Z"></path><path d="M300 260 L340 110 L380 260Z"></path></g><g fill="#4F7060"><path d="M100 280 L150 90 L200 280Z"></path><path d="M220 280 L270 130 L320 280Z"></path></g><rect y="260" width="400" height="40" fill="#3E5A4C"></rect><rect y="150" width="400" height="40" fill="#FFFFFF" opacity="0.25"></rect>`, lg('s', '#DCE6DD', '#B9CDBE'));
    case 'food': return S(`<rect width="400" height="300" fill="#D9C2A2"></rect><circle cx="200" cy="150" r="104" fill="#F7F4EE"></circle><circle cx="200" cy="150" r="78" fill="#F2E3C9"></circle><circle cx="176" cy="132" r="20" fill="#E36A4E"></circle><circle cx="224" cy="160" r="22" fill="#E36A4E"></circle><path d="M180 180 q20 -10 40 0" stroke="#6E9A5A" stroke-width="10" stroke-linecap="round" fill="none"></path><circle cx="226" cy="120" r="10" fill="#6E9A5A"></circle><rect x="330" y="40" width="12" height="220" rx="6" fill="#B9A27E"></rect>`);
    case 'portrait': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><circle cx="200" cy="128" r="50" fill="#C99A82"></circle><path d="M150 112 C150 70 250 70 250 112 C246 92 156 92 150 112Z" fill="#3B2B26"></path><path d="M100 300 C100 220 150 196 200 196 C250 196 300 220 300 300Z" fill="#E7E2D9"></path>`, lg('s', '#F2D7C4', '#E7B9A2'));
    case 'couple': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><path d="M120 300 V160 a80 80 0 0 1 160 0 V300" fill="none" stroke="#FFFFFF" stroke-width="10" opacity="0.7"></path><circle cx="176" cy="150" r="22" fill="#C99A82"></circle><path d="M146 300 C146 230 160 190 176 190 C192 190 206 230 206 300Z" fill="#2B3346"></path><circle cx="226" cy="146" r="22" fill="#D7A98F"></circle><path d="M196 300 C196 230 210 186 226 186 C250 186 262 240 270 300Z" fill="#FBF9F5"></path>`, lg('s', '#E9DCEB', '#F7E9DE'));
    case 'dusk': return S(`<rect width="400" height="300" fill="url(#${id}s)"></rect><circle cx="200" cy="190" r="46" fill="#FFD2A1"></circle><rect y="190" width="400" height="110" fill="#3E4D74"></rect><path d="M150 210 H250 M170 226 H230 M186 242 H214" stroke="#FFD2A1" stroke-width="4" stroke-linecap="round" opacity="0.7"></path>`, lg('s', '#6E6A9E', '#F2A98A'));
    case 'pet': return S(`<rect width="400" height="300" fill="#F1E9DB"></rect><ellipse cx="200" cy="230" rx="100" ry="50" fill="#C79A6B"></ellipse><circle cx="200" cy="140" r="62" fill="#D4A878"></circle><path d="M146 110 L130 60 L176 92Z M254 110 L270 60 L224 92Z" fill="#B9875A"></path><circle cx="178" cy="136" r="7" fill="#2A2420"></circle><circle cx="222" cy="136" r="7" fill="#2A2420"></circle><ellipse cx="200" cy="162" rx="12" ry="8" fill="#2A2420"></ellipse>`);
    case 'doc': return S(`<rect width="400" height="300" fill="#C9CED6"></rect><rect x="110" y="30" width="180" height="240" rx="4" fill="#FFFFFF" transform="rotate(-4 200 150)"></rect><g stroke="#C3C8D2" stroke-width="7" stroke-linecap="round" transform="rotate(-4 200 150)"><path d="M136 70 H264 M136 96 H244 M136 122 H260 M136 148 H230 M136 174 H256"></path></g>`);
    default: return S(`<rect width="400" height="300" fill="#D7DCE4"></rect>`);
  }
}
const BEFORE_FILTER = 'brightness(0.72) saturate(0.55) contrast(0.9)';

// ---------- Components ----------
function btn(label, o = {}) {
  const kind = o.kind || 'secondary';
  const size = o.size || 'md';
  const h = size === 'lg' ? 48 : size === 'sm' ? 32 : 40;
  const fs = size === 'lg' ? 16 : size === 'sm' ? 13 : 14;
  const px = size === 'lg' ? 22 : size === 'sm' ? 12 : 16;
  const map = {
    primary: 'background: var(--pri); color: var(--onPri); border: 1px solid var(--pri)',
    accent: 'background: var(--acc); color: var(--onPri); border: 1px solid var(--acc)',
    secondary: 'background: var(--surf); color: var(--ink); border: 1px solid var(--line2)',
    ghost: 'background: transparent; color: var(--ink); border: 1px solid transparent',
    danger: 'background: var(--badTint); color: var(--bad); border: 1px solid transparent',
    tint: 'background: var(--accTint); color: var(--accInk); border: 1px solid transparent'
  };
  const ic = o.icon ? icon(o.icon, size === 'sm' ? 15 : 17) : '';
  const ic2 = o.iconR ? icon(o.iconR, size === 'sm' ? 15 : 17) : '';
  const inner = `${ic}${label ? `<span>${label}</span>` : ''}${ic2}`;
  const style = `display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: ${o.h || h}px; padding: 0 ${label ? px : 0}px; ${!label ? `width: ${o.h || h}px;` : ''} border-radius: ${o.radius ?? 12}px; font-size: ${fs}px; font-weight: 550; letter-spacing: -0.01em; white-space: nowrap; text-decoration: none; ${map[kind]}${o.full ? '; width: 100%' : ''}${o.style ? '; ' + o.style : ''}`;
  const aria = !label && o.aria ? ` aria-label="${o.aria}"` : (o.aria ? ` aria-label="${o.aria}"` : '');
  if (o.href) return `<a href="${o.href}" class="zb" style="${style}"${aria}>${inner}</a>`;
  return `<button type="button" class="zb${kind === 'ghost' || kind === 'secondary' ? ' zh' : ''}" style="${style}"${aria}${o.disabled ? ' disabled' : ''}>${inner}</button>`;
}
function iconBtn(name, aria, o = {}) { return btn('', Object.assign({ icon: name, aria, kind: 'ghost', size: o.size || 'md', radius: 10 }, o)); }
function chip(label, tone = 'neutral', o = {}) {
  const map = {
    neutral: 'background: var(--bg2); color: var(--ink2)', acc: 'background: var(--accTint); color: var(--accInk)',
    good: 'background: var(--goodTint); color: var(--good)', warn: 'background: var(--warnTint); color: var(--warn)',
    bad: 'background: var(--badTint); color: var(--bad)', ink: 'background: var(--pri); color: var(--onPri)',
    outline: 'background: transparent; color: var(--ink2); box-shadow: inset 0 0 0 1px var(--line2)'
  };
  return `<span style="display: inline-flex; align-items: center; gap: 5px; height: ${o.h || 24}px; padding: 0 ${o.px || 9}px; border-radius: 99px; font-size: ${o.fs || 12}px; font-weight: 550; white-space: nowrap; ${map[tone]}">${o.icon ? icon(o.icon, 13) : ''}${o.dot ? `<span style="width: 6px; height: 6px; border-radius: 50%; background: currentColor"></span>` : ''}${label}</span>`;
}
function field(label, o = {}) {
  const id = uid('f');
  const ic = o.icon ? `<span style="position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: var(--muted); display: flex">${icon(o.icon, 17)}</span>` : '';
  const inputStyle = `width: 100%; height: ${o.h || 44}px; padding: 0 ${o.trail ? 44 : 14}px 0 ${o.icon ? 40 : 14}px; border-radius: 12px; border: 1px solid ${o.error ? 'var(--bad)' : 'var(--line2)'}; background: var(--surf); font-size: 15px; ${o.mono ? `font-family: ${MONO}; letter-spacing: 0.04em;` : ''}`;
  return `<div style="display: flex; flex-direction: column; gap: 6px; ${o.wrapStyle || ''}">${label ? `<label for="${id}" style="font-size: 13px; font-weight: 550; color: var(--ink2)">${label}</label>` : ''}<div style="position: relative">${ic}<input id="${id}" type="${o.type || 'text'}" ${o.value ? `value="${o.value}"` : ''} placeholder="${o.placeholder || ''}" ${!label && o.aria ? `aria-label="${o.aria}"` : ''} style="${inputStyle}" ${o.readonly ? 'readonly' : ''}>${o.trail ? `<span style="position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex">${o.trail}</span>` : ''}</div>${o.hint ? `<span style="font-size: 12.5px; color: ${o.error ? 'var(--bad)' : 'var(--muted)'}">${o.hint}</span>` : ''}</div>`;
}
function sw(label, on = false, o = {}) {
  const id = uid('s');
  return `<div style="display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 44px; ${o.style || ''}"><label for="${id}" style="display: flex; flex-direction: column; gap: 2px; font-size: 14px; font-weight: 500; cursor: pointer">${label}${o.hint ? `<span style="font-size: 12.5px; font-weight: 400; color: var(--muted)">${o.hint}</span>` : ''}</label><span style="display: flex; align-items: center; gap: 8px">${o.badge || ''}<input id="${id}" class="zsw" type="checkbox" role="switch" ${on ? 'checked' : ''} ${o.disabled ? 'disabled' : ''}></span></div>`;
}
function rangeRow(label, val, pos = 50, o = {}) {
  const id = uid('r');
  return `<div style="display: flex; flex-direction: column; gap: 4px"><div style="display: flex; justify-content: space-between; align-items: baseline"><label for="${id}" style="font-size: 13px; color: var(--ink2)">${label}</label><span style="font-family: ${MONO}; font-size: 12px; color: ${o.changed ? 'var(--acc)' : 'var(--muted)'}">${val}</span></div><input id="${id}" class="zrange" type="range" min="0" max="100" value="${pos}"></div>`;
}
function avatar(txt, i = 0, size = 32) {
  const bgs = ['#F3C6C8', '#C8DAF6', '#CFE5D6', '#E6E1F3', '#F6DDB8'];
  const ink = ['#7A3940', '#2B4677', '#2E5A40', '#4A3D78', '#6B4A17'];
  return `<span style="width: ${size}px; height: ${size}px; border-radius: 50%; background: ${bgs[i % 5]}; color: ${ink[i % 5]}; display: inline-flex; align-items: center; justify-content: center; font-size: ${Math.round(size * 0.38)}px; font-weight: 600; flex-shrink: 0">${txt}</span>`;
}
function card(inner, o = {}) {
  return `<section style="background: var(--surf); border: 1px solid var(--line); border-radius: ${o.r || 20}px; padding: ${o.p ?? 20}px; ${o.shadow ? 'box-shadow: var(--shadow);' : ''} ${o.style || ''}">${inner}</section>`;
}
function eyebrow(t, c = 'var(--muted)') { return `<span style="font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: ${c}">${t}</span>`; }
function sampleBadge(t = 'Sample data') { return chip(t, 'outline', { icon: 'info' }); }

// Ad slot for free tier. kind: sponsored|adsense
function adSlot(kind = 'sponsored', o = {}) {
  if (kind === 'adsense') {
    return `<aside aria-label="Advertisement" style="border: 1px dashed var(--line2); border-radius: 16px; padding: 14px; display: flex; flex-direction: column; gap: 10px; background: var(--surf2); ${o.style || ''}"><div style="display: flex; justify-content: space-between; align-items: center"><span style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted)">AD</span><a href="#plans" style="font-size: 12px; text-decoration: none">Remove ads</a></div><div style="height: ${o.h || 120}px; border-radius: 10px; background: var(--bg2); display: flex; align-items: center; justify-content: center; text-align: center; font-size: 12px; color: var(--muted); padding: 10px">Google AdSense unit · ${o.size || '300×250'}<br>Loads in a sandboxed frame only after ad consent</div></div>`;
  }
  return `<aside aria-label="Sponsored" style="border: 1px solid var(--line); border-radius: 16px; overflow: hidden; background: var(--surf); display: flex; flex-direction: ${o.row ? 'row' : 'column'}; ${o.style || ''}"><div style="${o.row ? 'width: 120px; flex-shrink: 0' : `height: ${o.h || 120}px`}">${photo('product', { label: 'Sponsor image placeholder' })}</div><div style="padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; min-width: 0"><span style="font-size: 11px; font-weight: 600; letter-spacing: 0.06em; color: var(--muted)">SPONSORED</span><span style="font-size: 14px; font-weight: 600">[Sponsor name]</span><span style="font-size: 12.5px; color: var(--muted); line-height: 1.4">[One-line sponsor message, reviewed in Admin › Ads]</span><a href="#plans" style="font-size: 12px; text-decoration: none; margin-top: 2px">Go ad-free with Pro</a></div></aside>`;
}

// ---------- Page wrapper ----------
// fluid PAGE: root is container; fixed: root fixed w x h
function dcPage({ title, body: inner, w = 1440, h = 900, fluid = true, darkDefault = false, logic = '', vals = '', props = {}, lang = 'en', rootStyle = '' }) {
  const allProps = Object.assign({ dark: { editor: 'boolean', default: darkDefault, section: 'Theme' } }, props, { $preview: { width: w, height: h } });
  const dp = JSON.stringify(allProps).replace(/&/g, '&amp;').replace(/'/g, '&#39;');
  const sizing = fluid ? `width: 100%; min-height: ${h}px` : `width: ${w}px; height: ${h}px; overflow: hidden`;
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
${FONT_LINK}
<style>
${BASE_CSS}
</style>
</helmet>
<div class="zr" data-theme="{{theme}}" style="container-type: inline-size; container-name: zr; ${sizing}; background: var(--bg); color: var(--ink); font-family: ${FONT}; font-size: 15px; line-height: 1.45; -webkit-font-smoothing: antialiased; ${rootStyle}">
${inner}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='${dp}'>
class Component extends DCLogic {
${logic}
  renderVals() {
    const dark = this.props.dark ?? ${darkDefault};
    return { theme: dark ? 'dark' : 'light'${vals ? ', ' + vals : ''} };
  }
}
</script>
</body>
</html>
`;
}
// Wrapper artboard that imports another artboard (same folder) with props, e.g. dark mode or phone width.
function dcWrap({ title, child, w, h, dark = false, hint }) {
  const dp = JSON.stringify({ $preview: { width: w, height: h } });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
${FONT_LINK}
<style>
${BASE_CSS}
</style>
</helmet>
<div style="width: ${w}px; min-height: ${h}px; background: ${dark ? DARK.bg : LIGHT.bg}; font-family: ${FONT}">
<dc-import name="${child}" dark="{{dark}}" hint-size="${hint || `${w}px,${h}px`}"></dc-import>
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='${dp}'>
class Component extends DCLogic {
  renderVals() {
    return { dark: ${dark} };
  }
}
</script>
</body>
</html>
`;
}

// Write a canvas folder: files = [{name, html, x, y, w, h, title, expand, interactive}], notes
const fs = require('fs');
const path = require('path');
function writeCanvas(root, title, boards, notes = {}, launch) {
  const proj = path.join(root, 'project');
  fs.mkdirSync(proj, { recursive: true });
  const index = { v: 3, createdOnFiles: { v: 1, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z') }, title, launch: launch || { view: 'canvas' }, pages: [], boards: {}, order: [], notes, designSystems: [] };
  for (const b of boards) {
    fs.writeFileSync(path.join(proj, b.name), b.html);
    const e = { x: b.x, y: b.y, w: b.w, h: b.h };
    if (b.title) e.title = b.title;
    if (b.expand) e.expand = 'fill';
    if (b.interactive) e.is_interactive = true;
    index.boards[b.name] = e;
    index.order.push(b.name);
  }
  fs.writeFileSync(path.join(proj, 'canvas.json'), JSON.stringify(index, null, 1));
  return index;
}

module.exports = { FONT, MONO, FONT_LINK, LIGHT, DARK, M, BASE_CSS, IC, icon, uid, markBreeze, markAperture, markZ, markLens, wordmark, rabbitHead, scarfTail, windLines, mascotPose, mascotFace, photo, BEFORE_FILTER, btn, iconBtn, chip, field, sw, rangeRow, avatar, card, eyebrow, sampleBadge, adSlot, dcPage, dcWrap, writeCanvas };
