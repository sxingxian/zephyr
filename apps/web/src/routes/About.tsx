import { Card, CardHead } from '@zephyr/ui';
import { SettingsNav } from '../components/SettingsNav';
import { Shell } from '../components/Shell';

interface Lib {
  name: string;
  licence: string;
  use: string;
  source: string;
}
/** Open-source software bundled in the app (the landing page and server list theirs separately). */
const LIBS: Lib[] = [
  {
    name: 'LibRaw',
    licence: 'LGPL-2.1 (also available under CDDL-1.0)',
    use: 'Reads RAW files (CR2, NEF, ARW) on your device. Shipped as a separate WebAssembly file, libraw.wasm, which can be replaced.',
    source: 'https://github.com/LibRaw/LibRaw',
  },
  {
    name: '@colorhythm/libraw-wasm',
    licence: 'MIT',
    use: 'The WebAssembly build of LibRaw and its JavaScript bindings.',
    source: 'https://github.com/colorhythm/libraw-wasm',
  },
  { name: 'React', licence: 'MIT', use: 'The app’s interface.', source: 'https://github.com/facebook/react' },
  {
    name: 'React Router',
    licence: 'MIT',
    use: 'Pages and navigation.',
    source: 'https://github.com/remix-run/react-router',
  },
  {
    name: 'TanStack Virtual',
    licence: 'MIT',
    use: 'The photo grid.',
    source: 'https://github.com/TanStack/virtual',
  },
  {
    name: 'exifr',
    licence: 'MIT',
    use: 'Reads camera details from photos you upload.',
    source: 'https://github.com/MikeKovarik/exifr',
  },
  {
    name: 'hash-wasm',
    licence: 'MIT',
    use: 'Fingerprints files to skip duplicates.',
    source: 'https://github.com/Daninet/hash-wasm',
  },
  {
    name: 'fflate',
    licence: 'MIT',
    use: 'Packs exported photos into a .zip.',
    source: 'https://github.com/101arrowz/fflate',
  },
  {
    name: 'SimpleWebAuthn',
    licence: 'MIT',
    use: 'Passkey sign-in.',
    source: 'https://github.com/MasterKale/SimpleWebAuthn',
  },
  {
    name: 'Geist and Geist Mono',
    licence: 'SIL Open Font License 1.1',
    use: 'Typefaces.',
    source: 'https://github.com/vercel/geist-font',
  },
];

export function About() {
  return (
    <Shell title="Settings">
      <div className="settings">
        <SettingsNav />
        <div className="settings__body">
          <Card>
            <CardHead title="Open-source licences">
              Zephyr is built with these libraries. Thank you to their authors.
            </CardHead>
            <ul className="plain-list licences">
              {LIBS.map((l) => (
                <li key={l.name} className="row">
                  <span className="row__text">
                    <span className="row__title">{l.name}</span>
                    <span className="row__sub">{l.use}</span>
                    <span className="row__sub">
                      {l.licence} ·{' '}
                      <a href={l.source} target="_blank" rel="noopener noreferrer">
                        Source code
                      </a>
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
          <p className="z-hint">
            LibRaw is used under the GNU Lesser General Public License 2.1. You can get its source code from
            the link above, and replace the libraw.wasm file the app loads with your own build.
          </p>
        </div>
      </div>
    </Shell>
  );
}
