# Note Decay

Find the notes that are quietly rotting.

Every vault accumulates notes that were true when you wrote them and are not true now. Nothing tells you which ones. Note Decay scores every note's staleness from four signals, ranks them, and gives you a worklist.

> Note Decay never edits your notes. The only thing it ever writes is a `decay:` line in a note's frontmatter — and only when you explicitly run "Set decay profile for this note".

## How the score works

A note decays on a **half-life**. One half-life of neglect halves how fresh a signal is; two half-lives quarter it. Three signals feed the score:

| Signal | Weight | Where it comes from |
| --- | :---: | --- |
| **Last edited** | 0.5 | The file's modification time. |
| **Last opened** | 0.3 | Obsidian does not record this. **Note Decay does** — see the activity log below. |
| **Inbound-link recency** | 0.2 | The newest note that still links here. |

The score is `0`–`100`, higher is more decayed, and it lands in a band: **fresh** (< 30), **aging** (30–59), **stale** (60–84), **decayed** (≥ 85).

**A note with no inbound links is never punished for it.** The weights renormalize over the signals that actually exist. An orphan note is not a stale note, and treating a missing signal as a zero would mark half the vault as decayed on day one.

### Per-note half-lives

Set a note's decay profile in its frontmatter:

```yaml
---
decay: fast        # 14-day half-life — meeting notes, inbox captures
---
```

| Profile | Half-life | For |
| --- | --- | --- |
| `fast` | 14 days | Notes that are stale the moment they are cold. |
| `slow` | 90 days (default) | Reference notes that age, but not quickly. |
| `evergreen` | never | Exempt. Never enters the queue, at any age. |

Half-lives, weights, band thresholds, the frontmatter key, and the excluded folders are all configurable. A **typo** in the profile (`decay: evergreeen`) falls back to the default — it never silently exempts the note.

## What you get

### Free — all of it

- **Staleness score** for every note, from edits, opens, and inbound links.
- **A sortable review queue** in the sidebar — by score, last edited, last opened, or editing time.
- **Dimmed stale notes** in the file explorer.
- **The score for the active note** in the status bar.
- **Per-note half-lives** from frontmatter, and per-profile tuning.
- **Snooze** a note you are not ready to deal with.
- **CSV export** of every score.
- No caps, no note limit, no nag screen. Works on mobile.

### Pro — $29 one-time, unlocks all five Second Read add-ons

Pro adds the two features that need to compare notes **by meaning** rather than by metadata:

- **Group the queue by topic** — cluster the review queue so one session covers one subject.
- **Superseded-note detection** — flag a stale note whose content is now largely covered by *newer* notes. The ones you rewrote without noticing.

Both need the local semantic engine (see below), and both are **not yet available** — the engine has no published build as of this release. Everything in the free tier works now.

One key unlocks Pro in all five Second Read add-ons: Note Decay, Standing Questions, Effort Index, Prior Art, and Unwritten. Licenses are verified **offline** with an Ed25519 signature built into the add-on. No account, no server, no network request.

## Disclosures

Please read these before installing. They are the things this add-on does that you cannot see.

### It records which notes you open, on your device

Obsidian does not track when a note was last opened, so **Note Decay logs it itself**. Without that, "last opened" is not a signal anyone could compute.

> This add-on records, on your device only, which notes you open. The log lives in `<vault>/.obsidian/second-read/signals/` and never leaves your machine. Delete the folder to erase it; there is a **Clear activity log** button in settings.

The log is a plain append-only text file. It records the note path and a timestamp — nothing about the note's contents. It is shared with the other Second Read add-ons (Effort Index writes editing time into the same log), which is why installing a second one is instantly useful instead of starting from zero history.

### Pro features download and run a program (and only if you ask)

The two Pro features need a local semantic engine: a self-contained program that runs on your computer, embeds your notes locally, and **opens no network connections**.

- **Nothing is downloaded unless you click "Download engine" in settings** and confirm a dialog that names the exact URL, version, SHA-256 checksum, and install path.
- The download is **verified against a checksum built into this add-on before anything is extracted or run.** If it does not match, the file is deleted and nothing executes.
- The engine is installed **outside your vault**, in your system's application-data folder (`%LOCALAPPDATA%\second-read-engine` on Windows). It is never written into your notes folder.
- It runs only while Obsidian is open, and it is killed when the last Second Read add-on unloads.
- Source: [github.com/israerusan/second-read-engine](https://github.com/israerusan/second-read-engine).
- **Desktop only.** On mobile, the Pro semantic features are unavailable and everything else works.
- If your system refuses to run a downloaded program (antivirus, a `noexec` mount, Flatpak), you can point the add-on at an engine binary you installed yourself. The download is a convenience, not the mechanism.

**This means the add-on accesses files outside your vault**, and that is exactly what the two bullets above describe.

### It decorates Obsidian's file explorer

The stale-note dimming decorates Obsidian's own file list, which has no public API for it. If a future Obsidian release changes the file explorer, **the dimming stops working and nothing else does**. It is a toggle in settings.

## Commands

| Command | What it does |
| --- | --- |
| Open review queue | The ranked worklist, in the right sidebar. |
| Show decay score for this note | The score and why. |
| Snooze this note | Keeps it out of the queue for a while. |
| Set decay profile for this note | Writes `decay:` into the note's frontmatter. |
| Export decay scores as CSV | Writes `Decay Scores.csv` into the vault. |
| Group the review queue by topic | **Pro + engine.** Hidden from the palette when unavailable. |

No default hotkeys — bind your own in Settings → Hotkeys.

## Install

Not yet in the community directory. To install manually, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/note-decay/` and enable it in Settings → Community plugins.

## Development

```bash
npm install
npm run sync:shared     # vendor the shared Second Read core
npm run lint            # typecheck + the review bot's own eslint ruleset
npm test                # lint + drift check + the whole suite
npm run build           # production bundle
npm run install:vault -- <path to a vault>
```

`src/shared/` is **vendored** from [obsidian-plugin-core](https://github.com/israerusan/obsidian-plugin-core) and must never be edited here — `npm test` fails on drift.

## License

MIT. See [LICENSE](LICENSE).
