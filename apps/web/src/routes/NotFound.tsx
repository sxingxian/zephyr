import { Mascot } from '@zephyr/ui';
import { Link } from 'react-router';

export function NotFound() {
  return (
    <main id="main" className="nf">
      <Mascot pose="ponder" width={180} tile={{ background: 'var(--m-lilac)', height: 200, radius: 100 }} />
      <h1 className="nf__title">This page blew away.</h1>
      <p className="z-muted">The link may be old, or the page may have moved.</p>
      <Link to="/" className="z-btn z-btn--primary z-btn--lg">
        Back to Zephyr
      </Link>
    </main>
  );
}
