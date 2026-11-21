//#region src/utils/icon-names.d.ts
type IconType = 'inline' | 'sprite';
//#endregion
//#region src/lib/resolve-icon-names.d.ts
/**
 * A reference to a specific icon usage in a source file, including its
 * location for diagnostic reporting.
 */
interface UnresolvedIconRef {
  /** File path, line, and column, e.g. "app/components/banner.gts:34:12". */
  location: string;
  /** The icon slug that could not be resolved. */
  slug: string;
}
/**
 * An icon that was found in multiple source directories.
 */
interface AmbiguousIconRef {
  /** File path, line, and column, e.g. "app/components/banner.gts:34:12". */
  location: string;
  /** The icon slug. */
  slug: string;
  /** All paths where the icon was found. */
  paths: string[];
}
//#endregion
//#region src/lib/resolve-import-alias.d.ts
/**
 * Represents a single import alias mapping from the `imports` field in
 * package.json. Only wildcard (`*`) patterns are supported — exact mappings
 * are ignored since they don't apply to arbitrary icon paths.
 *
 * @example { alias: '#icons/*', targetPrefix: 'public/icons/' }
 */
interface ImportAlias {
  /** The full alias pattern, e.g. `"#icons/*"`. */
  alias: string;
  /**
   * The directory prefix that the alias maps to, with the leading `./`
   * stripped and a trailing `/` ensured, e.g. `"public/icons/"`.
   */
  targetPrefix: string;
}
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
declare function parseImportAliases(imports: Record<string, string>): ImportAlias[];
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
declare function applyImportAlias(importPath: string, aliases: ImportAlias[]): string | undefined;
//#endregion
//#region src/codemod.d.ts
/**
 * Options for the convenience `run` function. Only `projectRoot` is required;
 * source directories and import aliases are read from disk automatically.
 */
interface Options {
  /** Absolute path to the Ember project root. */
  projectRoot: string;
}
/**
 * Options for `transform`. All project-level configuration is pre-computed
 * and passed in, so the transform itself does no filesystem I/O.
 */
interface TransformOptions extends Options {
  /** svgJar source directories (e.g. `['public', 'vendor/icons']`). */
  sourceDirs: string[];
  /** Parsed import aliases from the project's package.json. */
  importAliases: ImportAlias[];
}
/**
 * Result of transforming a single file.
 */
interface TransformResult {
  /** The transformed source text. */
  output: string;
  /** Icon usages that could not be found in any source directory, with file location. */
  unresolvedIcons: UnresolvedIconRef[];
  /**
   * Icon usages found in multiple source directories, with file location and
   * all matching paths. The first match is used for the import, but these
   * should be reported to the user for review.
   */
  ambiguousIcons: AmbiguousIconRef[];
}
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
declare function transform(source: string, filePath: string, options: TransformOptions): TransformResult;
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
declare function run(source: string, filePath: string, options: Options): TransformResult;
//#endregion
//#region src/lib/remove-svg-jar-config.d.ts
/**
 * Removes the `svgJar` property (and its entire value) from the options object
 * passed to `new EmberApp(...)` in an `ember-cli-build.js` source string.
 *
 * @param source  Raw source text of ember-cli-build.js.
 * @returns       Transformed source with the svgJar config property removed.
 */
declare function removeSvgJarConfig(source: string): string;
//#endregion
//#region src/lib/file-system.d.ts
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
declare function readSourceDirs(projectRoot: string): string[];
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
declare function readImportAliases(projectRoot: string): ImportAlias[];
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
declare function findTemplateFiles(projectRoot: string, targetDir?: string): string[];
//#endregion
export { type AmbiguousIconRef, type IconType, type ImportAlias, type Options, type TransformOptions, type TransformResult, type UnresolvedIconRef, applyImportAlias, findTemplateFiles, parseImportAliases, readImportAliases, readSourceDirs, removeSvgJarConfig, run, transform };