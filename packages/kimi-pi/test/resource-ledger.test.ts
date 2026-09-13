import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getAssistantTexts, type Harness } from "../../coding-agent/test/suite/harness.ts";
import { createKimiResourceLedger, planArtifactWrite } from "../src/resource-ledger.ts";

describe("Kimi resource ledger", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("plans dense artifacts across bounded tool calls", () => {
		expect(planArtifactWrite(200_000, "code", 32_768)).toEqual({
			estimatedTokens: 100_000,
			recommendedChunks: 4,
			maximumCharactersPerChunk: 65_536,
			maxArtifactChunkTokens: 32_768,
		});
	});

	it("persists checkpoints through the kimi_resources tool", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKimiResourceLedger({
					outputCapTokens: 1000,
					warningThresholdTokens: 800,
					ledgerDirectory: ".kimi-test",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("kimi_resources", {
					action: "checkpoint",
					summary: "Parsed the input and created a file skeleton.",
					nextAction: "Append the first bounded section.",
					artifacts: ["output.txt: skeleton"],
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("checkpoint complete"),
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		const ledgerPath = join(harness.tempDir, ".kimi-test", "resource-ledger.json");
		expect(existsSync(ledgerPath)).toBe(true);
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(ledger.checkpoints).toHaveLength(1);
		expect(ledger.checkpoints[0].nextAction).toBe("Append the first bounded section.");
	});

	it("continues the same session after an output-length stop", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKimiResourceLedger({
					outputCapTokens: 100,
					warningThresholdTokens: 25,
					ledgerDirectory: ".kimi-test",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("x".repeat(200), { stopReason: "length" }),
			fauxAssistantMessage("recovered with another turn"),
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["x".repeat(200), "recovered with another turn"]);
		const recoveryMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "kimi-output-limit-recovery",
		);
		expect(recoveryMessages).toHaveLength(1);
		const recoveryMessage = recoveryMessages[0];
		if (!recoveryMessage || recoveryMessage.role !== "custom") throw new Error("Missing recovery message");
		expect(recoveryMessage.content).toContain("same session and reasoning content are preserved");
		const ledgerPath = join(harness.tempDir, ".kimi-test", "resource-ledger.json");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(ledger.lengthRecoveries).toBe(1);
	});

	it("recovers repeatedly without duplicate continuation turns", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKimiResourceLedger({
					outputCapTokens: 100,
					warningThresholdTokens: 25,
					ledgerDirectory: ".kimi-test",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("a".repeat(200), { stopReason: "length" }),
			fauxAssistantMessage("b".repeat(200), { stopReason: "length" }),
			fauxAssistantMessage("recovered after two limits"),
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["a".repeat(200), "b".repeat(200), "recovered after two limits"]);
		const recoveryMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "kimi-output-limit-recovery",
		);
		expect(recoveryMessages).toHaveLength(2);
		const ledgerPath = join(harness.tempDir, ".kimi-test", "resource-ledger.json");
		const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
		expect(ledger.lengthRecoveries).toBe(2);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("queues one checkpoint turn after a high non-truncated response", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKimiResourceLedger({
					outputCapTokens: 100,
					warningThresholdTokens: 25,
					ledgerDirectory: ".kimi-test",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("x".repeat(200)),
			fauxAssistantMessage("checkpointed on the follow-up"),
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(getAssistantTexts(harness)).toEqual(["x".repeat(200), "checkpointed on the follow-up"]);
		const budgetMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "kimi-output-budget",
		);
		expect(budgetMessages).toHaveLength(1);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("does not queue a warning after the response already called a tool", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createKimiResourceLedger({
					outputCapTokens: 100,
					warningThresholdTokens: 25,
					ledgerDirectory: ".kimi-test",
				}),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("kimi_resources", {
					action: "checkpoint",
					summary: "x".repeat(200),
					nextAction: "Finish.",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		const budgetMessages = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "kimi-output-budget",
		);
		expect(budgetMessages).toHaveLength(0);
		expect(getAssistantTexts(harness)).toEqual(["", "done"]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("injects the Kimi resource protocol once", async () => {
		let providerSystemPrompt = "";
		const harness = await createHarness({
			extensionFactories: [createKimiResourceLedger()],
			systemPrompt: "Base prompt",
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				providerSystemPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("start");
		await harness.session.agent.waitForIdle();

		expect(providerSystemPrompt.match(/## Kimi resource-accounting protocol/g)).toHaveLength(1);
	});
});
