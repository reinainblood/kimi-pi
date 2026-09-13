#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionPath = resolve(packageRoot, "src/resource-ledger.ts");
const piCommand = process.env.KIMI_PI_BASE_COMMAND ?? "pi";

export function buildPiArgs(args) {
	return ["--extension", extensionPath, ...args];
}

function run() {
	const child = spawn(piCommand, buildPiArgs(process.argv.slice(2)), {
		stdio: "inherit",
		env: process.env,
	});

	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.on(signal, () => child.kill(signal));
	}

	child.on("error", (error) => {
		const detail = error.code === "ENOENT" ? `Pi executable not found: ${piCommand}` : error.message;
		console.error(`kimi-pi: ${detail}`);
		process.exitCode = 1;
	});

	child.on("exit", (code, signal) => {
		if (signal) {
			process.kill(process.pid, signal);
			return;
		}
		process.exitCode = code ?? 1;
	});
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) run();
