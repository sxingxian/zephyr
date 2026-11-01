import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@zephyr/ui/styles.css';
import './guest.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { GuestApp } from './GuestApp';

// The guest gallery page: a separate, light app. No member session, no service worker, no analytics.
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <GuestApp pathname={window.location.pathname} />
    </StrictMode>,
  );
}
