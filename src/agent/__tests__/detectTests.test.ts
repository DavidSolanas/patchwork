import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import nock from 'nock';
import { Octokit } from '@octokit/rest';
import { detectTestCommands } from '../detectTests.js';

const TOKEN = 'ghp_test_token';
const makeTestOctokit = () => new Octokit({ auth: TOKEN });

function mockFile(path: string, content: string) {
  nock('https://api.github.com')
    .get(`/repos/o/r/contents/${path}`)
    .reply(200, {
      type: 'file',
      encoding: 'base64',
      content: Buffer.from(content).toString('base64'),
    });
}

function mock404(path: string) {
  nock('https://api.github.com').get(`/repos/o/r/contents/${path}`).reply(404, {});
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('detectTestCommands', () => {
  it('returns npm test when package.json declares a test script', async () => {
    mockFile('package.json', JSON.stringify({ scripts: { test: 'vitest' } }));
    mock404('pytest.ini');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual(['npm test']);
  });

  it('skips package.json when no test script is declared', async () => {
    mockFile('package.json', JSON.stringify({ scripts: { build: 'tsc' } }));
    mock404('pytest.ini');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual([]);
  });

  it('detects pytest from pytest.ini', async () => {
    mock404('package.json');
    mockFile('pytest.ini', '[pytest]\n');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual(['pytest']);
  });

  it('detects pytest from pyproject.toml only when [tool.pytest] is present', async () => {
    mock404('package.json');
    mock404('pytest.ini');
    mockFile('pyproject.toml', '[project]\nname="x"\n');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual([]);
  });

  it('detects multiple stacks at once and dedupes pytest hits', async () => {
    mock404('package.json');
    mockFile('pytest.ini', '');
    mockFile('pyproject.toml', '[tool.pytest.ini_options]\n');
    mockFile('Cargo.toml', '[package]\nname="x"\n');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual(['pytest', 'cargo test']);
  });

  it('detects make test from a Makefile target', async () => {
    mock404('package.json');
    mock404('pytest.ini');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mockFile('Makefile', 'all:\n\t@echo hi\n\ntest:\n\tpytest\n');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual(['make test']);
  });

  it('returns empty when nothing matches', async () => {
    mock404('package.json');
    mock404('pytest.ini');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual([]);
  });

  it('tolerates malformed package.json', async () => {
    mockFile('package.json', '{ not valid json');
    mock404('pytest.ini');
    mock404('pyproject.toml');
    mock404('Cargo.toml');
    mock404('go.mod');
    mock404('Makefile');

    const out = await detectTestCommands({ octokit: makeTestOctokit(), owner: 'o', name: 'r' });
    expect(out).toEqual([]);
  });
});
