// FIT BOX: the letterbox rule shared by the presenter's slide surfaces, the exported page and the
// transition runner's stage -- scale a content box to fit inside a container as large as possible
// and centre it. Pure arithmetic, so the page-side runner bundle can import it.

/** Where the content sits inside the container, in the container's units, and the scale applied to it. */
export type FittedBox = Readonly<{ left: number; top: number; width: number; height: number; scale: number }>;

/** `content` scaled by the largest non-negative factor that fits `container`, centred in it. */
export function fitBox(options: Readonly<{ container: Readonly<{ width: number; height: number }>; content: Readonly<{ width: number; height: number }> }>): FittedBox {
  const { container, content } = options;
  const scale = Math.max(0, Math.min(container.width / content.width, container.height / content.height));
  const width = content.width * scale;
  const height = content.height * scale;
  return { left: (container.width - width) / 2, top: (container.height - height) / 2, width, height, scale };
}
