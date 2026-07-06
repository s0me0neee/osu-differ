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
