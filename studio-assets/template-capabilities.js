/**
 * Which visual properties each template actually renders.
 *
 * The inspector hides controls a template ignores instead of showing dead inputs that
 * silently change project JSON without changing the video.
 */
/** Composes its own centred layout, so free positioning has nowhere to land. */
const TEXT_ONLY_VISUAL = Object.freeze({ position: false, fit: false, kenBurns: false });
/** Slideshow draws one image per scene: it crops or letterboxes, and optionally zooms. */
const SLIDE_VISUAL = Object.freeze({ position: false, fit: true, kenBurns: true });
/** Mixer places media cards by normalised x/y/width; it always crops to fill the card. */
const MIXER_VISUAL = Object.freeze({ position: true, fit: false, kenBurns: false });

const TEXT_CAPABILITY = Object.freeze({
  position: false,
  fontSize: true,
  color: true,
  align: true,
});

const CAPABILITIES = Object.freeze({
  base: Object.freeze({
    text: Object.freeze({ ...TEXT_CAPABILITY, motion: true }),
    image: TEXT_ONLY_VISUAL,
    video: TEXT_ONLY_VISUAL,
  }),
  'kinetic-text': Object.freeze({
    text: TEXT_CAPABILITY,
    image: TEXT_ONLY_VISUAL,
    video: TEXT_ONLY_VISUAL,
  }),
  'image-slideshow': Object.freeze({
    text: TEXT_CAPABILITY,
    image: SLIDE_VISUAL,
    // The slideshow only draws `type: 'image'` backgrounds; a video element is ignored.
    video: TEXT_ONLY_VISUAL,
  }),
  'video-mixer': Object.freeze({
    text: TEXT_CAPABILITY,
    image: MIXER_VISUAL,
    video: MIXER_VISUAL,
  }),
});

const FALLBACK = Object.freeze({
  text: TEXT_CAPABILITY,
  image: TEXT_ONLY_VISUAL,
  video: TEXT_ONLY_VISUAL,
});

export function capabilitiesFor(templateId) {
  return CAPABILITIES[templateId] || FALLBACK;
}

export function supportsProperty(templateId, elementType, property) {
  const capabilities = capabilitiesFor(templateId);
  return Boolean(capabilities[elementType]?.[property]);
}
