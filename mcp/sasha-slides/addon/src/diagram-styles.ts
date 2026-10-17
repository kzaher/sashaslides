// DIAGRAM.HTML's stylesheet: only Tidepool tokens (engine/src/theme), like the editor shell's. The
// dialog is a column -- header or bar, then the list or the draw.io frame filling the rest. A flex
// column, not position:fixed: fixed collapses inside HtmlService's sandboxed frame (measured on the
// old add-on's draw.io dialog, renderer/html2slides/addon-server/public/addon-bundle/Code.gs).

import { TIDEPOOL_TOKENS } from "../../engine/src/theme/tidepool-theme.ts";

const light = TIDEPOOL_TOKENS.light;
const typography = TIDEPOOL_TOKENS.typography;
const spacing = TIDEPOOL_TOKENS.spacing;
const radius = TIDEPOOL_TOKENS.radius;
const control = TIDEPOOL_TOKENS.control;

export const DIAGRAM_CSS = [
  `html,body{margin:0;height:100%;overflow:hidden;background:${light.ground};color:${light.text};font:${typography.sizes.body}px/${typography.lineHeight} ${typography.fontFamily}}`,
  `#sasha-slides-root{height:100%}`,
  `.sasha-diagram-list{height:100%;box-sizing:border-box;overflow:auto;padding:${spacing.large}px ${spacing.extraLarge}px}`,
  `.sasha-diagram-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:${spacing.medium}px}`,
  `.sasha-diagram-header h1{margin:0;font-size:${typography.sizes.body * 1.5}px;font-weight:600}`,
  `.sasha-diagram-actions{display:flex;flex-wrap:wrap;gap:${spacing.small}px}`,
  `.sasha-diagram-primary,.sasha-diagram-secondary{display:inline-flex;align-items:center;height:${control.height}px;padding:0 ${spacing.large}px;border:0;border-radius:${radius.pill}px;font:inherit;cursor:pointer}`,
  `.sasha-diagram-primary{background:${light.inkButton};color:${light.inkButtonText}}`,
  `.sasha-diagram-secondary{background:${light.secondaryButton};color:${light.text}}`,
  `.sasha-diagram-primary:disabled,.sasha-diagram-secondary:disabled,.sasha-diagram-disabled{opacity:${TIDEPOOL_TOKENS.disabledOpacity};cursor:default}`,
  `.sasha-diagram-secondary input{display:none}`,
  `.sasha-diagram-notice{margin:${spacing.medium}px 0 0;padding:${spacing.small}px ${spacing.medium}px;border-radius:${radius.control}px;background:${light.cardGlass}}`,
  `.sasha-diagram-error{color:${light.danger}}`,
  `.sasha-diagram-success{color:${light.success}}`,
  `.sasha-diagram-empty{color:${light.textMuted}}`,
  `.sasha-diagram-rows{list-style:none;margin:${spacing.large}px 0 0;padding:0;display:grid;gap:${spacing.small}px}`,
  `.sasha-diagram-row{display:flex;align-items:center;justify-content:space-between;gap:${spacing.medium}px;padding:${spacing.medium}px ${spacing.large}px;border-radius:${radius.card}px;background:${light.cardGlass};border:1px solid ${light.hairline}}`,
  `.sasha-diagram-selected{border-color:${light.selection}}`,
  `.sasha-diagram-meta{display:block;color:${light.textMuted}}`,
  `.sasha-diagram-editor{display:flex;flex-direction:column;height:100%}`,
  `.sasha-diagram-bar{flex:0 0 auto;display:flex;align-items:center;gap:${spacing.medium}px;padding:${spacing.small}px ${spacing.medium}px;border-bottom:1px solid ${light.hairline}}`,
  `.sasha-diagram-status{color:${light.textMuted}}`,
  `.sasha-diagram-frame{flex:1 1 auto;width:100%;border:0;display:block}`,
].join("");
