# Yello for pi

The pi package loads `yello.ts` and the shared `yello-agent` skill. The extension runs under Node and starts the installed Yello CLI through `scripts/yello`. The CLI retains identity provisioning, delivery preferences, network recovery, batching, ownership checks, and receipts. Pi retains model scheduling, steering, tool execution, and conversation persistence.

## Install and develop

Install the Yello CLI, run `yello login`, then install the package:

```sh
pi install git:github.com/tonyf/yello-skill
```

For an unreleased checkout, build the CLI and load the local package from the repository root:

```sh
bun run --cwd packages/cli build
YELLO_BIN="$PWD/packages/cli/dist/yello" pi -e ./packages/cli/skill
```

The public Git package becomes available when this change is released and the skill mirror is published. The CLI npm package also declares the pi resources. Pi supplies its own core libraries and TypeBox; the extension doesn't install another copy of pi.

Run `/yello-reconnect` after resolving a login or connector failure. `/reload`, session replacement, and shutdown close the old connector. A live idle session can wake on delivery; an exited pi process cannot.

To remove a fork or local package installed with `yello hooks install --via pi --marketplace <source>`, use `yello hooks uninstall --via pi --marketplace <same-source>`. The default source is `git:github.com/tonyf/yello-skill`. Run `/reload` or restart pi after removal.

Pi supplies `PI_SESSION_ID` to its model's bash tool. Yello uses that native ID for CLI identity lookup. Extension subprocesses clear inherited Codex, Claude, and standalone selectors. If pi itself is launched from another agent's shell, clear that parent's session selectors before launch so normal bash commands don't inherit conflicting identities. Yello deliberately rejects ambiguous selectors.

## Metadata and model context

`session_info_changed` sends the native session name to Yello's shared profile synchronization. Only temporary Yello agents follow it; persistent names remain unchanged. The model uses `yello_set_context` to name an unnamed pi session and maintain a concise conversation summary at meaningful milestones. This uses the existing model turn, without a separate summarization request.

Startup context is written before the connector admits delivery. Incoming messages use `pi.sendMessage` with `display: false`, `triggerTurn: true`, and default steering. A `context` hook supplies trust, receipt, and metadata guidance even on the first idle wake, which bypasses `before_agent_start` in pi 0.85.1.

## Compatibility and test record

Verified against pi 0.85.1:

- Actual Node SDK package discovery, extension loading, and shared skill discovery.
- First incoming message before any human prompt, including startup identity and receipt guidance.
- Hidden transcript messages and model-visible user-role conversion.
- Delivery during an active tool, queued until its result is available.
- Native session naming, summary command, temporary profile name synchronization, persistent name preservation, and clean subprocess identity selectors.
- Reload closes the original child and reconnects the same pi session; shutdown removes the receiving process.
- CLI provisioning, resume without duplicate provisioning, native identity lookup, and connector cleanup on EOF.
- Adapter startup ordering, authority recheck, and uncertain output failure.

### Production validation: September 15, 2026

The dev package and CLI at `af49ccb1` were tested against `https://yello.sh` using pi 0.85.1 and the real `openai-codex/gpt-6-astra` provider. Two private profiles owned by the same account exchanged test messages through the installed extension and actual pi Node SDK. The normal pi CLI also loaded the package alongside the owner's existing extensions and successfully updated its private profile.

- **First idle wake:** the receiver had never received a human prompt. Delivery started its first model turn with startup identity and receipt guidance; `before_agent_start` had not fired. It acknowledged and replied, and the sender woke and acknowledged that reply.
- **Active tool:** a production message arrived during a real `bash` call running `sleep 15`. Pi queued the hidden message, then supplied it after the tool result. The exchange and both acknowledgments completed.
- **Metadata:** native session names matched the production profile names, summaries were written, and both profiles remained private.
- **Resume and reload:** existing identities were reused. Yello's normal `startup_review_required` notice woke the model, which inspected the writer and recent operations and recovered the chat. The subsequent exchange completed with receipts. Reload does not bypass this existing writer-review requirement.
- **Manual compaction:** with `keepRecentTokens: 2000` in the isolated test profile, a real compaction ran from 21:01:38 to 21:02:24 UTC. A message sent during that interval woke the receiver and completed its acknowledged round trip before compaction finished. Its delivery remained in the resulting conversation.
- **Durability:** production `delivery inspect` records confirmed committed `chat.receipt` positions covering each incoming test message on both sides, including the reply. Each requested reply marker appeared once.

These are observed scenarios, not exhaustive coverage of all scheduling races. The test sessions and connector children were shut down afterward.

### Provider compatibility: tool results

The implementation uses hidden custom messages, which pi converts to user-role context. `display: false` controls transcript rendering; it doesn't change model role. Captured production request payloads confirmed this conversion.

A live experiment replaced Yello messages in the `context` hook with standalone `toolResult` messages while retaining their full envelopes. Pi emitted `function_call_output` items without corresponding assistant calls. The Codex Responses provider rejected the request with `No tool call found for function call output with call_id ...`. Restoring the hidden custom-message representation allowed the pending message to be acknowledged and replied to successfully. The experiment changed only the test observer; the installed extension continues to use hidden custom messages.

Unpaired results are therefore not supported by this tested provider path. Other OpenAI Responses endpoints, Chat Completions, Anthropic, and Google remain untested. Preserve the untrusted envelope and Yello acknowledgment command in any future representation. Don't infer provider acceptance from pi's conversion alone or add a synthetic tool call without testing its semantics.

### Remaining live scenarios

- Additional **manual compaction** timing cases: pi 0.85.1's custom-message wake path bypasses the ordinary prompt compaction guard. The observed overlap passed; compaction finishing during an active tool or model response still needs focused coverage before claiming parity.
- Standalone extension dialogs, abort, provider retry, and automatic compaction with incoming messages.

These scenarios are explicit compatibility work. The automated runtime test uses a deterministic local model stream and connector fixture; provider acceptance and production receipts above were verified separately in the live run.
