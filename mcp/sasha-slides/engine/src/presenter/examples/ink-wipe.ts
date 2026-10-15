// THE WORKED EXAMPLE of a scripted transition (SPEC.md section 11, "Writing a transition"): what
// Claude writes, kept as a STRING because a script is data the runner evaluates in its sandbox, never
// code the engine runs in its own realm -- and because the engine ships no hand-written JavaScript
// files. The script dialog shows it as the authoring reference; the Chrome end-to-end driver runs it
// through the real runner on the second site.
//
// What it shows an author: honour `reducedMotion` and the start from black; put the incoming slide
// on top and reveal it with an animated clip; stagger the incoming leaves from `context.elements`;
// await the animation (its rejection on abort ends the run as the presenter asked); clean up the
// overlay.

export const INK_WIPE_EXAMPLE_SCRIPT = `sashaTransition.define({
  name: "Ink wipe",
  async run(context) {
    const { outgoing, incoming, overlay, durationMilliseconds, direction } = context;
    if (outgoing === null || context.reducedMotion) {
      await context.animate(incoming, [{ opacity: 0 }, { opacity: 1 }], { duration: 150 }).finished;
      return;
    }
    const sweep = direction === "forward" ? ["inset(0 0 0 100%)", "inset(0 0 0 0)"] : ["inset(0 100% 0 0)", "inset(0 0 0 0)"];
    // The incoming slide is beneath; put it on top and reveal it with a moving clip.
    incoming.style.zIndex = "2";
    overlay.style.background = "radial-gradient(circle at 50% 50%, rgba(28,35,51,.18), transparent 70%)";
    const reveal = context.animate(incoming, [{ clipPath: sweep[0] }, { clipPath: sweep[1] }],
      { duration: durationMilliseconds, easing: "cubic-bezier(.6,0,.2,1)" });
    for (const element of context.elements("incoming")) {
      context.animate(element.node, [{ transform: "translateY(12px)", opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: durationMilliseconds * 0.6, delay: durationMilliseconds * 0.4, easing: "ease-out", fill: "both" });
    }
    await reveal.finished; // rejects on abort, which ends the run as the presenter asked
    overlay.style.background = "";
  },
});
`;
