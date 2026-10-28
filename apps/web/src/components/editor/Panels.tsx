import {
  BUILT_IN_RECIPES,
  type CropAspect,
  type EditRecipe,
  type EditSection,
  type HueBand,
  MAX_SAVED_RECIPES,
  mergeRecipe,
  RANGES,
  RECIPE_SECTIONS,
  type SavedRecipe,
} from '@zephyr/shared/client';
import { Button, Icon, IconButton, Spinner } from '@zephyr/ui';
import { type ReactNode, useState } from 'react';
import {
  BANDS,
  CONTROLS,
  getMixer,
  getValue,
  MIXER_KEYS,
  resetSection,
  SECTION_LABELS,
  setMixer,
  setValue,
} from '../../lib/editor/controls';
import { Slider } from './Slider';

export type Tool = 'adjust' | 'crop' | 'recipes';
export interface Edit {
  recipe: EditRecipe;
  /** Live change while dragging. */
  preview: (r: EditRecipe) => void;
  /** Record one undo step (with the given recipe, or the last preview). */
  commit: (r?: EditRecipe) => void;
}

export function ToolTabs({ tool, onChange }: { tool: Tool; onChange: (t: Tool) => void }) {
  const tabs: [Tool, string, 'sliders' | 'crop' | 'layers'][] = [
    ['adjust', 'Adjust', 'sliders'],
    ['crop', 'Crop', 'crop'],
    ['recipes', 'Recipes', 'layers'],
  ];
  return (
    <div className="etabs" role="tablist" aria-label="Editing tools">
      {tabs.map(([t, label, icon]) => (
        <button
          key={t}
          type="button"
          role="tab"
          id={`etab-${t}`}
          aria-selected={tool === t}
          aria-controls="epanel"
          className="etabs__tab"
          onClick={() => onChange(t)}
          onKeyDown={(e) => {
            const i = tabs.findIndex(([x]) => x === tool);
            const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!d) return;
            e.preventDefault();
            const next = tabs[(i + d + tabs.length) % tabs.length]?.[0] ?? 'adjust';
            onChange(next);
            document.getElementById(`etab-${next}`)?.focus();
          }}
        >
          <Icon name={icon} size={15} />
          {label}
        </button>
      ))}
    </div>
  );
}

const open = new Map<EditSection, boolean>();
function Section({ id, edit, children }: { id: EditSection; edit: Edit; children: ReactNode }) {
  const [isOpen, setOpen] = useState(open.get(id) ?? true);
  const changed = edit.recipe[id] !== undefined;
  const title = SECTION_LABELS[id];
  return (
    <section className="esec">
      <div className="esec__head">
        <button
          type="button"
          className="esec__toggle"
          aria-expanded={isOpen}
          onClick={() => {
            open.set(id, !isOpen);
            setOpen(!isOpen);
          }}
        >
          <Icon name={isOpen ? 'chevD' : 'chevR'} size={15} className="esec__chev" />
          {title}
          {changed && <span className="esec__dot" role="img" aria-label="Changed" />}
        </button>
        {changed && (
          <IconButton
            icon="undo"
            size="sm"
            label={`Reset ${title}`}
            onClick={() => edit.commit(resetSection(edit.recipe, id))}
          />
        )}
      </div>
      {isOpen && <div className="esec__body">{children}</div>}
    </section>
  );
}

export function Histogram({
  data,
  caption,
}: {
  data: { r: Uint32Array; g: Uint32Array; b: Uint32Array } | null;
  caption?: ReactNode;
}) {
  const path = (h: Uint32Array, max: number) => {
    const pts = Array.from(
      h,
      (v, i) => `${((i / (h.length - 1)) * 300).toFixed(1)},${(64 - (Math.sqrt(v) / max) * 58).toFixed(1)}`,
    );
    return `0,64 ${pts.join(' ')} 300,64`;
  };
  let max = 1;
  if (data)
    for (const h of [data.r, data.g, data.b])
      for (let i = 1; i < h.length - 1; i++) max = Math.max(max, Math.sqrt(h[i] as number));
  return (
    <figure className="ehist" aria-label="Histogram">
      <svg viewBox="0 0 300 64" preserveAspectRatio="none" aria-hidden="true">
        {data && (
          <>
            <polygon points={path(data.r, max)} fill="#E5484D" fillOpacity=".35" />
            <polygon points={path(data.g, max)} fill="#3BA55D" fillOpacity=".35" />
            <polygon points={path(data.b, max)} fill="#3D7BE0" fillOpacity=".35" />
          </>
        )}
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

export function AdjustPanel({ edit }: { edit: Edit }) {
  const [band, setBand] = useState<HueBand>('orange');
  const group = (section: 'light' | 'color' | 'detail' | 'effects') =>
    CONTROLS.filter((c) => c.section === section).map((c) => (
      <Slider
        key={c.key}
        label={c.label}
        value={getValue(edit.recipe, c)}
        min={c.min}
        max={c.max}
        step={c.step}
        bipolar={c.bipolar}
        track={c.track}
        onInput={(v) => edit.preview(setValue(edit.recipe, c, v))}
        onCommit={(v) => edit.commit(v === undefined ? undefined : setValue(edit.recipe, c, v))}
      />
    ));
  const bandLabel = BANDS.find((b) => b.band === band)?.label ?? '';
  return (
    <>
      <Section id="light" edit={edit}>
        {group('light')}
      </Section>
      <Section id="color" edit={edit}>
        {group('color')}
      </Section>
      <Section id="mixer" edit={edit}>
        <fieldset className="emix">
          <legend className="z-sr">Colour range</legend>
          {BANDS.map((b) => {
            const changed = MIXER_KEYS.some((k) => getMixer(edit.recipe, b.band, k.key) !== 0);
            return (
              <label
                key={b.band}
                className={`emix__dot${changed ? ' is-changed' : ''}`}
                style={{ background: b.color }}
              >
                <input
                  type="radio"
                  className="z-sr"
                  name="mixer-band"
                  checked={band === b.band}
                  onChange={() => setBand(b.band)}
                  aria-label={`${b.label}${changed ? ', changed' : ''}`}
                />
              </label>
            );
          })}
        </fieldset>
        {MIXER_KEYS.map((k) => (
          <Slider
            key={k.key}
            label={`${k.label}`}
            value={getMixer(edit.recipe, band, k.key)}
            {...RANGES.mixer[k.key]}
            track={k.key === 'hue' ? `linear-gradient(90deg, ${hueTrack(band)})` : undefined}
            onInput={(v) => edit.preview(setMixer(edit.recipe, band, k.key, v))}
            onCommit={(v) => edit.commit(v === undefined ? undefined : setMixer(edit.recipe, band, k.key, v))}
          />
        ))}
        <span className="esec__hint">Adjusting {bandLabel.toLowerCase()}s</span>
      </Section>
      <Section id="detail" edit={edit}>
        {group('detail')}
      </Section>
      <Section id="effects" edit={edit}>
        {group('effects')}
      </Section>
    </>
  );
}
function hueTrack(band: HueBand): string {
  const i = BANDS.findIndex((b) => b.band === band);
  const prev = BANDS[(i + BANDS.length - 1) % BANDS.length]?.color;
  const next = BANDS[(i + 1) % BANDS.length]?.color;
  return `${prev}, ${BANDS[i]?.color}, ${next}`;
}

export const ASPECTS: { id: CropAspect; label: string; portrait?: CropAspect; landscape?: CropAspect }[] = [
  { id: 'original', label: 'Original' },
  { id: 'free', label: 'Free' },
  { id: '1:1', label: '1:1' },
  { id: '4:5', label: '4:5', portrait: '4:5', landscape: '5:4' },
  { id: '3:2', label: '3:2', portrait: '2:3', landscape: '3:2' },
  { id: '16:9', label: '16:9', portrait: '9:16', landscape: '16:9' },
];
/** The aspect button an actual aspect belongs to ("5:4" → "4:5"). */
export function aspectButton(a: CropAspect | undefined): CropAspect {
  if (!a) return 'original';
  return ASPECTS.find((x) => x.id === a || x.portrait === a || x.landscape === a)?.id ?? 'original';
}
export const isPortraitAspect = (a: CropAspect | undefined) => a === '4:5' || a === '2:3' || a === '9:16';
const isPaired = (a: CropAspect | undefined) => ASPECTS.some((x) => x.portrait === a || x.landscape === a);
/**
 * Orientation the paired chips (4:5, 3:2, 16:9) show and apply: the current crop's when it is one of them,
 * otherwise the orientation of the (rotated) photo.
 */
export function cropOrientation(
  a: CropAspect | undefined,
  photo: { width: number; height: number },
): 'portrait' | 'landscape' {
  if (isPaired(a)) return isPortraitAspect(a) ? 'portrait' : 'landscape';
  return photo.width >= photo.height ? 'landscape' : 'portrait';
}
/** The ratio a chip actually applies for the orientation ("4:5" chip in landscape → "5:4"). */
export function aspectChoice(
  a: (typeof ASPECTS)[number],
  orientation: 'portrait' | 'landscape',
): { aspect: CropAspect; label: string } {
  if (!a.portrait || !a.landscape) return { aspect: a.id, label: a.label };
  const aspect = orientation === 'portrait' ? a.portrait : a.landscape;
  return { aspect, label: aspect };
}

export interface CropActions {
  /** Orientation the paired ratio chips show and apply (see cropOrientation). */
  orientation: 'portrait' | 'landscape';
  setAspect: (a: CropAspect) => void;
  setOrientation: (portrait: boolean) => void;
  rotate: (dir: 1 | -1) => void;
  flip: (axis: 'h' | 'v') => void;
}

export function CropPanel({ edit, actions }: { edit: Edit; actions: CropActions }) {
  const crop = edit.recipe.crop;
  const cur = aspectButton(crop?.aspect);
  const def = ASPECTS.find((a) => a.id === cur);
  const angle = crop?.angle ?? 0;
  const setCrop = (patch: Partial<NonNullable<EditRecipe['crop']>>) => ({
    ...edit.recipe,
    crop: { ...(crop ?? {}), ...patch },
  });
  return (
    <>
      <section className="ecropsec">
        <span className="ecropsec__title" id="aspect-label">
          Aspect ratio
        </span>
        <fieldset className="easpect" aria-labelledby="aspect-label">
          {ASPECTS.map((a) => {
            const c = aspectChoice(a, actions.orientation);
            return (
              <label key={a.id} className="easpect__btn">
                <input
                  type="radio"
                  className="z-sr"
                  name="crop-aspect"
                  aria-label={c.label}
                  checked={cur === a.id}
                  onChange={() => actions.setAspect(a.id)}
                  onClick={() => cur === a.id && actions.setAspect(a.id)}
                />
                {c.label}
              </label>
            );
          })}
        </fieldset>
        {def?.portrait && (
          <fieldset className="seg eorient">
            <legend className="z-sr">Orientation</legend>
            {(['Portrait', 'Landscape'] as const).map((o) => (
              <label key={o} className="seg__btn">
                <input
                  type="radio"
                  className="z-sr"
                  name="crop-orientation"
                  checked={(o === 'Portrait') === (actions.orientation === 'portrait')}
                  onChange={() => actions.setOrientation(o === 'Portrait')}
                />
                {o}
              </label>
            ))}
          </fieldset>
        )}
      </section>
      <section className="esec">
        <div className="esec__head">
          <span className="esec__toggle esec__toggle--static">
            Straighten{angle !== 0 && <span className="esec__dot" role="img" aria-label="Changed" />}
          </span>
          {angle !== 0 && (
            <IconButton
              icon="undo"
              size="sm"
              label="Reset straighten"
              onClick={() => edit.commit(setCrop({ angle: 0 }))}
            />
          )}
        </div>
        <div className="esec__body">
          <Slider
            label="Angle"
            value={angle}
            {...RANGES.crop.angle}
            suffix="°"
            onInput={(v) => edit.preview(setCrop({ angle: v }))}
            onCommit={(v) => edit.commit(v === undefined ? undefined : setCrop({ angle: v }))}
          />
        </div>
      </section>
      <section className="esec">
        <div className="esec__head">
          <span className="esec__toggle esec__toggle--static">Rotate &amp; flip</span>
        </div>
        <div className="erot">
          <IconButton icon="rotate" kind="secondary" label="Rotate left" onClick={() => actions.rotate(-1)} />
          <IconButton
            icon="rotate"
            kind="secondary"
            label="Rotate right"
            className="erot--mirror"
            onClick={() => actions.rotate(1)}
          />
          <IconButton
            icon="compare"
            kind="secondary"
            label="Flip horizontal"
            aria-pressed={Boolean(crop?.flipH)}
            onClick={() => actions.flip('h')}
          />
          <IconButton
            icon="compare"
            kind="secondary"
            label="Flip vertical"
            className="erot--turn"
            aria-pressed={Boolean(crop?.flipV)}
            onClick={() => actions.flip('v')}
          />
        </div>
      </section>
      <section className="esec">
        <div className="esec__head">
          <span className="esec__toggle esec__toggle--static">
            Perspective
            {(crop?.perspectiveV || crop?.perspectiveH) && (
              <span className="esec__dot" role="img" aria-label="Changed" />
            )}
          </span>
          {Boolean(crop?.perspectiveV || crop?.perspectiveH) && (
            <IconButton
              icon="undo"
              size="sm"
              label="Reset perspective"
              onClick={() => edit.commit(setCrop({ perspectiveV: 0, perspectiveH: 0 }))}
            />
          )}
        </div>
        <div className="esec__body">
          {(['perspectiveV', 'perspectiveH'] as const).map((k) => (
            <Slider
              key={k}
              label={k === 'perspectiveV' ? 'Vertical' : 'Horizontal'}
              value={crop?.[k] ?? 0}
              {...RANGES.crop[k]}
              onInput={(v) => edit.preview(setCrop({ [k]: v }))}
              onCommit={(v) => edit.commit(v === undefined ? undefined : setCrop({ [k]: v }))}
            />
          ))}
          <span className="esec__hint">
            <Icon name="info" size={14} />
            Straightens leaning walls in buildings and interiors.
          </span>
        </div>
      </section>
    </>
  );
}

export interface RecipeActions {
  saved: SavedRecipe[] | null;
  error: string | null;
  hover: (r: EditRecipe | null) => void;
  apply: (r: EditRecipe, name: string) => void;
  save: () => void;
  rename: (r: SavedRecipe) => void;
  remove: (r: SavedRecipe) => void;
  thumb: string | null;
}

export function RecipesPanel({ edit, actions }: { edit: Edit; actions: RecipeActions }) {
  const [menu, setMenu] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const preview = (id: string, r: EditRecipe | null) => {
    setFocus(r ? id : null);
    actions.hover(r ? mergeRecipe(edit.recipe, r, RECIPE_SECTIONS) : null);
  };
  const look = (r: EditRecipe) => cssLook(r);
  return (
    <>
      <Button kind="tint" icon="plus" full onClick={actions.save}>
        Save current edits as a recipe
      </Button>
      <section className="erecipes">
        <div className="erecipes__head">
          <span>Your recipes</span>
          {actions.saved && (
            <span className="mono erecipes__count">
              {actions.saved.length} of {MAX_SAVED_RECIPES}
            </span>
          )}
        </div>
        {actions.error && <p className="esec__hint">{actions.error}</p>}
        {!actions.saved && !actions.error && <Spinner size={16} label="Loading recipes" />}
        {actions.saved?.length === 0 && (
          <p className="esec__hint">Save the look of this photo to use it on others in one click.</p>
        )}
        <ul className="erecipes__list">
          {actions.saved?.map((s) => (
            <li
              key={s.id}
              className={`erow${focus === s.id ? ' is-preview' : ''}`}
              onMouseEnter={() => preview(s.id, s.recipe)}
              onMouseLeave={() => preview(s.id, null)}
            >
              <button
                type="button"
                className="erow__main"
                onFocus={() => preview(s.id, s.recipe)}
                onBlur={() => preview(s.id, null)}
                onClick={() => actions.apply(s.recipe, s.name)}
              >
                <span className="erow__thumb" style={{ filter: look(s.recipe) }}>
                  {actions.thumb && <img src={actions.thumb} alt="" />}
                </span>
                <span className="erow__text">
                  <span className="erow__name">{s.name}</span>
                  <span className="erow__sub">
                    {focus === s.id ? 'Previewing on this photo' : sectionsOf(s.recipe)}
                  </span>
                </span>
              </button>
              {focus === s.id && (
                <Button
                  kind="primary"
                  size="sm"
                  tabIndex={-1}
                  onClick={() => actions.apply(s.recipe, s.name)}
                >
                  Apply
                </Button>
              )}
              <div className="erow__more">
                <IconButton
                  icon="more"
                  size="sm"
                  label={`More for ${s.name}`}
                  aria-expanded={menu === s.id}
                  onClick={() => setMenu(menu === s.id ? null : s.id)}
                />
                {menu === s.id && (
                  <div className="emenu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        actions.rename(s);
                      }}
                    >
                      Rename
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      className="emenu__danger"
                      onClick={() => {
                        setMenu(null);
                        actions.remove(s);
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="erecipes erecipes--built">
        <div className="erecipes__head">
          <span>Zephyr recipes</span>
        </div>
        <div className="ebuilt">
          {BUILT_IN_RECIPES.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`ebuilt__item${focus === b.id ? ' is-preview' : ''}`}
              onMouseEnter={() => preview(b.id, b.recipe)}
              onMouseLeave={() => preview(b.id, null)}
              onFocus={() => preview(b.id, b.recipe)}
              onBlur={() => preview(b.id, null)}
              onClick={() => actions.apply(b.recipe, b.name)}
            >
              <span className="ebuilt__img" style={{ filter: look(b.recipe) }}>
                {actions.thumb && <img src={actions.thumb} alt="" />}
              </span>
              <span className="ebuilt__name">{b.name}</span>
            </button>
          ))}
        </div>
      </section>
      <p className="esec__hint esec__hint--block">
        <Icon name="info" size={14} />
        <span>
          Hover to preview. A recipe sets light, colour and detail; it never changes the crop. Undo puts the
          previous settings back.
        </span>
      </p>
    </>
  );
}

function sectionsOf(r: EditRecipe): string {
  return (
    RECIPE_SECTIONS.filter((s) => r[s] !== undefined)
      .map((s) => (s === 'mixer' ? 'Mixer' : SECTION_LABELS[s]))
      .join(' · ') || 'No changes'
  );
}

/** A rough CSS-filter impression of a recipe, for the small recipe tiles only (the photo shows the real thing). */
export function cssLook(r: EditRecipe): string {
  const L = r.light ?? {};
  const C = r.color ?? {};
  const b = 1 + (L.exposure ?? 0) * 0.25 + ((L.shadows ?? 0) + (L.whites ?? 0)) / 600;
  const c = 1 + ((L.contrast ?? 0) - (L.blacks ?? 0) * 0.5) / 250;
  const s = Math.max(0, 1 + ((C.saturation ?? 0) + (C.vibrance ?? 0) * 0.6) / 100);
  const sep = Math.max(0, (C.temperature ?? 0) / 120);
  return `brightness(${b.toFixed(3)}) contrast(${c.toFixed(3)}) saturate(${s.toFixed(3)}) sepia(${sep.toFixed(3)})`;
}
