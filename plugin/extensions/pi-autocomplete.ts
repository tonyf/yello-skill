import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { type DirectoryItem, PiDirectory } from "./pi-directory";

// Pi triggers at whitespace boundaries; these prefixes also activate mentions inside ordinary prose/Markdown.
const mentionTriggers = ["@", "(", "[", "{", "*", "_", "`", '"', "'", "“", "‘"];

export function mention(item: DirectoryItem) {
	return `@${item.handle}${item.kind === "person" ? "/" : ""}`;
}

export function completion(item: DirectoryItem): AutocompleteItem {
	return {
		value: mention(item),
		label: mention(item),
		description: `Yello ${item.kind === "person" ? "connection" : "agent"} · ${item.name}${item.description ? ` · ${item.description}` : ""}`,
	};
}

export function createYelloAutocomplete(
	current: AutocompleteProvider,
	directory: PiDirectory,
	report: (error?: Error) => void,
): AutocompleteProvider {
	const ownItems = new WeakSet<AutocompleteItem>();

	return {
		triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), ...mentionTriggers])],
		async getSuggestions(lines, line, col, options) {
			const before = (lines[line] ?? "").slice(0, col);
			// Leave email addresses, quoted paths, dot paths, and other file syntax to pi.
			const match = before.match(/(?:^|[\s\p{Ps}\p{Pi}])[*_`"']*@([a-z0-9-]*(?:\/[a-z0-9-]*)?)$/iu);

			if (!match) return current.getSuggestions(lines, line, col, options);
			const query = match[1];
			const prefix = `@${query}`;

			const pending = directory.search(query, options.signal).then(
				(items) => ({ items }),
				// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Normalize arbitrary Promise rejections at the async boundary.
				(error: unknown) => ({ error: error instanceof Error ? error : new Error(String(error)) }),
			);

			const existing = await current.getSuggestions(lines, line, col, options);
			// A cold or offline Yello lookup must not hold file completion until its network timeout.
			// The read continues warming the cache; the next keystroke or Tab includes its results.
			const result = existing?.items.length ? await briefly(pending) : await pending;

			if (options.signal.aborted || directory.signal.aborted) return null;

			if (!result) return existing;

			if ("error" in result) {
				report(result.error);

				return existing;
			}

			report();

			if (existing && existing.prefix !== prefix) return existing;
			const items = result.items.slice(0, 12).map(completion);

			for (const item of items) ownItems.add(item);
			items.push(...(existing?.items ?? []));

			return items.length ? { prefix, items } : existing;
		},
		applyCompletion(lines, line, col, item, prefix) {
			if (!ownItems.has(item)) return current.applyCompletion(lines, line, col, item, prefix);
			const text = lines[line] ?? "";
			const before = text.slice(0, col - prefix.length);
			const after = text.slice(col);
			const suffix = item.value.endsWith("/") || /^[\s\p{P}]/u.test(after) ? "" : " ";
			const next = [...lines];
			next[line] = before + item.value + suffix + after;

			return { lines: next, cursorLine: line, cursorCol: before.length + item.value.length + suffix.length };
		},
		shouldTriggerFileCompletion(lines, line, col) {
			return current.shouldTriggerFileCompletion?.(lines, line, col) ?? true;
		},
	};
}

async function briefly<T>(pending: Promise<T>) {
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			pending,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), 250);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
