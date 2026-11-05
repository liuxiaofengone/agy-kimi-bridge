import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KimiApiError, KimiNetworkError } from '../src/errors.js';
import { isDirectExecution, runToolHandler } from '../src/index.js';

describe('isDirectExecution', () => {
  // Exercise real platform behavior: build native absolute paths (with spaces
  // and non-ASCII characters) and derive the module URL the same way Node
  // does at process startup, instead of hardcoding POSIX-shaped literals.
  const nativeRoot = join(tmpdir(), 'codex kimi 桥 entry');
  const entryPath = join(nativeRoot, 'dist 目录', 'index.js');
  const entryUrl = pathToFileURL(entryPath).href;

  it('returns true when the module URL matches the argv entry path and basename is index.js', () => {
    expect(isDirectExecution(entryUrl, entryPath)).toBe(true);
  });

  it('compares normalized absolute paths', () => {
    const dottyUrl = pathToFileURL(join(nativeRoot, 'dist 目录', '.', 'nested', '..', 'index.js')).href;
    expect(isDirectExecution(dottyUrl, entryPath)).toBe(true);
  });

  it('accepts forward-slash argv paths only where the platform treats them as native', () => {
    const winEntry = 'C:\\repo 目录\\dist\\index.js';
    const winEntryForwardSlashes = 'C:/repo 目录/dist/index.js';
    // Windows APIs accept both separators for the same file; POSIX does not.
    expect(isDirectExecution(pathToFileURL(winEntry).href, winEntryForwardSlashes))
      .toBe(process.platform === 'win32');
  });

  it('returns false when the module URL differs from the argv importer path', () => {
    // Importing dist/index.js from another entry (e.g. server.mjs) must not auto-start.
    expect(isDirectExecution('file:///some/path/dist/index.js', '/some/path/mcp/server.mjs')).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.js', '/some/other/importer.mjs')).toBe(false);
  });

  it('returns false when the argv entry basename is not index.js', () => {
    expect(isDirectExecution('file:///some/path/mcp/server.mjs', '/some/path/mcp/server.mjs')).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.mjs', '/some/path/dist/index.mjs')).toBe(false);
  });

  it('returns false for missing, empty, or invalid argv path', () => {
    expect(isDirectExecution('file:///some/path/dist/index.js', undefined)).toBe(false);
    expect(isDirectExecution('file:///some/path/dist/index.js', '')).toBe(false);
  });

  it('returns false for malformed module URLs', () => {
    expect(isDirectExecution('not-a-url', '/some/path/dist/index.js')).toBe(false);
    expect(isDirectExecution('', '/some/path/dist/index.js')).toBe(false);
  });
});

describe('runToolHandler', () => {
  it('returns successful results as MCP text content', async () => {
    const result = await runToolHandler(async () => ({ ok: true }));
    expect(result).toEqual({
      content: [{ type: 'text', text: JSON.stringify({ ok: true }, null, 2) }],
    });
  });

  it('returns structured MCP errors for KimiApiError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiApiError(40001, 'bad request', 'req_123', { field: 'name' });
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toEqual({
      error: 'bad request',
      code: 40001,
      requestId: 'req_123',
      details: { field: 'name' },
    });
  });

  it('returns structured MCP errors for KimiNetworkError', async () => {
    const result = await runToolHandler(async () => {
      throw new KimiNetworkError('connection refused', new Error('ECONNREFUSED'));
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('connection refused');
    expect(parsed.code).toBe('NETWORK');
  });

  it('returns structured MCP errors for unexpected errors', async () => {
    const result = await runToolHandler(async () => {
      throw new Error('boom');
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('boom');
    expect(parsed.code).toBe('UNKNOWN');
  });
});

describe('MCP server identity', () => {
  it('reports plugin version 0.3.0 in the source', () => {
    const source = readFileSync(resolve('src/index.ts'), 'utf8');
    expect(source).toContain("version: '0.3.0'");
  });
});
