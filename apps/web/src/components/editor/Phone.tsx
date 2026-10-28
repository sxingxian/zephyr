import { BUILT_IN_RECIPES, type HueBand, type MixerChannel, RANGES } from '@zephyr/shared/client';
import { Icon } from '@zephyr/ui';
import { type CSSProperties, useState } from 'react';
import {
  ariaValue,
  BANDS,
  CONTROLS,
  formatValue,
  getMixer,
  getValue,
  MIXER_KEYS,
  setMixer,
  setValue,
} from '../../lib/editor/controls';
import {
  ASPECTS,
  aspectButton,
  aspectChoice,
  type CropActions,
  cssLook,
  type Edit,
  type RecipeActions,
} from './Panels';

/** The phone's big value readout plus a ticked dial (a native range input under the ticks). */
function Dial({
  label,
  value,
  min,
  max,
  step,
  suffix = '',
  onInput,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onInput: (v: number) => void;
  onCommit: () => void;
}) {
  const pos = ((value - min) / (max - min)) * 100;
  return (
    <div className="edial">
      <div className="edial__read">
        <span className="edial__label">{label}</span>
        <span className={`edial__value${value ? ' is-changed' : ''}`}>
          {formatValue(value, step, suffix)}
        </span>
      </div>
      <div className="edial__rail" style={{ '--pos': `${pos}%` } as CSSProperties}>
        <span className="edial__ticks" aria-hidden="true" />
        <span className="edial__mark" aria-hidden="true" />
        <input
          type="range"
          aria-label={label}
          aria-valuetext={ariaValue({ label }, value, step, suffix)}
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onInput(Number(e.target.value))}
          onPointerUp={onCommit}
          onKeyUp={onCommit}
          onBlur={onCommit}
          onDoubleClick={() => {
            onInput(0);
            onCommit();
          }}
        />
      </div>
    </div>
  );
}

type Group = 'light' | 'color' | 'mixer' | 'detail' | 'effects';
const GROUPS: [Group, string][] = [
  ['light', 'Light'],
  ['color', 'Colour'],
  ['mixer', 'Mixer'],
  ['detail', 'Detail'],
  ['effects', 'Effects'],
];

export function PhoneAdjust({ edit }: { edit: Edit }) {
  const [group, setGroup] = useState<Group>('light');
  const [key, setKey] = useState('exposure');
  const [band, setBand] = useState<HueBand>('orange');
  const [mkey, setMkey] = useState<keyof MixerChannel>('saturation');
  const controls = group === 'mixer' ? [] : CONTROLS.filter((c) => c.section === group);
  const c = controls.find((x) => x.key === key) ?? controls[0];
  const pick = (g: Group) => {
    setGroup(g);
    const first = CONTROLS.find((x) => x.section === g);
    if (first) setKey(first.key);
  };
  return (
    <>
      {group === 'mixer' ? (
        <>
          <Dial
            label={`${BANDS.find((b) => b.band === band)?.label} ${MIXER_KEYS.find((k) => k.key === mkey)?.label.toLowerCase()}`}
            value={getMixer(edit.recipe, band, mkey)}
            {...RANGES.mixer[mkey]}
            onInput={(v) => edit.preview(setMixer(edit.recipe, band, mkey, v))}
            onCommit={() => edit.commit()}
          />
          <fieldset className="emix emix--phone">
            <legend className="z-sr">Colour range</legend>
            {BANDS.map((b) => (
              <label key={b.band} className="emix__dot" style={{ background: b.color }}>
                <input
                  type="radio"
                  className="z-sr"
                  name="mixer-band-phone"
                  checked={band === b.band}
                  onChange={() => setBand(b.band)}
                  aria-label={b.label}
                />
              </label>
            ))}
          </fieldset>
          <div className="echips">
            {MIXER_KEYS.map((k) => (
              <button
                key={k.key}
                type="button"
                aria-pressed={mkey === k.key}
                className="echip"
                onClick={() => setMkey(k.key)}
              >
                <span className="echip__name">{k.label}</span>
                <span className="echip__val">{formatValue(getMixer(edit.recipe, band, k.key), 1)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        c && (
          <>
            <Dial
              label={c.label}
              value={getValue(edit.recipe, c)}
              min={c.min}
              max={c.max}
              step={c.step}
              onInput={(v) => edit.preview(setValue(edit.recipe, c, v))}
              onCommit={() => edit.commit()}
            />
            <div className="echips">
              {controls.map((x) => {
                const v = getValue(edit.recipe, x);
                return (
                  <button
                    key={x.key}
                    type="button"
                    aria-pressed={x.key === c.key}
                    className="echip"
                    onClick={() => setKey(x.key)}
                  >
                    <span className="echip__name">{x.short ?? x.label}</span>
                    <span className={`echip__val${v ? ' is-changed' : ''}`}>{formatValue(v, x.step)}</span>
                  </button>
                );
              })}
            </div>
          </>
        )
      )}
      <div className="egroups">
        {GROUPS.map(([g, label]) => (
          <button
            key={g}
            type="button"
            aria-pressed={group === g}
            className="egroups__btn"
            onClick={() => pick(g)}
          >
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

export function PhoneCrop({ edit, actions }: { edit: Edit; actions: CropActions }) {
  const [target, setTarget] = useState<'angle' | 'perspectiveV' | 'perspectiveH'>('angle');
  const crop = edit.recipe.crop;
  const cur = aspectButton(crop?.aspect);
  const range = target === 'angle' ? RANGES.crop.angle : RANGES.crop[target];
  const label =
    target === 'angle'
      ? 'Straighten'
      : target === 'perspectiveV'
        ? 'Vertical perspective'
        : 'Horizontal perspective';
  return (
    <>
      <Dial
        label={label}
        value={crop?.[target] ?? 0}
        {...range}
        suffix={target === 'angle' ? '°' : ''}
        onInput={(v) => edit.preview({ ...edit.recipe, crop: { ...(crop ?? {}), [target]: v } })}
        onCommit={() => edit.commit()}
      />
      <fieldset className="echips echips--pills">
        <legend className="z-sr">Aspect ratio</legend>
        {ASPECTS.map((a) => {
          const c = aspectChoice(a, actions.orientation);
          return (
            <label key={a.id} className="epill">
              <input
                type="radio"
                className="z-sr"
                name="crop-aspect-phone"
                aria-label={c.label}
                checked={cur === a.id}
                onChange={() => actions.setAspect(a.id)}
              />
              {c.label}
            </label>
          );
        })}
      </fieldset>
      <div className="ecropbtns">
        <button type="button" className="ecropbtn" onClick={() => actions.rotate(1)}>
          <Icon name="rotate" size={16} />
          Rotate
        </button>
        <button
          type="button"
          className="ecropbtn"
          aria-pressed={Boolean(crop?.flipH)}
          onClick={() => actions.flip('h')}
        >
          <Icon name="compare" size={16} />
          Flip
        </button>
        <button
          type="button"
          className="ecropbtn"
          aria-pressed={target !== 'angle'}
          onClick={() =>
            setTarget(
              target === 'angle' ? 'perspectiveV' : target === 'perspectiveV' ? 'perspectiveH' : 'angle',
            )
          }
        >
          <Icon name="perspective" size={16} />
          Perspective
        </button>
        <button
          type="button"
          className="ecropbtn"
          onClick={() => edit.commit({ ...edit.recipe, crop: undefined })}
          disabled={!crop}
        >
          <Icon name="undo" size={16} />
          Reset
        </button>
      </div>
    </>
  );
}

export function PhoneRecipes({ actions }: { edit: Edit; actions: RecipeActions }) {
  const all = [
    ...(actions.saved ?? []).map((s) => ({ id: s.id, name: s.name, recipe: s.recipe })),
    ...BUILT_IN_RECIPES,
  ];
  return (
    <>
      <ul className="ephone-recipes" aria-label="Recipes">
        {all.map((r) => (
          <li key={r.id}>
            <button type="button" className="ephone-recipe" onClick={() => actions.apply(r.recipe, r.name)}>
              <span className="ephone-recipe__img" style={{ filter: cssLook(r.recipe) }}>
                {actions.thumb && <img src={actions.thumb} alt="" />}
              </span>
              <span className="ephone-recipe__name">{r.name}</span>
            </button>
          </li>
        ))}
      </ul>
      <button type="button" className="ecropbtn ecropbtn--wide" onClick={actions.save}>
        <Icon name="plus" size={16} />
        Save current edits as a recipe
      </button>
    </>
  );
}
