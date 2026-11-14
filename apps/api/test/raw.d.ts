/** Vite's `?raw` imports: a file's text (used to check constants against the SQL migration). */
declare module '*.sql?raw' {
  const text: string;
  export default text;
}
declare module '*.mjs?raw' {
  const text: string;
  export default text;
}
