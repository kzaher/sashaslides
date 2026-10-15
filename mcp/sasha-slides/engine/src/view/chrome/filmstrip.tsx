// THE FILMSTRIP: every slide as a numbered `StaticSlide` thumbnail in a glass panel, with badges for
// skipped slides, transitions, open comments and who is looking at it; click to open, Shift or the
// primary modifier to select several, drag to reorder (SPEC.md section 9).
//
// Key decisions:
//
//  * VIRTUALISED PAST 40 SLIDES. Up to 40 every thumbnail is mounted; beyond that only the ones in
//    view, plus a few either side, are (`visibleThumbnailRange`). Thumbnails sit at fixed offsets in
//    a full-height scroller, so the scroll bar is honest and scrolling never measures anything.
//  * A THUMBNAIL RE-RENDERS ONLY WHEN ITS SLIDE DOES. `StaticSlide` is memoised on what it draws
//    (static-slide.tsx), so typing on slide 3 redraws thumbnail 3 and no other.
//  * DRAGGING IS REPORTED, the reducer moves: `slideDragStarted`, `slideDragOver` with the slide
//    the drop would land after, `slideDragEnded`; the drop indicator draws from the gesture.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";
import { assertNever } from "../../contracts/assert-never.ts";
import type { CommentThread } from "../../contracts/discussion.ts";
import type { DocumentSnapshot, SlideSnapshot } from "../../contracts/document.ts";
import type { Gesture } from "../../contracts/editor-state.ts";
import type { SlideId } from "../../contracts/ids.ts";
import type { PeerPresence } from "../../contracts/presence.ts";
import type { Selection } from "../../contracts/selection.ts";
import { TIDEPOOL_CLASS } from "../../theme/tidepool-stylesheet.ts";
import { shallowEqual, useEditorSelector, useEditorServices } from "../application/editor-services.tsx";
import { peerColour } from "../canvas/canvas-overlay.tsx";
import { editingDisabledReason } from "./access.ts";
import { shownPeers, usePresenceNow } from "./presence.ts";
import { StaticSlide } from "../render/static-slide.tsx";
import { VIEW_CLASS } from "../view-stylesheet.ts";
import { Icon } from "./icons.tsx";
import { initials } from "./top-bar.tsx";
import { modifiersOf } from "../text/text-editor-handlers.ts";

/** Up to this many slides every thumbnail is mounted (SPEC.md section 8). */
export const VIRTUALISE_BEYOND_SLIDES = 40;
export const THUMBNAIL_WIDTH = 156;
export const THUMBNAIL_GAP = 14;
export const THUMBNAIL_OVERSCAN = 3;
/** The scroller's padding above the first thumbnail. */
const LIST_PADDING = 8;
/** What a thumbnail renders before the scroller has been measured (server rendering, first paint). */
export const ASSUMED_VIEWPORT_HEIGHT = 900;

/** The thumbnails to mount: all of them up to the threshold, else those in view plus the overscan. */
export function visibleThumbnailRange(options: Readonly<{ slideCount: number; scrollTop: number; viewportHeight: number; itemHeight: number }>): Readonly<{ first: number; last: number }> {
  if (options.slideCount <= VIRTUALISE_BEYOND_SLIDES) return { first: 0, last: options.slideCount - 1 };
  const first = Math.max(0, Math.floor((options.scrollTop - LIST_PADDING) / options.itemHeight) - THUMBNAIL_OVERSCAN);
  const last = Math.min(options.slideCount - 1, Math.ceil((options.scrollTop + options.viewportHeight) / options.itemHeight) + THUMBNAIL_OVERSCAN);
  return { first, last };
}

/** One thumbnail row's height for a page height. */
export function thumbnailItemHeight(pageHeight: number): number {
  return Math.round((THUMBNAIL_WIDTH * pageHeight) / 1280) + THUMBNAIL_GAP;
}

export const Filmstrip = memo(function Filmstrip(): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const view = useEditorSelector(
    (state) => ({
      document: state.document,
      currentSlideId: state.currentSlideId,
      selection: state.selection,
      dragging: draggingSlides(state.gesture),
      peers: state.peers,
      discussion: state.discussion,
      editing: editingDisabledReason(state),
    }),
    shallowEqual,
  );
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(ASSUMED_VIEWPORT_HEIGHT);
  const dropped = useRef(false);
  const slides = view.document.slides;
  const itemHeight = thumbnailItemHeight(view.document.pageSize.height);
  const range = visibleThumbnailRange({ slideCount: slides.length, scrollTop, viewportHeight, itemHeight });
  const selected = selectedSlides({ selection: view.selection, currentSlideId: view.currentSlideId });
  const openThreads = threadCountsBySlide(view.discussion.threads);
  const presenceNow = usePresenceNow({ now: services.now, watching: view.peers.length > 0 });
  const peers = useMemo(() => shownPeers({ peers: view.peers, now: presenceNow }).map((entry) => entry.peer), [view.peers, presenceNow]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight));
    observer.observe(element);
    setViewportHeight(element.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = scroller.current;
    const index = slides.findIndex((slide) => slide.id === view.currentSlideId);
    if (element === null || index < 0) return;
    const top = LIST_PADDING + index * itemHeight;
    if (top < element.scrollTop || top + itemHeight > element.scrollTop + element.clientHeight) element.scrollTo({ top: Math.max(0, top - itemHeight) });
  }, [view.currentSlideId, slides, itemHeight]);

  const dropAfterAt = (clientY: number): SlideId | null => {
    const element = scroller.current;
    if (element === null) return null;
    const offset = clientY - element.getBoundingClientRect().top + element.scrollTop - LIST_PADDING;
    const index = Math.round(offset / itemHeight) - 1;
    if (index < 0) return null;
    return slides[Math.min(index, slides.length - 1)]?.id ?? null;
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (view.dragging === null) return;
    event.preventDefault();
    const dropAfter = dropAfterAt(event.clientY);
    if (dropAfter !== view.dragging.dropAfter) dispatch({ kind: "slideDragOver", dropAfter });
  };

  const dropIndex = view.dragging === null ? null : view.dragging.dropAfter === null ? 0 : slides.findIndex((slide) => slide.id === view.dragging?.dropAfter) + 1;

  return (
    <nav className={`${TIDEPOOL_CLASS.panel} ${VIEW_CLASS.filmstrip}`} aria-label="Slides">
      <div
        ref={scroller}
        className={VIEW_CLASS.filmstripScroller}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onDragOver={onDragOver}
        onDrop={(event) => {
          if (view.dragging === null) return;
          event.preventDefault();
          dropped.current = true;
          dispatch({ kind: "slideDragEnded", dropped: true });
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          dispatch({ kind: "contextMenuOpened", at: { x: event.clientX, y: event.clientY }, scope: "filmstrip" });
        }}
        role="listbox"
        aria-multiselectable="true"
        aria-label="Slides in order"
      >
        <div style={{ position: "relative", height: LIST_PADDING * 2 + slides.length * itemHeight }}>
          {slides.slice(range.first, range.last + 1).map((slide, offset) => {
            const index = range.first + offset;
            return (
              <Thumbnail
                key={slide.id}
                slide={slide}
                document={view.document}
                number={index + 1}
                top={LIST_PADDING + index * itemHeight}
                current={slide.id === view.currentSlideId}
                selected={selected.includes(slide.id)}
                openThreads={openThreads.get(slide.id) ?? 0}
                peers={peers}
                onDragStart={() => {
                  dropped.current = false;
                  dispatch({ kind: "slideDragStarted", slideIds: selected.includes(slide.id) ? selected : [slide.id] });
                }}
                onDragEnd={() => {
                  if (!dropped.current) dispatch({ kind: "slideDragEnded", dropped: false });
                }}
              />
            );
          })}
          {dropIndex === null ? null : <div className={VIEW_CLASS.dropIndicator} style={{ top: LIST_PADDING + dropIndex * itemHeight - THUMBNAIL_GAP / 2 - 1 }} />}
        </div>
      </div>
      <div style={{ padding: "8px" }}>
        <button type="button" className={TIDEPOOL_CLASS.secondaryPill} style={{ inlineSize: "100%" }} disabled={view.editing !== null} title={view.editing ?? undefined} onClick={() => dispatch({ kind: "newSlideRequested", layoutId: null })}>
          <Icon name="plus" /> New slide
        </button>
      </div>
    </nav>
  );
});

const Thumbnail = memo(function Thumbnail(properties: Readonly<{
  slide: SlideSnapshot;
  document: DocumentSnapshot;
  number: number;
  top: number;
  current: boolean;
  selected: boolean;
  openThreads: number;
  peers: readonly PeerPresence[];
  onDragStart: () => void;
  onDragEnd: () => void;
}>): ReactElement {
  const services = useEditorServices();
  const dispatch = services.system.dispatch;
  const slide = properties.slide;
  const lookers = properties.peers.filter((peer) => peer.slideId === slide.id);
  return (
    <button
      type="button"
      role="option"
      className={VIEW_CLASS.thumbnail}
      style={{ top: properties.top }}
      aria-selected={properties.selected}
      aria-label={`Slide ${properties.number}${slide.skipped ? ", skipped" : ""}`}
      data-current={properties.current ? "true" : "false"}
      data-skipped={slide.skipped ? "true" : "false"}
      data-sasha-thumbnail={slide.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", `slide ${properties.number}`);
        properties.onDragStart();
      }}
      onDragEnd={properties.onDragEnd}
      onClick={(event) => {
        const modifiers = modifiersOf({ event, primaryModifier: services.primaryModifier });
        const mode = modifiers.shift ? "extend" : modifiers.primary ? "toggle" : "replace";
        dispatch({ kind: "slidesSelected", slideIds: [slide.id], mode });
        if (mode === "replace") dispatch({ kind: "slideActivated", slideId: slide.id });
      }}
    >
      <span className={VIEW_CLASS.thumbnailNumber}>{properties.number}</span>
      <span className={VIEW_CLASS.thumbnailFrame}>
        <StaticSlide slide={slide} document={properties.document} slideNumber={properties.number} scale={THUMBNAIL_WIDTH / 1280} assetAddress={services.assetAddress} />
        <span className={VIEW_CLASS.thumbnailBadges}>
          {slide.skipped ? (
            <span title="Skipped when presenting">
              <Icon name="skipped" />
            </span>
          ) : null}
          {slide.transition === null ? null : (
            <span title="Has a transition">
              <Icon name="transition" />
            </span>
          )}
          {properties.openThreads === 0 ? null : <span title={`${properties.openThreads} open comments`}>{properties.openThreads}</span>}
          {lookers.slice(0, 3).map((peer) => (
            <span key={peer.clientId} className={VIEW_CLASS.thumbnailAvatar} title={`${peer.person.displayName} is on this slide`} style={{ backgroundColor: peerColour(peer.person.colourIndex) }} data-peer={peer.person.id}>
              {initials(peer.person.displayName)}
            </span>
          ))}
        </span>
      </span>
    </button>
  );
});

function selectedSlides(options: Readonly<{ selection: Selection; currentSlideId: SlideId | null }>): readonly SlideId[] {
  const selection = options.selection;
  switch (selection.kind) {
    case "slides":
      return selection.slideIds;
    case "none":
    case "elements":
    case "text":
    case "tableCells":
      return options.currentSlideId === null ? [] : [options.currentSlideId];
    default:
      return assertNever(selection);
  }
}

function draggingSlides(gesture: Gesture): Readonly<{ dropAfter: SlideId | null }> | null {
  switch (gesture.kind) {
    case "draggingSlides":
      return gesture;
    case "idle":
    case "pressed":
    case "moving":
    case "resizing":
    case "rotating":
    case "movingLineEnd":
    case "marquee":
    case "creating":
    case "resizingTableLine":
    case "drawingMarking":
    case "panning":
      return null;
    default:
      return assertNever(gesture);
  }
}

function threadCountsBySlide(threads: readonly CommentThread[]): ReadonlyMap<SlideId, number> {
  const counts = new Map<SlideId, number>();
  for (const thread of threads) {
    switch (thread.status.kind) {
      case "open":
        counts.set(thread.anchor.slideId, (counts.get(thread.anchor.slideId) ?? 0) + 1);
        break;
      case "resolved":
        break;
      default:
        assertNever(thread.status);
    }
  }
  return counts;
}
