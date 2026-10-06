The release pipeline places `SHA256SUMS` here after all platform archives pass
verification. The plugin launcher downloads only the archive matching the plugin
version and checks it against this bundled manifest before installing it atomically
in the per-user cache. The archive includes the native privacy and notification
helpers. The privacy model is installed separately through `yello privacy setup`, or through
`setup_privacy` during an explicit MCP trial.

For local development, set `YELLO_BIN` to a compiled checkout build or a source
wrapper. A source checkout has no release manifest and does not download an
unrelated global CLI version.

The npm prepack step also includes this manifest. It reuses a prepared manifest or
fetches the exact released version, and rejects missing platform archives before
packing. Publish the compiled release before packing a new npm version.

Claude Code defaults to a 30-second parent MCP startup deadline. If the first
download is slower, the hook can finish caching it, but the channel needs an explicit
`/mcp` → Yello → Reconnect. Claude caches a failed connection for 15 minutes, so an
immediate restart or resume does not retry it. Owners on slow connections can launch with MCP_TIMEOUT=150000.
A child-process environment override cannot change the parent deadline.
