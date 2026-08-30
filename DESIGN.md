---
name: Platform
description: A calm, precise, dark-first personal AI workbench — one blue lamp marks the live work.
colors:
  primary: "oklch(0.64 0.16 250)"
  primary-foreground: "oklch(0.99 0 0)"
  primary-deep: "oklch(0.53 0.16 250)"
  ring: "oklch(0.55 0.15 250)"
  background: "oklch(0.16 0 0)"
  foreground: "oklch(0.96 0 0)"
  card: "oklch(0.19 0 0)"
  muted: "oklch(0.23 0 0)"
  muted-foreground: "oklch(0.65 0 0)"
  secondary: "oklch(0.24 0 0)"
  border: "oklch(0.28 0 0)"
  destructive: "oklch(0.62 0.22 25)"
  destructive-foreground: "oklch(0.99 0 0)"
  success: "oklch(0.72 0.17 145)"
  warning: "oklch(0.80 0.15 85)"
typography:
  headline:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 2
  title:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.75
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.625
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.5
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  button-ghost:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 16px"
  input-default:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    height: "40px"
    padding: "8px 12px"
  chip-muted:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
  card-panel:
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "16px"
  nav-item-active:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  user-bubble:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.body}"
    rounded: "{rounded.xl}"
    padding: "8px 16px"
  composer-shell:
    backgroundColor: "{colors.background}"
    rounded: "{rounded.xl}"
    padding: "8px 12px"
  tool-block:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
---

# Design System: Platform

## Overview

**Creative North Star: "The Night Workbench"**

Platform is a dark room with one lamp on. The interface is a personal workbench the owner keeps open all day: near-black surfaces, hairline borders, and a single blue accent that means exactly one thing — *work is happening here*. When the assistant streams, when a field takes focus, when the user speaks (the blue bubble), the lamp is on. Everything else recedes to grays so the work is the brightest thing on screen.

The feel is calm, precise, utilitarian. Surfaces never lift or glow; state changes are decisive color swaps, not movements. Density is compact — 12–14px body text, 6px paddings on rows, tight vertical rhythm — because this is an Operate surface: the visitor completes tasks, scans status, and reads transcripts, often for hours. The chat transcript is the product's center; every panel (Knowledge, Models, MCP, Skills, Agents, Dashboard) is a quiet toolshed behind it.

The system is deliberately dark-only (decision D9 in the codebase; light mode is deferred, and adding it later is a one-file token swap). It runs identically in the browser and the Electron desktop app, so nothing may assume a browser chrome, custom fonts, or a network-loaded asset.

**Key Characteristics:**

- Dark-only tonal layering: depth comes from surface lightness (0.16 → 0.19 → 0.23) plus 1px hairlines, never from shadow
- One accent color (Workbench Blue) with strict semantic scope: live work only
- System font stacks, zero webfonts — the type is meant to be invisible
- Compact, information-dense layout: fixed 240px rail, centered 768px transcript
- Shadows mark *detached* layers only (menus, dialogs, toast); everything resting is flat
- Monospace is a first-class voice: tool names, code, skills, identifiers

## Colors

A neutral near-black ramp with one blue accent and three status signals; OKLCH is the canonical format, defined once in `web/src/styles/globals.css` `@theme` under shadcn/ui naming.

### Primary

One blue in two lightness steps — same hue (250), same chroma (0.16); only the lightness differs, so it reads as one color, not a palette.

- **Workbench Blue** (oklch(0.64 0.16 250)): The lamp's light — text, links, focus borders, running-tool edges, and tints on dark surfaces. As text it passes AA everywhere it appears (5.0–5.8:1 on background/card/muted).
- **Deep Workbench Blue** (oklch(0.53 0.16 250), `primary-deep`): The lamp's housing — every filled surface that carries white text: the user's message bubble, the active nav item, primary buttons, the send/stop control. White on it is 5.15:1; on the bright step it would be 3.9:1 (AA fail). The fill shape clears 3:1 against the worktop (3.68:1).
- **Focus Blue** (oklch(0.55 0.15 250), `ring`): The focus ring token — a dimmer step sitting outside controls as a 2px ring with a 2px offset (4.0:1 against the worktop).

### Neutral

- **Near-Black Worktop** (oklch(0.16 0 0), `background`): The root surface — page canvas and the composer's inner field.
- **Card Surface** (oklch(0.19 0 0), `card` / `popover`): The raised-but-flat layer for the sidebar, headers, popovers, and toast.
- **Quiet Surface** (oklch(0.23 0 0), `muted`): Hover fills, session-row current state, chips, code-block inline background; at 40% opacity it backs thinking/tool blocks.
- **Raised Surface** (oklch(0.24 0 0), `secondary` / `accent`): Secondary buttons and ghost-hover fills — the top step of the neutral ramp.
- **Hairline Gray** (oklch(0.28 0 0), `border` / `input`): Every border and input stroke in the product.
- **Dim Gray** (oklch(0.65 0 0), `muted-foreground`): Secondary text — labels, timestamps, placeholders, block headers.
- **Soft White** (oklch(0.96 0 0), `foreground`): Primary text on every surface.

### Tertiary

- **Error Red** (oklch(0.62 0.22 25), `destructive`): Destructive actions and failed-tool state.
- **Done Green** (oklch(0.72 0.17 145), `success`): Connected status dot, completed-tool left rail.
- **Pending Amber** (oklch(0.80 0.15 85), `warning`): Connecting status dot.

### Named Rules

**The One Lamp Rule.** Workbench Blue appears on ≤10% of any screen and always means live work: streaming, focus, selection, active navigation, or the user's own words. If blue is used decoratively, the lamp goes out — the accent dies.

**The Dead Navy Rule.** The 2019-era navy palette of the pre-redesign vanilla page is a confirmed anti-reference. No navy, no desaturated steel blues, no second accent hue.

## Typography

**Display Font:** none — no display tier exists.
**Body Font:** system sans (ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif)
**Label/Mono Font:** system mono (ui-monospace, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace)

**Character:** The pairing is deliberately anonymous — native platform type at native rendering, chosen so the chat feels like the OS it runs in (and so the Electron desktop app and browser are pixel-identical with zero font loading). Monospace carries the machine's voice: tool names, code, skill identifiers.

### Hierarchy

- **Headline** (600, 24px, line-height 2): One per panel page (`/models`, `/agents`, …) — the page title.
- **Title** (600, 18px / 16px): Panel sub-sections; markdown `h1`/`h2` render at 18px/16px so the transcript never shouts.
- **Body** (400, 14px, line-height 1.625): Chat transcript, markdown prose, composer input, tables. The workhorse size.
- **Label** (500, 12px): Buttons, nav items, inputs, chips, tool-block headers. The most common size in the product.
- **Micro** (400–600, 10–11px): Timestamps (10px), code-block language headers (10px, uppercase, wide tracking). Never below 10px.
- **Mono** (400–600, 12px, `0.85em` inline): Tool names, code fences (Shiki), skill blocks, command tokens.

### Named Rules

**The Invisible Type Rule.** System stacks only. Never introduce a webfont, icon font, or remote-loaded type — the font swap must stay invisible and the desktop bundle stays self-contained.

**The Content-First Rule.** The transcript is the loudest thing on screen. Markdown headings top out at 18px; no panel heading, chrome label, or status line may outsize the words the agent produces.

## Layout

A fixed-rail shell: `grid-cols-[240px_1fr]` at `100dvh`, `overflow-hidden`. The left rail (240px, Card Surface, hairline right border) stacks brand → nav → session list (scrolls) → footer (agent select, model chip, status dot, locale, settings). The content column never scrolls the shell; the transcript scrolls inside.

The chat transcript centers at `max-w-3xl` (768px) with 24px between turns; the composer docks full-width beneath it with its field matching the same 768px. Panel pages center at `max-w-4xl` (896px) with 24px page padding. The chat header is sticky (`bg-card/95` + `backdrop-blur`) over the scrolling transcript.

Density is compact: 4px is the smallest gap, 8/12/16px carry most spacing, 24px separates regions. Rows are 12px-type with 6px vertical padding. Responsive behavior is minimal and desktop-first today: the only structural breakpoint is `md` (768px) for the Dashboard's two-column section grid; no mobile navigation pattern exists yet — do not invent one silently.

All copy resolves through i18n bundles (zh-CN first; en/es/fr/ja follow), so labels must survive both Chinese and Latin widths — favor truncation (`truncate`) over fixed widths.

## Elevation & Depth

Depth is tonal, not optical. The page stacks four neutral lightness steps (0.16 worktop → 0.19 card → 0.23 muted → 0.24 secondary) separated by 1px hairlines; a surface "raises" by getting lighter, and that is the whole depth system. Two blur effects exist as utility, not decoration: the sticky chat header (`bg-card/95 backdrop-blur`) and the dialog scrim (`bg-black/80 backdrop-blur-sm`).

### Shadow Vocabulary

- **Floating** (`box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)` — `shadow-lg`): The only shadow in the system. Detached layers only: popovers, context menus, the settings menu, toast, dialogs.

### Named Rules

**The Floating-Only Shadow Rule.** A box-shadow asserts "this layer is detached and will disappear." Resting cards, rows, inputs, and buttons are flat. If a surface needs emphasis, lighten its tone or add a hairline — never a shadow.

## Shapes

The form language is small-radius geometry: 6px (`rounded-md`) is the default for every control, row, block, and panel section; 8px (`rounded-lg`) steps up for dialogs and large empty-state frames. One exception is meaningful: 16px (`rounded-2xl`) belongs exclusively to the two "mouth" surfaces of the conversation — the composer shell the user types into and the user's own message bubble. Fully-round (`rounded-full`) is reserved for dots (status, avatar), circular icon buttons (attach, send), and pills.

Borders carry structure: 1px hairlines divide regions; the assistant turn hangs its tool/thinking blocks on a 1px left rail (`border-l` + 16px indent), and tool blocks add a 2px state-accented left edge (blue = running, red = error, green = done). Dashed borders mark drop zones and empty states (`border-dashed`).

### Named Rules

**The Soft Mouth Rule.** Only the surfaces you speak through get the 16px radius — the composer and the user bubble. Everything the machine renders back stays at 6–8px: the conversation's softness belongs to the human side.

## Components

For each: character line, then shape, color, states. All controls share the focus treatment — 2px Focus Blue ring, 2px offset (via `ring`/`ring-offset` tokens).

### Buttons

Compact and certain: state changes are decisive color swaps with no travel.
- **Shape:** 6px radius; heights 40px (default), 36px (sm), 44px (lg), 40×40 (icon); label type 12–14px/500.
- **Primary:** Deep Workbench Blue fill (white text at 5.15:1 AA), near-white text; hover = 90% opacity blue. Used sparingly (send is the only always-visible primary in chat).
- **Secondary:** Raised Surface (0.24) fill, Soft White text; hover = 80% opacity.
- **Outline:** 1px Hairline Gray stroke on the Worktop; hover fills Quiet Surface.
- **Ghost:** transparent; hover fills Quiet Surface (accent). The workhorse for rows and icon actions.
- **Link:** blue text, underline on hover.

### Chips

- **Style:** Quiet Surface fill, 6px radius, 2px/8px padding, 12px text — attachment chips, model chip, session meta.
- **State:** Removable chips carry an inline X (ghost icon button); chips never elevate.

### Cards / Containers

- **Corner Style:** 6px radius (dashboard sections), 8px (dialogs, empty states).
- **Background:** transparent on panel pages — a card is a hairline border with 16px padding, not a filled box. Filled surfaces (card 0.19) belong to the rail, popovers, and toast.
- **Shadow Strategy:** none at rest (see Floating-Only Shadow Rule).
- **Border:** 1px Hairline Gray; dashed for empty/drop states.
- **Internal Padding:** 16px standard, 40px for dashed empty-state frames.

### Inputs / Fields

- **Style:** 1px Hairline Gray stroke on the Worktop, 6px radius, 40px height, 12px type; placeholders in Dim Gray. Textareas share the stroke; the chat composer instead uses the shell below.
- **Focus:** 2px Focus Blue ring with 2px offset (inputs/buttons); the sidebar's native selects swap their border to Workbench Blue.
- **Disabled:** 50% opacity, not-allowed cursor. Errors render as a red-bordered callout (40% opacity red border), not red fields.

### Navigation

240px left rail on Card Surface. Nav items: 6px radius, 8px/12px padding, 12px type; resting Dim Gray, hover Quiet Surface fill, **active = Deep Workbench Blue fill** (the only blue in the rail). Session rows below: 12px type with 10px Dim Gray timestamps, current row Quiet Surface fill, right-click (or Shift+F10) context menu. Footer stacks selects, the read-only model chip (navigates to `/models`), the status dot (green/amber/red), and the locale picker.

### Composer (signature)

The conversation's mouth and the softest object in the product: a 16px-radius shell (1px hairline, Worktop fill) that turns Workbench Blue on `focus-within`, holding a fully-round ghost paperclip (32px), a borderless autogrowing textarea (max 200px), and a fully-round blue send button (32px). While a run streams, that button swaps in place to a stop control — same circle, solid square glyph — which finalizes the turn locally where it stands (dsh has no interrupt RPC; the composer returns immediately). Attachment chips stack inside the shell; slash-command autocomplete rises as a bordered popover (Floating shadow) above it; drag-over covers the whole dock with a dashed blue overlay at 5% blue. Enter never submits during IME composition — the draft and the pinyin candidates are sacred.

### Assistant Turn (signature)

Full-width article under a 24px avatar dot (20% blue circle) and the assistant label. Blocks hang on a 1px left rail with 16px indent: markdown prose (14px/1.625), collapsible thinking blocks (Quiet Surface at 40%, chevron rotates open), and tool blocks (2px state-colored left edge, mono tool name, italic status — *running* blue / *error* red / *done* green — expanding to mono args/result). Skill and command blocks share the neutral container with no state edge — only stateful work earns a color. The user's turn is the counterpoint: right-aligned 16px-radius Deep Workbench Blue bubble, max 85% width. A turn cut off by a disconnect carries an amber 「已中断」 chip — a truncation must never masquerade as a finished answer.

### Code Blocks (signature)

A fixed dark editor surface (#22272e — the one hard-coded color, a token candidate), 6px radius, hairline top divider, and a 10px uppercase wide-tracked language header with a copy button that fades in on hover. Shiki handles syntax colors; the shell stays neutral.

### Dialog

Centered, `max-w-lg`, 8px radius, 1px border, Worktop fill, 24px padding, Floating shadow, over a `black/80` blurred scrim; enters with fade only.

## Do's and Don'ts

### Do:

- **Do** use Workbench Blue for exactly five things: streaming, focus/selection, active nav, running tools, and the user bubble (The One Lamp Rule).
- **Do** build depth with the four neutral steps (0.16/0.19/0.23/0.24) and 1px hairlines — a raised surface is a lighter surface.
- **Do** center the transcript at 768px (`max-w-3xl`) and keep 24px between turns.
- **Do** use monospace for anything the machine emits or accepts as an identifier: tool names, code, skills, `/commands`.
- **Do** resolve every user-visible string through the locale bundles — zh-CN lands first; design labels that survive both Chinese and English widths.
- **Do** keep state changes as instant color swaps (`transition-colors`, 150ms); the only transforms are functional (chevron rotation) and the only loops are semantic (spinner, streaming pulse).

### Don't:

- **Don't** add a second accent hue, gradients, glassmorphism, or neon glow — flat tonal layering is the identity.
- **Don't** put a box-shadow on anything that rests; shadow means floating and temporary.
- **Don't** introduce webfonts, icon fonts, or remote type assets (The Invisible Type Rule).
- **Don't** design light-mode variants or `[data-theme="light"]` styles yet — dark-only is decision D9; when light mode lands it is a one-file token swap, not a per-component fork.
- **Don't** let markdown or panel headings exceed 18px, or add entrance/parallax/decorative motion.
- **Don't** hard-code new hex colors in components — extend the `@theme` tokens instead (the existing #22272e code surface is a known debt, not a license).
