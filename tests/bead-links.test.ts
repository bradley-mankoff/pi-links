/**
 * A Bead id in a reply becomes a link to that Bead on the board, naming its project
 * (GLOSSARY.md, fac-qpv.7.1). These tests drive the seam the Epic's Testing Decisions
 * name: a pi session in print mode with the bead-links extension, a temporary Beads repo,
 * and a provider at the edge that answers with the reply the test gives it.
 *
 * The board is at 127.0.0.1, its port from BEADS_BOARD_PORT or 3917, and its workspace is
 * the session's repo path, so a link opens the Bead in the right project.
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

/** The OSC 8 sequence a terminal shows as a clickable link. */
const link = (text: string, url: string): string => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;

test("a Bead id in a reply becomes a link to that Bead on the board, in the session's repo", () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc", "epic");
		bead(workspace, "fac-abc.1");
		const run = runPi(workspace, ["what is next?"], "Bead fac-abc.1 is ready.");
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, `Bead ${link("fac-abc.1", board("fac-abc.1", workspace.dir))} is ready.\n`);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("the board's port comes from BEADS_BOARD_PORT, and is 3917 without it", () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc");
		const reply = "Bead fac-abc is ready.";
		const withoutPort = runPi(workspace, ["what is next?"], reply);
		assert.equal(withoutPort.status, 0, withoutPort.stderr);
		assert.equal(withoutPort.stdout, `Bead ${link("fac-abc", board("fac-abc", workspace.dir, 3917))} is ready.\n`);

		const withPort = runPi(workspace, ["what is next?"], reply, { environment: { BEADS_BOARD_PORT: "4400" } });
		assert.equal(withPort.status, 0, withPort.stderr);
		assert.equal(withPort.stdout, `Bead ${link("fac-abc", board("fac-abc", workspace.dir, 4400))} is ready.\n`);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("only ids that exist in the repo become links; code and existing links stay as they are", () => {
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
		].join("\n");
		const run = runPi(workspace, ["what is next?"], reply);
		assert.equal(run.status, 0, run.stderr);
		const linked = reply.replace(
			"Bead fac-abc.1 is ready.",
			`Bead ${link("fac-abc.1", board("fac-abc.1", workspace.dir))} is ready.`,
		);
		assert.equal(run.stdout, `${linked}\n`);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("a Bead created during one turn becomes a link in the next turn's reply", () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc", "epic");
		const run = runPi(workspace, ["make a Bead", "what did you make?"], "I made Bead fac-abc.2.", {
			createOnFirstRequest: "fac-abc.2",
		});
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, `I made Bead ${link("fac-abc.2", board("fac-abc.2", workspace.dir))}.\n`);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});

test("the model reads its own earlier replies as plain ids, without the terminal's escapes", () => {
	const workspace = makeWorkspace();
	try {
		bead(workspace, "fac-abc");
		const reply = "Bead fac-abc is ready.";
		const run = runPi(workspace, ["what is next?", "and now?"], reply);
		assert.equal(run.status, 0, run.stderr);
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
			!requests[1].messages.some((text) => text.includes("\x1b]8;")),
			"no terminal escape reached the model",
		);
	} finally {
		fs.rmSync(workspace.dir, { recursive: true, force: true });
	}
});
