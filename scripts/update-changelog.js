#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

function run(cmd) {
  try { return execSync(cmd, { cwd: root, encoding: 'utf8' }).toString().trim(); }
  catch (e) { return ''; }
}

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }

let changelog = '';
try { changelog = fs.readFileSync(changelogPath, 'utf8'); } catch (e) { changelog = '# Changelog\n\n## Unreleased\n\n'; }
const lines = changelog.split(/\r?\n/);
let unreleasedContent = '';
const unreleasedIndex = lines.findIndex(l => /^##\s+Unreleased\b/i.test(l));
if (unreleasedIndex >= 0) {
  let nextHeader = -1;
  for (let i = unreleasedIndex + 1; i < lines.length; i++) { if (/^##\s+/.test(lines[i])) { nextHeader = i; break; } }
  if (nextHeader === -1) nextHeader = lines.length;
  unreleasedContent = lines.slice(unreleasedIndex+1, nextHeader).join('\n').trim();
}

const pkg = readJSON(pkgPath || path.join(root, 'package.json'));
const currentVersion = pkg.version || '';

const revs = run('git rev-list --reverse HEAD -- package.json').split(/\r?\n/).filter(Boolean);
if (revs.length === 0) {
  // No package.json history — just preserve Unreleased
  const out = '# Changelog\n\n## Unreleased\n\n' + (unreleasedContent ? unreleasedContent + '\n\n' : '\n') + '_No version history found in git/package.json_\n';
  fs.writeFileSync(changelogPath, out, 'utf8');
  console.log('Wrote CHANGELOG.md (no git/package.json history).');
  process.exit(0);
}

let entries = [];
for (const c of revs) {
  const content = run(`git show ${c}:package.json`);
  if (!content) continue;
  let ver = '';
  try { ver = JSON.parse(content).version || ''; } catch (e) { ver = ''; }
  if (!ver) continue;
  const date = run(`git show -s --format=%ad --date=short ${c}`) || '';
  entries.push({ commit: c, version: ver, date });
}

if (entries.length === 0) {
  const out = '# Changelog\n\n## Unreleased\n\n' + (unreleasedContent ? unreleasedContent + '\n\n' : '\n') + '_No version entries found in package.json history_\n';
  fs.writeFileSync(changelogPath, out, 'utf8');
  console.log('Wrote CHANGELOG.md (no version entries).');
  process.exit(0);
}

// compress to unique version change points
let versionCommits = [];
for (let i = 0; i < entries.length; i++) {
  if (i === 0 || entries[i].version !== entries[i-1].version) versionCommits.push(entries[i]);
}

let versions = [];
for (let i = 0; i < versionCommits.length; i++) {
  const ver = versionCommits[i].version;
  const commit = versionCommits[i].commit;
  const date = versionCommits[i].date || '';
  const prevRef = (i === 0) ? run('git rev-list --max-parents=0 HEAD').split(/\r?\n/)[0] : versionCommits[i-1].commit;
  const log = run(`git log --pretty=format:"%h %ad %s" --date=short ${prevRef}..${commit}`);
  const commits = log.split(/\r?\n/).filter(Boolean);
  versions.push({ version: ver, date, commits, commit });
}

const last = versionCommits[versionCommits.length-1];
let extra = [];
if (last) {
  const extraLog = run(`git log --pretty=format:"%h %ad %s" --date=short ${last.commit}..HEAD`);
  extra = extraLog.split(/\r?\n/).filter(Boolean);
}

// build markdown: newest-first
let out = '# Changelog\n\n';
out += '## Unreleased\n\n';
out += (unreleasedContent ? unreleasedContent + '\n\n' : '\n');

for (let i = versions.length - 1; i >= 0; i--) {
  const v = versions[i];
  out += `## ${v.version} - ${v.date || '?'}\n\n`;
  if (v.commits.length === 0) {
    out += '- (no recorded commits)\n\n';
  } else {
    for (const c of v.commits) out += `- ${c}\n`;
    out += '\n';
  }
}
if (extra.length > 0) {
  out += `## ${versions[versions.length-1].version} (additional commits since package.json change) - ${extra.length} commits\n\n`;
  for (const l of extra) out += `- ${l}\n`;
  out += '\n';
}

out += '_Generated from git history by update-changelog.js._\n';

fs.writeFileSync(changelogPath, out, 'utf8');
console.log('Wrote CHANGELOG.md (synchronized with git history).');
