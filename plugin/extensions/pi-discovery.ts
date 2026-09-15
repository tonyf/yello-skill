import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completion, createYelloAutocomplete, mention } from "./pi-autocomplete";
import { type DirectoryItem, PiDirectory } from "./pi-directory";
import { YelloPicker } from "./pi-picker";

export function registerDiscovery(pi: ExtensionAPI) {
	let directory: PiDirectory | undefined;

	pi.on("session_start", (_event, ctx) => {
		directory?.close();
		const current = new PiDirectory(pi, ctx);
		directory = current;

		if (ctx.mode !== "tui") return;
		ctx.ui.addAutocompleteProvider((base) =>
			createYelloAutocomplete(base, current, (error) => {
				ctx.ui.setStatus("yello-search", error ? "Yello search unavailable · /yello for details" : undefined);
			}),
		);
	});
	pi.on("session_shutdown", (_event, ctx) => {
		directory?.close();
		directory = undefined;

		if (ctx.mode === "tui") ctx.ui.setStatus("yello-search", undefined);
	});
	pi.registerCommand("yello", {
		description: "Search connections and visible agents; insert an agent mention into your draft",
		getArgumentCompletions: async (prefix) => {
			const current = directory;

			if (!current) return null;

			// Errors are shown in the picker; argument completion must leave normal typing usable.
			try {
				return (await current.search(prefix, current.signal)).slice(0, 12).map(completion);
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui")
				throw new Error("Open /yello in pi's interactive terminal to browse and insert agent mentions.");
			const current = directory;

			if (!current) throw new Error("Run /yello-reconnect before searching for agents.");
			const id = ctx.sessionManager.getSessionId();
			ctx.ui.setStatus("yello-search", undefined);
			current.refresh();
			let render: (() => void) | undefined;

			const selected = await ctx.ui.custom<DirectoryItem | undefined>((tui, theme, keys, done) => {
				render = () => tui.requestRender();

				return new YelloPicker(current, args, tui, theme, keys, done);
			});

			if (selected && directory === current && !current.signal.aborted && ctx.sessionManager.getSessionId() === id) {
				// The UI API owns the cursor; insert only the handle so surrounding draft separators stay intact.
				ctx.ui.pasteToEditor(mention(selected));
				// Pi's programmatic paste updates editor state; render it after the picker has closed.
				render?.();
			}
		},
	});

	return { refresh: () => directory?.refresh() };
}
