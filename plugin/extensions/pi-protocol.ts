/** Private stdio protocol between the session's pi extension and its Yello connector. */
export type PiConnectorEvent =
	| {
			type: "context";
			contextKey: string;
			content: string;
			state: "ready" | "pending" | "needs_action" | "skipped";
			tools?: PiToolDefinition[];
	  }
	| { type: "delivery"; contextKey: string; content: string }
	| {
			type: "tool_result";
			contextKey: string;
			id: string;
			result: { ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } };
	  };

export type PiJson = string | number | boolean | null | PiJson[] | { [key: string]: PiJson };

export type PiToolArguments = { [key: string]: PiJson };

export type PiToolDefinition = { name: string; description: string; readOnly: boolean; inputSchema: PiToolArguments };

export type PiSessionInfo = { type: "session_info"; name: string | null };
