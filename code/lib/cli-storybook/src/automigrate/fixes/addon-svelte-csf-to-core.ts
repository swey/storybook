import { parser, types as t } from 'storybook/internal/babel';
import { getProjectRoot, normalizeAddonName } from 'storybook/internal/common';
import { logger } from 'storybook/internal/node-logger';
import type { StorybookConfigRaw } from 'storybook/internal/types';

import picocolors from 'picocolors';
import { dedent } from 'ts-dedent';

import { getFrameworkPackageName } from '../helpers/mainConfigFile.ts';
import { isAtOrPastVersion } from '../helpers/versionBoundary.ts';
import type { Fix } from '../types.ts';

const ADDON = '@storybook/addon-svelte-csf';
const SVELTE_CSF_FRAMEWORKS = ['@storybook/svelte-vite', '@storybook/sveltekit'];
const MIGRATION_GUIDE = 'https://github.com/storybookjs/storybook/blob/next/MIGRATION.md';

// `from '…'`, `import '…'` and `import('…')`, but not other strings such as an `addons` entry.
const ADDON_IMPORT =
  /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])@storybook\/addon-svelte-csf\2/g;
const SCRIPT_BLOCK = /(<script\b[^>]*>)([\s\S]*?)(<\/script>)/g;
const SOURCE_FILES = '**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts,svelte,mdx}';

export interface AddonSvelteCsfToCoreResult {
  framework: string;
  /** Svelte CSF story files that use the legacy syntax, which must be migrated by hand. */
  legacyStoryFiles: string[];
  legacyTemplate: boolean;
}

const findAddonEntry = (mainConfig: StorybookConfigRaw) =>
  mainConfig.addons?.find((addon) => normalizeAddonName(addon) === ADDON);

/**
 * Merge the named imports of `source` that share an import kind into the first of them, so the
 * rewrite does not leave two `import { … } from` statements for the framework package.
 */
const mergeImports = (code: string, source: string) => {
  let ast: t.File;
  try {
    ast = parser.parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
  } catch {
    return code;
  }

  const groups = new Map<string, t.ImportDeclaration[]>();
  for (const node of ast.program.body) {
    if (
      t.isImportDeclaration(node) &&
      node.source.value === source &&
      node.specifiers.length > 0 &&
      node.specifiers.every((specifier) => t.isImportSpecifier(specifier))
    ) {
      const kind = node.importKind ?? 'value';
      groups.set(kind, [...(groups.get(kind) ?? []), node]);
    }
  }

  const edits: { start: number; end: number; text: string }[] = [];
  for (const [first, ...rest] of groups.values()) {
    if (rest.length === 0) {
      continue;
    }
    const specifiers = [first, ...rest].flatMap(({ specifiers }) =>
      specifiers.map((specifier) => code.slice(specifier.start!, specifier.end!))
    );
    edits.push({
      start: first.specifiers[0].start!,
      end: first.specifiers.at(-1)!.end!,
      text: [...new Set(specifiers)].join(', '),
    });
    // Remove the other statements with their whole line, indentation included.
    for (const node of rest) {
      const lineStart = code.lastIndexOf('\n', node.start! - 1) + 1;
      const ownLine = code.slice(lineStart, node.start!).trim() === '' && code[node.end!] === '\n';
      edits.push(
        ownLine
          ? { start: lineStart, end: node.end! + 1, text: '' }
          : { start: node.start!, end: node.end!, text: '' }
      );
    }
  }

  return edits
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, { start, end, text }) => result.slice(0, start) + text + result.slice(end),
      code
    );
};

export const rewriteSvelteCsfImports = (code: string, id: string, framework: string) => {
  if (code.search(ADDON_IMPORT) === -1) {
    return null;
  }
  const renamed = code.replace(ADDON_IMPORT, `$1$2${framework}$2`);

  if (id.endsWith('.svelte')) {
    return renamed.replace(
      SCRIPT_BLOCK,
      (_, open: string, content: string, close: string) =>
        open + mergeImports(content, framework) + close
    );
  }
  // MDX is not JavaScript, so its imports are only renamed.
  return id.endsWith('.mdx') ? renamed : mergeImports(renamed, framework);
};

/** Svelte CSF files without `defineMeta` use the legacy syntax: `<Meta>`, `export const meta`, … */
const isLegacyStoryFile = (code: string) =>
  code.search(ADDON_IMPORT) !== -1 && !/\bdefineMeta\b/.test(code);

export const addonSvelteCsfToCore: Fix<AddonSvelteCsfToCoreResult> = {
  id: 'addon-svelte-csf-to-core',
  link: `${MIGRATION_GUIDE}#svelte-csf-is-built-into-the-svelte-frameworks`,

  async check({ mainConfig, packageManager, storybookVersion, storiesPaths, files }) {
    const framework = getFrameworkPackageName(mainConfig);
    const addonEntry = findAddonEntry(mainConfig);

    if (
      !isAtOrPastVersion(storybookVersion, '11.0.0') ||
      !framework ||
      !SVELTE_CSF_FRAMEWORKS.includes(framework) ||
      (!addonEntry && !packageManager.getAllDependencies()[ADDON])
    ) {
      return null;
    }

    const legacyStoryFiles: string[] = [];
    for (const path of storiesPaths.filter((path) => path.endsWith('.svelte'))) {
      if (isLegacyStoryFile(await files.read(path))) {
        legacyStoryFiles.push(path);
      }
    }

    return {
      framework,
      legacyStoryFiles,
      legacyTemplate:
        typeof addonEntry === 'object' &&
        (addonEntry.options as { legacyTemplate?: boolean } | undefined)?.legacyTemplate === true,
    };
  },

  prompt() {
    return dedent`
      Svelte CSF is built into the Svelte frameworks, so ${picocolors.magenta(ADDON)} is no longer needed.
      We'll remove the addon and import Svelte CSF from your framework package instead.
    `;
  },

  transform: () => [
    {
      filter: { kind: ['main'] },
      editConfig: (main) => {
        if ((main.getNamesFromPath(['addons']) ?? []).includes(ADDON)) {
          main.removeEntryFromArray(['addons'], ADDON);
        }
      },
    },
  ],

  async run({ packageManager, result, files }) {
    if (packageManager.getAllDependencies()[ADDON]) {
      await packageManager.removeDependencies([ADDON]);
    }

    // Any source file can import the addon's types, not only stories and config files.
    // eslint-disable-next-line depend/ban-dependencies
    const { globby } = await import('globby');
    const sourceFiles = await globby(SOURCE_FILES, {
      cwd: getProjectRoot(),
      absolute: true,
      gitignore: true,
      ignore: ['**/node_modules/**', '**/dist/**', '**/storybook-static/**', '**/.svelte-kit/**'],
    });
    await files.edit(sourceFiles, (code, path) =>
      rewriteSvelteCsfImports(code, path, result.framework)
    );

    if (result.legacyTemplate || result.legacyStoryFiles.length > 0) {
      const files = result.legacyStoryFiles.map((path) => `- ${path}`).join('\n');
      logger.warn(dedent`
        Storybook 11 removes the legacy Svelte CSF syntax, such as ${picocolors.cyan('<Meta>')}, ${picocolors.cyan('export const meta')} and ${picocolors.cyan('<Template>')}. Migrate your legacy stories to ${picocolors.cyan('defineMeta')} by hand${files ? `:\n${files}` : '.'}

        See ${MIGRATION_GUIDE}#svelte-csf-legacy-story-syntax-removed
      `);
    }
  },
};
