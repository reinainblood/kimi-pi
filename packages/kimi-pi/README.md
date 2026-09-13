# Kimi-Pi

Kimi-Pi is a Kimi-focused Pi distribution with durable resource accounting.
It addresses a recurring Kimi failure mode: a long reasoning response consumes
the full output allowance before the model materializes a required artifact.

## Capabilities

- Tracks estimated or provider-reported output usage throughout every response.
- Persists `.kimi/output-budget.json` as the active response grows.
- Provides the `kimi_resources` tool for status, checkpoints, ledger reads, and
  artifact write planning.
- Persists task progress in `.kimi/resource-ledger.json` using atomic writes.
- Queues a tool-first continuation before the next model call when a response
  crosses the configured warning threshold.
- Automatically continues the same session after `stopReason: length` and
  requires recovery into bounded tool writes.
- Repeats budget and recovery behavior for the entire task.

The ledger stores established facts, decisions, artifact state, tests, remaining
work, and next actions. It explicitly excludes private chain-of-thought.

## Run

From this repository:

```bash
node packages/kimi-pi/bin/kimi-pi.js --provider <provider> --model <model>
```

As a Pi package:

```bash
pi -e git:github.com/reinainblood/kimi-pi@<commit>
```

The extension defaults to a 131,072-token response cap, a 90,000-token warning
threshold, and 32,768-token maximum artifact chunks. A provider wrapper can set
different values through `createKimiResourceLedger()` when required.

The defaults can also be overridden per process with
`KIMI_OUTPUT_CAP_TOKENS`, `KIMI_OUTPUT_WARNING_TOKENS`,
`KIMI_MAX_ARTIFACT_CHUNK_TOKENS`, and `KIMI_RESOURCE_LEDGER_DIR`. The warning
threshold must remain below the output cap.

The `kimi-pi` executable delegates to the installed `pi` binary and attaches
the resource-ledger extension before all user arguments. Set
`KIMI_PI_BASE_COMMAND` only when Pi has a nonstandard executable path.

## Resource tool

`kimi_resources` supports:

- `status`: response, context and ledger state.
- `checkpoint`: atomically record concise task progress and the next tool action.
- `plan_write`: estimate output cost and split a large artifact into bounded
  tool calls.
- `read`: retrieve the durable ledger.
