---
version: alpha
name: Skill Loom Workbench
description: >-
  Visual system for the Skill Loom web UI — a light, paper-toned local
  control plane for Agent Skills with one system-blue accent, frosted
  structural chrome, and a loom motif, styled with Tailwind v4 and CSS
  custom properties.
colors:
  paper: "oklch(98.5% 0.005 250)"
  paper-2: "oklch(96% 0.008 250)"
  paper-3: "oklch(93.5% 0.01 250)"
  ink: "oklch(20% 0.02 260)"
  ink-2: "oklch(45% 0.02 255)"
  rule: "oklch(88% 0.01 250)"
  rule-strong: "oklch(78% 0.015 250)"
  chrome: "oklch(100% 0 0 / 0.72)"
  chrome-border: "oklch(100% 0 0 / 0.55)"
  accent: "oklch(52% 0.175 255)"
  accent-hover: "oklch(46% 0.165 255)"
  accent-soft: "oklch(94.5% 0.032 255)"
  accent-ink: "oklch(99% 0 0)"
  accent-text: "oklch(42% 0.16 255)"
  focus: "oklch(52% 0.175 255)"
  warn: "oklch(70% 0.14 75)"
  warn-soft: "oklch(97% 0.03 85)"
  draft: "oklch(48% 0.04 250)"
  draft-soft: "oklch(96% 0.015 250)"
typography:
  display:
    fontFamily: '"Fraunces", -apple-system, BlinkMacSystemFont, "SF Pro Display", system-ui, serif'
    fontSize: 1.375rem
  body:
    fontFamily: '"Instrument Sans", -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif'
    fontSize: 0.9375rem
  mono:
    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace'
    fontSize: 0.75rem
rounded:
  sm: 8px
  md: 12px
  lg: 16px
spacing:
  3xs: 0.25rem
  2xs: 0.5rem
  xs: 0.75rem
  sm: 1rem
  md: 1.5rem
  lg: 2rem
  xl: 3rem
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
  button-secondary:
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
---

## Overview

Skill Loom is a local-first control plane that turns a private catalog of Agent Skills into a small, reproducible runtime projection. The UI should feel like a quiet, precise workbench rather than a marketing site: light paper surfaces, a single system-blue accent, frosted structural chrome, and an editorial serif used only for display. The product is designed-as-app, so every screen is built from the same workbench vocabulary — instrument-like mono labels, hairline rules, and loom-motif indicators (warp threads, weave bars, crosshatch texture) instead of decorative imagery.

## Colors

The palette is a warm light paper scale with one refined system blue; semantic states reuse the same tinted-pair pattern.

- **Paper (`paper`, `paper-2`, `paper-3`):** the page, hover, and muted-surface scale; keep large surfaces on this scale and reserve pure white for small controls and button gradients.
- **Ink (`ink`, `ink-2`):** primary and secondary text tones; `ink-2` also carries metadata and placeholders.
- **Rules (`rule`, `rule-strong`):** hairline borders, dividers, and sort headers; `rule-strong` is the hover/edge variant.
- **Chrome (`chrome`, `chrome-border`):** translucent white for sticky topbars, toolbars, and nav panels, always paired with backdrop blur; fall back to opaque white under `prefers-reduced-transparency: reduce`.
- **Accent (`accent` and its variants):** `accent` drives primary buttons, active nav, and indicators; `accent-hover` is its pressed state; `accent-soft` tints selected rows and focus rings; `accent-ink` is the only text color placed on `accent`; `accent-text` is the accent-family color for text on light backgrounds (it keeps 4.5:1 on `accent-soft`); `focus` marks focused input borders.
- **Status (`warn`, `warn-soft`, `draft`, `draft-soft`):** tinted background + darker text pairs for status pills; never use status colors as full-surface backgrounds.

## Typography

Three named scales carry the whole product.

- **Display (`display`):** Fraunces for page titles and the wordmark; set headings tight, with optical size variation when size allows.
- **Body (`body`):** Instrument Sans for all UI prose, controls, and descriptions; slightly negative tracking at body size.
- **Mono (`mono`):** IBM Plex Mono for skill names, counts, and overline labels; overlines are uppercase with wide tracking and tabular numerals for any figure that can change.

## Layout

Layout is a workbench shell: a sticky topbar, a left navigation column, a central stage, and a right drawer that falls below the stage on narrow screens. Spacing comes from a 4pt-based scale (`3xs`–`xl`); step within the scale instead of inventing gaps. Content is capped at a max width and horizontally padded on large screens.

## Elevation & Depth

Depth comes from two instruments only: a single soft lift shadow for cards and panels, and frosted translucency (blur plus saturation) for sticky chrome. The page background stays flat paper with a faint fixed radial tint; the loom crosshatch texture and film grain sit on top as non-interactive overlays and must stay subtle.

## Shapes

Corner radii are continuous and three-stepped: `sm` for controls, inputs, and chips; `md` for small panels and inline messages; `lg` for cards, list surfaces, and nav shells. Fully rounded (pill) shapes are reserved for status toggles, badges, and indicator threads.

## Components

Buttons are the primary shared control: primary buttons pair `accent` with `accent-ink` text at `sm` radius, secondary buttons pair a hairline `rule` border with `ink` text at the same radius, and both give instant pointer-down feedback (slight scale press, no release delay). Text inputs and search fields use the `sm` radius, a `rule` border, and a focus treatment of `focus` border plus an `accent-soft` ring. List rows sit on divided `rule` hairlines, and dirty rows carry an accent warp thread at the left edge instead of a heavier highlight.

## Do's and Don'ts

- Do consume the named tokens (`--color-*`, `--font-*`, `--radius-*`, `--space-*`) via Tailwind arbitrary values or `@theme` mappings instead of writing new raw color values.
- Don't introduce a second styling system; Tailwind v4 plus CSS custom properties is the only path.
- Do keep contrast pairs intact: `accent-ink` on `accent`, `accent-text` for accent-family text on light surfaces.
- Do keep motion critically damped (short ease-out transitions); reserve bounce for momentum gestures.
- Don't replace frosted chrome with opaque graphite panels; chrome stays translucent with the reduced-transparency fallback.
- Do render every count, size, and skill name in the mono scale with tabular numerals.
