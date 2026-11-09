/**
 * A Bead id in a reply becomes a link to that Bead on the board, naming its project
 * (fac-qpv.7.1). These tests drive the seam the Bead names: the markdown transformer pi
 * renders an assistant message through. A reply's words go in, and the markdown pi's
 * renderer draws comes out; the message pi holds for the model is never touched. The board
 * is at 127.0.0.1, its port from BEADS_BOARD_PORT or 3917, and its workspace is the
 * session's repo path, so a link opens the Bead in the right project.
 *
 * One test drives a real pi session in print mode, because the model's context is only
 * visible on the wire, through the provider at the edge.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extension = path.join(repoRoot, "extensions", "bead-links.ts");
const testProvider = path.join(repoRoot, "tests", "fixtures", "bead-links-test-provider.ts");

/** One temporary Mac with its own Beads repo and pi folder. */
type Workspace = { dir: string; home: string; agentDir: string; log: string };

/** bd in the repo, under the repo's own HOME, as a Project Manager's shell runs it. */
const bd = (dir: string, home: string, args: string[]): void => {
	execFileSync("bd", args, {
		cwd: dir,
		env: { ...process.env, HOME: home, BD_NON_INTERACTIVE: "1" },
		stdio: "pipe",
	});
};

let template: string | undefined;

after(() => {
	if (template) fs.rmSync(template, { recursive: true, force: true });
});

/** One `bd init`, made once and copied, so each test starts from the same empty repo. */
function templateRepo(): string {
	if (template) return template;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bead-links-template-"));
	const home = path.join(dir, "home");
	fs.mkdirSync(home, { recursive: true });
	execFileSync("git", ["init", "-q", dir], { stdio: "pipe" });
	bd(dir, home, ["init", "--prefix", "fac", "--skip-agents", "--skip-hooks", "--non-interactive", "--quiet"]);
	template = dir;
	return dir;
}

function makeWorkspace(): Workspace {
	const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "bead-links-")));
	fs.cpSync(templateRepo(), dir, { recursive: true });
	// A lock the template's init left behind must not make the copy look busy.
	fs.rmSync(path.join(dir, ".beads", "embeddeddolt.gate.lock"), { force: true });
	const home = path.join(dir, "home");
	const agentDir = path.join(dir, "pi-agent");
	fs.mkdirSync(agentDir, { recursive: true });
	return {
		dir,
		home,
		agentDir,
		log: path.join(dir, "requests.jsonl"),
	};
}

/** A Bead the reply may name; a child id needs its parent first. */
const bead = (workspace: Workspace, id: string, type = "task"): void => {
	bd(workspace.dir, workspace.home, ["create", `Bead ${id}`, "--id", id, "--type", type, "--quiet"]);
};

/** What pi tells a markdown transformer about the message it is drawing. */
type MarkdownContext = {
	messageType: "user" | "assistant" | "assistant-thinking";
	isStreaming: boolean;
	availableWidth: number;
};

const assistant: MarkdownContext = { messageType: "assistant", isStreaming: false, availableWidth: 80 };
const fromTheUser: MarkdownContext = { messageType: "user", isStreaming: false, availableWidth: 80 };

/** The events and transformer pi receives from the extension, standing in for pi's API. */
type Seam = {
	fire: (event: string, cwd: string) => Promise<void>;
	transform: (markdown: string, context: MarkdownContext) => string;
};

/** The extension as pi loads it: the handlers it subscribes, and the transformer it registers. */
async function loadExtension(): Promise<Seam> {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	let transformer: ((markdown: string, context: MarkdownContext) => string) | undefined;
	const pi = {
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
			handlers.set(event, handler);
		},
		registerMarkdownTransformer(candidate: (markdown: string, context: MarkdownContext) => string): void {
			transformer = candidate;
		},
	};
	const loaded = (await import(extension)) as { default: (pi: unknown) => void };
	loaded.default(pi);
	assert.ok(transformer, "the extension registered a markdown transformer");
	return {
		fire: async (event, cwd) => {
			await handlers.get(event)?.({}, { cwd });
		},
		transform: transformer,
	};
}

/** An assistant reply as pi's renderer receives it, after the extension's transformer. */
async function renderReply(workspace: Workspace, markdown: string, context = assistant): Promise<string> {
	const seam = await loadExtension();
	await seam.fire("session_start", workspace.dir);
	return seam.transform(markdown, context);
}

type PiOutput = { status: number | null; stdout: string; stderr: string };

/** What a test changes about the session: the Bead its first request creates, and its environment. */
type RunOptions = { createOnFirstRequest?: string; environment?: Record<string, string> };

/**
 * A pi session in print mode with the extension, the test provider and the test's reply.
 * The environment has no board port unless the test gives one.
 */
function runPi(workspace: Workspace, prompts: string[], reply: string, options: RunOptions = {}): PiOutput {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.BEADS_BOARD_PORT;
	const result = spawnSync(
		"pi",
		[
			"-ns",
			"-ne",
			"-e",
			extension,
			"-e",
			testProvider,
			"--model",
			"bead-links-test/reply",
			"-p",
			...prompts,
		],
		{
			cwd: workspace.dir,
			encoding: "utf8",
			env: {
				...env,
				HOME: workspace.home,
				PI_CODING_AGENT_DIR: workspace.agentDir,
				PI_SKIP_VERSION_CHECK: "1",
				PI_OFFLINE: "1",
				PI_TELEMETRY: "0",
				BEAD_LINKS_TEST_REPLY: reply,
				BEAD_LINKS_TEST_CREATE: options.createOnFirstRequest ?? "",
				BEAD_LINKS_TEST_LOG: workspace.log,
				...options.environment,
			},
		},
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The board's URL for one Bead: the id, and the project as the session's repo path. */
const board = (id: string, repoPath: string, port = 3917): string =>
	`http://127.0.0.1:${port}/#/board?issue=${id}&workspace=${encodeURIComponent(repoPath)}`;

/** The markdown link pi's renderer draws as the id alone, clickable. */
const link = (id: string, repoPath: string, port = 3917): string => `[${id}](<${board(id, repoPath, port)}>)`;

test("a Bead id in an assistant reply becomes a markdown link to that Bead on the board, in the session's repo", async () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc", "epic");
		bead(workspace, "fac-abc.1");
		const rendered = await renderReply(workspace, "Bead fac-abc.1 is ready.");
		assert.equal(rendered, `Bead ${link("fac-abc.1", workspace.dir)} is ready.`);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("the board's port comes from BEADS_BOARD_PORT, and is 3917 without it", async () => {
	const workspace = makeWorkspace();
	const original = process.env.BEADS_BOARD_PORT;
	try {
		bead(workspace, "fac-abc");
		delete process.env.BEADS_BOARD_PORT;
		assert.equal(await renderReply(workspace, "Bead fac-abc is ready."), `Bead ${link("fac-abc", workspace.dir, 3917)} is ready.`);

		process.env.BEADS_BOARD_PORT = "4400";
		assert.equal(await renderReply(workspace, "Bead fac-abc is ready."), `Bead ${link("fac-abc", workspace.dir, 4400)} is ready.`);
	} finally {
		if (original === undefined) delete process.env.BEADS_BOARD_PORT;
		else process.env.BEADS_BOARD_PORT = original;
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("only ids that exist in the repo become links; code, existing links and the user's own words stay as they are", async () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc", "epic");
		bead(workspace, "fac-abc.1");
		const reply = [
			"Bead fac-abc.1 is ready.",
			"",
			"fac-abc.9, beads-ui and file-links are not Beads.",
			"",
			"`fac-abc.1` in a code span stays plain.",
			"",
			"```text",
			"fac-abc.1",
			"```",
			"",
			"[the Bead](http://127.0.0.1:3917/#/board?issue=fac-abc.1) stays a link.",
			"http://127.0.0.1:3917/#/board?issue=fac-abc.1 stays a URL.",
			"",
			"Bead fac-abc.1.",
		].join("\n");
		const linked = reply
			.replace(
				"Bead fac-abc.1 is ready.",
				`Bead ${link("fac-abc.1", workspace.dir)} is ready.`,
			)
			.replace("Bead fac-abc.1.", `Bead ${link("fac-abc.1", workspace.dir)}.`);
		assert.equal(await renderReply(workspace, reply), linked);
		assert.equal(await renderReply(workspace, reply, fromTheUser), reply, "the user's words are not linked");
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a Bead created during one turn becomes a link in the next turn's reply", async () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc", "epic");
		const seam = await loadExtension();
		await seam.fire("session_start", workspace.dir);
		bead(workspace, "fac-abc.2");
		await seam.fire("turn_end", workspace.dir);
		assert.equal(
			seam.transform("I made Bead fac-abc.2.", assistant),
			`I made Bead ${link("fac-abc.2", workspace.dir)}.`,
		);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("the model's context holds the reply as written, with no link in it", () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc");
		const reply = "Bead fac-abc is ready.";
		const run = runPi(workspace, ["what is next?", "and now?"], reply);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, `${reply}\n`, "the printed reply holds the id, not a link or an escape");
		const requests = fs
			.readFileSync(workspace.log, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { messages: string[] });
		assert.equal(requests.length, 2, "both prompts reached the model");
		assert.ok(
			requests[1].messages.includes(reply),
			`the second request carried the earlier reply as written: ${JSON.stringify(requests[1].messages)}`,
		);
		assert.ok(
			!requests[1].messages.some((text) => text.includes("](<") || text.includes("\x1b]8;")),
			"no link reached the model",
		);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});
