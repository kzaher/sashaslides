// THE SAMPLE PHOTOGRAPH: a small landscape drawn as markup, standing in for an uploaded photograph. The
// demo stores its bytes as an asset, the chrome harness answers its asset address with it, and the
// export comparison deck draws it on both sides, so all three show the same picture.

/** The landscape as SVG markup (440 by 360). */
export const SAMPLE_PHOTOGRAPH_MARKUP = `<svg xmlns="http://www.w3.org/2000/svg" width="440" height="360" viewBox="0 0 440 360"><defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><rect width="440" height="360" fill="url(#sky)"/><circle cx="330" cy="110" r="46" fill="#fb923c"/><path d="M0 260 L120 150 L230 250 L320 180 L440 270 L440 360 L0 360 Z" fill="#0e7490"/><path d="M0 300 L160 230 L300 300 L440 250 L440 360 L0 360 Z" fill="#047857"/></svg>`;

/** The landscape as a `data:` address, so nothing has to be fetched to draw it. */
export const SAMPLE_PHOTOGRAPH_ADDRESS = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SAMPLE_PHOTOGRAPH_MARKUP)}`;
