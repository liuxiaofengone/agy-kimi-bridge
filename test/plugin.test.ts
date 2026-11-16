import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, it } from 'vitest';

const pluginRoot = resolve('plugins/kimi-delegate');
const bundlePath = join(pluginRoot, 'mcp/server.mjs');
const validatorPath = resolve('scripts/validate-plugin.mjs');

function runValidator(root: string): void {
  execFileSync(process.execPath, [validatorPath, root], { stdio: 'pipe' });
}

function runValidatorCapturing(root: string): { status: number | null; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [validatorPath, root], { stdio: 'pipe', encoding: 'utf8' });
    return { status: 0, stdout, stderr: '' };
  } catch (error) {
    const err = error as { status?: number; stdout?: unknown; stderr?: unknown };
    return {
      status: err.status ?? null,
      stdout: String(err.stdout ?? ''),
      stderr: String(err.stderr ?? ''),
    };
  }
}

function copyPluginToTemp(): { temporaryRoot: string; copiedPluginRoot: string } {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'kimi-delegate-validate-'));
  const copiedPluginRoot = join(temporaryRoot, 'kimi-delegate');
  cpSync(pluginRoot, copiedPluginRoot, { recursive: true });
  return { temporaryRoot, copiedPluginRoot };
}

function expandPluginRoot(value: string, root: string): string {
  if (value === '${PLUGIN_ROOT}') return root;
  if (value.startsWith('${PLUGIN_ROOT}/') || value.startsWith('${PLUGIN_ROOT}\\')) {
    return resolve(root, value.slice('${PLUGIN_ROOT}/'.length));
  }
  return resolve(root, value);
}

interface SkillEscapeOps {
  linkFile: (target: string, linkPath: string) => void;
  linkDirJunction: (target: string, linkPath: string) => void;
}

function createOutsideSkillEscape(
  copiedPluginRoot: string,
  temporaryRoot: string,
  ops: SkillEscapeOps = {
    linkFile: (target, linkPath) => symlinkSync(target, linkPath),
    linkDirJunction: (target, linkPath) => symlinkSync(target, linkPath, 'junction'),
  },
): { escapeLink: string } {
  const outsideSkill = join(temporaryRoot, 'outside-SKILL.md');
  writeFileSync(outsideSkill, '# escaped skill content', 'utf8');
  const skillPath = join(copiedPluginRoot, 'skills', 'kimi-delegate', 'SKILL.md');
  rmSync(skillPath, { force: true });
  try {
    ops.linkFile(outsideSkill, skillPath);
    return { escapeLink: skillPath };
  } catch {
    const outsideDir = join(temporaryRoot, 'outside-skill-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'SKILL.md'), '# escaped skill content', 'utf8');
    const escapeLink = join(copiedPluginRoot, 'skills', 'escaped-skill');
    ops.linkDirJunction(outsideDir, escapeLink);
    return { escapeLink };
  }
}

describe('Antigravity plugin package', () => {
  it('passes the repository-local portable plugin validation', () => {
    expect(() => runValidator(pluginRoot)).not.toThrow();
  });

  it('rejects a plugin package missing its skill', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      rmSync(join(copiedPluginRoot, 'skills/kimi-delegate/SKILL.md'), { force: true });
      expect(() => runValidator(copiedPluginRoot)).toThrow(/SKILL\.md/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a plugin package with a baked-in token value', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const mcpConfigPath = join(copiedPluginRoot, 'mcp_config.json');
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      mcpConfig.mcpServers['kimi-delegate'].env.KIMI_SERVER_TOKEN = 'baked-in-secret';
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      expect(() => runValidator(copiedPluginRoot)).toThrow(/KIMI_SERVER_TOKEN/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a plugin package missing its MCP bundle', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      rmSync(join(copiedPluginRoot, 'mcp/server.mjs'), { force: true });
      expect(() => runValidator(copiedPluginRoot)).toThrow(/bundle/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a malformed semantic version', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const manifestPath = join(copiedPluginRoot, 'plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.version = '0.3.0garbage';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      expect(() => runValidator(copiedPluginRoot)).toThrow(/version/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('accepts a full semver with both prerelease and build metadata', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const manifestPath = join(copiedPluginRoot, 'plugin.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifest.version = '1.2.3-rc.1+sha.abc';
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      expect(() => runValidator(copiedPluginRoot)).not.toThrow();
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it.each(['01.2.3', '1.2.3-alpha..1', '1.2.3-01', '1.2', '1.2.3-'])(
    'rejects invalid semver %s',
    (version) => {
      const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
      try {
        const manifestPath = join(copiedPluginRoot, 'plugin.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.version = version;
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
        expect(() => runValidator(copiedPluginRoot)).toThrow(/semantic version/);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([null, 42, 'manifest', false, []])(
    'rejects a manifest whose root JSON value is %s',
    (rootValue) => {
      const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
      try {
        writeFileSync(
          join(copiedPluginRoot, 'plugin.json'),
          JSON.stringify(rootValue),
          'utf8',
        );
        const result = runValidatorCapturing(copiedPluginRoot);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('root value must be a non-null, non-array JSON object');
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it.each([42, 'bad-env', null, []])(
    'rejects a server env whose value is %s',
    (envValue) => {
      const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
      try {
        const mcpConfigPath = join(copiedPluginRoot, 'mcp_config.json');
        const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
        mcpConfig.mcpServers['kimi-delegate'].env = envValue;
        writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
        expect(() => runValidator(copiedPluginRoot)).toThrow(/env must be a non-null, non-array object/);
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true });
      }
    },
  );

  it('rejects non-string env values, including a non-string token, without echoing them', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const mcpConfigPath = join(copiedPluginRoot, 'mcp_config.json');
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      mcpConfig.mcpServers['kimi-delegate'].env = {
        KIMI_SERVER_TOKEN: 12345,
        OTHER_FLAG: { marker: 'SYNTH_c0ffee42_MARKER' },
      };
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));

      const result = runValidatorCapturing(copiedPluginRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('env KIMI_SERVER_TOKEN must be a string');
      expect(result.stderr).toContain('env OTHER_FLAG must be a string');
      expect(result.stdout).not.toContain('SYNTH_c0ffee42_MARKER');
      expect(result.stderr).not.toContain('SYNTH_c0ffee42_MARKER');
      expect(result.stderr).not.toContain('12345');
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('never echoes file contents when JSON parsing fails', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    const syntheticSecret = 'SYNTH_9f8e7d6c_PLACEHOLDER';
    try {
      writeFileSync(
        join(copiedPluginRoot, 'mcp_config.json'),
        `{"KIMI_SERVER_TOKEN":${syntheticSecret}}`,
        'utf8',
      );
      const result = runValidatorCapturing(copiedPluginRoot);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('invalid JSON');
      expect(result.stdout).not.toContain(syntheticSecret);
      expect(result.stderr).not.toContain(syntheticSecret);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a SKILL.md that resolves outside the plugin root', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    const { escapeLink } = createOutsideSkillEscape(copiedPluginRoot, temporaryRoot);
    try {
      expect(() => runValidator(copiedPluginRoot)).toThrow(/outside the plugin root/);
    } finally {
      rmSync(escapeLink, { force: true });
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a real junction and still rejects the package when the file symlink is denied with EPERM', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    let fileLinkAttempts = 0;
    const { escapeLink } = createOutsideSkillEscape(copiedPluginRoot, temporaryRoot, {
      linkFile: () => {
        fileLinkAttempts += 1;
        const error = new Error('operation not permitted, symlink') as NodeJS.ErrnoException;
        error.code = 'EPERM';
        throw error;
      },
      linkDirJunction: (target, linkPath) => symlinkSync(target, linkPath, 'junction'),
    });
    try {
      expect(fileLinkAttempts).toBe(1);
      expect(() => runValidator(copiedPluginRoot)).toThrow(/outside the plugin root/);
    } finally {
      rmSync(escapeLink, { force: true });
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('still fails when a symlinked skill tree escapes even if another valid skill exists', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    const escapeLink = join(copiedPluginRoot, 'skills', 'evil-escape');
    try {
      const outsideDir = join(temporaryRoot, 'outside-skill-tree');
      mkdirSync(join(outsideDir, 'evil'), { recursive: true });
      writeFileSync(join(outsideDir, 'evil', 'SKILL.md'), '# escaped skill', 'utf8');
      symlinkSync(outsideDir, escapeLink, 'junction');

      expect(() => runValidator(copiedPluginRoot)).toThrow(/outside the plugin root/);
    } finally {
      rmSync(escapeLink, { force: true });
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects an absolute server cwd even when it points inside the plugin root', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const mcpConfigPath = join(copiedPluginRoot, 'mcp_config.json');
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      mcpConfig.mcpServers['kimi-delegate'].cwd = copiedPluginRoot;
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      expect(() => runValidator(copiedPluginRoot)).toThrow(/plugin-relative/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('rejects a non-string server cwd with a controlled error', () => {
    const { temporaryRoot, copiedPluginRoot } = copyPluginToTemp();
    try {
      const mcpConfigPath = join(copiedPluginRoot, 'mcp_config.json');
      const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, 'utf8'));
      mcpConfig.mcpServers['kimi-delegate'].cwd = 42;
      writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2));
      expect(() => runValidator(copiedPluginRoot)).toThrow(/non-empty plugin-relative string/);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  it('launches a portable PLUGIN_ROOT bundle with Antigravity timeout and eager tools', () => {
    const config = JSON.parse(readFileSync(join(pluginRoot, 'mcp_config.json'), 'utf8'));
    expect(config.mcpServers['kimi-delegate']).toMatchObject({
      command: 'node',
      args: ['${PLUGIN_ROOT}/mcp/server.mjs'],
      cwd: '${PLUGIN_ROOT}',
      timeoutSeconds: 600,
      tools: {
        kimi_delegate_and_wait: { eager: true },
        kimi_bridge_status: { eager: true },
      },
    });
    expect(existsSync(bundlePath)).toBe(true);
  });

  it('starts after the plugin is copied away from the repository', async () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'kimi-delegate-package-'));
    const copiedPluginRoot = join(temporaryRoot, 'kimi-delegate');
    cpSync(pluginRoot, copiedPluginRoot, { recursive: true });

    const config = JSON.parse(readFileSync(join(copiedPluginRoot, 'mcp_config.json'), 'utf8'));
    const serverConfig = config.mcpServers['kimi-delegate'];
    const spawnCwd = expandPluginRoot(serverConfig.cwd, copiedPluginRoot);
    const spawnArgs = serverConfig.args.map((arg: string) => expandPluginRoot(arg, copiedPluginRoot));

    const transport = new StdioClientTransport({
      command: serverConfig.command,
      args: spawnArgs,
      cwd: spawnCwd,
      env: {
        HOME: temporaryRoot,
        PLUGIN_ROOT: copiedPluginRoot,
        PLUGIN_DATA: join(temporaryRoot, 'plugin-data'),
        KIMI_CODE_HOME: join(temporaryRoot, 'kimi-home'),
        KIMI_SERVER_TOKEN: '',
        KIMI_AUTO_START: 'false',
      },
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'portable-plugin-smoke', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const result = await client.listTools();
      const toolNames = result.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining([
        'kimi_bridge_status',
        'kimi_delegate_task',
        'kimi_delegate_and_wait',
        'kimi_review_package',
        'kimi_wait_for_prompt',
        'kimi_abort_and_wait',
      ]));
    } finally {
      await client.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  }, 15_000);

  it('contains portable release metadata', () => {
    const packageJson = JSON.parse(readFileSync(resolve('package.json'), 'utf8'));
    const manifest = JSON.parse(
      readFileSync(join(pluginRoot, 'plugin.json'), 'utf8'),
    );

    expect(packageJson).toMatchObject({
      name: 'agy-kimi-bridge',
      version: '0.3.0',
      license: 'MIT',
      engines: { node: '>=20' },
    });
    expect(manifest).toMatchObject({
      name: 'kimi-delegate',
      displayName: 'Kimi Delegate',
      version: expect.stringMatching(/^0\.3\.0$/),
      license: 'MIT',
    });
    expect(existsSync(resolve('LICENSE'))).toBe(true);

    const bundleText = readFileSync(bundlePath, 'utf8');
    expect(bundleText).toContain('0.3.0');

    const skill = readFileSync(join(pluginRoot, 'skills/kimi-delegate/SKILL.md'), 'utf8');
    expect(skill).toContain('committedChanges');
    expect(skill).toContain('workingTreeChanges');
    expect(skill).toContain('initialDirtyPaths');
  });

  it('uses a basename-aware guard so the bundle starts main exactly once', () => {
    const bundleText = readFileSync(bundlePath, 'utf8');
    expect(bundleText).not.toContain('if (import.meta.url === `file://${process.argv[1]}`)');
    expect(bundleText).toContain('isDirectExecution(import.meta.url, process.argv[1])');
  });

  it('does not package machine-specific paths or credential values', () => {
    const configText = readFileSync(join(pluginRoot, 'mcp_config.json'), 'utf8');
    const bundleText = readFileSync(bundlePath, 'utf8');

    const sanitizedBundle = bundleText
      .split('/#token=[^\\s]+/gi').join('')
      .split('#token=[redacted]').join('');
    const packagedText = `${configText}\n${sanitizedBundle}`;

    expect(packagedText).not.toContain('/Users/ximenchuifeng');
    expect(packagedText).not.toContain(resolve('.'));
    expect(packagedText).not.toContain('Authorization: Bearer');
    expect(packagedText).not.toContain('#token=');

    const configuredToken = process.env.KIMI_SERVER_TOKEN?.trim();
    if (configuredToken) expect(packagedText).not.toContain(configuredToken);
  });
});
