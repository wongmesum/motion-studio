/** Curated, version-pinned Lottie catalog from ytrofr/claude-remotion-editor.
 * The upstream MIT license and notices must be retained when copying assets.
 * Catalog entries are not executable input and must never accept arbitrary URLs.
 */
export const LOTTIE_CATALOG = Object.freeze([
  Object.freeze({ id: 'click-sunburst-soft-xs', label: 'Click sunburst', category: 'gesture', file: 'click-sunburst-soft-xs.json' }),
  Object.freeze({ id: 'cursor-anim-filled-click', label: 'Cursor click', category: 'cursor', file: 'cursor-anim-filled-click.json' }),
  Object.freeze({ id: 'cursor-anim-filled-idle', label: 'Cursor idle', category: 'cursor', file: 'cursor-anim-filled-idle.json' }),
]);
export function findLottie(id) {
  return LOTTIE_CATALOG.find(item => item.id === id) || null;
}
