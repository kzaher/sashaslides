/* Add-on installer link builder.
 *
 * Paste a Google Slides deck / Google Doc id (or its full URL) → get the
 * one-liner that installs the SashaSlides add-on onto THAT document:
 *
 *   curl -fsSL "<origin>/install.sh?doc=<id>" | bash
 *
 * The served script (public/install-addon.sh) handles clasp auth persistence
 * (re-login only when the stored token stopped working), binds/updates the
 * Apps Script project, and pushes the current /addon-bundle.
 */
window.h2s.register(async (bridge) => {
  const { $ } = bridge;
  const input = $("#install-doc-input");
  const out = $("#install-cmd");
  const copyBtn = $("#install-copy-btn");
  if (!input || !out) return;   // section absent (e.g. stripped shell)

  const ORIGIN = (() => { try { return new URL(document.baseURI).origin; } catch (e) { return ""; } })();

  // Accept a bare id or any docs.google.com URL (…/d/<id>/edit, …?id=<id>).
  function extractId(s) {
    s = String(s || "").trim();
    const m = s.match(/\/d\/([A-Za-z0-9_-]{20,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
    if (m) return m[1];
    return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : null;
  }

  function update() {
    const id = extractId(input.value);
    if (!id) {
      out.textContent = input.value.trim()
        ? "— that doesn't look like a document id or docs.google.com URL —"
        : "";
      out.dataset.cmd = "";
      if (copyBtn) copyBtn.disabled = true;
      return;
    }
    const cmd = `curl -fsSL "${ORIGIN}/install.sh?doc=${id}" | bash`;
    out.textContent = cmd;
    out.dataset.cmd = cmd;
    if (copyBtn) copyBtn.disabled = false;
  }

  input.addEventListener("input", update);
  if (copyBtn) copyBtn.addEventListener("click", async () => {
    if (!out.dataset.cmd) return;
    try { await navigator.clipboard.writeText(out.dataset.cmd); copyBtn.textContent = "Copied ✓"; }
    catch (e) { copyBtn.textContent = "Copy failed"; }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
  });
  update();
});
