/** Hand-written types for decay.mjs. Drift between the two is caught by `tsc --noEmit`. */

export type DecayBand = "fresh" | "aging" | "stale" | "decayed" | "exempt";

export interface HalfLives {
	fast: number;
	slow: number;
	evergreen: number;
	[profile: string]: number;
}

export interface DecayWeights {
	mtime: number;
	open: number;
	inbound: number;
}

export interface BandThresholds {
	aging: number;
	stale: number;
	decayed: number;
}

export interface DecayOptions {
	halfLives?: Partial<HalfLives>;
	weights?: Partial<DecayWeights>;
	bands?: Partial<BandThresholds>;
	defaultProfile?: string;
}

export interface DecayInput {
	mtime: number;
	/** ms. 0 when we have never observed this note being opened. */
	lastOpen: number;
	/** ms. The first moment the signals store saw this note at all. */
	firstSeen: number;
	/** ms. 0 when nothing links here. */
	newestInboundMtime: number;
	/** The `decay:` frontmatter value. Unknown/missing falls back to `defaultProfile`. */
	profile?: string;
	/** ms. Set by "Snooze this note"; lives in data.json, never in the note. */
	snoozedUntil?: number;
}

export interface DecayScore {
	/** 0..100, higher = more decayed. */
	score: number;
	band: DecayBand;
	reasons: string[];
	/** The half-life the score was computed on, in days. 0 for an exempt note. */
	halfLifeDays: number;
}

export const DEFAULT_HALF_LIVES: Readonly<HalfLives>;
export const DEFAULT_WEIGHTS: Readonly<DecayWeights>;
export const DEFAULT_BANDS: Readonly<BandThresholds>;
export const DEFAULT_PROFILE: string;
export const DEFAULT_FRONTMATTER_KEY: string;

export function halfLifeFor(profile: string | undefined, opts?: DecayOptions): number;
export function ageDays(then: number, now: number): number;
export function freshness(days: number, halfLifeDays: number): number;
export function decayScore(input: DecayInput, now: number, opts?: DecayOptions): DecayScore;
export function inboundRecency(
	resolvedLinks: Record<string, Record<string, number>> | null | undefined,
	mtimeByPath: Record<string, number>
): Record<string, number>;
export function profileFromFrontmatter(
	frontmatter: Record<string, unknown> | null | undefined,
	key?: string
): string | undefined;
