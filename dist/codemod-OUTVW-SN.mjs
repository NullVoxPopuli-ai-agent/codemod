import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zmod";
import { globSync } from "tinyglobby";
import { emberParser } from "zmod-ember";
//#region src/lib/get-svg-jar-source-dirs.ts
const DEFAULT_SOURCE_DIRS$1 = ["public"];
/**
* Extracts a string value from an AST element, returning null for anything
* that isn't a non-empty string literal.
*/
function toStringOrNull(element) {
	if (element.type !== "Literal" || typeof element.value !== "string") return null;
	if (element.value.trim() === "") return null;
	return element.value;
}
function getSvgJarSourceDirs(source) {
	const sourceDirsArrays = z(source).find(z.Property, { key: { name: "svgJar" } }).find(z.Property, { key: { name: "sourceDirs" } }).find(z.ArrayExpression);
	if (sourceDirsArrays.length === 0) return { sourceDirs: DEFAULT_SOURCE_DIRS$1 };
	const sourceDirs = sourceDirsArrays.nodes().flatMap((node) => {
		const elements = node.elements;
		if (!Array.isArray(elements)) return [];
		return elements.map(toStringOrNull);
	}).filter((dir) => dir !== null);
	return { sourceDirs: sourceDirs.length > 0 ? sourceDirs : DEFAULT_SOURCE_DIRS$1 };
}
//#endregion
//#region src/lib/resolve-import-alias.ts
/**
* Parses the `imports` field from a package.json object into a sorted list of
* alias mappings. Only `"#…/*": "./…/*"` patterns are included — the
* wildcard must appear at the end of both key and value.
*
* The returned list is sorted longest `targetPrefix` first so that the most
* specific alias wins when multiple patterns match.
*
* @param imports The raw `imports` object from package.json.
*
* @example
*   parseImportAliases({ '#icons/*': './public/icons/*', '#lib/*': './lib/*' })
*   // → [{ alias: '#icons/*', targetPrefix: 'public/icons/' },
*   //    { alias: '#lib/*',   targetPrefix: 'lib/' }]
*/
function parseImportAliases(imports) {
	const aliases = [];
	for (const [key, value] of Object.entries(imports)) {
		if (!key.endsWith("/*") || typeof value !== "string" || !value.endsWith("/*")) continue;
		const targetPrefix = value.replace(/^\.\//, "").replace(/\/\*$/, "/");
		aliases.push({
			alias: key,
			targetPrefix
		});
	}
	aliases.sort((a, b) => b.targetPrefix.length - a.targetPrefix.length);
	return aliases;
}
/**
* Attempts to rewrite a resolved import path using a matching package.json
* import alias. Returns the aliased path if a match is found, or `undefined`
* if no alias applies.
*
* @param importPath The resolved icon path relative to the project root,
*                   e.g. `"public/icons/arrow.svg"`.
* @param aliases    Parsed import aliases from `parseImportAliases`.
* @returns          The aliased import path (e.g. `"#icons/arrow.svg"`) or
*                   `undefined` if no alias matches.
*
* @example
*   const aliases = parseImportAliases({ '#icons/*': './public/icons/*' });
*   applyImportAlias('public/icons/arrow.svg', aliases);
*   // → '#icons/arrow.svg'
*
* @example
*   applyImportAlias('vendor/icons/arrow.svg', aliases);
*   // → undefined  (no matching alias)
*/
function applyImportAlias(importPath, aliases) {
	for (const { alias, targetPrefix } of aliases) if (importPath.startsWith(targetPrefix)) {
		const remainder = importPath.slice(targetPrefix.length);
		return `${alias.replace(/\/\*$/, "/")}${remainder}`;
	}
}
//#endregion
//#region src/lib/file-system.ts
const DEFAULT_SOURCE_DIRS = ["public"];
/** File names to try when looking for the ember-cli-build config. */
const EMBER_CLI_BUILD_FILES = [
	"ember-cli-build.js",
	"ember-cli-build.mjs",
	"ember-cli-build.cjs"
];
/**
* Returns the absolute path to the ember-cli-build config file in the project
* root, trying `.js`, `.mjs`, and `.cjs` extensions in order. Returns
* `undefined` if none exist.
*
* @param projectRoot Absolute path to the Ember project root.
*/
function findEmberCliBuildFile(projectRoot) {
	for (const fileName of EMBER_CLI_BUILD_FILES) {
		const filePath = path.join(projectRoot, fileName);
		if (existsSync(filePath)) return filePath;
	}
}
/**
* Reads the ember-cli-build config file from the project root and extracts
* the svgJar source directories. Tries `.js`, `.mjs`, and `.cjs` extensions.
* Falls back to `['public']` when no config file is found or it contains no
* svgJar config.
*
* @param projectRoot Absolute path to the Ember project root.
*
* @example
*   readSourceDirs('/my-project')
*   // → ['public/icons', 'vendor/icons']
*/
function readSourceDirs(projectRoot) {
	for (const fileName of EMBER_CLI_BUILD_FILES) {
		const filePath = path.join(projectRoot, fileName);
		try {
			return getSvgJarSourceDirs(readFileSync(filePath, "utf-8")).sourceDirs;
		} catch {}
	}
	return DEFAULT_SOURCE_DIRS;
}
/**
* Reads the project's `package.json` and extracts any `imports` field entries
* that use wildcard patterns (e.g. `"#icons/*": "./public/icons/*"`).
*
* These aliases are used by the codemod to generate short import specifiers
* instead of long relative paths when a matching alias exists.
*
* Returns an empty array when the file is missing, malformed, or has no
* `imports` field.
*
* @param projectRoot Absolute path to the Ember project root.
*
* @example
*   readImportAliases('/my-project')
*   // → [{ alias: '#icons/*', targetPrefix: 'public/icons/' }]
*/
function readImportAliases(projectRoot) {
	const packageJsonPath = path.join(projectRoot, "package.json");
	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
		if (packageJson.imports && typeof packageJson.imports === "object") return parseImportAliases(packageJson.imports);
	} catch {}
	return [];
}
/**
* Searches for an SVG file matching the given icon slug inside the provided
* source directories. Returns the first match along with all matches (to
* detect ambiguity), or `undefined` if the file is not found anywhere.
*
* Source directories are searched in order; the first match is used as the
* import path. A slug without a slash also matches a file of that name in a
* subfolder, as with ember-svg-jar's default `stripPath: true`. When the icon exists in multiple directories, all paths are
* returned so the caller can warn the user.
*
* @param iconSlug    The icon identifier as used in `{{svgJar "icon-slug"}}`,
*                    without the leading `#`. May contain slashes for nested
*                    paths (e.g. `"nav/arrow"`).
* @param sourceDirs  Array of directories to search, relative to projectRoot
*                    (e.g. `["public", "vendor/icons"]`).
* @param projectRoot Absolute path to the Ember project root.
*
* @example
*   resolveIconPath('arrow', ['public', 'vendor'], '/my-project')
*   // → { importPath: 'public/arrow.svg', allPaths: ['public/arrow.svg'] }
*
* @example
*   // When the same icon exists in both directories:
*   resolveIconPath('arrow', ['public', 'vendor'], '/my-project')
*   // → { importPath: 'public/arrow.svg', allPaths: ['public/arrow.svg', 'vendor/arrow.svg'] }
*/
function resolveIconPath(iconSlug, sourceDirs, projectRoot) {
	const allPaths = [];
	for (const dir of sourceDirs) if (existsSync(path.join(projectRoot, dir, `${iconSlug}.svg`))) allPaths.push(`${dir}/${iconSlug}.svg`);
	if (allPaths.length === 0 && !iconSlug.includes("/")) for (const dir of sourceDirs) {
		const matches = globSync(`**/${iconSlug}.svg`, { cwd: path.join(projectRoot, dir) }).sort();
		for (const match of matches) allPaths.push(`${dir}/${match}`);
	}
	if (allPaths.length === 0) return void 0;
	return {
		importPath: allPaths[0],
		allPaths
	};
}
/**
* Finds all Glimmer template files (`.gjs` and `.gts`) in a project.
*
* Searches the entire project tree (or a subdirectory if `targetDir` is
* provided), excluding `node_modules/` and `dist/`. Glimmer components can
* be imported from anywhere, so the search is not limited to conventional
* directories like `app/components/`.
*
* Returns paths relative to the project root (e.g. `"app/components/banner.gts"`).
*
* @param projectRoot Absolute path to the project root.
* @param targetDir   Optional subdirectory to scope the search to
*                    (relative to projectRoot, e.g. `"app/components"`).
*
* @example
*   findTemplateFiles('/my-project')
*   // → ['app/components/banner.gts', 'app/templates/application.gts']
*
* @example
*   findTemplateFiles('/my-project', 'app/components')
*   // → ['app/components/banner.gts', 'app/components/sidebar.gjs']
*/
function findTemplateFiles(projectRoot, targetDir) {
	return globSync(`${targetDir ? `${targetDir}/` : ""}**/*.{gjs,gts}`, {
		cwd: projectRoot,
		ignore: ["**/node_modules/**", "**/dist/**"]
	}).map((match) => path.normalize(match));
}
//#endregion
//#region src/lib/remove-svg-jar-config.ts
/**
* Removes the `svgJar` property (and its entire value) from the options object
* passed to `new EmberApp(...)` in an `ember-cli-build.js` source string.
*
* @param source  Raw source text of ember-cli-build.js.
* @returns       Transformed source with the svgJar config property removed.
*/
function removeSvgJarConfig(source) {
	const root = z(source);
	const svgJarProperty = root.find(z.Property, { key: { name: "svgJar" } });
	if (svgJarProperty.length === 0) return source;
	svgJarProperty.remove();
	return root.toSource().replace(/\{\s*,\s*\}/gs, "{}");
}
//#endregion
//#region src/lib/build-icon-import-path.ts
/**
* Builds the import path for an icon component.
*
* If the project's package.json defines an `imports` alias that matches the
* icon's resolved path, the alias is used (e.g. `"#icons/arrow.svg"`).
* Otherwise, a relative path from the file being transformed is computed
* (e.g. `"../../public/icons/arrow.svg"`).
*
* Inline icons append `?unsafe-inline` to opt into SVG markup injection.
* Sprite icons use a plain path since they reference a `<symbol>` in a
* sprite sheet.
*
* @param icon           The resolved icon with its import path.
* @param filePath       Path of the file being transformed, relative to the project root.
* @param importAliases  Parsed import aliases from the project's package.json.
*/
function buildIconImportPath(icon, filePath, importAliases) {
	const suffix = icon.type === "inline" ? "?unsafe-inline" : "";
	const aliased = applyImportAlias(icon.importPath, importAliases);
	if (aliased) return `${aliased}${suffix}`;
	let relativePath = path.relative(path.dirname(filePath), icon.importPath);
	if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`;
	return `${relativePath}${suffix}`;
}
//#endregion
//#region src/utils/glimmer.ts
/**
* Extracts the raw icon name string from the first parameter of a svgJar
* mustache call. Handles two forms:
*
*   - String literal:   {{svgJar "icon-name"}}  → "icon-name"
*   - Sub-expression:   {{svgJar (helper "icon-name")}}  → "icon-name"
*
* Returns undefined if the icon name cannot be statically determined.
*/
function extractRawIconName(firstParam) {
	if (firstParam?.type === "GlimmerStringLiteral") return firstParam.value;
	if (firstParam?.type === "GlimmerSubExpression") {
		const subFirstParam = firstParam.params[0];
		if (subFirstParam?.type === "GlimmerStringLiteral") return subFirstParam.value;
	}
}
/**
* Serialises a single Glimmer hash pair value into the appropriate HTML/HBS
* attribute syntax for use in an angle-bracket component invocation.
*
* The four cases mirror what Glimmer can express as a hash value:
*
*   GlimmerStringLiteral  → key="value"
*   GlimmerBooleanLiteral → key  (true, bare attribute)  /  key={{false}}  (false)
*   GlimmerPathExpression → key={{identifier}}
*   GlimmerSubExpression  → key={{helper arg1 arg2}}
*
* For the sub-expression case the original source text is sliced directly
* using the node's byte offsets, stripping the surrounding `()` parens that
* Handlebars uses for sub-expressions (they are not needed inside `{{}}`).
*/
function serialiseHashPairValue(key, value, source) {
	switch (value.type) {
		case "GlimmerStringLiteral": return `${key}="${value.value}"`;
		case "GlimmerBooleanLiteral": return value.value ? key : `${key}={{false}}`;
		case "GlimmerPathExpression": return `${key}={{${value.original}}}`;
		case "GlimmerSubExpression": return `${key}={{${source.slice(value.start + 1, value.end - 1)}}}`;
	}
}
/**
* Builds an angle-bracket component invocation string from a component name
* and the hash pairs collected from the original mustache call.
*
* @example
*   buildComponentTag('OneIcon', [], source)
*   // → '<OneIcon />'
*
* @example
*   buildComponentTag('Two', [{ key: 'class', value: ... }], source)
*   // → '<Two class="my-icon" />'
*/
function buildComponentTag(componentName, hashPairs, source) {
	if (hashPairs.length === 0) return `<${componentName} />`;
	return `<${componentName} ${hashPairs.map(({ key, value }) => serialiseHashPairValue(key, value, source)).join(" ")} />`;
}
//#endregion
//#region src/utils/icon-names.ts
/**
* Converts a kebab-case string to PascalCase.
* Used to derive a component name from an icon slug.
*
* @example "one-icon" → "OneIcon"
*/
function toPascalCase(str) {
	return str.replace(/(^\w|-\w)/g, (match) => match.replace(/-/, "").toUpperCase());
}
/**
* Extracts the filename (without extension) from an icon slug that may
* contain directory separators.
*
* @example "nav/arrow" → "arrow"
* @example "one-icon"  → "one-icon"
*/
function iconBaseName(iconSlug) {
	const lastSlash = iconSlug.lastIndexOf("/");
	return lastSlash === -1 ? iconSlug : iconSlug.slice(lastSlash + 1);
}
/**
* Determines whether an icon is inline SVG or a sprite reference.
* ember-svg-jar uses a leading "#" to denote sprite icons.
*
* @example "one-icon"     → 'inline'
* @example "#sprite-icon" → 'sprite'
*/
function determineIconType(rawIconName) {
	return rawIconName.startsWith("#") ? "sprite" : "inline";
}
//#endregion
//#region src/lib/replace-mustaches.ts
const j$1 = z;
/**
* Replaces every `{{svgJar ...}}` mustache call in the template with the
* equivalent angle-bracket component invocation, e.g. `<OneIcon />`.
*
* Uses the pre-resolved icon name map so that conflict disambiguation
* (IconName vs IconNameInline) is already settled before any replacement runs.
*
* Mustaches whose icon name cannot be statically resolved are left unchanged.
*/
function replaceMustachesWithComponents(svgJarUsages, resolvedIcons, source) {
	svgJarUsages.replaceWith((path) => {
		const node = path.node;
		const rawName = extractRawIconName(node.params[0]);
		if (!rawName) return node;
		const key = `${rawName.replace(/^#/, "")}:${determineIconType(rawName)}`;
		const icon = resolvedIcons.get(key);
		if (!icon) return node;
		return buildComponentTag(icon.componentName, node.hash?.pairs ?? [], source);
	});
}
/**
* Inserts an import declaration for each icon component collected during the
* pre-scan pass.
*
* If the file already has imports, the new ones are inserted after the last
* existing import. If there are no imports at all (e.g. a bare template-only
* component with no JS), the imports are prepended at the top of the file.
*/
function addIconImports(root, usedIcons, filePath, importAliases) {
	const allImports = root.find(j$1.ImportDeclaration);
	if (allImports.length > 0) {
		const lastImport = allImports.at(allImports.length - 1);
		for (const icon of usedIcons.values()) {
			const importPath = buildIconImportPath(icon, filePath, importAliases);
			lastImport?.insertAfter(`\nimport ${icon.componentName} from '${importPath}';`);
		}
	} else {
		const lines = [...usedIcons.values()].map((icon) => `import ${icon.componentName} from '${buildIconImportPath(icon, filePath, importAliases)}';`).join("\n");
		root.insertAt(0, lines + "\n\n");
	}
}
//#endregion
//#region src/lib/resolve-icon-names.ts
/**
* Formats a file path, line number, and column into a location string.
*
* @example formatLocation('app/components/banner.gts', 34, 12) → 'app/components/banner.gts:34:12'
*/
function formatLocation(filePath, line, column) {
	if (line == null) return filePath;
	if (column == null) return `${filePath}:${line}`;
	return `${filePath}:${line}:${column}`;
}
/**
* Pre-scans all svgJar mustache calls to collect the full set of (slug, type)
* pairs used in the file, resolves each to an actual SVG file on disk, then
* resolves any name conflicts.
*
* Icons that cannot be found in any source directory are collected in
* `unresolved` with their file location so the caller can report them.
*
* Icons found in multiple source directories are collected in `ambiguous`.
* The first match is used for the import, but the caller should warn the user.
*
* Conflict rule: when the same slug appears as both inline and sprite, the
* sprite gets the plain PascalCase name (e.g. "IconName") and the inline
* variant gets an "Inline" suffix (e.g. "IconNameInline").
*/
function resolveIconNames(svgJarUsages, sourceDirs, projectRoot, filePath) {
	const resolved = /* @__PURE__ */ new Map();
	const unresolved = [];
	const ambiguous = [];
	const seenSlugs = /* @__PURE__ */ new Set();
	svgJarUsages.forEach((nodePath) => {
		const node = nodePath.node;
		const rawName = extractRawIconName(node.params[0]);
		if (!rawName) return;
		const iconSlug = rawName.replace(/^#/, "");
		const type = determineIconType(rawName);
		const key = `${iconSlug}:${type}`;
		const line = node.loc?.start.line;
		const column = node.loc?.start.column;
		const location = formatLocation(filePath, line, column);
		if (resolved.has(key)) return;
		const result = resolveIconPath(iconSlug, sourceDirs, projectRoot);
		if (!result) {
			unresolved.push({
				location,
				slug: iconSlug
			});
			return;
		}
		if (result.allPaths.length > 1 && !seenSlugs.has(iconSlug)) ambiguous.push({
			location,
			slug: iconSlug,
			paths: result.allPaths
		});
		seenSlugs.add(iconSlug);
		const componentName = toPascalCase(iconBaseName(iconSlug));
		resolved.set(key, {
			componentName,
			iconSlug,
			type,
			importPath: result.importPath
		});
	});
	for (const [key, icon] of resolved) if (icon.type === "inline") {
		const spriteKey = `${icon.iconSlug}:sprite`;
		if (resolved.has(spriteKey)) resolved.set(key, {
			...icon,
			componentName: `${icon.componentName}Inline`
		});
	}
	return {
		resolved,
		unresolved,
		ambiguous
	};
}
//#endregion
//#region src/codemod.ts
const j = z.withParser(emberParser);
/**
* Transforms a single .gjs/.gts file, migrating all `ember-svg-jar` usage to
* direct SVG component imports.
*
* This is the core transform function. It performs no filesystem I/O beyond
* resolving icon paths — all project-level configuration (source directories,
* import aliases) must be pre-computed and passed via `options`.
*
* Steps performed:
*   1. Parse the file with the Glimmer-aware ember parser.
*   2. Pre-scan all `{{svgJar "..."}}` calls, resolve each icon to an actual
*      SVG file on disk, and resolve any name conflicts.
*   3. Replace resolved mustaches with angle-bracket component tags. Icons
*      that cannot be found on disk are left unchanged.
*   4. Remove the `ember-svg-jar` import declaration (only when all icons
*      in the file were resolved).
*   5. Add a new import for each resolved icon component.
*
* @param source   Raw source text of the file.
* @param filePath Path to the file, relative to the project root.
* @param options  Pre-computed project configuration.
*/
function transform(source, filePath, options) {
	const { projectRoot, sourceDirs, importAliases } = options;
	const root = j(source, { filePath });
	const svgJarImport = root.find(j.ImportDeclaration, { source: { value: "ember-svg-jar/helpers/svg-jar" } });
	const importSpecifier = svgJarImport.find(j.ImportDefaultSpecifier);
	const localNode = importSpecifier.length > 0 ? importSpecifier.get().node.local : void 0;
	const identifier = localNode?.type === "Identifier" ? String(localNode.name) : "svgJar";
	const svgJarUsages = root.find("GlimmerMustacheStatement", { path: { original: identifier } });
	if (svgJarUsages.length === 0) return {
		output: source,
		unresolvedIcons: [],
		ambiguousIcons: []
	};
	const { resolved: resolvedIcons, unresolved: unresolvedIcons, ambiguous: ambiguousIcons } = resolveIconNames(svgJarUsages, sourceDirs, projectRoot, filePath);
	avoidNameCollisions(root, resolvedIcons);
	replaceMustachesWithComponents(svgJarUsages, resolvedIcons, source);
	if (svgJarImport.length > 0 && unresolvedIcons.length === 0) svgJarImport.remove();
	addIconImports(root, resolvedIcons, filePath, importAliases);
	return {
		output: root.toSource(),
		unresolvedIcons,
		ambiguousIcons
	};
}
/**
* Renames icon components whose name the file already uses, such as an icon
* "link" in a file that imports a `Link` component. The icon gets an "Icon"
* suffix, then a number if that name is taken too.
*/
function avoidNameCollisions(root, resolvedIcons) {
	const taken = new Set(root.find(j.Identifier).nodes().map((node) => String(node.name)));
	for (const [key, icon] of resolvedIcons) {
		let name = icon.componentName;
		if (taken.has(name)) {
			name = `${icon.componentName}Icon`;
			for (let i = 2; taken.has(name); i++) name = `${icon.componentName}Icon${i}`;
		}
		taken.add(name);
		if (name !== icon.componentName) resolvedIcons.set(key, {
			...icon,
			componentName: name
		});
	}
}
/**
* Convenience function that reads project configuration from disk and
* transforms a single file.
*
* Reads `ember-cli-build.js` for svgJar source directories and `package.json`
* for import aliases, then delegates to `transform()`.
*
* @param source   Raw source text of the file.
* @param filePath Path to the file, relative to the project root.
* @param options  Must include `projectRoot`.
*/
function run(source, filePath, options) {
	const { projectRoot } = options;
	return transform(source, filePath, {
		projectRoot,
		sourceDirs: readSourceDirs(projectRoot),
		importAliases: readImportAliases(projectRoot)
	});
}
//#endregion
export { findTemplateFiles as a, applyImportAlias as c, findEmberCliBuildFile as i, parseImportAliases as l, transform as n, readImportAliases as o, removeSvgJarConfig as r, readSourceDirs as s, run as t };
