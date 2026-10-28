import { matchPath, useLocation } from 'react-router';
import { AlbumPage } from '../routes/Albums';
import { LibraryPage } from '../routes/Library';
import { ViewerHostProvider } from './LibraryBits';
import { Viewer } from './Viewer';

/**
 * Hosts the pages that open the photo viewer ("/", "/favourites", "/albums/:id") and the viewer itself at
 * "/photo/:id". Opening a photo keeps the page underneath mounted (scroll position, loaded pages and selection
 * survive), and the browser's Back button closes the viewer.
 */
export function LibraryHost() {
  const loc = useLocation();
  const bg = (loc.state as { bg?: string } | null)?.bg;
  const photo = matchPath('/photo/:photoId', loc.pathname);
  const pagePath = photo ? (bg ?? '/') : loc.pathname;
  const album = matchPath('/albums/:albumId', pagePath);
  const page =
    pagePath === '/favourites' ? (
      <LibraryPage key="favourites" view="favourites" />
    ) : album?.params.albumId ? (
      <AlbumPage key={`album:${album.params.albumId}`} albumId={album.params.albumId} />
    ) : (
      <LibraryPage key="library" view="library" />
    );
  return (
    <ViewerHostProvider>
      {page}
      {photo?.params.photoId && <Viewer photoId={photo.params.photoId} fromGrid={Boolean(bg)} />}
    </ViewerHostProvider>
  );
}
