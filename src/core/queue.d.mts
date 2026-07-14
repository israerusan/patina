import type { DecayBand } from "./decay.d.mts";

export type QueueSort = "score" | "mtime" | "lastOpen" | "effort";

/** One scored note. Everything the sidebar and the CSV need, and nothing from `obsidian`. */
export interface QueueRow {
	path: string;
	title: string;
	score: number;
	band: DecayBand;
	reasons: string[];
	halfLifeDays: number;
	mtime: number;
	/** 0 when never observed. */
	lastOpen: number;
	newestInboundMtime: number;
	/** From the shared signals store — Effort Index's aggregate, 0 when it is not installed. */
	editMs: number;
	revisions: number;
}

export interface QueueOptions {
	sort?: QueueSort;
	minScore?: number;
	excludeFolders?: readonly string[];
	limit?: number;
}

export const QUEUE_SORTS: readonly QueueSort[];

export function isExcluded(path: string, folders: readonly string[] | null | undefined): boolean;
export function sortQueue(rows: readonly QueueRow[], sort: QueueSort): QueueRow[];
export function buildQueue(rows: readonly QueueRow[], opts?: QueueOptions): QueueRow[];
export function toCsv(rows: readonly QueueRow[]): string;
