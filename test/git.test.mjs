import { test } from "node:test";
import assert from "node:assert/strict";
import {
	MAX_MESSAGE_LENGTH,
	clampLogCount,
	clampMaxLines,
	parseBranches,
	parseDiffStat,
	parseEntry,
	parseLog,
	parsePorcelainStatus,
	renderStatus,
	truncateLines,
	validateCommitMessage,
	validatePaths
} from "../lib/git.js";

test("validateCommitMessage accepts a normal message", () => {
	assert.equal(validateCommitMessage("fix: resolve the widget glitch"), null);
	assert.equal(validateCommitMessage("feat: subject\n\nbody line"), null);
});

test("validateCommitMessage rejects empty, oversized, and NUL messages", () => {
	assert.match(validateCommitMessage(""), /non-empty/);
	assert.match(validateCommitMessage("   \n"), /non-empty/);
	assert.match(validateCommitMessage("x".repeat(MAX_MESSAGE_LENGTH + 1)), /too long/);
	assert.match(validateCommitMessage("a\0b"), /NUL/);
});

test("validatePaths accepts relative paths and rejects traversal", () => {
	assert.equal(validatePaths(undefined), null);
	assert.equal(validatePaths(["src/a.js", "docs/read me.md"]), null);
	assert.match(validatePaths(["../escape"]), /inside the repository/);
	assert.match(validatePaths(["a/../../escape"]), /inside the repository/);
	assert.match(validatePaths(["C:/windows/evil"]), /inside the repository/);
	assert.match(validatePaths(["/etc/passwd"]), /inside the repository/);
	assert.match(validatePaths([]), /must not be empty/);
	assert.match(validatePaths(["ok", "..\\up"]), /inside the repository/);
});

test("parsePorcelainStatus parses branch header with ahead/behind", () => {
	const state = parsePorcelainStatus("## main...origin/main [ahead 2, behind 1]");
	assert.equal(state.branch, "main");
	assert.equal(state.upstream, "origin/main");
	assert.equal(state.ahead, 2);
	assert.equal(state.behind, 1);
	assert.equal(state.staged.length, 0);
});

test("parsePorcelainStatus parses staged, unstaged, untracked, conflicts, renames", () => {
	const output = [
		"## feature...origin/feature [ahead 1]",
		"M  lib/git.js",
		" M src/index.js",
		"MM both.js",
		"R  old.js -> new.js",
		"?? notes.md",
		"UU conflicted.txt"
	].join("\n");
	const state = parsePorcelainStatus(output);
	assert.equal(state.branch, "feature");
	assert.equal(state.ahead, 1);
	assert.equal(state.behind, 0);
	assert.deepEqual(state.staged.map((e) => e.status), ["M", "M", "R"]);
	assert.deepEqual(state.unstaged.map((e) => e.status), ["M", "M"]);
	assert.deepEqual(state.untracked.map((e) => e.path), ["notes.md"]);
	assert.deepEqual(state.conflicts.map((e) => e.path), ["conflicted.txt"]);
	const rename = state.staged.find((e) => e.status === "R");
	assert.equal(rename.path, "new.js");
	assert.equal(rename.from, "old.js");
});

test("parseEntry splits rename arrows and keeps plain paths", () => {
	assert.deepEqual(parseEntry("a/b/c.txt"), { path: "a/b/c.txt" });
	assert.deepEqual(parseEntry("old -> new"), { path: "new", from: "old" });
});

test("parseDiffStat parses insertions and deletions", () => {
	assert.deepEqual(parseDiffStat(" 3 files changed, 12 insertions(+), 4 deletions(-)"), {
		files: 3,
		insertions: 12,
		deletions: 4
	});
	assert.deepEqual(parseDiffStat(" 1 file changed, 5 insertions(+)"), { files: 1, insertions: 5, deletions: null });
	assert.deepEqual(parseDiffStat("nothing here"), { files: null, insertions: null, deletions: null });
});

test("parseLog parses commits and optional name-status files", () => {
	const output = [
		"abc1234\t2026-08-14\tfix: widget glitch",
		"",
		"M\tlib/git.js",
		"A\ttest/git.test.mjs",
		"def5678\t2026-08-13\tfeat: add status tool",
		""
	].join("\n");
	const commits = parseLog(output, true);
	assert.equal(commits.length, 2);
	assert.equal(commits[0].hash, "abc1234");
	assert.equal(commits[0].subject, "fix: widget glitch");
	assert.deepEqual(commits[0].files, ["lib/git.js", "test/git.test.mjs"]);
	assert.equal(commits[1].files.length, 0);
});

test("parseBranches marks the current branch", () => {
	const { branches } = parseBranches("* main\n  feature/x");
	assert.deepEqual(branches, [
		{ current: true, name: "main" },
		{ current: false, name: "feature/x" }
	]);
});

test("clampLogCount and clampMaxLines respect bounds", () => {
	assert.equal(clampLogCount(undefined), 10);
	assert.equal(clampLogCount(3), 3);
	assert.equal(clampLogCount(0), 1);
	assert.equal(clampLogCount(999), 50);
	assert.equal(clampMaxLines(undefined), 500);
	assert.equal(clampMaxLines(5), 10);
	assert.equal(clampMaxLines(99999), 2000);
});

test("truncateLines marks truncation and keeps the tail marker", () => {
	const text = Array.from({ length: 5 }, (_, i) => `line ${i}`).join("\n");
	const { text: out, truncated } = truncateLines(text, 3);
	assert.equal(truncated, true);
	assert.match(out, /… \(truncated 2 lines\)/);
	assert.equal(truncateLines(text, 10).truncated, false);
});

test("renderStatus covers empty and populated states", () => {
	const empty = renderStatus({ branch: "main", upstream: "origin/main", ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflicts: [] });
	assert.match(empty, /branch: main \(upstream origin\/main\)/);
	assert.match(empty, /staged \(0\): none/);
	const populated = renderStatus({
		branch: "main",
		upstream: null,
		ahead: 1,
		behind: 2,
		staged: [{ status: "M", path: "a.js" }],
		unstaged: [],
		untracked: [{ path: "b.md" }],
		conflicts: [{ path: "c.txt" }]
	});
	assert.match(populated, /ahead 1, behind 2/);
	assert.match(populated, /M  a\.js/);
	assert.match(populated, /\?\?  b\.md/);
	assert.match(populated, /UU  c\.txt/);
});
