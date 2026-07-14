import type { QueueRow } from "./queue.d.mts";

/** One note the engine reported as a neighbour of another. `note` is a vault path. */
export interface TopicNeighbour {
	note: string;
	score: number;
}

/** Engine hits, keyed by the path of the note they were the neighbours OF. */
export type NeighbourMap = Record<string, readonly TopicNeighbour[]>;

export interface TopicGroup {
	/** The most central member's title — what the session is about. */
	label: string;
	/** That member's path. */
	centroid: string;
	/** Ranked by decay score, most decayed first. */
	members: QueueRow[];
	/** The group's own rank: its worst-decayed member. */
	score: number;
	/** Mean similarity across the edges that formed the group, 0..1. */
	cohesion: number;
}

export interface TopicGrouping {
	groups: TopicGroup[];
	/** Every queue row with no neighbour above the threshold. Never silently dropped. */
	ungrouped: QueueRow[];
}

export interface TopicOptions {
	minScore?: number;
}

/** A hit against a stale note's chunks, with the mtime of the note it came from. */
export interface SupersededHit {
	note: string;
	title?: string;
	mtime: number;
	score: number;
	preview?: string;
}

export interface SupersededCandidate {
	path: string;
	title: string;
	/** The candidate's decay score. */
	score: number;
	mtime: number;
	hits: readonly SupersededHit[];
}

/** A newer note that covers a stale one. */
export interface SupersedingNote {
	path: string;
	title: string;
	mtime: number;
	score: number;
	preview: string;
}

export interface SupersededNote {
	path: string;
	title: string;
	/** The note's decay score. */
	score: number;
	mtime: number;
	/** The newest notes covering it, best first, capped at `maxCited`. */
	by: SupersedingNote[];
	/** How many newer notes cover it in total (`by` may be shorter). */
	byCount: number;
	/** Mean similarity across every superseding note, 0..1. */
	confidence: number;
}

export interface SupersededOptions {
	minScore?: number;
	minNotes?: number;
	maxCited?: number;
}

export const TOPIC_MIN_SCORE: number;
export const TOPIC_MIN_GROUP: number;
export const SUPERSEDED_MIN_SCORE: number;
export const SUPERSEDED_MIN_NOTES: number;
export const SUPERSEDED_MAX_CITED: number;

export function groupByTopic(
	rows: readonly QueueRow[],
	neighbours: NeighbourMap,
	opts?: TopicOptions
): TopicGrouping;

export function rankSuperseded(
	candidates: readonly SupersededCandidate[],
	opts?: SupersededOptions
): SupersededNote[];

export function supersededReason(entry: SupersededNote): string;
