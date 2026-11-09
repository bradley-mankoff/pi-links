/**
 * bead-links: turns each real Bead id in the model's replies into an OSC 8 link to that
 * Bead on the board, so a Ctrl-click opens it beside the conversation (fac-qpv.7.1).
 *
 * The link is http://127.0.0.1:<port>/#/board?issue=<id>&workspace=<repo path>: the board
 * otherwise looks the id up in whichever project it last showed, so the workspace names the
 * session's repo and the link works whatever the board was showing. The port comes from
 * `BEADS_BOARD_PORT`, and is 3917 without one.
 *
 * An id becomes a link only when it exists in the session's repo: the extension loads the
 * ids with `bd list --all --brief --json --limit 0` at session start and again after each
 * turn, so a word that looks like an id, such as beads-ui, stays plain. The limit is 0
 * because bd's default answer is the first 50 Beads, and a project with more would leave
 * its later ids plain. Fenced code blocks, code spans and existing links and URLs are left
 * as they are.
 *
 * It follows the work Mac's file-links.ts, which links file paths in replies the same way.
 */
import { execFile } from "node:child_process";
import type { AgentMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_PORT = 3917;

/** The board's port: `BEADS_BOARD_PORT` when it holds a usable port, and 3917 otherwise. */
const boardPort = (): number => {
	const value = Number((process.env.BEADS_BOARD_PORT ?? "").trim());
	return Number.isInteger(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
};

/** The ids the session's repo holds, or undefined when bd could not be asked. */
const listIds = (cwd: string): Promise<string[] | undefined> =>
	new Promise((resolve) =>
		execFile(
			"bd",
			["list", "--all", "--brief", "--json", "--limit", "0"],
			{ cwd, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
			(err, stdout) => {
				if (err) return resolve(undefined);
				try {
					const rows = JSON.parse(stdout) as Array<{ id?: unknown }>;
					resolve(rows.flatMap((row) => (typeof row.id === "string" ? [row.id] : [])));
				} catch {
					resolve(undefined);
				}
			},
		),
	);

/**
 * Where a reply's links point, and the words that may become one: the session's repo, the
 * board's port, and the ids that repo holds.
 */
type Board = { repo: string; port: number; ids: Set<string> };

const boardUrl = (id: string, board: Board): string =>
	`http://127.0.0.1:${board.port}/#/board?issue=${encodeURIComponent(id)}&workspace=${encodeURIComponent(board.repo)}`;

/** The OSC 8 sequence pi itself uses for a link. */
const hyperlink = (text: string, url: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

/**
 * Leftmost alternative wins: existing links, autolinks and URLs are kept as written, then
 * code spans, then a whole word that may be a Bead id. A sentence's trailing dot is not
 * part of the word, so "fac-abc.1." links the id and keeps the dot.
 */
const KEPT_OR_WORD =
	/(\[[^\]\n]*\]\([^)\n]*\)|<[^>\s]+>|\b[a-z][\w+.-]*:\/\/\S+)|`([^`\n]+)`|(?<![\w.-])([a-z][\w.-]*\w)/gi;

const linkLine = (line: string, board: Board): string =>
	line.replace(
		KEPT_OR_WORD,
		(match, kept: string | undefined, code: string | undefined, word: string | undefined) =>
			kept === undefined && code === undefined && word && board.ids.has(word)
				? hyperlink(word, boardUrl(word, board))
				: match,
	);

/** Every line outside a fenced code block; the fences themselves and their lines are kept. */
const linkMarkdown = (markdown: string, board: Board): string => {
	let fence: string | undefined;
	return markdown
		.split("\n")
		.map((line) => {
			const open = /^\s*(`{3,}|~{3,})/.exec(line);
			if (open && (!fence || open[1].startsWith(fence))) {
				fence = fence ? undefined : open[1];
				return line;
			}
			return fence ? line : linkLine(line, board);
		})
		.join("\n");
};

/** Every text block of an assistant message mapped; the same message when none changed. */
const mapText = (message: AgentMessage, map: (text: string) => string): AgentMessage => {
	if (message.role !== "assistant") return message;
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "text") return block;
		const text = map(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? { ...message, content } : message;
};

const linkMessage = (message: AgentMessage, board: Board): AgentMessage =>
	mapText(message, (text) => linkMarkdown(text, board));

/** An OSC 8 link's opening sequence, which carries the URL, and its closing one. */
const OSC8 = /\x1b]8;[^\x1b\x07]*(?:\x1b\\|\x07)/g;

/** The same message with the terminal's links removed, for the model to read. */
const plainMessage = (message: AgentMessage): AgentMessage => mapText(message, (text) => text.replace(OSC8, ""));

export default function beadLinks(pi: ExtensionAPI): void {
	const board: Board = { repo: "", port: DEFAULT_PORT, ids: new Set() };
	let loading: Promise<void> = Promise.resolve();

	const refresh = (cwd: string): Promise<void> => {
		loading = listIds(cwd).then((listed) => {
			if (listed) board.ids = new Set(listed);
		});
		return loading;
	};

	pi.on("session_start", async (_event, ctx) => {
		board.repo = ctx.cwd;
		board.port = boardPort();
		await refresh(ctx.cwd);
	});
	// A turn may create Beads with a tool call, so the ids are reloaded after each turn,
	// before the next model request.
	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx.cwd);
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		await loading;
		if (board.ids.size === 0) return;
		const message = linkMessage(event.message, board);
		return message === event.message ? undefined : { message };
	});
	// The model reads its own earlier replies on the next request. The escapes are for the
	// terminal, so they are removed from what it is sent, and a quoted id stays a plain id.
	pi.on("context", (event) => {
		const messages = event.messages.map(plainMessage);
		return messages.some((message, i) => message !== event.messages[i]) ? { messages } : undefined;
	});
}
