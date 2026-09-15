import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Input,
	Key,
	matchesKey,
	SelectList,
	Text,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
} from "@earendil-works/pi-tui";
import { mention } from "./pi-autocomplete";
import { displayText, type DirectoryItem, PiDirectory } from "./pi-directory";

/** Pi's native input and selection components keep keyboard navigation and IME behavior. */
export class YelloPicker implements Component, Focusable {
	private readonly input = new Input({ placeholder: "Search connections or @owner/agent" });
	private list?: SelectList;
	private message = "Loading connections…";
	private selected?: DirectoryItem;
	private search?: AbortController;
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private readonly onClose = () => this.done(undefined);

	constructor(
		private readonly directory: PiDirectory,
		query: string,
		private readonly tui: TUI,
		private readonly theme: Theme,
		private readonly keys: KeybindingsManager,
		private readonly done: (item: DirectoryItem | undefined) => void,
	) {
		this.setQuery(query);
		this.directory.signal.addEventListener("abort", this.onClose, { once: true });
		this.update();
	}

	get focused() {
		return this.input.focused;
	}
	set focused(value: boolean) {
		this.input.focused = value;
	}

	private setQuery(query: string) {
		this.input.setValue("");
		this.input.handleInput(`\x1b[200~${displayText(query)}\x1b[201~`);
	}

	private choose(item: DirectoryItem) {
		if (item.kind === "agent") return this.done(item);
		this.setQuery(`${item.handle}/`);
		this.update();
	}

	private update(debounce = false) {
		this.search?.abort();
		clearTimeout(this.timer);
		const controller = new AbortController();
		this.search = controller;
		this.list = undefined;
		this.selected = undefined;
		this.message = "Searching…";
		const run = () => void this.load(this.input.getValue(), controller.signal);

		if (debounce) this.timer = setTimeout(run, 150);
		else run();
		this.tui.requestRender();
	}

	private async load(query: string, signal: AbortSignal) {
		try {
			const items = await this.directory.search(query, signal);

			if (signal.aborted || this.disposed) return;
			this.message = query.includes("/")
				? "No visible agents match this search."
				: "No connections or agents match this search.";
			this.setItems(items);
		} catch (error) {
			if (signal.aborted || this.disposed) return;
			this.message = displayText(error instanceof Error ? error.message : String(error));
		}

		this.tui.requestRender();
	}

	private setItems(items: DirectoryItem[]) {
		if (!items.length) return;
		const byValue = new Map(items.map((item) => [mention(item), item]));
		this.selected = items[0];
		this.list = new SelectList(
			items.map((item) => ({ value: mention(item), label: mention(item), description: item.name })),
			8,
			{
				selectedPrefix: (text) => this.theme.fg("accent", text),
				selectedText: (text) => this.theme.fg("accent", text),
				description: (text) => this.theme.fg("muted", text),
				scrollInfo: (text) => this.theme.fg("dim", text),
				noMatch: (text) => this.theme.fg("warning", text),
			},
		);
		this.list.onSelect = (option) => {
			const item = byValue.get(option.value);

			if (item) this.choose(item);
		};

		this.list.onSelectionChange = (option) => {
			this.selected = byValue.get(option.value);
		};
	}

	handleInput(data: string) {
		if (this.keys.matches(data, "tui.select.cancel")) return this.done(undefined);

		if (matchesKey(data, Key.ctrl("r"))) {
			this.directory.refresh();

			return this.update();
		}

		if (
			this.keys.matches(data, "tui.select.up") ||
			this.keys.matches(data, "tui.select.down") ||
			this.keys.matches(data, "tui.select.confirm")
		) {
			this.list?.handleInput(data);
		} else {
			const before = this.input.getValue();
			this.input.handleInput(data);

			if (this.input.getValue() !== before) this.update(true);
		}

		this.tui.requestRender();
	}

	render(width: number) {
		const title = this.theme.fg("accent", this.theme.bold("Yello · Find an agent"));

		const preview =
			this.selected?.kind === "person"
				? `${this.selected.description}. Enter to browse visible agents.`
				: (this.selected?.description ?? "");

		return [
			...new Text(title, 1, 0).render(width),
			...this.input.render(width),
			"",
			...(this.list?.render(width) ?? new Text(this.theme.fg("muted", this.message), 1, 0).render(width)),
			"",
			...new Text(this.theme.fg("muted", preview), 1, 0).render(width).slice(0, 4),
			...new Text(
				this.theme.fg("dim", "Type to search · ↑↓ choose · Enter select · Esc cancel · Ctrl+R refresh"),
				1,
				0,
			).render(width),
		];
	}

	invalidate() {
		this.input.invalidate();
		this.list?.invalidate();
	}

	dispose() {
		this.disposed = true;
		clearTimeout(this.timer);
		this.search?.abort();
		this.directory.signal.removeEventListener("abort", this.onClose);
	}
}
