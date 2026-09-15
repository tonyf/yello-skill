import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiConnection, sessionEnvironment, yelloWrapper } from "./pi-connection";
import { registerDiscovery } from "./pi-discovery";

export default function yello(pi: ExtensionAPI) {
	let generation = 0;
	let active: { id: string; connection: PiConnection } | undefined;
	let startupContext: string | undefined;
	const discovery = registerDiscovery(pi);

	const stop = async () => {
		generation++;
		const previous = active;
		active = undefined;
		startupContext = undefined;
		await previous?.connection.close();
	};

	const start = async (ctx: ExtensionContext) => {
		discovery.refresh();
		const previous = active;
		active = undefined;
		startupContext = undefined;
		const current = ++generation;
		await previous?.connection.close();

		if (current !== generation) return;
		const id = ctx.sessionManager.getSessionId();
		const live = () => current === generation && ctx.sessionManager.getSessionId() === id;

		const connection = new PiConnection(
			id,
			ctx.cwd,
			ctx.sessionManager.getSessionName(),
			(event) => {
				if (!live()) return;

				if (event.type === "context") startupContext = event.state === "needs_action" ? undefined : event.content;

				if (event.type === "context" && event.state === "needs_action") {
					ctx.ui.notify(event.content, "warning");

					return;
				}

				// Pi schedules active turns and idle wakes. Hidden custom messages currently convert to user-role context.
				pi.sendMessage(
					{
						customType: event.type === "context" ? "yello-context" : "yello-message",
						content: event.content,
						display: false,
					},
					{ triggerTurn: event.type === "delivery" },
				);
			},
			(message) => {
				if (!live()) return;
				ctx.ui.notify(message, "warning");
			},
		);

		active = { id, connection };
		await connection.started;
	};

	pi.on("session_start", async (_event, ctx) => {
		await start(ctx);
	});
	pi.on("session_shutdown", stop);
	pi.on("session_info_changed", (_event, ctx) => {
		if (active?.id === ctx.sessionManager.getSessionId())
			active.connection.setName(ctx.sessionManager.getSessionName());
	});
	// Resumed sessions can contain older startup chores. Keep only this connection's latest context.
	pi.on("context", (event) => {
		let latest = -1;

		for (const [index, message] of event.messages.entries()) {
			if (message.role === "custom" && message.customType === "yello-context" && message.content === startupContext)
				latest = index;
		}

		return {
			messages: event.messages.filter(
				(message, index) =>
					message.role !== "custom" ||
					(message.customType !== "yello-guidance" &&
						(message.customType !== "yello-context" || index === latest)),
			),
		};
	});
	pi.registerCommand("yello-reconnect", {
		description: "Reconnect this session's Yello identity and incoming messages",
		handler: async (_args, ctx) => {
			await start(ctx);
		},
	});
	pi.registerTool({
		name: "yello_set_context",
		label: "Update Yello context",
		description:
			"Publish a concise conversation summary to this session's Yello profile. Optionally set the pi session name; Yello mirrors it only for temporary agents.",
		promptSnippet: "Publish a conversation summary once substantive work is clear or reaches a meaningful milestone",
		promptGuidelines: [
			"Use yello_set_context once substantive work is clear and at meaningful milestones or task changes. Summarize current work for peers; optionally name an unnamed pi session. Casual conversation does not need a profile update.",
		],
		parameters: Type.Object({
			description: Type.String({
				minLength: 1,
				maxLength: 1000,
				description: "Current work and relevant context, suitable for peers who can see the agent",
			}),
			name: Type.Optional(Type.String({ minLength: 1, maxLength: 100, description: "Concise pi session name" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const id = ctx.sessionManager.getSessionId();
			const current = generation;
			const env = Object.entries(sessionEnvironment(id)).map(([key, value]) => `${key}=${value}`);

			const result = await pi.exec(
				"env",
				[...env, "sh", yelloWrapper, "agent", "update", "--description", params.description, "--no-pretty"],
				{ cwd: ctx.cwd, signal, timeout: 30000 },
			);

			if (result.code !== 0)
				throw new Error(result.stderr.trim() || result.stdout.trim() || "Yello profile update failed.");

			if (current !== generation || ctx.sessionManager.getSessionId() !== id)
				throw new Error("The pi session changed during the profile update.");

			if (params.name !== undefined) pi.setSessionName(params.name);

			return { content: [{ type: "text", text: result.stdout.trim() }], details: {} };
		},
	});
}
