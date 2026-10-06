import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PiConnection } from "./pi-connection";
import { registerDiscovery } from "./pi-discovery";
import type { PiToolDefinition, PiToolArguments } from "./pi-protocol";

export default function yello(pi: ExtensionAPI) {
	let generation = 0;
	let active: { id: string; connection: PiConnection } | undefined;
	let startupContext: string | undefined;
	const discovery = registerDiscovery(pi);

	const registerTools = (catalog: PiToolDefinition[]) => {
		for (const tool of catalog) {
			pi.registerTool({
				name: `yello_${tool.name}`,
				label: `Yello: ${tool.name.replaceAll("_", " ")}`,
				description: tool.description,
				promptSnippet: tool.description,
				parameters: Type.Unsafe<PiToolArguments>(tool.inputSchema),
				async execute(_toolCallId, params, signal, _onUpdate, ctx) {
					const id = ctx.sessionManager.getSessionId();
					const selected = active;

					if (!selected || selected.id !== id) throw new Error("Run /yello-reconnect before using Yello tools.");
					// The native session owns its title; profile sync preserves persistent names.
					const input = { ...params };

					if (tool.name === "set_context") delete input.name;

					let result =
						tool.name === "set_context" && input.description === undefined
							? { ok: true, data: {} }
							: await selected.connection.callTool(tool.name, input, signal, tool.readOnly);

					const current = active === selected && ctx.sessionManager.getSessionId() === id;

					if (!current && result.ok) {
						result = {
							ok: false,
							error: {
								code: tool.readOnly ? "session_changed" : "mutation_completion_interrupted",
								message:
									"The pi session changed during this call. Inspect the original result before retrying.",
								details: {
									context_key: `pi:${id}`,
									tool: tool.name,
									result: tool.readOnly ? undefined : result.data,
								},
							},
						};
					}

					// oxlint-disable-next-line anti-slop/no-runtime-typeof -- The native tool catalog validates name as a string; narrow the generic JSON transport field for pi.
					if (current && result.ok && tool.name === "set_context" && typeof params.name === "string")
						pi.setSessionName(params.name);

					if (!result.ok) throw new Error(JSON.stringify(result.error));

					return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
				},
			});
		}
	};

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

				if (event.type === "context") {
					if (event.tools) registerTools(event.tools);
					startupContext = event.state === "needs_action" ? undefined : event.content;
				}

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
}
