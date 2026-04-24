#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;

function* walk(dir, depth = 0) {
	if (depth > 12) return;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (
				e.name === 'node_modules' ||
				e.name === 'dist' ||
				e.name === '.turbo' ||
				e.name === 'coverage' ||
				e.name === '.git' ||
				e.name === '.pnpm-store'
			)
				continue;
			yield* walk(p, depth + 1);
		} else if (e.isFile()) {
			yield p;
		}
	}
}

function hasTestFiles(pkgDir) {
	for (const file of walk(pkgDir)) {
		if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return file;
	}
	return null;
}

function findPackageJsons() {
	const out = [];
	const roots = [join(repoRoot, 'packages'), join(repoRoot, 'cypress')];
	for (const r of roots) {
		try {
			statSync(r);
		} catch {
			continue;
		}
		for (const file of walk(r)) {
			if (file.endsWith('/package.json') && !file.includes('/template/')) out.push(file);
		}
	}
	return out;
}

const empty = [];
const populated = [];
for (const pj of findPackageJsons()) {
	let json;
	try {
		json = JSON.parse(readFileSync(pj, 'utf8'));
	} catch {
		continue;
	}
	const t = json?.scripts?.test;
	if (typeof t !== 'string') continue;
	if (!/(^|[\s&;])jest($|[\s&;-])/.test(t)) continue;
	if (/--passWithNoTests/.test(t)) continue;
	const dir = pj.replace(/\/package\.json$/, '');
	const sample = hasTestFiles(dir);
	if (!sample) {
		empty.push({ name: json.name, dir: dir.replace(repoRoot, ''), test: t });
	} else {
		populated.push({ name: json.name, sample: sample.replace(repoRoot, '') });
	}
}

console.log('## Packages with "test: jest" (no --passWithNoTests) and ZERO test files:');
for (const p of empty) console.log(`  ${p.name}  (test=${JSON.stringify(p.test)})  :: ${p.dir}`);
console.log(`\nTotal empty: ${empty.length}`);
console.log(`Total with tests: ${populated.length}`);
