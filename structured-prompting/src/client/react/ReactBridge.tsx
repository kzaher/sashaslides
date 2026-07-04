/** @jsxImportSource preact */
/**
 * PREACT → REACT bridge. The monitor shell is preact; the conversation viewer
 * is real React 18. This component lives on the preact side (note the preact
 * pragma), renders a plain host `<div>`, and in a preact effect mounts a
 * `react-dom/client` root into it running the React `ConversationApp`.
 *
 * On prop change we call `root.render` again with fresh props (keeping the
 * same root — React reconciles). On unmount we `root.unmount()`. Detail.tsx
 * already keys the whole panel on `selectedId`, so a node switch remounts THIS
 * component (fresh root) — but we also handle in-place prop updates for the
 * live graph-snapshot poll (which changes every 250ms without a remount).
 *
 * Guards against double-mount (StrictMode / effect re-fire) via a ref.
 */
import { useEffect, useRef } from "preact/hooks";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { ConversationApp, type ConversationAppProps } from "./ConversationApp.js";

export function ReactConversationBridge(props: ConversationAppProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<Root | null>(null);
  // Keep the latest props in a ref so the render effect can read them without
  // re-creating the root.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount the React root once, unmount on cleanup.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (rootRef.current) return; // guard double-mount
    const root = createRoot(host);
    rootRef.current = root;
    root.render(React.createElement(ConversationApp, propsRef.current));
    return () => {
      // Defer unmount to escape React's "synchronous unmount during render"
      // warning when preact tears us down.
      const r = rootRef.current;
      rootRef.current = null;
      if (r) queueMicrotask(() => r.unmount());
    };
  }, []);

  // Re-render the React tree whenever props change (e.g. the 250ms graph poll
  // hands us a new snapshot, or the selection/prompt changes without a full
  // remount).
  useEffect(() => {
    if (rootRef.current) {
      rootRef.current.render(React.createElement(ConversationApp, props));
    }
  }, [props.sessionId, props.cwd, props.selectedNodeId, props.selectedPrompt, props.graphSnapshot.version, props.onSelect]);

  return <div ref={hostRef} />;
}
