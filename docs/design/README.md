# Design

- **Design system:** [Lomi Review](https://claude.ai/artifact/3pykxKtRkUdnH2ZWryn1yM) — tokens, brand book, cover.
- **Approved screens:** [Lomi Review — Screens](https://claude.ai/artifact/PeQJygFgcrTEAFUTkMxMuq) — 8 artboards (approved 2026-11-27).
- **Theme:** the app ships **dark-only**, using the design system's dark values (`apps/web/design-tokens.css`). The screens on the canvas are drawn in light; map each light colour to its same-named dark token.

## Tokens (dark)

| Token | Value | Use |
|---|---|---|
| surface | #111418 | Page background |
| surface-raised | #1a1e24 | Cards, value rows, text pane, dialogs |
| ink | #eceff3 | Primary text |
| ink-muted | #9aa4b1 | Secondary text, labels, Queued status |
| border | #2c323b | Hairlines, outlines |
| accent | #7c9cf5 | Primary buttons (text `on-accent` #0b1020), links, focus ring, Extracting |
| pending | #f0a24a | Pending, gaps, Changed |
| approved | #4ade80 | Approved, Extracted |
| corrected | #b794f6 | Corrected |
| carried | #2dd4bf | Carried over |
| failed | #f87171 | Failed, errors |
| highlight | #5c4a12 | Evidence mark behind ink |

Type: Inter (UI) and JetBrains Mono (evidence) from Google Fonts; styles display 32/38, title 20/28, body 15/22, label 13/18, caption 12/16, evidence 13/20 mono. Radii sm 4, md 8, pill 999. Spacing 4/8/16/24.

Badges: state colour text on `bg-<state>/15`, `rounded-pill`, label style. Progress bar: pending → approved → corrected → carried.

## Artboard → React

| Artboard | Route / component |
|---|---|
| Main (Document list) | `app/page.tsx`, `StatusBadge`, `ProgressBar`, `UploadDialog` |
| Login | `app/login/page.tsx` (byok only) |
| States (no LLM) | `app/settings/page.tsx` + `LlmBanner` (local only) |
| DetailFirst / DetailReextract | `app/documents/[id]/page.tsx`, `ValueRow`, `ReviewForm`, `ChangeBadge`, `EvidenceText` |
| DetailHistory | same page with `?version=N`, read-only, `VersionSwitcher` |
| States (extracting, failed) | detail header states |
| MobileList / MobileDetail | same routes at <768px: table → cards, document text in `<details>` |
