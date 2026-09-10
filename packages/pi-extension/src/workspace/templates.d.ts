// The scaffold template files are imported as plain text (esbuild `text` loader,
// configured in scripts/bundle-extension.ts; Vitest reads them via its own
// asset handling). They are byte-for-byte copies of
// packages/desktop/src/main/template/, kept in sync by templates.sync.test.ts.

declare module "*.journal" {
  const content: string;
  export default content;
}

declare module "*.tmpl" {
  const content: string;
  export default content;
}
