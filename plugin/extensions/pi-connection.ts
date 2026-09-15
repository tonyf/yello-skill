import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { PiConnectorEvent, PiSessionInfo } from "./pi-protocol";

export const yelloWrapper = fileURLToPath(new URL("../scripts/yello", import.meta.url));

export function sessionEnvironment(sessionId: string) {
	return { CODEX_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "", YELLO_AGENT_SESSION: "", PI_SESSION_ID: sessionId };
}

/** One pipe per live pi session. Yello's connector owns network retries, batching, and receipts. */
export class PiConnection {
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
		receive: (event: PiConnectorEvent) => void,
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

		this.timeout = setTimeout(() => fail("Yello startup timed out."), 35000);
		reader.on("line", (line) => {
			if (this.closed) return;

			try {
				const event: unknown = JSON.parse(line);

				if (!validEvent(event, sessionId)) throw new Error("Invalid connector event");
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
	async close() {
		if (this.closed) return this.exited;
		this.closed = true;
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

function validEvent(event: unknown, sessionId: string): event is PiConnectorEvent {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- Parse JSON from the child pipe before using any event fields.
	if (!event || typeof event !== "object" || !("type" in event) || !("contextKey" in event) || !("content" in event))
		return false;

	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The envelope requires text content and the exact active session key.
	if (event.contextKey !== `pi:${sessionId}` || typeof event.content !== "string") return false;

	return (
		event.type === "delivery" ||
		(event.type === "context" &&
			"state" in event &&
			["ready", "pending", "needs_action", "skipped"].includes(String(event.state)))
	);
}
