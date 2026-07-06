// Sidebar model — mirrors the Rust `ManiaSetDto`/`ManiaDiffDto` (realm.rs).
// The grouping is done in Rust (`read_mania_library`); this is just the shape.

export interface DiffMeta {
	title: string;
	titleUnicode: string;
	artist: string;
	author: string;
}

export interface ManiaDiff {
	hash: string;
	name: string;
	stars: number;
	keyCount: number;
	// true for an auto-converted (osu!std->mania) diff. keyCount/stars here
	// are the original std beatmap's, not the converted ones — the real
	// values only get computed on demand when the difficulty is opened.
	isConvert: boolean;
	audioHash?: string; // content hash of the song's audio file, if resolvable
	audioFile?: string; // audio filename (for MIME), e.g. "audio.mp3"
	meta: DiffMeta;
}

export interface ManiaSet {
	id: string;
	title: string; // original (unicode) — primary display
	titleRomanized: string; // english / romanized
	artist: string;
	author: string;
	difficulties: ManiaDiff[];
}
