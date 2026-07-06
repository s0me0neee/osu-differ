import type { ManiaDiff, ManiaSet } from "./model";

type SelectHandler = (diff: ManiaDiff) => void;

export interface SidebarHandle {
	/** Programmatically open + select a difficulty by its beatmap hash (expands
	 * its set, highlights it, scrolls to it, and fires onSelect). Returns whether
	 * a matching row was found. */
	selectByHash(hash: string): boolean;
}

const KEY_HUES: Record<number, string> = {
	4: "#7cc6ff",
	5: "#8affc1",
	6: "#ffd479",
	7: "#ff9ecb",
	8: "#c79bff",
};

// isConvert: original std CS isn't the real mania key count (that requires
// parsing the full .osu file), so avoid showing a misleading number here —
// the info page computes and shows the real one.
function keyBadge(keys: number, isConvert: boolean): HTMLElement {
	const el = document.createElement("span");
	el.className = "key-badge";
	if (isConvert) {
		el.textContent = "CV";
		el.title = "auto-converted from osu!standard — key count shown on the info page";
		el.style.color = "#999";
	} else {
		el.textContent = `${keys}K`;
		el.style.color = KEY_HUES[keys] ?? "#cbb";
	}
	return el;
}

export function renderSidebar(
	root: HTMLElement,
	sets: ManiaSet[],
	onSelect: SelectHandler,
): SidebarHandle {
	root.textContent = "";

	const search = document.createElement("input");
	search.className = "search";
	search.type = "search";
	search.placeholder = `Search ${sets.length} mania sets…`;
	root.appendChild(search);

	const list = document.createElement("div");
	list.className = "set-list";
	root.appendChild(list);

	let activeDiffEl: HTMLElement | null = null;

	const selectDiff = (el: HTMLElement, diff: ManiaDiff) => {
		activeDiffEl?.classList.remove("active");
		el.classList.add("active");
		activeDiffEl = el;
		onSelect(diff);
	};

	const buildSet = (set: ManiaSet): HTMLElement => {
		const wrap = document.createElement("div");
		wrap.className = "set";

		const header = document.createElement("button");
		header.className = "set-header";
		header.innerHTML =
			`<span class="chevron">▸</span>` +
			`<span class="set-meta"><span class="set-title"></span>` +
			`<span class="set-artist"></span></span>` +
			`<span class="set-count">${set.difficulties.length}</span>`;
		const titleEl = header.querySelector(".set-title") as HTMLElement;
		titleEl.textContent = set.title;
		if (set.titleRomanized && set.titleRomanized !== set.title) {
			const alt = document.createElement("span");
			alt.className = "title-alt";
			alt.textContent = ` — ${set.titleRomanized}`;
			titleEl.appendChild(alt);
		}
		(header.querySelector(".set-artist") as HTMLElement).textContent = set.artist;

		const diffs = document.createElement("div");
		diffs.className = "diff-list";
		diffs.hidden = true;

		for (const diff of set.difficulties) {
			const row = document.createElement("button");
			row.className = "diff-row";
			row.appendChild(keyBadge(diff.keyCount, diff.isConvert));

			const name = document.createElement("span");
			name.className = "diff-name";
			name.textContent = diff.name;
			row.appendChild(name);

			const stars = document.createElement("span");
			stars.className = "diff-stars";
			stars.textContent = `★ ${diff.stars.toFixed(2)}`;
			row.appendChild(stars);

			row.dataset.hash = diff.hash; // for selectByHash lookups
			row.addEventListener("click", () => selectDiff(row, diff));
			diffs.appendChild(row);
		}

		header.addEventListener("click", () => {
			const willOpen = diffs.hidden !== false;
			diffs.hidden = !willOpen;
			wrap.classList.toggle("open", willOpen);
		});

		wrap.appendChild(header);
		wrap.appendChild(diffs);
		return wrap;
	};

	const render = (filter: string) => {
		list.textContent = "";
		const q = filter.trim().toLowerCase();
		const shown = q
			? sets.filter(
					(s) =>
						s.title.toLowerCase().includes(q) ||
						s.titleRomanized.toLowerCase().includes(q) ||
						s.artist.toLowerCase().includes(q),
				)
			: sets;
		for (const set of shown) list.appendChild(buildSet(set));
	};

	search.addEventListener("input", () => render(search.value));
	render("");

	const selectByHash = (hash: string): boolean => {
		// Clear any active filter so the target set is present in the DOM.
		if (search.value) {
			search.value = "";
			render("");
		}
		const row = list.querySelector<HTMLElement>(
			`.diff-row[data-hash="${CSS.escape(hash)}"]`,
		);
		if (!row) return false;
		// Expand the containing set so the selection is visible.
		const wrap = row.closest(".set");
		const diffs = wrap?.querySelector<HTMLElement>(".diff-list");
		if (diffs?.hidden) {
			diffs.hidden = false;
			wrap?.classList.add("open");
		}
		row.click(); // reuses selectDiff: highlight + onSelect
		row.scrollIntoView({ block: "center" });
		return true;
	};

	return { selectByHash };
}
