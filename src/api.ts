import { invoke } from "@tauri-apps/api/core";

// --- Realm shapes (subset of fields we use) ---

export interface Ref {
	_type: string;
	_pk: string;
}

export interface RealmMetadata {
	Title: string;
	TitleUnicode: string;
	Artist: string;
	ArtistUnicode: string;
	Author?: { Username?: string };
	Source?: string;
	Tags?: string;
}

export interface RealmDifficulty {
	DrainRate: number;
	CircleSize: number;
	OverallDifficulty: number;
	ApproachRate: number;
	SliderMultiplier: number;
	SliderTickRate: number;
}

export interface RealmBeatmap {
	ID: string;
	DifficultyName: string;
	Ruleset: Ref;
	Difficulty: RealmDifficulty;
	Metadata: RealmMetadata;
	BeatmapSet: Ref;
	Length: number;
	BPM: number;
	Hash: string;
	StarRating: number;
	TotalObjectCount: number;
}

export interface RealmBeatmapSet {
	ID: string;
	Beatmaps: Ref[];
}

export interface RealmDump {
	Beatmap: RealmBeatmap[];
	BeatmapSet: RealmBeatmapSet[];
	[table: string]: unknown;
}

// --- Beatmap detail (mirrors src-tauri/src/beatmap.rs) ---

export interface DifficultySettings {
	ar: number;
	od: number;
	cs: number;
	hp: number;
	slider_multiplier: number;
	slider_tick_rate: number;
}

export interface TimingInfo {
	time: number;
	bpm: number;
	beat_len: number;
	meter: number;
}

export interface ManiaNote {
	start_time: number;
	column: number;
	end_time: number | null;
}

export interface BpmSummary {
	min: number;
	max: number;
	primary: number;
}

export interface BeatmapDetail {
	mode: string;
	key_count: number;
	difficulty: DifficultySettings;
	bpm: BpmSummary;
	timing_points: TimingInfo[];
	notes: ManiaNote[];
	star_rating: number;
	length_ms: number;
	tap_count: number;
	hold_count: number;
	column_counts: number[];
}

export async function loadRealm(path: string): Promise<RealmDump> {
	const json = await invoke<string>("read_realm", { path });
	return JSON.parse(json) as RealmDump;
}

export function loadBeatmap(hash: string): Promise<BeatmapDetail> {
	return invoke<BeatmapDetail>("read_beatmap", { hash });
}
