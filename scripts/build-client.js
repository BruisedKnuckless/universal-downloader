/**
 * Bundles the browser half of @vercel/blob into public/js/vendor/blob-client.js.
 *
 * The frontend is plain script tags with no bundler, so the ESM package is
 * pre-built into an IIFE that hangs `upload()` off window. The output is
 * committed, which means neither Vercel nor Railway needs a build step —
 * re-run `npm run build:client` only when @vercel/blob is upgraded.
 */
const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');

const OUT = path.join(__dirname, '../public/js/vendor/blob-client.js');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

esbuild.buildSync({
  stdin: {
    contents: `
      import { upload } from '@vercel/blob/client';
      window.VercelBlobClient = { upload };
    `,
    resolveDir: path.join(__dirname, '..'),
    loader: 'js'
  },
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  // The SDK reads optional overrides from process.env, which does not exist in
  // a browser. Substituting an empty object makes every lookup undefined
  // instead of a ReferenceError.
  define: { 'process.env': '{}' },
  outfile: OUT
});

const { size } = fs.statSync(OUT);
console.log(`built ${path.relative(process.cwd(), OUT)} (${(size / 1024).toFixed(1)} KB)`);
