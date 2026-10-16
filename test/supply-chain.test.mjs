import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = join(import.meta.dirname, "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const pkg = JSON.parse(read("package.json"));

test("the package runs no code at install time and ships nothing but its sources", () => {
	const lifecycle = [
		"preinstall",
		"install",
		"postinstall",
		"prepare",
		"prepublish",
		"prepublishOnly",
		"prepack",
		"postpack",
	];
	assert.deepEqual(
		lifecycle.filter((name) => pkg.scripts?.[name] !== undefined),
		[],
	);
	assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
	assert.equal(pkg.bin, undefined, "no executables");
	assert.deepEqual(pkg.files, ["src", "README.md", "LICENSE"]);
});

test("packages the host provides are peers with the any-version range, and never runtime dependencies", () => {
	// The Pi package guide: the host supplies these, so they are declared with "*" and not bundled.
	const hostProvided = [
		"@earendil-works/pi-ai",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-tui",
		"typebox",
	];
	const peers = pkg.peerDependencies ?? {};
	for (const name of hostProvided) {
		if (name in peers) assert.equal(peers[name], "*", `${name} is a peer and must accept any host version`);
		assert.equal(pkg.dependencies?.[name], undefined, `${name} must not be a runtime dependency`);
	}
	assert.ok("@earendil-works/pi-coding-agent" in peers, "the extension API comes from the host");
});

test("dependency build scripts have a single policy: deny", () => {
	const workspace = read("pnpm-workspace.yaml");
	assert.doesNotMatch(workspace, /^onlyBuiltDependencies:/m, "the legacy allow list contradicted allowBuilds");
	assert.doesNotMatch(workspace, /^\s+"?[@\w/.-]+"?:\s*true\s*$/m, "nothing is allowed to build");
	for (const name of ["@google/genai", "esbuild", "protobufjs"]) {
		const escaped = name.replace(/[/@.]/g, "\\$&");
		assert.match(workspace, new RegExp(`^\\s+"?${escaped}"?:\\s*false\\s*$`, "m"), `${name} is denied`);
	}
});

test("the source reaches for no files, network, processes, environment or dynamic code", () => {
	const dir = join(root, "src");
	const forbidden =
		/child_process|node:(fs|net|http|https|dns|os|vm|worker_threads)|\beval\(|new Function\(|process\.env|\bfetch\(|\bimport\(|require\(/;
	for (const file of readdirSync(dir)) {
		assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), forbidden, `src/${file}`);
	}
});
