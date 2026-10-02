/**
 * APEX KART — public asset path helper.
 *
 * The game ships both standalone (dev: served at /) and as a GitHub Pages
 * project site (served at https://<user>.github.io/<repo>/). NEXT_PUBLIC_BASE_PATH
 * is injected at build time (see package.json build:static) so every public
 * asset reference works in both layouts.
 */

/** '' in dev, e.g. '/gmail' on GitHub Pages. */
export const PUBLIC_BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Resolve a public/ asset: publicAsset('models/asfalto.jpg'). */
export function publicAsset(path: string): string {
  return `${PUBLIC_BASE}/${path.replace(/^\//, '')}`;
}
