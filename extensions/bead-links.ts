/**
 * bead-links: turns each real Bead id in the model's replies into a link to that Bead on
 * the board, so a Ctrl-click opens it beside the conversation (fac-qpv.7.1).
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
 * The link is a markdown link `[<id>](<url>)` handed to pi through its markdown transformer,
 * so pi's renderer draws the id alone, clickable, and the reply text pi keeps for the model
 * never holds a link. Writing the terminal's own escapes into the reply looked right in
 * print mode, which passes the text through, but pi's TUI stripped them, leaving the URL in
 * the conversation (pi-links-gzj). It follows the work Mac's file-links.ts, which links file
 * paths in replies the same way.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
				? `[${word}](<${boardUrl(word, board)}>)`
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

export default function beadLinks(pi: ExtensionAPI): void {
	const board: Board = { repo: "", port: DEFAULT_PORT, ids: new Set() };

	const refresh = async (cwd: string): Promise<void> => {
		const listed = await listIds(cwd);
		if (listed) board.ids = new Set(listed);
	};

	pi.on("session_start", async (_event, ctx) => {
		board.repo = ctx.cwd;
		board.port = boardPort();
		await refresh(ctx.cwd);
	});
	// A turn may create Beads with a tool call, so the ids are reloaded after each turn,
	// in time for the next reply to link them.
	pi.on("turn_end", async (_event, ctx) => {
		await refresh(ctx.cwd);
	});
	// Only the assistant's reply is drawn with links; the message pi keeps stays as written.
	pi.registerMarkdownTransformer((markdown, context) =>
		context.messageType === "assistant" ? linkMarkdown(markdown, board) : markdown,
	);
}
