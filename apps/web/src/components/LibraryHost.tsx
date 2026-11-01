import { SCENES, type SceneId } from '@zephyr/shared/client';
import { Spinner } from '@zephyr/ui';
import { lazy, Suspense } from 'react';
import { matchPath, useLocation } from 'react-router';
import { AlbumPage } from '../routes/Albums';
import { LibraryPage } from '../routes/Library';
import { ViewerHostProvider } from './LibraryBits';
import { Viewer } from './Viewer';

// The editor (WebGL, RAW decoding) is its own chunk, loaded when a photo is first edited.
const Editor = lazy(() => import('./editor/Editor').then((m) => ({ default: m.Editor })));
// Phase 6: a person's and a scene's photos (their own chunks).
const PersonPage = lazy(() => import('../routes/People').then((m) => ({ default: m.PersonPage })));
const ScenePhotosPage = lazy(() => import('../routes/Scenes').then((m) => ({ default: m.ScenePhotosPage })));

/**
 * Hosts the pages that open the photo viewer ("/", "/favourites", "/albums/:id"), the viewer itself at
 * "/photo/:id" and the editor at "/edit/:id". Opening a photo keeps the page underneath mounted (scroll
 * position, loaded pages and selection survive), and the browser's Back button closes the viewer or editor.
 */
export function LibraryHost() {
  const loc = useLocation();
  const bg = (loc.state as { bg?: string } | null)?.bg;
  const photo = matchPath('/photo/:photoId', loc.pathname);
  const edit = matchPath('/edit/:photoId', loc.pathname);
  const pagePath = photo || edit ? (bg ?? '/') : loc.pathname;
  const album = matchPath('/albums/:albumId', pagePath);
  const person = matchPath('/people/:personId', pagePath);
  const scene = matchPath('/scenes/:scene', pagePath);
  const sceneId = scene?.params.scene;
  const page = person?.params.personId ? (
    <Suspense fallback={<Spinner size={22} label="Loading" />}>
      <PersonPage key={`person:${person.params.personId}`} personId={person.params.personId} />
    </Suspense>
  ) : sceneId && (SCENES as readonly string[]).includes(sceneId) ? (
    <Suspense fallback={<Spinner size={22} label="Loading" />}>
      <ScenePhotosPage key={`scene:${sceneId}`} scene={sceneId as SceneId} />
    </Suspense>
  ) : pagePath === '/favourites' ? (
    <LibraryPage key="favourites" view="favourites" />
  ) : album?.params.albumId ? (
    <AlbumPage key={`album:${album.params.albumId}`} albumId={album.params.albumId} />
  ) : (
    <LibraryPage key="library" view="library" />
  );
  return (
    <ViewerHostProvider>
      <div className="host-page" inert={Boolean(edit) || undefined}>
        {page}
      </div>
      {photo?.params.photoId && <Viewer photoId={photo.params.photoId} fromGrid={Boolean(bg)} />}
      {edit?.params.photoId && (
        <Suspense
          fallback={
            <div className="editor editor--msg">
              <Spinner size={22} label="Opening the editor" />
            </div>
          }
        >
          <Editor key="editor" photoId={edit.params.photoId} />
        </Suspense>
      )}
    </ViewerHostProvider>
  );
}
