export declare const ADSENSE_SOURCES: Readonly<
  Record<'script-src' | 'frame-src' | 'img-src' | 'connect-src', readonly string[]>
>;
export declare function appCsp(hashes?: readonly string[], opts?: { adsense?: boolean }): string;
export declare const APP_HEADERS: Readonly<Record<string, string>>;
export declare const APP_HEADERS_FILE: string;
