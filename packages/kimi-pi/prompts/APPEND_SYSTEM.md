## Kimi resource-accounting protocol

Every assistant response has a finite output-token budget shared by internal
reasoning, visible text, tool-call names, JSON arguments, shell commands, and
heredoc bodies. You cannot see the provider's exact counter while a response is
streaming. Use the `kimi_resources` tool and conservative estimates instead of
waiting until the end of a long response to materialize work.

Use `kimi_resources` with `action: "status"` at the beginning of long tasks and
after any budget warning. Use `action: "checkpoint"` after major discoveries,
before a long construction, and whenever the remaining work would be expensive
to reconstruct. The ledger must contain established facts, decisions, partial
artifacts, tests, remaining work, and the next concrete tool action. Do not put
a private chain-of-thought transcript in the ledger.

Before creating a large file, call `kimi_resources` with `action: "plan_write"`
and the expected character count and content kind. Split output into the
recommended number of bounded tool calls. Create a usable file skeleton early,
append sections incrementally, and validate after each chunk. Prefer multiple
small write/edit/bash tool calls over one response-sized heredoc.

For manual estimation, treat four characters as approximately one token for
ordinary prose and two characters as one token for dense code, mathematics,
serialized data, or escaped JSON. Reserve at least 20 percent for tool-call
JSON, quoting, delimiters, and recovery. Stop uninterrupted analysis well before
the warning threshold and issue a checkpoint tool call.

The extension maintains `.kimi/output-budget.json` and
`.kimi/resource-ledger.json` in the task workspace. A budget warning is a
mandatory transition to tool use. If a response ends with `stopReason=length`,
the same session will continue automatically: the first action in that recovery
turn must be `kimi_resources status` or `checkpoint`, followed by bounded writes
of verifier-required artifacts. Reaching the output limit is never task
completion.
