// THE THREADS ON ONE CANDIDATE, down the editor's right edge.
//
// This is the same conversation the Ask Sasha sidebar shows, read from the same `SlideCommentsLoad`
// (session-log.ts) -- so the two surfaces cannot disagree about what has been asked or what came
// back. They are separate HtmlService documents that share nothing but the server, and the join is
// one function rather than two loops written twice.
//
// IT IS DRAWN AS COMMENTS, with `comment-card.tsx`, because that is what they are: the user asks
// something about a box on a slide, Sasha answers in the same thread, and the user resolves it.
// A reader has Google's own comment pane open a few hundred pixels away, so anything else here
// would read as a different product.
//
// WHAT IT CANNOT DO is as important as what it can: nothing here claims an answer is coming. An
// open thread says how long it has been open, never "Sasha is working on it" -- this document
// cannot see whether a Claude session is attached (UI-CONTRACT.md).

import { useState, type JSX } from "react";
import { CommentBody, CommentCard, CommentHead } from "./comment-card.tsx";
import { assertNever } from "./protocol.ts";
import type { Offer, SlideFrame } from "./picker-state.ts";
import type { PickerActions } from "./Picker.tsx";
import { threadsForSlide, type SlideThreadsRead } from "./session-log.ts";

export function ThreadRail({
  offer,
  frame,
  disabled,
  actions,
}: {
  offer: Offer;
  frame: SlideFrame;
  disabled: boolean;
  actions: PickerActions;
}): JSX.Element {
  const read = threadsForSlide({
    comments: offer.comments,
    proposalId: offer.proposal.proposalId,
    slideIndex: frame.index,
  });
  return (
    <aside className="sasha-threads" aria-label={`Comments on candidate ${String(frame.index)}`}>
      <p className="sasha-threads-head mono">Comments</p>
      <ThreadBody read={read} disabled={disabled} actions={actions} index={frame.index} />
    </aside>
  );
}

/**
 * Exhaustive over the read, so "we could not look" can never be rendered as "there is nothing".
 * That distinction is the whole reason `SlideThreadsRead` is a union and not an array.
 */
function ThreadBody({
  read,
  disabled,
  actions,
  index,
}: {
  read: SlideThreadsRead;
  disabled: boolean;
  actions: PickerActions;
  index: number;
}): JSX.Element {
  switch (read.kind) {
    case "unreadable":
      return <p className="sasha-trouble">These comments could not be read: {read.message}</p>;
    case "read":
      if (read.threads.length === 0) {
        return (
          <p className="sasha-dim">
            Nothing asked about this candidate yet. Pick the annotate tool, click the thing that is
            wrong and say what is wrong with it.
          </p>
        );
      }
      return (
        <ul className="sasha-thread-list">
          {read.threads.map((thread) => (
            <li key={thread.commentId}>
              <Thread thread={thread} disabled={disabled} actions={actions} index={index} />
            </li>
          ))}
        </ul>
      );
    default:
      return assertNever(read);
  }
}

/** One thread: the question, every answer under it, and the two things the user can do. */
function Thread({
  thread,
  disabled,
  actions,
  index,
}: {
  thread: Extract<SlideThreadsRead, { kind: "read" }>["threads"][number];
  disabled: boolean;
  actions: PickerActions;
  index: number;
}): JSX.Element {
  const [reply, setReply] = useState("");
  const send = (): void => {
    if (disabled || reply.trim() === "") return;
    actions.replyToThread({ index, commentId: thread.commentId, text: reply.trim() });
    setReply("");
  };
  return (
    <CommentCard tone={thread.resolved ? "plain" : "flagged"}>
      <CommentHead
        author={thread.author}
        at={thread.at}
        nowMs={null}
        {...(thread.region === null ? {} : { where: "a box on this slide" })}
        actions={
          thread.resolved ? (
            <span className="sasha-thread-done mono">Resolved</span>
          ) : (
            <button
              type="button"
              className="sasha-thread-resolve"
              disabled={disabled}
              title="Mark this thread resolved"
              aria-label="Mark this thread resolved"
              onClick={() => actions.resolveThread({ index, commentId: thread.commentId })}
            >
              &#x2713;
            </button>
          )
        }
      />
      <CommentBody text={thread.text} />

      {thread.replies.map((answer) => (
        <div className="sasha-thread-reply" key={answer.replyId}>
          <CommentHead
            author={answer.authoredByAgent ? "Sasha" : answer.author}
            at={answer.createdAt}
            nowMs={null}
          />
          <CommentBody text={answer.text} />
        </div>
      ))}

      {thread.resolved ? null : (
        <div className="sasha-thread-compose">
          <textarea
            className="sasha-note"
            rows={2}
            disabled={disabled}
            placeholder="Reply, or add what else is wrong"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey)) return;
              event.preventDefault();
              send();
            }}
          />
          <button
            type="button"
            className="sasha-send-anomaly"
            disabled={disabled || reply.trim() === ""}
            onClick={send}
          >
            Reply
          </button>
        </div>
      )}
    </CommentCard>
  );
}
