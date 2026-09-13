import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionFactory,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const SYSTEM_PROMPT = readFileSync(new URL("../prompts/APPEND_SYSTEM.md", import.meta.url), "utf8").trim();
const SYSTEM_MARKER = "## Kimi resource-accounting protocol";
const DEFAULT_OUTPUT_CAP_TOKENS = 131_072;
const DEFAULT_WARNING_THRESHOLD_TOKENS = 90_000;
const DEFAULT_MAX_ARTIFACT_CHUNK_TOKENS = 32_768;
const BUDGET_FILENAME = "output-budget.json";
const LEDGER_FILENAME = "resource-ledger.json";

const contentKinds = ["prose", "code", "math", "json"] as const;
type ContentKind = (typeof contentKinds)[number];

const resourceInputSchema = Type.Object({
	action: StringEnum(["status", "checkpoint", "plan_write", "read"] as const),
	summary: Type.Optional(Type.String({ description: "Concise established progress; never private chain-of-thought" })),
	nextAction: Type.Optional(Type.String({ description: "Next concrete tool action" })),
	artifacts: Type.Optional(Type.Array(Type.String(), { description: "Task artifact paths and current state" })),
	estimatedCharacters: Type.Optional(Type.Number({ minimum: 0 })),
	contentKind: Type.Optional(StringEnum(contentKinds)),
});

type ResourceInput = Static<typeof resourceInputSchema>;

interface ResourceLedgerOptions {
	outputCapTokens?: number;
	warningThresholdTokens?: number;
	maxArtifactChunkTokens?: number;
	ledgerDirectory?: string;
}

interface Checkpoint {
	timestamp: string;
	summary: string;
	nextAction: string;
	artifacts: string[];
	responseOutputTokens: number;
}

interface Ledger {
	version: 1;
	createdAt: string;
	updatedAt: string;
	checkpoints: Checkpoint[];
	lengthRecoveries: number;
}

interface ResponseBudget {
	outputCapTokens: number;
	warningThresholdTokens: number;
	estimatedOrReportedOutputTokens: number;
	estimatedRemainingTokens: number;
	phase: "idle" | "streaming" | "finished";
	stopReason: string | null;
	warningQueued: boolean;
	lengthRecoveries: number;
	updatedAt: string;
}

interface RuntimeState {
	currentOutputTokens: number;
	lastOutputTokens: number;
	lastStopReason: string | null;
	warningQueued: boolean;
	lengthRecoveries: number;
	lastPersistedBucket: number;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return resolved;
}

function environmentInteger(name: string): number | undefined {
	const raw = process.env[name];
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function workspacePaths(cwd: string, ledgerDirectory: string): { budget: string; ledger: string } {
	const root = resolve(cwd, ledgerDirectory);
	return {
		budget: resolve(root, BUDGET_FILENAME),
		ledger: resolve(root, LEDGER_FILENAME),
	};
}

function atomicWrite(path: string, contents: string): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, path);
}

function emptyLedger(): Ledger {
	const now = new Date().toISOString();
	return { version: 1, createdAt: now, updatedAt: now, checkpoints: [], lengthRecoveries: 0 };
}

function readLedger(path: string): Ledger {
	if (!existsSync(path)) return emptyLedger();
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1) {
		throw new Error(`Unsupported Kimi resource ledger at ${path}`);
	}
	return parsed as Ledger;
}

function writeLedger(path: string, ledger: Ledger): void {
	atomicWrite(path, `${JSON.stringify(ledger, null, 2)}\n`);
}

function writeBudget(path: string, budget: ResponseBudget): void {
	atomicWrite(path, `${JSON.stringify(budget, null, 2)}\n`);
}

function estimatedOutputTokens(message: Parameters<typeof estimateTokens>[0]): number {
	if (message.role !== "assistant") return 0;
	return Math.max(message.usage.output, estimateTokens(message));
}

function charsPerToken(kind: ContentKind): number {
	return kind === "prose" ? 4 : 2;
}

export function planArtifactWrite(
	estimatedCharacters: number,
	kind: ContentKind,
	maxArtifactChunkTokens = DEFAULT_MAX_ARTIFACT_CHUNK_TOKENS,
): {
	estimatedTokens: number;
	recommendedChunks: number;
	maximumCharactersPerChunk: number;
	maxArtifactChunkTokens: number;
} {
	if (!Number.isFinite(estimatedCharacters) || estimatedCharacters < 0) {
		throw new Error("estimatedCharacters must be a non-negative finite number");
	}
	const ratio = charsPerToken(kind);
	const estimatedTokens = Math.ceil(estimatedCharacters / ratio);
	const maximumCharactersPerChunk = maxArtifactChunkTokens * ratio;
	return {
		estimatedTokens,
		recommendedChunks: Math.max(1, Math.ceil(estimatedCharacters / maximumCharactersPerChunk)),
		maximumCharactersPerChunk,
		maxArtifactChunkTokens,
	};
}

function resourceSnapshot(
	state: RuntimeState,
	ctx: ExtensionContext,
	paths: { budget: string; ledger: string },
	outputCapTokens: number,
	warningThresholdTokens: number,
): Record<string, unknown> {
	const ledger = readLedger(paths.ledger);
	return {
		outputCapTokens,
		warningThresholdTokens,
		currentResponseOutputTokens: state.currentOutputTokens,
		currentResponseEstimatedRemaining: Math.max(0, outputCapTokens - state.currentOutputTokens),
		lastResponseOutputTokens: state.lastOutputTokens,
		lastStopReason: state.lastStopReason,
		lengthRecoveries: state.lengthRecoveries,
		context: ctx.getContextUsage() ?? null,
		budgetPath: paths.budget,
		ledgerPath: paths.ledger,
		checkpointCount: ledger.checkpoints.length,
		latestCheckpoint: ledger.checkpoints.at(-1) ?? null,
	};
}

export function createKimiResourceLedger(options: ResourceLedgerOptions = {}): ExtensionFactory {
	const outputCapTokens = positiveInteger(options.outputCapTokens, DEFAULT_OUTPUT_CAP_TOKENS, "outputCapTokens");
	const warningThresholdTokens = positiveInteger(
		options.warningThresholdTokens,
		DEFAULT_WARNING_THRESHOLD_TOKENS,
		"warningThresholdTokens",
	);
	const maxArtifactChunkTokens = positiveInteger(
		options.maxArtifactChunkTokens,
		DEFAULT_MAX_ARTIFACT_CHUNK_TOKENS,
		"maxArtifactChunkTokens",
	);
	if (warningThresholdTokens >= outputCapTokens) {
		throw new Error("warningThresholdTokens must be lower than outputCapTokens");
	}
	const ledgerDirectory = options.ledgerDirectory ?? process.env.KIMI_RESOURCE_LEDGER_DIR ?? ".kimi";

	return (pi: ExtensionAPI) => {
		const state: RuntimeState = {
			currentOutputTokens: 0,
			lastOutputTokens: 0,
			lastStopReason: null,
			warningQueued: false,
			lengthRecoveries: 0,
			lastPersistedBucket: -1,
		};

		const persistBudget = (ctx: ExtensionContext, phase: ResponseBudget["phase"]): void => {
			const paths = workspacePaths(ctx.cwd, ledgerDirectory);
			writeBudget(paths.budget, {
				outputCapTokens,
				warningThresholdTokens,
				estimatedOrReportedOutputTokens: state.currentOutputTokens,
				estimatedRemainingTokens: Math.max(0, outputCapTokens - state.currentOutputTokens),
				phase,
				stopReason: state.lastStopReason,
				warningQueued: state.warningQueued,
				lengthRecoveries: state.lengthRecoveries,
				updatedAt: new Date().toISOString(),
			});
		};

		pi.on("before_agent_start", (event) => {
			if (event.systemPrompt.includes(SYSTEM_MARKER)) return;
			return { systemPrompt: `${event.systemPrompt}\n\n${SYSTEM_PROMPT}` };
		});

		pi.on("message_start", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			state.currentOutputTokens = 0;
			state.warningQueued = false;
			state.lastPersistedBucket = -1;
			persistBudget(ctx, "streaming");
		});

		pi.on("message_update", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			state.currentOutputTokens = estimatedOutputTokens(event.message);
			const bucket = Math.floor(state.currentOutputTokens / 4096);
			if (bucket !== state.lastPersistedBucket) {
				state.lastPersistedBucket = bucket;
				persistBudget(ctx, "streaming");
			}
			if (state.warningQueued || state.currentOutputTokens < warningThresholdTokens) return;

			state.warningQueued = true;
			persistBudget(ctx, "streaming");
			pi.appendEntry("kimi-output-budget-warning", {
				estimatedOutputTokens: state.currentOutputTokens,
				outputCapTokens,
			});
		});

		pi.on("message_end", (event, ctx) => {
			if (event.message.role !== "assistant") return;
			state.currentOutputTokens = estimatedOutputTokens(event.message);
			state.lastOutputTokens = state.currentOutputTokens;
			state.lastStopReason = event.message.stopReason;
			persistBudget(ctx, "finished");
			if (event.message.stopReason === "length") {
				state.lengthRecoveries += 1;
				persistBudget(ctx, "finished");
				const paths = workspacePaths(ctx.cwd, ledgerDirectory);
				const ledger = readLedger(paths.ledger);
				ledger.lengthRecoveries = state.lengthRecoveries;
				ledger.updatedAt = new Date().toISOString();
				writeLedger(paths.ledger, ledger);
				pi.appendEntry("kimi-output-limit-recovery", {
					outputTokens: state.currentOutputTokens,
					outputCapTokens,
					recovery: state.lengthRecoveries,
				});
				pi.sendMessage(
					{
						customType: "kimi-output-limit-recovery",
						display: true,
						content:
							`OUTPUT LIMIT RECOVERY ${state.lengthRecoveries}: the preceding response ` +
							`ended with stopReason=length at ${state.currentOutputTokens}/${outputCapTokens}. ` +
							`The same session and reasoning content are preserved. Your first action now ` +
							`must be kimi_resources status or checkpoint, followed by bounded tool writes. ` +
							`Do not resume free-form analysis before materializing recoverable task state.`,
					},
					{ deliverAs: "steer", triggerTurn: true },
				);
				return;
			}

			const usedTool = event.message.content.some((part) => part.type === "toolCall");
			if (!state.warningQueued || usedTool) return;
			pi.sendMessage(
				{
					customType: "kimi-output-budget",
					display: true,
					content:
						`OUTPUT BUDGET WARNING: the preceding response consumed at least ` +
						`${state.currentOutputTokens} of ${outputCapTokens} output tokens. ` +
						`Before more analysis, call kimi_resources status or checkpoint, then ` +
						`materialize verifier-required output in bounded chunks. Estimate every ` +
						`remaining heredoc with plan_write and reserve 20 percent for control syntax.`,
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		});

		pi.registerTool({
			name: "kimi_resources",
			label: "Kimi resources",
			description:
				"Inspect response/context budgets, checkpoint durable task progress, and plan bounded artifact writes.",
			promptSnippet: "Track Kimi response budgets and durable task checkpoints",
			promptGuidelines: [
				"Use kimi_resources status at the start of long tasks and after budget warnings.",
				"Checkpoint established progress before large constructions; never store private chain-of-thought.",
				"Use plan_write before large heredocs or serialized outputs and follow its chunk recommendation.",
			],
			parameters: resourceInputSchema,
			async execute(_toolCallId, input: ResourceInput, _signal, _onUpdate, ctx) {
				const paths = workspacePaths(ctx.cwd, ledgerDirectory);
				if (input.action === "status") {
					const snapshot = resourceSnapshot(state, ctx, paths, outputCapTokens, warningThresholdTokens);
					return { content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }], details: snapshot };
				}

				if (input.action === "read") {
					const ledger = readLedger(paths.ledger);
					return { content: [{ type: "text", text: JSON.stringify(ledger, null, 2) }], details: ledger };
				}

				if (input.action === "plan_write") {
					if (input.estimatedCharacters === undefined || input.contentKind === undefined) {
						throw new Error("plan_write requires estimatedCharacters and contentKind");
					}
					const plan = planArtifactWrite(input.estimatedCharacters, input.contentKind, maxArtifactChunkTokens);
					return { content: [{ type: "text", text: JSON.stringify(plan, null, 2) }], details: plan };
				}

				if (!input.summary || !input.nextAction) {
					throw new Error("checkpoint requires summary and nextAction");
				}
				const ledger = readLedger(paths.ledger);
				const now = new Date().toISOString();
				ledger.updatedAt = now;
				ledger.lengthRecoveries = state.lengthRecoveries;
				ledger.checkpoints.push({
					timestamp: now,
					summary: input.summary,
					nextAction: input.nextAction,
					artifacts: input.artifacts ?? [],
					responseOutputTokens: state.currentOutputTokens,
				});
				writeLedger(paths.ledger, ledger);
				const result = {
					ledgerPath: paths.ledger,
					checkpointCount: ledger.checkpoints.length,
					checkpoint: ledger.checkpoints.at(-1),
				};
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			},
		});
	};
}

export default createKimiResourceLedger({
	outputCapTokens: environmentInteger("KIMI_OUTPUT_CAP_TOKENS"),
	warningThresholdTokens: environmentInteger("KIMI_OUTPUT_WARNING_TOKENS"),
	maxArtifactChunkTokens: environmentInteger("KIMI_MAX_ARTIFACT_CHUNK_TOKENS"),
});
