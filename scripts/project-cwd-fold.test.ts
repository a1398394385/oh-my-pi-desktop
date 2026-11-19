// Regression: one directory registered through a symlink and through its real
// path rendered as two same-named project rows (the MCP scope list labels a
// project by path.basename, so both read "/…/etower-agent"). The list folds on
// read, so an existing omp-desktop.json with both spellings converges to one.
import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { H } from "../host/state.ts";
import { readDesktopProjects } from "../host/profile.ts";

test("symlink and real spelling fold into one project entry", () => {
	const real = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-cwdfold-")));
	const repo = path.join(real, "repo");
	fs.mkdirSync(repo);
	const link = path.join(real, "link");
	fs.symlinkSync(repo, link);
	H.desktopProjectsPath = path.join(real, "omp-desktop.json");
	fs.writeFileSync(
		H.desktopProjectsPath,
		JSON.stringify({ allProjects: [link, repo, repo], removedProjects: [link] }),
	);
	const projects = readDesktopProjects();
	expect(projects.allProjects).toEqual([repo]);
	// A removal recorded under either spelling must still target the folded entry
	expect(projects.removedProjects).toEqual([repo]);
});
