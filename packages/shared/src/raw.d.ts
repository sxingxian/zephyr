/** Vite's `?raw` imports in tests: a file's text (the shared name cases in supabase/tests). */
declare module '*.txt?raw' {
  const text: string;
  export default text;
}
