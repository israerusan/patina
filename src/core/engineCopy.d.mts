/**
 * Structural, not `SemanticBlock` itself — this module must not import from `src/semantic.ts`
 * (which imports this one back). Every member of the SemanticBlock union satisfies it.
 */
export interface EngineBlockLike {
	kind: string;
	message?: string;
}

export const ENGINE_HOME_LABEL: Readonly<Record<string, string>>;
export const EMPTY_TOPIC_GROUPS: string;
export const EMPTY_SUPERSEDED: string;

/** The install directory the consent modal prints, in env-var form (DESIGN 7.1). */
export function engineInstallDir(target: string, version: string): string;

/** Why a semantic feature cannot run — one honest paragraph per block kind. */
export function blockCopy(block: EngineBlockLike, feature: string): string;
