#!/usr/bin/env node
// Portable Codex plugin package validator for this repository.
// Runs on Node >= 20 with no third-party dependencies and no machine-specific
// paths, so a fresh clone can validate the plugin on any platform:
//
//   node scripts/validate-plugin.mjs plugins/kimi-delegate
//
// Exits 0 when the package is well-formed; exits 1 and prints every detected
// problem otherwise.
//
// Trust boundary: every path that is read or accepted (manifest, skill files,
// MCP config, server cwd, bundle) goes through the same two guards:
//   1. plugin-relative + lexical containment inside the plugin root, and
//   2. realpath containment, so symlinks/junctions cannot smuggle in targets
//      outside the root.
// Problems are reported with fixed messages that never echo file contents or
// underlying error text, so neither configuration secrets nor tokens can leak
// through validation output.

import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

const problems = [];
const fail = (message) => problems.push(message);

// Full SemVer 2.0.0: numeric identifiers without leading zeros, non-empty
// dot-separated prerelease/build identifiers, prerelease and build may coexist.
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function fileType(stat) {
  return stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'non-regular file';
}

// Parse JSON without ever surfacing input content: error messages from
// JSON.parse can quote the offending token (including secrets), so only a
// fixed description plus the byte position is reported.
function readJsonSecure(file, label) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    fail(`${label}: cannot read file`);
    return { text: undefined, value: undefined };
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch (error) {
    const position = /position (\d+)/.exec(error?.message ?? '');
    fail(`${label}: invalid JSON` + (position ? ` at position ${position[1]}` : ''));
    return { text, value: undefined };
  }
}

// Central guard #2: the real target of `target` must exist, must stay inside
// the plugin root (symlink/junction escape rejection), and must have the
// expected file type. Returns { real, stat } or undefined after recording a
// failure. A failed guard always records a problem — an escaped link is never
// silently skipped just because other valid entries exist.
function guardRealTarget(rootReal, label, target, { expectDir = false } = {}) {
  let real;
  try {
    real = realpathSync(target);
  } catch {
    fail(`${label}: path does not exist: ${target}`);
    return undefined;
  }
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    fail(`${label}: resolves outside the plugin root (symlink/junction escape): ${target} -> ${real}`);
    return undefined;
  }
  let stat;
  try {
    stat = statSync(real);
  } catch {
    fail(`${label}: cannot stat resolved path: ${target}`);
    return undefined;
  }
  if (expectDir && !stat.isDirectory()) {
    fail(`${label}: expected a directory, got ${fileType(stat)}: ${target}`);
    return undefined;
  }
  if (!expectDir && !stat.isFile()) {
    fail(`${label}: expected a file, got ${fileType(stat)}: ${target}`);
    return undefined;
  }
  return { real, stat };
}

// Central guard #1: a plugin-relative path must resolve lexically inside the
// plugin root. Absolute paths are rejected outright — pointing back into the
// same checkout is still not a portable, plugin-relative reference.
function guardPluginRelative(pluginRoot, label, value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label}: must be a non-empty plugin-relative string`);
    return undefined;
  }
  if (isAbsolute(value)) {
    fail(`${label}: must be plugin-relative, not absolute: ${value}`);
    return undefined;
  }
  const resolved = resolve(pluginRoot, value);
  if (resolved !== pluginRoot && !resolved.startsWith(pluginRoot + sep)) {
    fail(`${label}: escapes the plugin root: ${value}`);
    return undefined;
  }
  return resolved;
}

function scanMachineSpecific(text, label) {
  if (text.includes('/Users/')) fail(`${label}: contains a macOS user directory path`);
  if (/[A-Za-z]:[\\/]+Users[\\/]/.test(text)) fail(`${label}: contains a Windows user directory path`);
  if (text.includes('Authorization: Bearer')) fail(`${label}: contains an Authorization bearer header`);
  // Allow the bundle's own token-redaction regex literal and its replacement
  // string; anything else carrying a token query is a leak.
  const sanitized = text.split('/#token=[^\\s]+/gi').join('').split('#token=[redacted]').join('');
  if (sanitized.includes('#token=')) fail(`${label}: contains a token-bearing URL`);
}

// Walk the skill tree, guarding every directory and every recognized
// SKILL.md with the same realpath containment rules. Symlinked directories
// inside the tree are followed only when their real target stays in the root;
// an escape is a hard failure, not an ignore.
function collectSkillFiles(rootReal, dir, label, depth, found) {
  const dirInfo = guardRealTarget(rootReal, `${label}: directory`, dir, { expectDir: true });
  if (!dirInfo) return found;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    fail(`${label}: cannot read directory: ${dir}`);
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      // Resolve the link target first: escapes fail here, before any read.
      const info = guardRealTarget(rootReal, `${label}: ${full}`, full);
      if (!info) continue;
      if (info.stat.isDirectory()) {
        if (depth + 1 > 3) {
          fail(`${label}: directory nesting deeper than 3 levels: ${full}`);
          continue;
        }
        collectSkillFiles(rootReal, full, label, depth + 1, found);
      } else if (entry.name === 'SKILL.md') {
        found.push(full);
      }
    } else if (entry.isDirectory()) {
      if (depth + 1 > 3) {
        fail(`${label}: directory nesting deeper than 3 levels: ${full}`);
        continue;
      }
      collectSkillFiles(rootReal, full, label, depth + 1, found);
    } else if (entry.name === 'SKILL.md') {
      if (guardRealTarget(rootReal, `${label}: ${full}`, full)) {
        found.push(full);
      }
    }
  }
  return found;
}

function validate(pluginRootArg) {
  if (!pluginRootArg) {
    fail('usage: node scripts/validate-plugin.mjs <plugin-root>');
    return;
  }
  const pluginRoot = resolve(pluginRootArg);
  if (!existsSync(pluginRoot) || !statSync(pluginRoot).isDirectory()) {
    fail(`plugin root not found or not a directory: ${pluginRoot}`);
    return;
  }
  let rootReal;
  try {
    rootReal = realpathSync(pluginRoot);
  } catch {
    fail(`plugin root cannot be resolved: ${pluginRoot}`);
    return;
  }

  // 1. Manifest: plugin-relative location, real target inside the root, and
  //    the fields Codex needs to install and display the plugin.
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const manifestInfo = guardRealTarget(rootReal, 'plugin manifest', manifestPath);
  if (!manifestInfo) return;
  const { text: manifestText, value: manifest } = readJsonSecure(manifestInfo.real, 'plugin manifest');
  if (manifestText !== undefined) scanMachineSpecific(manifestText, 'plugin manifest');
  // Root type gate: valid JSON of the wrong shape (null, a number, a string,
  // false, or an array) must fail with a fixed message, never exit 0. Field
  // checks below still run against an empty object so every schema problem is
  // reported in one pass.
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fail('plugin manifest: root value must be a non-null, non-array JSON object');
  }
  const manifestObject = manifest !== null && typeof manifest === 'object' && !Array.isArray(manifest)
    ? manifest
    : {};

  if (typeof manifestObject.name !== 'string' || manifestObject.name.length === 0) fail('manifest: name must be a non-empty string');
  if (typeof manifestObject.version !== 'string' || !SEMVER_RE.test(manifestObject.version)) {
    fail('manifest: version must be a full semantic version, got ' + JSON.stringify(manifestObject.version));
  }
  if (typeof manifestObject.author?.name !== 'string' || manifestObject.author.name.length === 0) fail('manifest: author.name is required');
  if (typeof manifestObject.interface?.developerName !== 'string' || manifestObject.interface.developerName.length === 0) {
    fail('manifest: interface.developerName is required');
  }
  if (typeof manifestObject.license !== 'string' || manifestObject.license.length === 0) fail('manifest: license is required');
  if (typeof manifestObject.homepage !== 'string' || manifestObject.homepage.length === 0) fail('manifest: homepage is required');
  if (typeof manifestObject.repository !== 'string' || manifestObject.repository.length === 0) fail('manifest: repository is required');

  // 2. Skills: plugin-relative path whose real directory target stays in the
  //    root, with at least one guarded SKILL.md.
  let mcpConfigPath;
  if (manifestObject.skills !== undefined) {
    const skillsDir = guardPluginRelative(pluginRoot, 'manifest: skills', manifestObject.skills);
    if (skillsDir) {
      if (guardRealTarget(rootReal, 'manifest: skills', skillsDir, { expectDir: true })) {
        const skillFiles = collectSkillFiles(rootReal, skillsDir, 'skills tree', 0, []);
        if (skillFiles.length === 0) {
          fail('manifest: no SKILL.md found under the skills path');
        }
      }
    }
  } else {
    fail('manifest: skills must be a plugin-relative path');
  }

  // 3. MCP config: same two guards, then per-server packaging rules.
  if (manifestObject.mcpServers !== undefined) {
    mcpConfigPath = guardPluginRelative(pluginRoot, 'manifest: mcpServers', manifestObject.mcpServers);
  } else {
    fail('manifest: mcpServers must be a plugin-relative path');
  }

  if (!mcpConfigPath) return;
  const mcpInfo = guardRealTarget(rootReal, 'mcp config', mcpConfigPath);
  if (!mcpInfo) return;
  const { text: mcpText, value: mcpConfig } = readJsonSecure(mcpInfo.real, 'mcp config');
  if (mcpText !== undefined) scanMachineSpecific(mcpText, 'mcp config');
  if (mcpConfig === null || typeof mcpConfig !== 'object' || Array.isArray(mcpConfig)) {
    fail('mcp config: root value must be a non-null, non-array JSON object');
    return;
  }
  const servers = mcpConfig.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers) || Object.keys(servers).length === 0) {
    fail('mcp config: mcpServers must define at least one server');
    return;
  }
  for (const [serverName, server] of Object.entries(servers)) {
    if (server === null || typeof server !== 'object' || Array.isArray(server)) {
      fail(`mcp config: server ${serverName} must be a non-null, non-array object`);
      continue;
    }
    if (typeof server.command !== 'string' || server.command.length === 0) {
      fail(`mcp config: server ${serverName} is missing a command`);
      continue;
    }
    if (server.command !== 'node' && !/^node\d*$/.test(server.command)) {
      fail(`mcp config: server ${serverName} command must be a portable node executable, got ${JSON.stringify(server.command)}`);
    }
    if (!Array.isArray(server.args) || server.args.length === 0) {
      fail(`mcp config: server ${serverName} must declare bundle args`);
      continue;
    }
    // cwd must be a plugin-relative directory when present; an absolute path
    // keeps working only on the machine that produced it, so it is refused
    // even when it happens to point inside this checkout.
    let serverCwd = pluginRoot;
    if (server.cwd !== undefined) {
      const guardedCwd = guardPluginRelative(pluginRoot, `mcp config: server ${serverName} cwd`, server.cwd);
      if (guardedCwd) {
        if (guardRealTarget(rootReal, `mcp config: server ${serverName} cwd`, guardedCwd, { expectDir: true })) {
          serverCwd = guardedCwd;
        }
      }
    }
    for (const arg of server.args) {
      if (typeof arg !== 'string' || isAbsolute(arg)) {
        fail(`mcp config: server ${serverName} arg must be plugin-relative, got ${JSON.stringify(arg)}`);
        continue;
      }
      const bundlePath = resolve(serverCwd, arg);
      if (bundlePath !== pluginRoot && !bundlePath.startsWith(pluginRoot + sep)) {
        fail(`mcp config: server ${serverName} arg escapes the plugin root: ${arg}`);
        continue;
      }
      const bundleInfo = guardRealTarget(rootReal, `mcp config: server ${serverName} bundle`, bundlePath);
      if (!bundleInfo) continue;
      if (bundleInfo.stat.size === 0) {
        fail(`mcp config: server ${serverName} bundle is empty: ${arg}`);
      } else {
        scanMachineSpecific(readFileSync(bundleInfo.real, 'utf8'), `bundle ${arg}`);
      }
    }
    // env, when present, must be a non-null, non-array object whose values
    // are all strings; token-like keys must stay empty. Type failures use
    // fixed messages that never echo the offending value.
    if (server.env !== undefined) {
      if (server.env === null || typeof server.env !== 'object' || Array.isArray(server.env)) {
        fail(`mcp config: server ${serverName} env must be a non-null, non-array object`);
      } else {
        for (const [key, value] of Object.entries(server.env)) {
          if (typeof value !== 'string') {
            fail(`mcp config: server ${serverName} env ${key} must be a string`);
          } else if (/token/i.test(key) && value.trim() !== '') {
            fail(`mcp config: server ${serverName} env ${key} must stay empty; tokens are resolved at runtime`);
          }
        }
      }
    }
  }
}

validate(process.argv[2]);

if (problems.length > 0) {
  process.stderr.write(`plugin validation failed (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n`);
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.exit(1);
}
process.stdout.write('plugin validation passed\n');
