import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { PiConnectorEvent, PiSessionInfo, PiToolArguments } from "./pi-protocol";

export const yelloWrapper = fileURLToPath(new URL("../scripts/yello", import.meta.url));

export function sessionEnvironment(sessionId: string) {
	return { CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", YELLO_AGENT_SESSION: "", PI_SESSION_ID: sessionId };
}

/** One pipe per live pi session. Yello's connector owns network retries, batching, and receipts. */
export class PiConnection {
	private readonly pending = new Map<
		string,
		{
			resolve(result: Extract<PiConnectorEvent, { type: "tool_result" }>["result"]): void;
			interrupted(): void;
		}
	>();
	private readonly child: ChildProcessWithoutNullStreams;
	private closed = false;
	private stderr = "";
	private finishStartup: () => void = () => {};
	readonly started = new Promise<void>((resolve) => {
		this.finishStartup = resolve;
	});
	private readonly exited: Promise<void>;
	private readonly timeout: ReturnType<typeof setTimeout>;

	constructor(
		readonly sessionId: string,
		cwd: string,
		name: string | undefined,
		receive: (event: Exclude<PiConnectorEvent, { type: "tool_result" }>) => void,
		failed: (message: string) => void,
	) {
		this.child = spawn("sh", [yelloWrapper, "hooks", "pi", "--context", sessionId], {
			cwd,
			env: { ...process.env, ...sessionEnvironment(sessionId) },
			stdio: "pipe",
		});
		const reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });

		const fail = (message: string) => {
			if (this.closed) return;
			failed(`${message} Run /yello-reconnect after resolving it.`);
			void this.close();
		};

		this.timeout = setTimeout(() => fail("Yello startup timed out."), 150000);
		reader.on("line", (line) => {
			if (this.closed) return;

			try {
				const event: unknown = JSON.parse(line);

				if (!validEvent(event, sessionId)) throw new Error("Invalid connector event");

				if (event.type === "tool_result") {
					this.pending.get(event.id)?.resolve(event.result);

					return;
				}

				receive(event);

				if (event.type === "context") {
					clearTimeout(this.timeout);
					this.finishStartup();
				}
			} catch {
				fail("Yello could not deliver connector context to this pi session.");
			}
		});
		this.child.stderr.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-2000);
		});
		this.child.stdin.on("error", () => fail("Yello's connector input closed."));
		this.child.on("error", (error) => fail(`Yello could not start: ${error.message}`));
		this.exited = new Promise((resolve) => {
			this.child.once("close", () => {
				reader.close();
				resolve();
				fail(`Yello's connector stopped.${this.stderr.trim() ? ` ${this.stderr.trim()}` : ""}`);
			});
		});
		this.setName(name);
	}
	setName(name: string | undefined) {
		if (this.closed) return;
		const message: PiSessionInfo = { type: "session_info", name: name ?? null };
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}
	async callTool(name: string, input: PiToolArguments, signal?: AbortSignal, readOnly = false) {
		signal?.throwIfAborted();

		if (this.closed) throw new Error("Yello is disconnected. Run /yello-reconnect.");
		const id = crypto.randomUUID();

		// Allocate before entering the pipe so an abrupt connector exit cannot lose the send selector.
		const original =
			name === "send_message" ? { ...input, request_id: input.request_id ?? crypto.randomUUID() } : { ...input };

		let timer: ReturnType<typeof setTimeout> | undefined;
		let cancel = () => {};

		try {
			return await new Promise<Extract<PiConnectorEvent, { type: "tool_result" }>["result"]>((resolve) => {
				const interrupted = () =>
					resolve({
						ok: false,
						error: {
							code: readOnly ? "connection_closed" : "mutation_outcome_unknown",
							message: readOnly
								? "The original pi connection closed."
								: "The original pi connector did not return a result. Inspect the original session and selectors before retrying this change.",
							details: { context_key: `pi:${this.sessionId}`, tool: name, requested: original },
						},
					});

				this.pending.set(id, { resolve, interrupted });
				cancel = () => {
					if (!this.closed) this.child.stdin.write(`${JSON.stringify({ type: "tool_cancel", id })}\n`);
					// Cancellation is a request, not evidence that a dispatched write did not commit.
					// Allow the connector's bounded network request to return its structured receipt.
					timer = setTimeout(interrupted, 35000);
				};

				signal?.addEventListener("abort", cancel, { once: true });
				this.child.stdin.write(`${JSON.stringify({ type: "tool_call", id, name, input: original })}\n`, (error) => {
					if (error) interrupted();
				});
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			this.pending.delete(id);
		}
	}

	async close() {
		if (this.closed) return this.exited;
		this.closed = true;

		for (const request of this.pending.values()) request.interrupted();
		this.pending.clear();
		clearTimeout(this.timeout);
		this.finishStartup();
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		const kill = setTimeout(() => this.child.kill("SIGKILL"), 2000);

		try {
			await this.exited;
		} finally {
			clearTimeout(kill);
		}
	}
}

const eventSchema = Type.Union([
	Type.Object({
		type: Type.Literal("context"),
		contextKey: Type.String(),
		content: Type.String(),
		state: Type.Union([
			Type.Literal("ready"),
			Type.Literal("pending"),
			Type.Literal("needs_action"),
			Type.Literal("skipped"),
		]),
		tools: Type.Optional(
			Type.Array(
				Type.Object({
					name: Type.String(),
					description: Type.String(),
					readOnly: Type.Boolean(),
					inputSchema: Type.Record(Type.String(), Type.Unknown()),
				}),
			),
		),
	}),
	Type.Object({ type: Type.Literal("delivery"), contextKey: Type.String(), content: Type.String() }),
	Type.Object({
		type: Type.Literal("tool_result"),
		contextKey: Type.String(),
		id: Type.String(),
		result: Type.Object({
			ok: Type.Boolean(),
			data: Type.Optional(Type.Unknown()),
			error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
		}),
	}),
]);

function validEvent(event: unknown, sessionId: string): event is PiConnectorEvent {
	return Value.Check(eventSchema, event) && event.contextKey === `pi:${sessionId}`;
}
