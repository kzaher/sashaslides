/**
 * Collecting `InterchangeLoss`es (deck-api.ts) while a deck crosses to or from Google Slides.
 *
 * A sink is scoped to a site: the mapping code for one element calls `losses.add(...)` without
 * knowing which slide it is on, and the caller scopes the sink with `at(...)` once. Features the
 * spec reports "once per deck" (`transition` on import, `layouts` and `themeColourLink` on export)
 * go through `addOncePerDeck`, so a hundred slides do not print a hundred identical lines.
 */
import type { InterchangeLoss } from "../engine/src/contracts/deck-api.ts";
import type { ElementId, SlideId } from "../engine/src/contracts/ids.ts";

export type LossSite = Readonly<{ slideId: SlideId | null; elementId: ElementId | null }>;

export type InterchangeLossSink = Readonly<{
  add(loss: Readonly<{ feature: string; detail: string }>): void;
  addOncePerDeck(loss: Readonly<{ feature: string; detail: string }>): void;
  at(site: Partial<LossSite>): InterchangeLossSink;
}>;

export type LossCollector = Readonly<{ sink: InterchangeLossSink; losses: () => readonly InterchangeLoss[] }>;

export function createLossCollector(): LossCollector {
  const collected: InterchangeLoss[] = [];
  const oncePerDeck = new Set<string>();
  const sinkAt = (site: LossSite): InterchangeLossSink => ({
    add: (loss) => {
      collected.push({ slideId: site.slideId, elementId: site.elementId, feature: loss.feature, detail: loss.detail });
    },
    addOncePerDeck: (loss) => {
      if (oncePerDeck.has(loss.feature)) return;
      oncePerDeck.add(loss.feature);
      collected.push({ slideId: null, elementId: null, feature: loss.feature, detail: loss.detail });
    },
    at: (next) => sinkAt({ slideId: next.slideId === undefined ? site.slideId : next.slideId, elementId: next.elementId === undefined ? site.elementId : next.elementId }),
  });
  return { sink: sinkAt({ slideId: null, elementId: null }), losses: () => [...collected] };
}
