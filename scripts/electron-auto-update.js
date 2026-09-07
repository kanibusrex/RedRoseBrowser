#!/usr/bin/env node
'use strict';

// §8.37 — the automated half of `npm run check-electron`. Run from a
// scheduled GitHub Actions workflow
// (.github/workflows/electron-auto-update.yml), this actually performs
// a same-major Electron bump (routine Chromium/Node/security patches,
// never a breaking API version) end to end: install, smoke-test,
// commit, wait for CI, tag, wait for CI again, publish — stopping and
// flagging with a GitHub issue instead, never touching code further,
// wherever any of that doesn't check out cleanly, or where a *newer
// major* version exists (a real breaking-change risk no automated
// check here can evaluate — see DESIGN.md §8.37 for the full reasoning
// and the explicit choice, made by the project's own maintainer, to
// let the routine case publish with no human review step).
//
// Deliberately a plain, deterministic script — no LLM judgment calls in
// a security-relevant auto-publish pipeline — reusing the exact same
// gh/git commands a maintainer would type by hand (this project's own
// git history has that exact manual sequence, repeated for every
// release before this existed).

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const PACKAGE_JSON_PATH = path.join(APP_ROOT, 'package.json');
const BUILD_WORKFLOW = 'build.yml';
const WORKFLOW_WAIT_TIMEOUT_MS = 25 * 60 * 1000; // electron-builder's own mac+windows builds routinely take a few minutes each
const WORKFLOW_POLL_INTERVAL_MS = 20 * 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, { cwd: APP_ROOT, encoding: 'utf8', ...opts }).trim();
}

function runInherit(cmd, args, opts = {}) {
  console.log(`+ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { cwd: APP_ROOT, stdio: 'inherit', ...opts });
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
}

// `pkgPath` defaults to the real package.json — overridable purely so a
// test can point this at a throwaway copy instead, without the pipeline
// itself ever needing to pass anything but the default.
function writePackageJsonVersion(version, pkgPath = PACKAGE_JSON_PATH) {
  // Only touches the top-level "version" field, via a plain string
  // replace on the raw text rather than a parse+stringify round trip —
  // keeps every other field's exact formatting (key order, spacing)
  // untouched, unlike JSON.stringify which would normalize the whole
  // file and produce a much noisier diff for a one-line change.
  const raw = fs.readFileSync(pkgPath, 'utf8');
  const updated = raw.replace(/^(\s*"version"\s*:\s*")[^"]*(")/m, `$1${version}$2`);
  if (updated === raw) throw new Error('Could not find a "version" field to update in package.json');
  fs.writeFileSync(pkgPath, updated, 'utf8');
}

function bumpPatch(version) {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) throw new Error(`Unexpected version format: ${version}`);
  const [major, minor, patch] = parts;
  return `${major}.${minor}.${patch + 1}`;
}

// Electron versions are always plain X.Y.Z for stable releases;
// anything with a hyphen (35.0.0-beta.1, ...nightly...) is a pre-release
// channel this should never consider.
function isStableVersion(v) {
  return /^\d+\.\d+\.\d+$/.test(v);
}

function parseVersion(v) {
  const [major, minor, patch] = v.split('.').map(Number);
  return { major, minor, patch };
}

function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

function ghIssueAlreadyOpen(titleNeedle) {
  const out = run('gh', ['issue', 'list', '--state', 'open', '--json', 'title', '--limit', '50']);
  const issues = JSON.parse(out || '[]');
  return issues.some((issue) => issue.title.includes(titleNeedle));
}

function openIssueOnce(title, body) {
  if (ghIssueAlreadyOpen(title)) {
    console.log(`An open issue already covers "${title}" — not opening a duplicate.`);
    return;
  }
  run('gh', ['issue', 'create', '--title', title, '--body', body]);
}

// Waits for a specific workflow run to reach a terminal state, keyed by
// *both* the commit sha and which ref triggered it — a tag push and the
// branch push that landed the same commit share that sha, so sha alone
// can't tell them apart once both exist.
async function waitForWorkflowRun({ headSha, headBranch }) {
  const deadline = Date.now() + WORKFLOW_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const out = run('gh', [
      'run',
      'list',
      '--workflow',
      BUILD_WORKFLOW,
      '--json',
      'databaseId,headSha,headBranch,status,conclusion,url',
      '--limit',
      '20',
    ]);
    const runs = JSON.parse(out || '[]');
    const match = runs.find((r) => r.headSha === headSha && r.headBranch === headBranch);
    if (match) {
      if (match.status === 'completed') {
        console.log(`Run ${match.url} completed: ${match.conclusion}`);
        return match.conclusion === 'success';
      }
      console.log(`Run ${match.url} is still ${match.status} — waiting...`);
    } else {
      console.log(`No ${BUILD_WORKFLOW} run for ${headBranch}@${headSha} yet — waiting...`);
    }
    await sleep(WORKFLOW_POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${BUILD_WORKFLOW} on ${headBranch}@${headSha} to finish.`);
}

function discardWorkingTreeChanges() {
  try {
    run('git', ['checkout', '--', '.']);
    run('git', ['clean', '-fd', '--', 'node_modules', 'package-lock.json']);
  } catch (err) {
    console.warn('Could not fully discard working tree changes:', err.message);
  }
}

async function main() {
  // --dry-run: the decision logic only (a real npm registry read), with
  // every write anywhere — npm install, the smoke test, every git/gh
  // command — skipped and just described instead. Doesn't need
  // RELEASE_PAT/gh auth at all, unlike a real run, specifically so this
  // is safe to run by anyone, anytime, against the real repo, including
  // by hand while reviewing this pipeline itself before ever trusting
  // it unattended.
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('--dry-run: read-only, nothing below will actually change anything.\n');

  // Fail fast and clearly if the PAT this whole pipeline depends on
  // (to actually trigger build.yml on push — the default GITHUB_TOKEN
  // deliberately can't, see DESIGN.md §8.37) isn't wired up correctly,
  // rather than failing confusingly partway through.
  if (!dryRun) {
    try {
      run('gh', ['auth', 'status']);
    } catch (err) {
      console.error(
        'gh is not authenticated — this workflow needs a repo secret named RELEASE_PAT ' +
          '(a fine-grained personal access token scoped to this repo with Contents: read/write) ' +
          'set as GH_TOKEN for this to be able to push commits/tags that actually trigger build.yml. ' +
          'See DESIGN.md §8.37 for the exact setup steps.'
      );
      throw err;
    }
  }

  const installedVersion = require(path.join(APP_ROOT, 'node_modules', 'electron', 'package.json')).version;
  console.log(`Installed Electron: ${installedVersion}`);

  const versionsRaw = run('npm', ['view', 'electron', 'versions', '--json']);
  const allVersions = JSON.parse(versionsRaw).filter(isStableVersion);
  const installedMajor = parseVersion(installedVersion).major;

  const sameMajorVersions = allVersions.filter((v) => parseVersion(v).major === installedMajor);
  const latestSameMajor = sameMajorVersions.sort(compareVersions).pop();

  const newerMajors = allVersions.filter((v) => parseVersion(v).major > installedMajor);
  if (newerMajors.length > 0) {
    const highestNewerMajor = newerMajors.sort(compareVersions).pop();
    const issueTitle = `A newer Electron major version is available (${highestNewerMajor})`;
    if (dryRun) {
      console.log(`[dry run] would open/check an issue: "${issueTitle}"`);
    } else {
      openIssueOnce(
        issueTitle,
        `Electron ${highestNewerMajor} is out — a major version bump (currently on ${installedMajor}.x). ` +
          `This is never auto-applied (breaking API changes are possible; see ` +
          `https://www.electronjs.org/docs/latest/breaking-changes). To upgrade by hand:\n\n` +
          '```\nnpm install --save-dev electron@' +
          highestNewerMajor +
          '\nnpm start   # confirm the app still launches cleanly\n```\n\n' +
          `This issue was opened automatically by .github/workflows/electron-auto-update.yml (DESIGN.md §8.37) ` +
          `and won't be duplicated while it stays open.`
      );
    }
  }

  if (!latestSameMajor || compareVersions(latestSameMajor, installedVersion) <= 0) {
    console.log(`Already on the latest Electron ${installedMajor}.x release (${installedVersion}) — nothing to do.`);
    return;
  }

  console.log(`Newer same-major Electron available: ${installedVersion} -> ${latestSameMajor}`);

  if (dryRun) {
    console.log(
      `[dry run] would: npm install --save-dev electron@${latestSameMajor}, run the smoke test, and if it passes, ` +
        `commit, push to main, wait for CI, tag v${bumpPatch(readPackageJson().version)}, push the tag, wait for CI ` +
        `again, then publish that release.`
    );
    return;
  }

  run('npm', ['install', '--save-dev', `electron@${latestSameMajor}`]);

  console.log('\nRunning the smoke test against the bumped Electron...');
  try {
    runInherit('node', ['scripts/smoke-test.js']);
  } catch (err) {
    console.error('Smoke test failed — discarding the bump, not committing anything.');
    discardWorkingTreeChanges();
    openIssueOnce(
      `Automated Electron bump to ${latestSameMajor} failed its smoke test`,
      `Bumping Electron from ${installedVersion} to ${latestSameMajor} made the app fail \`npm run smoke-test\` ` +
        `(it either didn't launch or its chrome window never loaded). Nothing was committed. ` +
        `Needs manual investigation — try \`npm install --save-dev electron@${latestSameMajor} && npm run smoke-test\` ` +
        `locally to reproduce.\n\nThis issue was opened automatically by ` +
        `.github/workflows/electron-auto-update.yml (DESIGN.md §8.37) and won't be duplicated while it stays open.`
    );
    process.exitCode = 1;
    return;
  }
  console.log('Smoke test passed.');

  const pkg = readPackageJson();
  const newAppVersion = bumpPatch(pkg.version);
  writePackageJsonVersion(newAppVersion);

  run('git', ['add', '-A']);
  run('git', [
    'commit',
    '-m',
    `Bump Electron to ${latestSameMajor} (automated security/patch update)\n\n` +
      `Same-major bump (${installedMajor}.x) — routine Chromium/Node/security patches, ` +
      `verified via npm run smoke-test before this commit was made.\n\n` +
      `Automated by .github/workflows/electron-auto-update.yml — see DESIGN.md §8.37.`,
  ]);
  const commitSha = run('git', ['rev-parse', 'HEAD']);
  run('git', ['push', 'origin', 'HEAD:main']);

  console.log(`\nPushed ${commitSha} to main — waiting for ${BUILD_WORKFLOW} to build it...`);
  const mainBuildOk = await waitForWorkflowRun({ headSha: commitSha, headBranch: 'main' });
  if (!mainBuildOk) {
    openIssueOnce(
      `Electron ${latestSameMajor} bump landed on main but CI failed`,
      `Commit ${commitSha} (bumping Electron to ${latestSameMajor}) passed the local smoke test but failed ` +
        `${BUILD_WORKFLOW} on main. The commit is already on main; no tag was created and nothing was published. ` +
        `Needs manual investigation.\n\nAutomated by .github/workflows/electron-auto-update.yml — see DESIGN.md §8.37.`
    );
    process.exitCode = 1;
    return;
  }
  console.log('main build succeeded.');

  const tag = `v${newAppVersion}`;
  run('git', ['tag', '-a', tag, '-m', tag]);
  run('git', ['push', 'origin', tag]);

  console.log(`\nPushed tag ${tag} — waiting for ${BUILD_WORKFLOW} to build and draft the release...`);
  const tagBuildOk = await waitForWorkflowRun({ headSha: commitSha, headBranch: tag });
  if (!tagBuildOk) {
    openIssueOnce(
      `${tag} (Electron ${latestSameMajor}) tagged but the release build failed`,
      `Tag ${tag} was pushed (Electron bump to ${latestSameMajor}) but ${BUILD_WORKFLOW}'s tag build failed, ` +
        `so no release was published. Whatever draft release exists for ${tag}, if any, was left as-is. ` +
        `Needs manual investigation.\n\nAutomated by .github/workflows/electron-auto-update.yml — see DESIGN.md §8.37.`
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nPublishing the ${tag} release...`);
  run('gh', ['release', 'edit', tag, '--draft=false']);
  console.log(`\nDone — ${tag} (Electron ${latestSameMajor}) is published.`);
}

// require.main check (not a bare call) so this can also be required by
// a test script for its pure helpers below — bumpPatch/isStableVersion/
// compareVersions/writePackageJsonVersion in particular — without that
// accidentally kicking off the real pipeline (git pushes, tags,
// gh issue/release calls) against the real repo.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = { isStableVersion, parseVersion, compareVersions, bumpPatch, writePackageJsonVersion };
