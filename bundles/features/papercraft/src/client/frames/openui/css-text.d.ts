// A sheet imported with `{ type: 'text' }` is its text (esbuild's `text` loader).
declare module '*.css' {
  const text: string;
  export default text;
}
