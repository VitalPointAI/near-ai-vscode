# Sterling design language

**Status:** not adopted: owner chose the original 74.3 theme with lifted cards on 2026-11-24 (74.3-UI-SPEC Q13, "owner reversed"). Kept for the record only; no UI-SPEC cites it as a contract, and aligning the Phase 46 pages to it (section 11) is dropped. Written 2026-11-24 at the owner's direction ("a more original look, from the subject's own world"), briefly accepted the same day, then reversed.
**Applies to:** every native Sterling workbench surface (Theia widgets, dialogs, status bar text). The extension's webviews follow it when they are next redesigned.
**Fixed constraints:** Theia theme variables only, codicons only, correct in light, dark, high contrast dark, high contrast light and `forced-colors: active`. The contract rules of each UI-SPEC still hold: at most 4 font sizes and 2 weights, spacing in {4, 8, 16, 24, 32, 48, 64}, verb-plus-noun button labels, meaning never by colour alone.

## 0. The idea

Sterling is used to write, mark, check and release staff work. The paper world it replaces already has a visual grammar that people trust and read fast: the classification banner at the top and foot of every page, the control block that says who classified a document and on what basis, the stamp that says what state a paper is in, the numbered message form, and the register where requests are logged one line each. Sterling's screens borrow that grammar. They look like a well-kept staff document, not like a consumer app: square, ruled, captioned, dense, quiet.

The language uses the grammar, never the authority: nothing on screen imitates an official national marking scheme, colour code, crest or form number.

## 1. Marking strip

**What:** the label of what is on screen, shown as a full-width strip at the top of the surface, and repeated at the foot of any view taller than its viewport. Text is the label's words (scale name plus level, then markings), transformed to uppercase with CSS (`text-transform: uppercase`, so screen readers get the normal words), letter-spaced (`0.12em`), centred, 13px weight 600. Top and bottom hairlines in `--theia-foreground`.

**Why:** a banner at top and foot is how every marked document says its level; people look there first by training.

**How meaning is carried:** by the strip's rule and texture, not its colour:
- provisional label (proposed, not yet affirmed): dashed bottom rule;
- final label (affirmed): double bottom rule (3px `double`);
- stopped (possible spill): the strip's ends are hatched (SDL 3), the text sits on plain paper in the middle.

**Colour:** neutral. Background `--theia-editorWidget-background`, text `--theia-foreground`. The strip never uses red, green, amber or any colour per level, because national schemes assign colours to levels and Sterling must not appear to claim one.

**Hook, not a feature:** your organization's signed rules may later carry a strip colour per level (a `classification@1` display entry signed by the security officer). Until a phase plans and builds that, strips stay neutral.

## 2. Square geometry and hairlines

**What:** frames are 1px hairlines (`--theia-panel-border`, falling back to `--theia-widget-border`). Radius 0 for frames, strips, stamps, lists and dialogs' inner blocks; 2px only on buttons, inputs and selects (Theia's own control radius). No drop shadows, no gradients except the hatch, no glow.

**Why:** ruled paper and printed forms are square. Rounded cards and soft shadows read as a consumer app and say nothing.

## 3. Stamps (state)

**What:** an item's or a request's state is a stamp: uppercase text, 11px weight 600, `0.08em` tracking, inside a rectangular frame whose line style encodes the state family, with the state's codicon before the text. Line styles:

| Family | Line | Examples |
|---|---|---|
| Neutral | 1px solid | Draft, Out of date, Assistant off |
| Provisional | 1px dashed | Checking, Proposed, Raised, Rules only |
| Waiting on another person | 1px dotted | Under review, Overdue (dotted, with the warning codicon) |
| Final | 3px double | Affirmed, Approved, Pass |
| Stopped | 2px solid frame with a hatched inner margin (`repeating-linear-gradient(135deg, …)` built from `color-mix(in srgb, var(--theia-errorForeground) 24%, transparent)`), text on plain paper | Possible spill, Fail, Refused |

**Why:** a rubber stamp is how a registry marks a paper's state, and its outline is what the eye catches. Encoding by line style means the state reads in greyscale, in high contrast and for colour-blind readers; the words carry the meaning for screen readers.

**Colour:** the stamp's text and frame use `--theia-foreground`, except Stopped (frame and hatch from `--theia-errorForeground`) and the icon, which may take the semantic theme colour (info, warning, error, `--theia-testing-iconPassed`). Icons are decorative.

**Forced colors and high contrast:** backgrounds disappear, so the hatch is lost; the 2px solid frame, the dashed, dotted and double lines and the text remain, which is why every family differs by line, not only by fill.

## 4. Form blocks

**What:** facts are laid out as a form: a caption above each value. Captions are 11px weight 600 uppercase, `0.08em` tracking, `--theia-descriptionForeground`; values are 13px weight 400 in `--theia-foreground`. Fields sit on a grid (two columns from 480px, one below), aligned to the 8px spacing step; numbers and times use `font-variant-numeric: tabular-nums`.

**Numbered fields** only where the person fills in or signs a genuine form (for example the Affirm dialog: 1 Item, 2 Label, 3 Based on, 4 Assisted by, 5 Classified by). Never as decoration on read-only panels.

**The control block:** the record of who classified something reads like a document's classification block, in this order: CLASSIFIED BY, BASED ON, ASSISTED BY, AFFIRMED.

**Why:** staff officers fill and read forms all day; captions above values scan faster than prose and survive translation.

## 5. Sections by rules, not cards

**What:** a surface is divided by a caption (SDL 4 style) followed by a hairline rule, not by boxes. Lists are registers: one line per entry, hairline between lines, no gap or card around each entry. The selected line gets a 1px `--theia-focusBorder` frame. A dialog is one frame; inside it, only rules.

**Why:** a register or a log is lines on a page. Cards inside cards waste width in a 240px side panel and make every item look equally important.

## 6. Type

- **Font:** `--theia-ui-font-family` for everything a person reads; `--theia-editor-font-family` for ids, hashes and fingerprints.
- **Sizes (4):** 11px captions and stamps (uppercase, tracked); 13px body; 16px headings (dialog titles, a page's section titles); 20px for a page title only. Uppercase is always a CSS transform, never typed copy.
- **Weights (2):** 400 and 600.
- **Times:** day, short month, year, 24-hour time and zone, assembled from `Intl.DateTimeFormat(...).formatToParts` so the order is fixed: "24 Nov 2026 14:02 UTC". Staff date-time groups (241402Z NOV 26) are an option an organization may choose later, not the default, because copy stays plain.

## 7. Colour

Neutral paper and ink: dominant `--theia-sideBar-background` or `--theia-editor-background`, frames and rules `--theia-panel-border`, ink `--theia-foreground`, captions `--theia-descriptionForeground`. The accent (`--theia-focusBorder`, which the Sterling edition maps to its maple colour; `--theia-button-background`; `--theia-textLink-foreground`) is reserved for focus rings, the one primary button of a state, links, and the selected register line. Semantic colours come only from the theme (`--theia-editorInfo-foreground`, `--theia-editorWarning-foreground`, `--theia-errorForeground`, `--theia-testing-iconPassed`) and never carry meaning alone.

## 8. Icons

Codicons only, 16px, in the text colour or the semantic colour of their stamp, always `aria-hidden` beside words. No emoji, no text glyphs (arrows, bullets, check marks typed as characters), no illustrations inside work surfaces.

## 9. Density

Compact, like a staff tool: 8px padding inside blocks, 16px between sections, 4px between register lines and caption-to-value. Hierarchy comes from captions, rules, the strip and the stamp, not from size jumps or card chrome. Controls are 32px high; targets never below 24px.

## 10. Never

- Pill badges, rounded cards, a coloured bar down one side of a card ("accent rail"), drop shadows, glows, gradients other than the stop hatch, glassy or blurred panels.
- Emoji or typed glyphs as icons; icon fonts other than codicons; illustrations or hero art on work surfaces.
- A colour per classification level, or any colour that resembles an official national colour code, until your organization's signed rules set one (SDL 1 hook).
- Uppercase typed into copy (only CSS transforms), more than 4 sizes, weights other than 400 and 600.
- Hex, rgb or named colours in product CSS; anything that only works in one theme.
- Decorative numbering, fake form numbers, crests, seals or imitation official markings.
- Motion beyond Theia's spinning `sync` icon, which stops under `prefers-reduced-motion: reduce`.

## 11. Shipped surfaces not yet aligned

Dropped 2026-11-24 with the language itself (see Status); kept as the record of what an alignment would have touched. The Phase 46 pages on `origin/feat/phase-46-wave-1` predate this language and are not changed by 74.3. That step would have aligned: the rail's hover and active states; the Get Started hero (gradient, glow animation, hex colours, 22px radius, shadow) and its destination cards (12px radius); the work-area pages (hero gradient, hex primary button); Resource Inventory (rounded rows, pill state badges); `sterling-portfolio.css` (12px radius sections, the 3px accent rail on the source card, pill badges, weights 650 and 730); and the Compliance page (custom hex state colours). Until then, new surfaces that reuse `sterling-portfolio.css` scope overrides under their own class so they do not inherit the card look (74.3-UI-SPEC "Reviews page overrides").
