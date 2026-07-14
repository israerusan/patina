# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-14

First release. The free tier is complete. The two Pro semantic features are **built**, and they
run the moment a semantic engine is available — which, in this release, means a user who points
the add-on at an engine binary they already have. There is no published engine build to download
yet, and there is no checkout yet, and the add-on says both of those things out loud rather than
selling something it cannot deliver.

### Added

- **Staleness scoring.** Every note is scored 0–100 from three signals on a per-note
  half-life: last edited (weight 0.5), last opened (0.3), and inbound-link recency (0.2).
  Bands: fresh, aging, stale, decayed.
- **A note with no inbound links is not punished for it.** The weights renormalize over the
  signals that exist, so an orphan note is not automatically a stale one.
- **Per-note half-lives** from a `decay:` frontmatter key — `fast` (14 days), `slow`
  (90 days, the default), `evergreen` (exempt, at any age). An unrecognised value falls back
  to the default profile rather than silently exempting the note.
- **The activity log.** Obsidian does not record when a note was opened, so this add-on does
  — locally, in `<vault>/.obsidian/second-read/signals/`. It is shared with the other Second
  Read add-ons through a single-writer election, so two of them installed together never
  double-count an event. There is a "Clear activity log" button in settings.
- **Review queue** — a sortable sidebar worklist (score / last edited / last opened /
  editing time). The "editing time" column reads Effort Index's aggregates out of the shared
  log when it is installed, with no dependency in either direction.
- **File-explorer dimming**, driven by a `data-decay` attribute and styled entirely in
  `styles.css`, so a theme can override it and disabling it leaves no trace.
- **Status-bar score** for the active note.
- **Snooze**, per-note, kept in the add-on's own data (never written into your note). A
  snooze follows the note across a rename.
- **CSV export** of every score, RFC 4180-escaped, with ISO-8601 timestamps.
- **Second Read Pro licensing.** One offline-verified Ed25519 key unlocks Pro in all five
  Second Read add-ons. Revocation is checked before the signature, so a leaked key can be
  killed without rotating the keypair and revoking Pro for every paying customer.

### Added — Pro (semantic)

- **Group the queue by topic.** The review queue is clustered into topics so one session covers
  one subject. Clusters are connected components over the engine's cosine neighbours (≥ 0.60),
  symmetrized so a truncated k-NN list cannot split a real topic in half. A note the engine
  finds no topic for is still listed, under its own heading — grouping never loses a note.
- **Superseded-note detection.** A stale note is flagged only when **two or more** notes that
  are genuinely newer cover it at ≥ 0.78 cosine against the note's own chunks. One close match
  is a follow-up, not a replacement; chunk hits are folded per note, so a single verbose note
  cannot clear a threshold designed to need two independent ones. "Newer" is re-checked against
  the vault's own mtimes, not taken on the engine's word.
- Both go through the **shared, refcounted engine broker** (five add-ons, one engine process,
  never five), chunk with the **shared chunker** (so the chunk ids in the shared index stay
  coherent across the suite), and cancel a superseded run through the engine's `cancel` RPC.
- Excluded folders are never sent to the engine.

### Honest degradation

- With no engine, the Pro features **do not return an empty list** — an empty list is
  indistinguishable from a clean vault. They open a dialog that says which of the five things
  went wrong (free tier, mobile, no build for this platform, no published engine, or a broken
  install), and when the answer is "not installed", they offer to install it through the shared
  consent modal, which names the URL, version, SHA-256 and install path. **Nothing is
  downloaded, extracted, made executable or run before that click.**
- The engine has **no published build** in this release, so the download button stays disabled
  (the engine host refuses to fetch an executable it cannot checksum) and the Pro features say
  so. The "Path to an existing engine" setting works today.

### Changed

- **The "Unlock Pro" buy button is gone until there is something to buy.** It pointed at a
  generic tip-jar page that cannot deliver a license key: a user who clicked it and paid would
  have bought nothing. The Pro card still renders — you are entitled to know what Pro is — and
  says "purchasing opens soon". `manifest.fundingUrl` is removed for the same reason. One
  constant, `PURCHASE_URL` in `src/product.ts`, turns every CTA in the add-on back on.

[1.0.0]: https://github.com/israerusan/note-decay/releases/tag/1.0.0
