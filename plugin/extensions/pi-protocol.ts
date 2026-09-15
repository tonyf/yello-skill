/** Private stdio protocol between the session's pi extension and its Yello connector. */
export type PiConnectorEvent =
	| {
			type: "context";
			contextKey: string;
			content: string;
			state: "ready" | "pending" | "needs_action" | "skipped";
	  }
	| { type: "delivery"; contextKey: string; content: string };

export type PiSessionInfo = { type: "session_info"; name: string | null };
