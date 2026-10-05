import { readFile, writeFile } from 'node:fs/promises';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { JsPackageManager } from 'storybook/internal/common';
import { logger } from 'storybook/internal/node-logger';
import type { StorybookConfigRaw } from 'storybook/internal/types';

import { fs, vol } from 'memfs';
import { dedent } from 'ts-dedent';

import { createFixFiles } from '../fix-files.ts';
import { checkFix, runFix } from '../helpers/fix-test-utils.ts';
import type { CheckOptions, RunOptions } from '../types.ts';
import {
  type AddonSvelteCsfToCoreResult,
  addonSvelteCsfToCore,
  rewriteSvelteCsfImports,
} from './addon-svelte-csf-to-core.ts';

vi.mock('node:fs/promises', { spy: true });
vi.mock('storybook/internal/node-logger', { spy: true });

const MAIN = '/project/.storybook/main.ts';
const STORY = '/project/src/Button.stories.svelte';
const HELPER = '/project/src/lib/args.ts';

vi.mock('globby', () => ({
  globby: vi.fn().mockResolvedValue([MAIN, STORY, HELPER]),
}));

const mainConfigFile = (addon: string) => dedent`
  import type { StorybookConfig } from '@storybook/sveltekit';

  const config: StorybookConfig = {
    stories: ['../src/**/*.stories.@(ts|svelte)'],
    addons: ['@storybook/addon-docs', ${addon}],
    framework: '@storybook/sveltekit',
  };
  export default config;
`;

describe('addon-svelte-csf-to-core', () => {
  const packageManager = {
    getAllDependencies: vi.fn(),
    removeDependencies: vi.fn().mockResolvedValue(undefined),
  } as unknown as JsPackageManager;

  const checkOptions = (mainConfig: Partial<StorybookConfigRaw>, storybookVersion = '11.0.0') =>
    ({
      packageManager,
      mainConfig,
      storybookVersion,
      storiesPaths: [STORY],
      configDir: '/project/.storybook',
      mainConfigPath: MAIN,
      files: createFixFiles().files,
    }) as unknown as CheckOptions;

  const runOptions = (result: AddonSvelteCsfToCoreResult) =>
    ({
      result,
      packageManager,
      mainConfigPath: MAIN,
      configDir: '/project/.storybook',
      storiesPaths: [STORY],
      storybookVersion: '11.0.0',
    }) as unknown as Omit<RunOptions<AddonSvelteCsfToCoreResult>, 'files'>;

  const result: AddonSvelteCsfToCoreResult = {
    framework: '@storybook/sveltekit',
    legacyStoryFiles: [],
    legacyTemplate: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vol.reset();
    vi.mocked(readFile).mockImplementation(fs.promises.readFile as typeof readFile);
    vi.mocked(writeFile).mockImplementation(fs.promises.writeFile as typeof writeFile);
    vi.mocked(logger.warn).mockImplementation(() => {});
    vi.mocked(packageManager.getAllDependencies).mockReturnValue({
      '@storybook/addon-svelte-csf': '^5.1.5',
    });
    vol.fromJSON({
      [MAIN]: mainConfigFile("'@storybook/addon-svelte-csf'"),
      [STORY]: dedent`
        <script module>
          import { defineMeta } from '@storybook/addon-svelte-csf';
        </script>
      `,
      [HELPER]: "import type { Args } from '@storybook/addon-svelte-csf';",
    });
  });

  describe('check', () => {
    const mainConfig = {
      framework: '@storybook/sveltekit',
      addons: ['@storybook/addon-svelte-csf'],
    };

    it('applies when the addon is in addons as a string', async () => {
      await expect(checkFix(addonSvelteCsfToCore, checkOptions(mainConfig))).resolves.toEqual(
        result
      );
    });

    it('applies when the addon is in addons as an object', async () => {
      const options = checkOptions({
        framework: { name: '@storybook/svelte-vite', options: {} },
        addons: [{ name: '@storybook/addon-svelte-csf', options: {} }],
      });

      await expect(checkFix(addonSvelteCsfToCore, options)).resolves.toEqual({
        ...result,
        framework: '@storybook/svelte-vite',
      });
    });

    it('applies when the addon is only a dependency', async () => {
      const options = checkOptions({ framework: '@storybook/sveltekit', addons: [] });

      await expect(checkFix(addonSvelteCsfToCore, options)).resolves.toEqual(result);
    });

    it('reports the legacyTemplate option', async () => {
      const options = checkOptions({
        framework: '@storybook/sveltekit',
        addons: [{ name: '@storybook/addon-svelte-csf', options: { legacyTemplate: true } }],
      });

      await expect(checkFix(addonSvelteCsfToCore, options)).resolves.toEqual({
        ...result,
        legacyTemplate: true,
      });
    });

    it('reports Svelte CSF story files that use the legacy syntax', async () => {
      vol.writeFileSync(
        STORY,
        dedent`
          <script>
            import { Meta, Story } from '@storybook/addon-svelte-csf';
          </script>

          <Meta title="Button" />
        `
      );

      await expect(checkFix(addonSvelteCsfToCore, checkOptions(mainConfig))).resolves.toEqual({
        ...result,
        legacyStoryFiles: [STORY],
      });
    });

    it('returns null when the project does not use the addon', async () => {
      vi.mocked(packageManager.getAllDependencies).mockReturnValue({});
      const options = checkOptions({ framework: '@storybook/sveltekit', addons: [] });

      await expect(checkFix(addonSvelteCsfToCore, options)).resolves.toBeNull();
    });

    it('returns null for frameworks without Svelte CSF', async () => {
      const options = checkOptions({ ...mainConfig, framework: '@storybook/react-vite' });

      await expect(checkFix(addonSvelteCsfToCore, options)).resolves.toBeNull();
    });

    it('returns null before Storybook 11', async () => {
      await expect(
        checkFix(addonSvelteCsfToCore, checkOptions(mainConfig, '10.4.0'))
      ).resolves.toBeNull();
    });
  });

  describe('run', () => {
    it('removes the addon from addons and from the dependencies', async () => {
      await runFix(addonSvelteCsfToCore, runOptions(result));

      expect(packageManager.removeDependencies).toHaveBeenCalledWith([
        '@storybook/addon-svelte-csf',
      ]);
      expect(vol.toJSON()[MAIN]).toContain("addons: ['@storybook/addon-docs']");
    });

    it('removes the addon from addons in the object form', async () => {
      vol.writeFileSync(
        MAIN,
        mainConfigFile("{ name: '@storybook/addon-svelte-csf', options: { legacyTemplate: true } }")
      );

      await runFix(addonSvelteCsfToCore, runOptions(result));

      expect(vol.toJSON()[MAIN]).toContain("addons: ['@storybook/addon-docs']");
    });

    it('rewrites the imports in story files', async () => {
      await runFix(addonSvelteCsfToCore, runOptions(result));

      expect(vol.toJSON()[STORY]).toBe(dedent`
        <script module>
          import { defineMeta } from '@storybook/sveltekit';
        </script>
      `);
    });

    it('rewrites the imports in other source files', async () => {
      await runFix(addonSvelteCsfToCore, runOptions(result));

      expect(vol.toJSON()[HELPER]).toBe("import type { Args } from '@storybook/sveltekit';");
    });

    it('warns about the legacy syntax when legacyTemplate is set', async () => {
      await runFix(addonSvelteCsfToCore, runOptions({ ...result, legacyTemplate: true }));

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('removes the legacy Svelte CSF syntax')
      );
    });

    it('lists the legacy story files in the warning', async () => {
      await runFix(addonSvelteCsfToCore, runOptions({ ...result, legacyStoryFiles: [STORY] }));

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`- ${STORY}`));
    });

    it('does not warn without legacy stories', async () => {
      await runFix(addonSvelteCsfToCore, runOptions(result));

      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe('rewriteSvelteCsfImports', () => {
    const rewrite = (code: string, id = STORY) =>
      rewriteSvelteCsfImports(code, id, '@storybook/svelte-vite');

    it('keeps aliases and type imports', () => {
      expect(
        rewrite(dedent`
          <script module lang="ts">
            import { defineMeta as dm, type Args } from '@storybook/addon-svelte-csf';
            import type { StoryContext } from "@storybook/addon-svelte-csf";
          </script>
        `)
      ).toBe(dedent`
        <script module lang="ts">
          import { defineMeta as dm, type Args } from '@storybook/svelte-vite';
          import type { StoryContext } from "@storybook/svelte-vite";
        </script>
      `);
    });

    it('merges the import into an existing import from the framework', () => {
      expect(
        rewrite(dedent`
          <script module lang="ts">
            import { defineMeta } from '@storybook/addon-svelte-csf';
            import { type StoryObj } from '@storybook/svelte-vite';
            import type { Args } from '@storybook/addon-svelte-csf';
            import type { Meta } from '@storybook/svelte-vite';
          </script>
        `)
      ).toBe(dedent`
        <script module lang="ts">
          import { defineMeta, type StoryObj } from '@storybook/svelte-vite';
          import type { Args, Meta } from '@storybook/svelte-vite';
        </script>
      `);
    });

    it('rewrites TypeScript files', () => {
      expect(
        rewrite(
          "import type { Args } from '@storybook/addon-svelte-csf';\nexport type Props = Args;",
          '/project/src/types.ts'
        )
      ).toBe("import type { Args } from '@storybook/svelte-vite';\nexport type Props = Args;");
    });

    it('rewrites MDX files', () => {
      expect(
        rewrite("import { defineMeta } from '@storybook/addon-svelte-csf';\n\n# Docs", '/a.mdx')
      ).toBe("import { defineMeta } from '@storybook/svelte-vite';\n\n# Docs");
    });

    it('leaves other strings that name the addon alone', () => {
      expect(rewrite("export const addons = ['@storybook/addon-svelte-csf'];")).toBeNull();
    });
  });
});
