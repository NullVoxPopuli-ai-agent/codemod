#!/usr/bin/env node
import { a as findTemplateFiles, i as findEmberCliBuildFile, n as transform, o as readImportAliases, r as removeSvgJarConfig, s as readSourceDirs } from "./codemod-OUTVW-SN.mjs";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import path, { basename } from "node:path";
import pc from "picocolors";
import { cancel, confirm, intro, isCancel, log, outro, spinner, text } from "@clack/prompts";
import { Command } from "commander";
//#region src/cli/resolve-config.ts
const TEMPLATE_EXTENSIONS = new Set([".gjs", ".gts"]);
/**
* Infers the Ember project root from a path by walking up the directory tree
* to find the parent of an `app/` segment.
*
* @example inferProjectRoot('/project/app/components/navbar.gjs') → '/project'
* @example inferProjectRoot('/project/app/components') → '/project'
* @returns The inferred project root, or `undefined` if no `app/` segment is found.
*/
function inferProjectRoot(absPath) {
	const segments = path.normalize(absPath).split(path.sep);
	for (let i = segments.length - 1; i >= 0; i--) if (segments[i] === "app") return segments.slice(0, i).join(path.sep) || path.sep;
}
/**
* Resolves CLI configuration from flags and defaults.
*
* Handles three cases for the path argument:
*
* 1. **No path or project root directory** — `projectRoot` is the directory,
*    all template files are discovered.
* 2. **Single file** (`.gjs`/`.gts`) — `projectRoot` is inferred from the
*    `app/` segment in the path. `files` is set to the single file.
* 3. **Subdirectory** (e.g. `app/components/`) — `projectRoot` is inferred,
*    `targetDir` is set to scope file discovery.
*
* When the project root is inferred (cases 2 and 3), `inferredProjectRoot`
* is set so that `runCodemod` can prompt the user to confirm or correct it.
*
* @param flags Raw flags from commander.
* @param cwd   The current working directory (injected for testability).
*/
function resolveConfig(flags, cwd = process.cwd()) {
	const resolvedPath = path.resolve(cwd, flags.path ?? ".");
	const pathType = getPathType(resolvedPath);
	const cleanConfig = flags.cleanConfig ?? false;
	if (pathType === "directory" && !flags.path) return {
		projectRoot: resolvedPath,
		dryRun: flags.dryRun,
		confirm: flags.confirm ?? false,
		cleanConfig
	};
	if (pathType === "file") {
		const inferred = inferProjectRoot(resolvedPath);
		const projectRoot = inferred ?? path.dirname(resolvedPath);
		return {
			projectRoot,
			dryRun: flags.dryRun,
			confirm: flags.confirm ?? false,
			files: [path.relative(projectRoot, resolvedPath)],
			inferredProjectRoot: inferred,
			cleanConfig
		};
	}
	const inferred = inferProjectRoot(resolvedPath);
	if (inferred && inferred !== resolvedPath) return {
		projectRoot: inferred,
		dryRun: flags.dryRun,
		confirm: flags.confirm ?? false,
		targetDir: path.relative(inferred, resolvedPath),
		inferredProjectRoot: inferred,
		cleanConfig
	};
	return {
		projectRoot: resolvedPath,
		dryRun: flags.dryRun,
		confirm: flags.confirm ?? false,
		cleanConfig
	};
}
/**
* Determines whether a path is a file, directory, or doesn't exist.
* Falls back to checking the extension for paths that don't exist yet.
*/
function getPathType(p) {
	try {
		return statSync(p).isFile() ? "file" : "directory";
	} catch {
		return TEMPLATE_EXTENSIONS.has(path.extname(p)) ? "file" : "directory";
	}
}
//#endregion
//#region src/cli/format-report.ts
/**
* Formats the results of the codemod run into an ESLint-style report string.
*
* Each file with diagnostics (unresolved or ambiguous icons) gets a section
* with the file path as a header and indented messages beneath it.
*
* Files with no issues are not shown. A summary line at the end shows totals.
*
* @example
*   app/components/banner.gts
*     5:2  warning  "missing-icon" not found in any source directory        unresolved
*     8:2  warning  "arrow" found in multiple source directories            ambiguous
*                   - public/icons/arrow.svg
*                   - vendor/icons/arrow.svg
*
*   2 warnings
*/
function formatReport(results, useColor = true) {
	const c = useColor ? pc : noColor;
	const lines = [];
	let totalUnresolved = 0;
	let totalAmbiguous = 0;
	let filesChanged = 0;
	for (const { filePath, changed, result } of results) {
		if (changed) filesChanged++;
		if (!(result.unresolvedIcons.length > 0 || result.ambiguousIcons.length > 0)) continue;
		lines.push("");
		lines.push(c.underline(filePath));
		for (const icon of result.unresolvedIcons) {
			totalUnresolved++;
			const loc = formatLoc(icon.location, filePath);
			lines.push(`  ${c.dim(loc)}  ${c.yellow("warning")}  ${c.bold(`"${icon.slug}"`)} not found in any source directory`);
		}
		for (const icon of result.ambiguousIcons) {
			totalAmbiguous++;
			const loc = formatLoc(icon.location, filePath);
			lines.push(`  ${c.dim(loc)}  ${c.yellow("warning")}  ${c.bold(`"${icon.slug}"`)} found in multiple source directories`);
			for (const p of icon.paths) lines.push(`  ${c.dim(" ".repeat(loc.length))}           - ${p}`);
		}
	}
	const totalWarnings = totalUnresolved + totalAmbiguous;
	lines.push("");
	if (totalWarnings > 0) {
		const parts = [];
		if (totalUnresolved > 0) parts.push(`${totalUnresolved} unresolved`);
		if (totalAmbiguous > 0) parts.push(`${totalAmbiguous} ambiguous`);
		lines.push(c.yellow(`${totalWarnings} ${totalWarnings === 1 ? "warning" : "warnings"} (${parts.join(", ")})`));
	}
	lines.push(`${filesChanged} ${filesChanged === 1 ? "file" : "files"} changed out of ${results.length} scanned`);
	return lines.join("\n");
}
/**
* Extracts just the line:column portion from a location string.
* Locations are stored as "filePath:line", so we strip the filePath prefix.
*/
function formatLoc(location, filePath) {
	if (location.startsWith(filePath + ":")) return location.slice(filePath.length + 1);
	return location;
}
/** No-op color functions for non-color output. */
const noColor = {
	underline: (s) => s,
	dim: (s) => s,
	yellow: (s) => s,
	bold: (s) => s
};
//#endregion
//#region src/cli/banners.ts
const defaultBanner = "@svg-jar/codemod - Leave ember-svg-jar behind!";
const gradientBanner = "\x1B[38;2;224;78;57m@\x1B[39m\x1B[38;2;224;80;56ms\x1B[39m\x1B[38;2;224;83;56mv\x1B[39m\x1B[38;2;225;85;55mg\x1B[39m\x1B[38;2;225;87;55m-\x1B[39m\x1B[38;2;225;90;54mj\x1B[39m\x1B[38;2;225;92;54ma\x1B[39m\x1B[38;2;226;95;53mr\x1B[39m\x1B[38;2;226;97;52m/\x1B[39m\x1B[38;2;226;100;52mc\x1B[39m\x1B[38;2;226;102;51mo\x1B[39m\x1B[38;2;226;105;51md\x1B[39m\x1B[38;2;227;107;50me\x1B[39m\x1B[38;2;227;110;50mm\x1B[39m\x1B[38;2;227;112;49mo\x1B[39m\x1B[38;2;227;115;48md\x1B[39m \x1B[38;2;228;118;48m-\x1B[39m \x1B[38;2;228;120;47mL\x1B[39m\x1B[38;2;228;123;47me\x1B[39m\x1B[38;2;228;126;46ma\x1B[39m\x1B[38;2;228;129;46mv\x1B[39m\x1B[38;2;229;131;45me\x1B[39m \x1B[38;2;229;134;44me\x1B[39m\x1B[38;2;229;137;44mm\x1B[39m\x1B[38;2;229;140;43mb\x1B[39m\x1B[38;2;229;143;43me\x1B[39m\x1B[38;2;230;146;42mr\x1B[39m\x1B[38;2;230;149;41m-\x1B[39m\x1B[38;2;230;152;41ms\x1B[39m\x1B[38;2;230;155;40mv\x1B[39m\x1B[38;2;231;158;40mg\x1B[39m\x1B[38;2;231;161;39m-\x1B[39m\x1B[38;2;231;164;38mj\x1B[39m\x1B[38;2;231;167;38ma\x1B[39m\x1B[38;2;231;170;37mr\x1B[39m \x1B[38;2;232;173;37mb\x1B[39m\x1B[38;2;232;177;36me\x1B[39m\x1B[38;2;232;180;35mh\x1B[39m\x1B[38;2;232;183;35mi\x1B[39m\x1B[38;2;233;186;34mn\x1B[39m\x1B[38;2;233;190;34md\x1B[39m\x1B[38;2;233;193;33m!\x1B[39m";
//#endregion
//#region src/cli/run-codemod.ts
function showIntro(isInteractive, hasColors) {
	console.log("");
	intro(isInteractive && hasColors ? pc.bold(gradientBanner) : defaultBanner);
	log.message([
		"This codemod migrates your Ember project from ember-svg-jar to",
		"direct SVG component imports. It will:",
		"",
		`  1. Find all ${pc.cyan("{{svgJar \"...\"}}")} calls in your templates`,
		`  2. Locate each icon SVG file in your source directories`,
		`  3. Replace mustache calls with ${pc.cyan("<Component />")} invocations`,
		`  4. Add the corresponding ${pc.cyan("import")} statements`
	]);
}
async function resolveProjectRoot(config, isInteractive) {
	if (!config.inferredProjectRoot || !isInteractive) return config.projectRoot;
	const answer = await text({
		message: "Project root:",
		initialValue: config.inferredProjectRoot
	});
	if (isCancel(answer)) {
		cancel("Cancelled.");
		process.exit(0);
	}
	return path.resolve(answer);
}
async function resolveDryRun(config, isInteractive) {
	if (config.dryRun !== void 0) return config.dryRun;
	if (isInteractive) {
		const answer = await confirm({
			message: "Dry run? (no file changes)",
			initialValue: false
		});
		if (isCancel(answer)) {
			cancel("Cancelled.");
			process.exit(0);
		}
		return answer;
	}
	return false;
}
function readProjectConfig(projectRoot) {
	log.step("Reading project configuration...");
	const sourceDirs = readSourceDirs(projectRoot);
	const importAliases = readImportAliases(projectRoot);
	log.info(`Source directories: ${sourceDirs.join(", ")}`);
	if (importAliases.length > 0) log.info(`Import aliases: ${importAliases.map((a) => a.alias).join(", ")}`);
	return {
		sourceDirs,
		importAliases
	};
}
function discoverTemplateFiles(config, projectRoot) {
	log.step("Discovering template files...");
	let templateFiles;
	if (config.files) {
		templateFiles = config.files;
		log.info(`Processing ${templateFiles.length} specified ${templateFiles.length === 1 ? "file" : "files"}.`);
	} else {
		templateFiles = findTemplateFiles(projectRoot, config.targetDir);
		if (config.targetDir) log.info(`Found ${templateFiles.length} ${templateFiles.length === 1 ? "file" : "files"} under ${config.targetDir}.`);
		else log.info(`Found ${templateFiles.length} ${templateFiles.length === 1 ? "file" : "files"} to process.`);
	}
	if (templateFiles.length === 0) {
		log.warn("No .gjs or .gts files found.");
		outro("Nothing to do.");
		return null;
	}
	return templateFiles;
}
async function transformFiles(templateFiles, projectRoot, transformOptions, config, dryRun) {
	log.step("Transforming files...");
	const results = [];
	const s = spinner();
	for (const filePath of templateFiles) {
		s.start(pc.dim(filePath));
		const absolutePath = path.join(projectRoot, filePath);
		const source = readFileSync(absolutePath, "utf-8");
		const result = transform(source, filePath, transformOptions);
		const changed = result.output !== source;
		if (changed) {
			if (!dryRun) writeFileSync(absolutePath, result.output, "utf-8");
			s.stop(`${pc.bold(filePath)} — ${dryRun ? pc.yellow("would change (dry run)") : pc.green("changed")}`);
		} else s.stop(`${pc.bold(filePath)} — ${pc.dim("no changes")}`);
		if (config.confirm) {
			const answer = await confirm({
				message: "Continue to next file?",
				initialValue: true
			});
			if (isCancel(answer) || !answer) {
				cancel("Stopped.");
				process.exit(0);
			}
		}
		results.push({
			filePath,
			changed,
			result
		});
	}
	return results;
}
function showOutro(results, dryRun, hasColors) {
	const changedCount = results.filter((r) => r.changed).length;
	if (dryRun && changedCount > 0) outro(`Dry run complete. ${changedCount} ${changedCount === 1 ? "file" : "files"} would be changed.`);
	else outro("Done!");
	const report = formatReport(results, hasColors);
	if (report.trim()) console.log(report);
}
async function maybeCleanConfig({ config, results, projectRoot, dryRun, isInteractive }) {
	if (!config.cleanConfig || config.files || config.targetDir) return;
	if (results.some((r) => r.result.unresolvedIcons.length > 0)) {
		log.warn("svgJar config was not removed from ember-cli-build.js — some icons could not be resolved.\nResolve them first, then re-run with --clean-config.");
		return;
	}
	const buildFile = findEmberCliBuildFile(projectRoot);
	if (!buildFile) {
		log.warn("Could not find ember-cli-build.js — skipping config removal.");
		return;
	}
	const buildFileName = basename(buildFile);
	if (dryRun) {
		log.info(`Would remove svgJar config from ${buildFileName} (dry run).`);
		return;
	}
	if (isInteractive) {
		const answer = await confirm({
			message: `Remove svgJar config from ${buildFileName}?`,
			initialValue: true
		});
		if (isCancel(answer)) {
			cancel("Cancelled.");
			process.exit(0);
		}
		if (!answer) return;
	}
	writeFileSync(buildFile, removeSvgJarConfig(readFileSync(buildFile, "utf-8")), "utf-8");
	log.success(`Removed svgJar config from ${buildFileName}.`);
}
/**
* Main CLI orchestrator. Discovers files, transforms them, and prints a report.
*
* This function is the testable core of the CLI — it receives a fully resolved
* config and does not parse command-line arguments itself.
*/
async function runCodemod(config) {
	const hasColors = process.stdout.hasColors?.(8) ?? false;
	const isInteractive = process.stdout.isTTY === true && process.stdin.isTTY === true;
	showIntro(isInteractive, hasColors);
	const projectRoot = await resolveProjectRoot(config, isInteractive);
	const dryRun = await resolveDryRun(config, isInteractive);
	if (dryRun) log.info("Dry run mode — no files will be written.");
	const { sourceDirs, importAliases } = readProjectConfig(projectRoot);
	const templateFiles = discoverTemplateFiles(config, projectRoot);
	if (!templateFiles) return [];
	const results = await transformFiles(templateFiles, projectRoot, {
		projectRoot,
		sourceDirs,
		importAliases
	}, config, dryRun);
	await maybeCleanConfig({
		config,
		results,
		projectRoot,
		dryRun,
		isInteractive
	});
	showOutro(results, dryRun, hasColors);
	return results;
}
//#endregion
//#region package.json
var name = "@svg-jar/codemod";
var version = "0.0.1";
var description = "A codemod to help users migrate away from ember-svg-jar";
//#endregion
//#region src/cli.ts
async function main() {
	const program = new Command();
	program.name(name).version(version).description(description).argument("[path]", "Path to the project root (defaults to current directory)").option("-d, --dry-run", "Run the codemod without writing changes to disk").option("-c, --confirm", "Ask for confirmation before writing each file").option("-C, --clean-config", "Remove the svgJar config from ember-cli-build.js after migrating").parse(process.argv);
	const opts = program.opts();
	const [pathArg] = program.args;
	await runCodemod(resolveConfig({
		path: pathArg,
		dryRun: opts.dryRun,
		confirm: opts.confirm,
		cleanConfig: opts.cleanConfig
	}));
}
main().catch((error) => {
	console.error("An error occurred while running the codemod:", error);
	process.exit(1);
});
//#endregion
export {};
