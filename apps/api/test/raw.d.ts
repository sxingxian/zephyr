/** Vite's `?raw` imports: a file's text (used to check constants against the SQL migration). */
declare module '*.sql?raw' {
  const text: string;
  export default text;
}

/** Vite's import.meta.glob (the route-file grep test in library-context.test.ts). */
interface ImportMeta {
  glob<T = unknown>(
    pattern: string,
    options: { query: '?raw'; import: 'default'; eager: true },
  ): Record<string, T>;
}
