/**
 * The outside service the Bead links tests talk to: a pi provider that answers with the
 * reply the test gives it, so a test can choose the words a Project Manager's reply holds.
 * On its first request it can create a Bead with bd, standing in for the model's own
 * `bd create` during a turn, so a test can see the next turn's reply link it.
 *
 * BEAD_LINKS_TEST_REPLY: the text of every reply.
 * BEAD_LINKS_TEST_CREATE: a Bead id to create on the first request, or empty.
 * BEAD_LINKS_TEST_LOG: one JSON object a line per request, with the text of each message
 * the request carried, so a test can see what the model was sent.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const api = "bead-links-test";
const log = process.env.BEAD_LINKS_TEST_LOG ?? "/dev/null";
const reply = process.env.BEAD_LINKS_TEST_REPLY ?? "answered";
const createId = process.env.BEAD_LINKS_TEST_CREATE ?? "";
let firstRequest = true;

const model = (id: string) => ({
	id,
	name: id,
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

const message = (requested: Model<Api>, text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
});

export default function beadLinksTestProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, context: unknown, _options?: SimpleStreamOptions) => {
		appendFileSync(
			log,
			`${JSON.stringify({
				messages: ((context as { messages?: unknown[] }).messages ?? []).map(textOf),
			})}\n`,
		);
		if (firstRequest && createId) {
			firstRequest = false;
			execFileSync("bd", ["create", `Bead ${createId}`, "--id", createId, "--type", "task", "--quiet"], {
				stdio: "ignore",
			});
		}
		const stream = createAssistantMessageEventStream();
		const answer = message(requested, reply);
		queueMicrotask(() => {
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "text_start", contentIndex: 0, partial: answer });
			stream.push({ type: "text_delta", contentIndex: 0, delta: reply, partial: answer });
			stream.push({ type: "text_end", contentIndex: 0, content: reply, partial: answer });
			stream.push({ type: "done", reason: "stop", message: answer });
		});
		return stream;
	};

	pi.registerProvider("bead-links-test", {
		name: "Bead links test provider",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("reply")],
		streamSimple,
	});
}

/** The text a message carries (copied from pi-flows, so this fixture stands alone). */
const textOf = (message: unknown): string => {
	if (typeof message !== "object" || message === null) return "";
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};
