import type { RealmBeatmap, RealmDump } from "./api";

export interface ManiaDiff {
	hash: string;
	name: string;
	stars: number;
	keyCount: number;
	beatmap: RealmBeatmap;
}

export interface ManiaSet {
	id: string;
	title: string; // original (unicode) — primary display
	titleRomanized: string; // english / romanized
	artist: string;
	author: string;
	difficulties: ManiaDiff[];
}

/** Group mania difficulties into sets, dropping non-mania and empty sets. */
export function buildManiaSets(dump: RealmDump): ManiaSet[] {
	const byId = new Map<string, RealmBeatmap>();
	for (const b of dump.Beatmap ?? []) byId.set(b.ID, b);

	const sets: ManiaSet[] = [];
	for (const set of dump.BeatmapSet ?? []) {
		const diffs: ManiaDiff[] = [];
		for (const ref of set.Beatmaps ?? []) {
			const b = byId.get(ref._pk);
			if (!b || b.Ruleset?._pk !== "mania") continue;
			diffs.push({
				hash: b.Hash,
				name: b.DifficultyName,
				stars: b.StarRating,
				keyCount: Math.round(b.Difficulty?.CircleSize ?? 0),
				beatmap: b,
			});
		}
		if (diffs.length === 0) continue;

		diffs.sort((a, b) => a.stars - b.stars);
		const meta = diffs[0].beatmap.Metadata;
		const romanized = meta?.Title ?? "";
		sets.push({
			id: set.ID,
			title: meta?.TitleUnicode || romanized || "(unknown)",
			titleRomanized: romanized,
			artist: meta?.Artist ?? "",
			author: meta?.Author?.Username ?? "",
			difficulties: diffs,
		});
	}

	// sort by the romanized title so latin ordering is intuitive
	sets.sort((a, b) =>
		(a.titleRomanized || a.title).localeCompare(b.titleRomanized || b.title),
	);
	return sets;
}
