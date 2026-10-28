import '@fontsource-variable/geist/wght.css';
import '@fontsource-variable/geist-mono/wght.css';
import '@zephyr/ui/styles.css';
import './styles.css';
import './editor.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { createRouter } from './App';

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <RouterProvider router={createRouter()} />
    </StrictMode>,
  );
}
