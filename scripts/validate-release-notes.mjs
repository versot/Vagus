import { readFile } from 'node:fs/promises';

const [path] = process.argv.slice(2);
if (!path) throw new Error('Usage: node scripts/validate-release-notes.mjs <release-note-file>');

const contents = await readFile(path, 'utf8');
if (/[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(contents)) {
  throw new Error(`${path} must be written in English and must not contain Chinese characters or punctuation.`);
}

console.log(`${path} contains no Chinese characters.`);
