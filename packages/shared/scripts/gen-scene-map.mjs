// Generates src/scene-map.ts: ImageNet labels (as Workers AI's ResNet-50 returns them) → Zephyr scenes.
// Usage: node scripts/gen-scene-map.mjs <path to imagenet_classes.js from @tensorflow-models/mobilenet (Apache 2.0)>
// Classes are picked by index range (dogs, cats, animals, food) or by their first name; an unknown name fails.

import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CLASSES = require(process.argv[2]).IMAGENET_CLASSES;
if (!CLASSES || Object.keys(CLASSES).length !== 1000) throw new Error('expected 1000 ImageNet classes');

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const byName = new Map(Object.entries(CLASSES).map(([i, n]) => [n.split(', ')[0].toLowerCase(), Number(i)]));
const names = (list) =>
  list.map((n) => {
    const i = byName.get(n.toLowerCase());
    if (i === undefined) throw new Error(`no ImageNet class named ${n}`);
    return i;
  });

/** Scene → class indices, most specific first (a class goes to the first scene that lists it). */
const SCENES = {
  pets: [...range(151, 268), ...range(281, 285)],
  food: [...range(923, 969), ...names(['mushroom'])],
  beach: names(['seashore', 'sandbar']),
  mountains: names(['alp', 'cliff', 'promontory', 'valley', 'volcano']),
  snow: names(['ski', 'snowmobile', 'snowplow', 'dogsled', 'bobsled']),
  water: names([
    'lakeside',
    'coral reef',
    'geyser',
    'canoe',
    'catamaran',
    'container ship',
    'fireboat',
    'gondola',
    'lifeboat',
    'liner',
    'pirate',
    'schooner',
    'speedboat',
    'submarine',
    'trimaran',
    'yawl',
    'paddle',
    'aircraft carrier',
    'wreck',
    'scuba diver',
    'snorkel',
    'breakwater',
    'dock',
    'boathouse',
  ]),
  flowers: names(['daisy', "yellow lady's slipper", 'pot', 'vase']),
  forest: names([
    'coral fungus',
    'agaric',
    'gyromitra',
    'stinkhorn',
    'earthstar',
    'hen-of-the-woods',
    'bolete',
    'acorn',
    'buckeye',
  ]),
  animals: [...range(0, 150), ...range(269, 280), ...range(286, 397)],
  interiors: names([
    'home theater',
    'library',
    'restaurant',
    'dining table',
    'four-poster',
    'studio couch',
    'wardrobe',
    'bookcase',
    'china cabinet',
    'desk',
    'entertainment center',
    'window shade',
    'shower curtain',
    'tub',
    'washbasin',
    'quilt',
    'rocking chair',
    'folding chair',
    'barber chair',
    'throne',
    'chiffonier',
    'medicine chest',
    'refrigerator',
    'microwave',
    'dishwasher',
    'stove',
    'toilet seat',
    'window screen',
    'sliding door',
    'radiator',
    'fire screen',
    'table lamp',
    'lampshade',
    'pool table',
    'prayer rug',
    'cradle',
    'crib',
    'bannister',
    'chime',
    'wall clock',
  ]),
  architecture: names([
    'castle',
    'church',
    'cinema',
    'dome',
    'greenhouse',
    'monastery',
    'mosque',
    'palace',
    'patio',
    'planetarium',
    'steel arch bridge',
    'stone wall',
    'stupa',
    'suspension bridge',
    'tile roof',
    'triumphal arch',
    'viaduct',
    'water tower',
    'beacon',
    'barn',
    'cliff dwelling',
    'fountain',
    'pier',
    'prison',
    'thatch',
    'obelisk',
    'megalith',
    'altar',
    'bell cote',
    'boathouse',
    'grocery store',
    'bookshop',
    'butcher shop',
    'tobacco shop',
    'toyshop',
    'barbershop',
    'shoe shop',
    'confectionery',
    'bakery',
    'mobile home',
    'picket fence',
    'chainlink fence',
    'worm fence',
    'sliding door',
    'turnstile',
    'traffic light',
    'street sign',
    'parking meter',
  ]),
  vehicles: names([
    'ambulance',
    'beach wagon',
    'cab',
    'convertible',
    'jeep',
    'limousine',
    'minivan',
    'Model T',
    'racer',
    'sports car',
    'police van',
    'pickup',
    'moving van',
    'trailer truck',
    'fire engine',
    'garbage truck',
    'tow truck',
    'school bus',
    'trolleybus',
    'minibus',
    'passenger car',
    'electric locomotive',
    'steam locomotive',
    'streetcar',
    'motor scooter',
    'moped',
    'mountain bike',
    'bicycle-built-for-two',
    'tricycle',
    'airliner',
    'warplane',
    'airship',
    'go-kart',
    'golfcart',
    'tractor',
    'forklift',
    'recreational vehicle',
    'car wheel',
    'grille',
    'tank',
    'half track',
    'freight car',
    'jinrikisha',
    'horse cart',
    'unicycle',
    'space shuttle',
    'amphibian',
  ]),
  documents: names([
    'envelope',
    'menu',
    'web site',
    'book jacket',
    'comic book',
    'crossword puzzle',
    'binder',
    'packet',
  ]),
};

const sceneOf = new Map();
for (const [scene, idx] of Object.entries(SCENES))
  for (const i of idx) if (!sceneOf.has(i)) sceneOf.set(i, scene);
const labels = {};
for (const [i, scene] of [...sceneOf].sort((a, b) => a[0] - b[0])) {
  for (const syn of CLASSES[i].split(', ')) {
    const k = syn.trim().toLowerCase();
    if (k && !(k in labels)) labels[k] = scene;
  }
}
const body = Object.entries(labels)
  .map(([k, v]) => `  ${JSON.stringify(k)}: '${v}',`)
  .join('\n');
writeFileSync(
  new URL('../src/scene-map.ts', import.meta.url),
  `/**
 * Phase 6: ImageNet class names (what Workers AI's ResNet-50 returns) → Zephyr scenes. Generated by
 * scripts/gen-scene-map.mjs from the ImageNet class list in @tensorflow-models/mobilenet (Apache 2.0); edit the
 * script, not this file. Night isn't here: the device decides it from the photo's brightness.
 */
import { SCENE_MIN_SCORE, type SceneId } from './ai-types';

/** Every synonym of every mapped class, lower case. */
export const LABEL_SCENES: Readonly<Record<string, Exclude<SceneId, 'night'>>> = {
${body}
};

/**
 * Scenes for a photo from the classifier's labels (any case; a label may list synonyms separated by commas).
 * Scores of labels in the same scene add up; scenes scoring at least SCENE_MIN_SCORE are kept, best first, at
 * most 3.
 */
export function sceneForLabels(labels: readonly { label: string; score: number }[]): { scene: SceneId; score: number }[] {
  const sum = new Map<SceneId, number>();
  for (const l of labels.slice(0, 10)) {
    if (typeof l?.label !== 'string' || typeof l.score !== 'number' || !Number.isFinite(l.score)) continue;
    const parts = l.label.toLowerCase().split(',').map((s) => s.trim());
    const scene = parts.map((p) => LABEL_SCENES[p]).find((s) => s !== undefined);
    if (!scene) continue;
    sum.set(scene, (sum.get(scene) ?? 0) + Math.min(1, Math.max(0, l.score)));
  }
  return [...sum]
    .map(([scene, score]) => ({ scene, score: Math.round(Math.min(1, score) * 1000) / 1000 }))
    .filter((s) => s.score >= SCENE_MIN_SCORE)
    .sort((a, b) => b.score - a.score || a.scene.localeCompare(b.scene))
    .slice(0, 3);
}
`,
);
console.log(`scene-map.ts: ${Object.keys(labels).length} labels, ${sceneOf.size} classes`);
