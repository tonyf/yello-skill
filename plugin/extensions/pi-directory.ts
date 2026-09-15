import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, stripTerminalSequences } from "@earendil-works/pi-tui";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { sessionEnvironment, yelloWrapper } from "./pi-connection";

// Validate only the CLI fields used here. The server owns visibility and profile rules.
const username = Type.String({ pattern: "^[a-z0-9-]+$", minLength: 1, maxLength: 32 });

const connections = Type.Object({
	data: Type.Array(
		Type.Object({ peer: Type.Object({ name: Type.String(), username: Type.Union([username, Type.Null()]) }) }),
	),
	pagination: Type.Object({ page: Type.Integer({ minimum: 1 }), hasMore: Type.Boolean() }),
});

const profile = Type.Object({
	profile: Type.Object({ username, name: Type.String() }),
	agents: Type.Array(
		Type.Object({ username, name: Type.String(), description: Type.Union([Type.String(), Type.Null()]) }),
	),
});

const failure = Type.Object({ ok: Type.Literal(false), error: Type.Object({ message: Type.String() }) });

const CACHE_MS = 30_000;

export interface DirectoryItem {
	kind: "person" | "agent";
	handle: string;
	name: string;
	description: string;
}

interface CachedItems {
	promise: Promise<DirectoryItem[]>;
	value?: DirectoryItem[];
	expiresAt: number;
}

export function displayText(value: string) {
	// Profile text is remote content, never terminal control sequences or additional UI rows.
	return (
		stripTerminalSequences(value)
			.replace(/\p{Bidi_Control}/gu, "")
			// oxlint-disable-next-line no-control-regex -- Strip remote control bytes before rendering terminal UI.
			.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** Read-only discovery through the installed CLI, scoped to this pi session. */
export class PiDirectory {
	private readonly lifetime = new AbortController();
	private readonly cache = new Map<string, CachedItems>();
	private readonly sessionId: string;

	constructor(
		private readonly pi: Pick<ExtensionAPI, "exec">,
		private readonly ctx: Pick<ExtensionContext, "cwd" | "sessionManager">,
	) {
		this.sessionId = ctx.sessionManager.getSessionId();
	}

	get signal() {
		return this.lifetime.signal;
	}

	close() {
		this.lifetime.abort();
		this.cache.clear();
	}

	refresh() {
		this.cache.clear();
	}

	private assertCurrent() {
		this.signal.throwIfAborted();

		if (this.ctx.sessionManager.getSessionId() !== this.sessionId)
			throw new Error("The pi session changed during Yello search.");
	}

	private async read<T extends TSchema>(args: string[], schema: T) {
		this.assertCurrent();
		const env = Object.entries(sessionEnvironment(this.sessionId)).map(([key, value]) => `${key}=${value}`);

		const result = await this.pi.exec("env", [...env, "sh", yelloWrapper, ...args, "--no-pretty"], {
			cwd: this.ctx.cwd,
			signal: this.signal,
			timeout: 10_000,
		});

		this.assertCurrent();
		const text = result.code === 0 ? result.stdout : result.stderr.trim() || result.stdout;
		let document: unknown;

		try {
			document = JSON.parse(text);
		} catch {
			throw new Error(displayText(text).slice(0, 500) || "Yello discovery returned no response.");
		}

		if (Value.Check(failure, document)) throw new Error(displayText(document.error.message));

		const envelope = Type.Object({
			ok: Type.Literal(true),
			data: schema,
			meta: Type.Object({ handle: Type.String() }),
		});

		if (result.code !== 0 || !Value.Check(envelope, document))
			throw new Error(
				"Yello discovery returned an invalid response. Update the Yello CLI and run /yello-reconnect.",
			);

		return document;
	}

	private async cached(key: string, load: () => Promise<DirectoryItem[]>) {
		this.assertCurrent();
		const previous = this.cache.get(key);

		if (previous && previous.expiresAt > Date.now()) return previous.promise;
		const entry: CachedItems = { promise: load(), expiresAt: Number.POSITIVE_INFINITY };
		this.cache.set(key, entry);

		try {
			const items = await entry.promise;
			this.assertCurrent();
			entry.value = items;
			entry.expiresAt = Date.now() + CACHE_MS;

			return items;
		} catch (error) {
			if (this.cache.get(key) === entry) this.cache.delete(key);
			throw error;
		}
	}

	private people() {
		return this.cached("connections", async () => {
			const people = new Map<string, DirectoryItem>();
			let page = 1;

			while (true) {
				const result = await this.read(
					["connections", "list", "--page", String(page), "--limit", "100"],
					connections,
				);

				const owner = result.meta.handle.split("/")[0];

				if (!Value.Check(username, owner)) throw new Error("Yello returned an invalid owner handle.");

				if (page === 1)
					people.set(owner, { kind: "person", handle: owner, name: owner, description: "Your agents" });

				for (const { peer } of result.data.data) {
					if (peer.username && !people.has(peer.username))
						people.set(peer.username, {
							kind: "person",
							handle: peer.username,
							name: displayText(peer.name),
							description: "Connection",
						});
				}

				if (!result.data.pagination.hasMore) break;

				if (result.data.pagination.page !== page) throw new Error("Yello returned an invalid connections page.");
				page++;
			}

			return [...people.values()];
		});
	}

	private agents(owner: string) {
		return this.cached(`@${owner}`, async () => {
			const result = await this.read(["profile", `@${owner}`], profile);

			return result.data.agents.map((agent: Static<typeof profile>["agents"][number]): DirectoryItem => ({
				kind: "agent",
				handle: `${result.data.profile.username}/${agent.username}`,
				name: displayText(agent.name),
				description: displayText(agent.description ?? ""),
			}));
		});
	}

	async search(query: string, signal: AbortSignal): Promise<DirectoryItem[]> {
		signal.throwIfAborted();
		const text = query.trim().replace(/^@/, "");
		const slash = text.indexOf("/");

		if (slash >= 0) {
			const owner = text.slice(0, slash).toLowerCase();

			if (!Value.Check(username, owner)) return [];
			const agents = await this.agents(owner);
			signal.throwIfAborted();

			return filterItems(agents, text.slice(slash + 1));
		}

		const people = await this.people();
		signal.throwIfAborted();

		if (!text) return people;
		const matchingPeople = filterItems(people, text);

		const match =
			matchingPeople.find((person) => person.handle === text.toLowerCase()) ??
			(matchingPeople.length === 1 ? matchingPeople[0] : undefined);

		const owners = new Set([people[0]?.handle, match?.handle]);
		await Promise.all([...owners].flatMap((owner) => (owner === undefined ? [] : [this.agents(owner)])));
		signal.throwIfAborted();
		const items = [...people];

		for (const [key, entry] of this.cache) {
			if (key.startsWith("@") && entry.value && entry.expiresAt > Date.now()) items.push(...entry.value);
		}

		return filterItems(items, text);
	}
}

function filterItems(items: DirectoryItem[], query: string) {
	return fuzzyFilter(items, query, (item) => `${item.handle} ${item.name} ${item.description}`);
}
