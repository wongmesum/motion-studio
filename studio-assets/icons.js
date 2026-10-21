/**
 * Inline SVG icons.
 *
 * Every icon is a fixed, hand-written path with no user input, so callers can assign the
 * markup directly. Icons inherit `currentColor` and are marked aria-hidden because the
 * surrounding control always owns the accessible name.
 */

const ICON_PATHS = {
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/>'
    + '<path d="M4 17l4.5-4.5 4 4L16 13l4 4"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="2"/><path d="M16 10.5l5-3v9l-5-3z"/>',
  audio: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  chevronLeft: '<path d="M14.5 6L8.5 12l6 6"/>',
  chevronRight: '<path d="M9.5 6l6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v9"/>',
  play: '<path d="M7 4.5l12 7.5-12 7.5z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 7l-5 5 5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.8-2L20 9M4 15l2.1 2a7 7 0 0 0 11.8-2"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13"/><path d="M10 11v6M14 11v6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  upload: '<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 20h16"/>',
  download: '<path d="M12 4v12"/><path d="M7 11l5 5 5-5"/><path d="M4 20h16"/>',
};

/** Returns SVG markup for a known icon name, or an empty string for an unknown one. */
export function iconMarkup(name) {
  const path = ICON_PATHS[name];
  if (!path) return '';
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"`
    + ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`
    + ` focusable="false">${path}</svg>`;
}

/** Replaces a button's content with the icon while keeping its accessible name intact. */
export function setButtonIcon(button, name) {
  button.innerHTML = iconMarkup(name);
}
