# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-14

First release. The free tier is complete; the two Pro semantic features are gated and ship
inert until the semantic engine has a published build.

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

### Gated, not yet available

- **Group the queue by topic** and **superseded-note detection** are Pro + semantic-engine
  features. The gate, the commands, and the settings rows are wired; the engine has no
  published release to pin yet, so both report that plainly instead of failing silently. The
  "Download engine" button is inert until a build is published — the shared engine host
  refuses to download an executable it cannot verify a checksum for.

[1.0.0]: https://github.com/israerusan/note-decay/releases/tag/1.0.0
