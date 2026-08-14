/**
 * @deepseek-ai/dsh-plugin-git-workflow — a DeepSeek Harness host plugin that
 * adds first-class Git workflow tools for the model.
 *
 * The harness ships no git tooling, so a model can only drive `git` through
 * bare `bash`/`pwsh` calls. This plugin registers structured, safe tools:
 *
 *  - `git_status` — branch, ahead/behind, staged / unstaged / untracked / conflicts
 *  - `git_diff`   — unstaged or staged diff (with optional --stat summary)
 *  - `git_log`    — recent commits (optionally with touched files)
 *  - `git_commit` — stage paths and create a commit from a validated message
 *  - `git_branch` — list local branches
 *
 * Every `git` invocation goes through `child_process.execFile("git", args)`
 * with an argument array — never through a shell — so no user input can be
 * interpreted as shell syntax. Paths are validated to stay inside the
 * repository, and commit messages are validated and passed with `-m`.
 *
 * Mount it in a profile patch or agent preset:
 *   - id: git-workflow
 *     name: dsh-plugin-git-workflow
 *
 * @module dsh-plugin-git-workflow
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import {
	clampLogCount,
	clampMaxLines,
	parseBranches,
	parseDiffStat,
	parseLog,
	parsePorcelainStatus,
	renderFailure,
	renderStatus,
	truncateLines,
	validateCommitMessage,
	validatePaths
} from "./git.js";

/** Stable Cordis plugin name. */
const name = "git-workflow";
/** Hard dependency: the tool registry. */
const inject = ["tools"];

const MAX_BUFFER = 8 * 1024 * 1024;
const runGit = promisify(execFile);

/** Resolve the tool workdir: explicit arg (relative to session cwd) or the session cwd. */
function resolveWorkdir(workdir, exec) {
	const headerCwd = exec?.agent?.session?.header?.cwd;
	const fallback = headerCwd ?? process.cwd();
	if (workdir === undefined) return fallback;
	return isAbsolute(workdir) ? workdir : resolve(fallback, workdir);
}

/**
 * Run `git` with an argument array and no shell. Resolves instead of throwing
 * so the tool can return a structured, model-readable failure.
 */
async function runGitTool(args, workdir, options = {}) {
	const { timeoutMs = 30000, input, signal } = options;
	try {
		const { stdout, stderr } = await runGit("git", args, {
			cwd: workdir,
			timeout: timeoutMs,
			maxBuffer: MAX_BUFFER,
			windowsHide: true,
			encoding: "utf8",
			input,
			signal
		});
		return { ok: true, stdout, stderr };
	} catch (error) {
		const code = error?.code !== undefined ? error.code : error?.exitCode ?? -1;
		return { ok: false, exitCode: typeof code === "number" ? code : null, message: String(error?.stderr || error?.message || "git failed").trim() };
	}
}

/** Shared schema helper: a string parameter. */
const strParam = (description) => ({ type: "string", description });

/** Shared schema helper: an array of repository-relative paths. */
const pathsParam = (description) => ({
	type: "array",
	items: { type: "string" },
	description
});

/**
 * Register the five git tools. All execution and validation logic lives in
 * pure functions (lib/git.js); this wrapper is a thin adapter over execFile.
 */
function apply(ctx) {
	const definitions = [
		{
			name: "git_status",
			description: "Inspect the git repository state in a working directory: current branch, upstream and ahead/behind counts, and the staged / unstaged / untracked / conflicted file lists. Returns structured, readable output instead of raw porcelain.",
			parameters: {
				type: "object",
				properties: {
					workdir: strParam("Repository directory. Defaults to the session working directory; relative paths resolve against it.")
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						state: {
							type: "object",
							additionalProperties: false,
							properties: {
								branch: { type: "string" },
								upstream: { type: "string" },
								ahead: { type: "number" },
								behind: { type: "number" },
								staged: { type: "array", items: { type: "object" } },
								unstaged: { type: "array", items: { type: "object" } },
								untracked: { type: "array", items: { type: "object" } },
								conflicts: { type: "array", items: { type: "object" } }
							}
						},
						exitCode: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (args, value) => [{ type: "text", text: value.ok ? renderStatus(value.state) : renderFailure(value, "git_status") }]
			},
			timeoutMs: 30000,
			async execute(args, exec) {
				const result = await runGitTool(["status", "--porcelain", "-b"], resolveWorkdir(args?.workdir, exec));
				if (!result.ok) return { ok: false, exitCode: result.exitCode, message: result.message };
				return { ok: true, state: parsePorcelainStatus(result.stdout) };
			}
		},
		{
			name: "git_diff",
			description: "Show the working-tree diff (unstaged by default) or the staged diff (--cached) of a git repository, with an optional --stat summary. Use paths to narrow the diff to specific files.",
			parameters: {
				type: "object",
				properties: {
					workdir: strParam("Repository directory. Defaults to the session working directory."),
					staged: { type: "boolean", description: "Show the staged (index) diff instead of the unstaged working-tree diff. Default false." },
					stat: { type: "boolean", description: "Only show a --stat summary (files changed, insertions, deletions). Default false." },
					paths: pathsParam("Optional repository-relative paths to narrow the diff."),
					maxLines: { type: "number", description: "Maximum diff lines to return (default 500, clamped to 10..2000)." }
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						output: { type: "string" },
						truncated: { type: "boolean" },
						stat: {
							type: "object",
							additionalProperties: false,
							properties: {
								files: { type: "number" },
								insertions: { type: "number" },
								deletions: { type: "number" }
							}
						},
						exitCode: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (args, value) => [{ type: "text", text: value.ok ? value.output : renderFailure(value, "git_diff") }]
			},
			timeoutMs: 30000,
			async execute(args, exec) {
				const pathsError = validatePaths(args?.paths);
				if (pathsError) return { ok: false, exitCode: null, message: pathsError };
				const gitArgs = ["diff", "--no-color"];
				if (args?.staged === true) gitArgs.push("--cached");
				if (args?.stat === true) gitArgs.push("--stat");
				if (args?.paths !== undefined && args?.paths !== null) gitArgs.push("--", ...args.paths);
				const result = await runGitTool(gitArgs, resolveWorkdir(args?.workdir, exec));
				if (!result.ok) return { ok: false, exitCode: result.exitCode, message: result.message };
				const { text, truncated } = truncateLines(result.stdout, clampMaxLines(args?.maxLines));
				return {
					ok: true,
					output: text,
					truncated,
					stat: args?.stat === true ? parseDiffStat(result.stdout) : undefined
				};
			}
		},
		{
			name: "git_log",
			description: "Show recent commit history of a git repository: hash, short date, and subject per commit, optionally with the files each commit touched. Useful for understanding what changed recently.",
			parameters: {
				type: "object",
				properties: {
					workdir: strParam("Repository directory. Defaults to the session working directory."),
					count: { type: "number", description: "Number of commits to show (default 10, clamped to 1..50)." },
					files: { type: "boolean", description: "Also list the files each commit touched (--name-status). Default false." },
					paths: pathsParam("Optional repository-relative paths to narrow the history.")
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						commits: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									hash: { type: "string" },
									date: { type: "string" },
									subject: { type: "string" },
									files: { type: "array", items: { type: "string" } }
								}
							}
						},
						exitCode: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (args, value) => {
					if (!value.ok) return [{ type: "text", text: renderFailure(value, "git_log") }];
					const lines = value.commits.map((c) => {
						const head = `${c.hash}  ${c.date}  ${c.subject}`;
						return c.files && c.files.length > 0 ? `${head}\n${c.files.map((f) => `      ${f}`).join("\n")}` : head;
					});
					return [{ type: "text", text: lines.join("\n") }];
				}
			},
			timeoutMs: 30000,
			async execute(args, exec) {
				const pathsError = validatePaths(args?.paths);
				if (pathsError) return { ok: false, exitCode: null, message: pathsError };
				const count = clampLogCount(args?.count);
				const gitArgs = ["log", `-n ${count}`, "--date=short", "--pretty=tformat:%h%x09%ad%x09%s"];
				if (args?.files === true) gitArgs.push("--name-status");
				if (args?.paths !== undefined && args?.paths !== null) gitArgs.push("--", ...args.paths);
				const result = await runGitTool(gitArgs, resolveWorkdir(args?.workdir, exec));
				if (!result.ok) return { ok: false, exitCode: result.exitCode, message: result.message };
				return { ok: true, commits: parseLog(result.stdout, args?.files === true) };
			}
		},
		{
			name: "git_commit",
			description: "Create a git commit: optionally stage the given repository-relative paths first, then commit with the given message. The message is validated (non-empty, max 2000 chars, no NUL) and passed to git with -m so it can never be interpreted as shell syntax. Fails clearly when there is nothing to commit.",
			parameters: {
				type: "object",
				properties: {
					workdir: strParam("Repository directory. Defaults to the session working directory."),
					message: { type: "string", description: "Commit message (required, max 2000 characters, may contain newlines for a subject + body)." },
					paths: pathsParam("Optional repository-relative paths to stage before committing. Omit to commit whatever is already staged."),
					allowEmpty: { type: "boolean", description: "Allow an empty commit (--allow-empty). Default false." }
				},
				required: ["message"]
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						shortHash: { type: "string" },
						message: { type: "string" },
						exitCode: { type: "number" }
					}
				},
				render: (args, value) => {
					if (!value.ok) return [{ type: "text", text: renderFailure(value, "git_commit") }];
					return [{ type: "text", text: `committed ${value.shortHash}: ${value.message}` }];
				}
			},
			timeoutMs: 60000,
			async execute(args, exec) {
				const messageError = validateCommitMessage(args?.message);
				if (messageError) return { ok: false, exitCode: null, message: messageError };
				const pathsError = validatePaths(args?.paths);
				if (pathsError) return { ok: false, exitCode: null, message: pathsError };
				const workdir = resolveWorkdir(args?.workdir, exec);
				if (args?.paths !== undefined && args?.paths !== null && args.paths.length > 0) {
					const addResult = await runGitTool(["add", "--", ...args.paths], workdir);
					if (!addResult.ok) return { ok: false, exitCode: addResult.exitCode, message: `git add failed: ${addResult.message}` };
				}
				const commitArgs = ["commit", "-m", args.message];
				if (args?.allowEmpty === true) commitArgs.push("--allow-empty");
				const commitResult = await runGitTool(commitArgs, workdir);
				if (!commitResult.ok) {
					const hint = /nothing to commit|no changes added|nothing added to commit/.test(commitResult.message)
						? " — stage paths with the `paths` argument (or pass allowEmpty: true for an empty commit)"
						: "";
					return { ok: false, exitCode: commitResult.exitCode, message: commitResult.message + hint };
				}
				const hashResult = await runGitTool(["rev-parse", "--short", "HEAD"], workdir);
				return {
					ok: true,
					shortHash: hashResult.ok ? hashResult.stdout.trim() : "?",
					message: args.message
				};
			}
		},
		{
			name: "git_branch",
			description: "List local git branches with a marker on the current branch. Useful before switching work or opening a pull request.",
			parameters: {
				type: "object",
				properties: {
					workdir: strParam("Repository directory. Defaults to the session working directory.")
				}
			},
			output: {
				schema: {
					type: "object",
					additionalProperties: false,
					properties: {
						ok: { type: "boolean" },
						branches: {
							type: "array",
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									current: { type: "boolean" },
									name: { type: "string" }
								}
							}
						},
						exitCode: { type: "number" },
						message: { type: "string" }
					}
				},
				render: (args, value) => {
					if (!value.ok) return [{ type: "text", text: renderFailure(value, "git_branch") }];
					return [{ type: "text", text: value.branches.map((b) => `${b.current ? "*" : " "} ${b.name}`).join("\n") }];
				}
			},
			timeoutMs: 30000,
			async execute(args, exec) {
				const result = await runGitTool(["branch", "--format=%(HEAD)%(refname:short)"], resolveWorkdir(args?.workdir, exec));
				if (!result.ok) return { ok: false, exitCode: result.exitCode, message: result.message };
				return { ok: true, branches: parseBranches(result.stdout).branches };
			}
		}
	];
	for (const definition of definitions) {
		ctx.effect(() => ctx.tools.register(definition), `git-workflow: ${definition.name}`);
	}
}

export { apply, inject, name };
