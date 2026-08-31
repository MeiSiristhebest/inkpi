import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

function walk(dir) {
  let results = [];
  const list = readdirSync(dir);
  for (const file of list) {
    if (['node_modules', '.git', '.trash', 'dist', 'coverage'].includes(file)) continue;
    const fullPath = join(dir, file);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      results.push(...walk(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

const allFiles = walk('.');
let changedCount = 0;

for (const file of allFiles) {
  if (file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.ico')) continue;
  try {
    const content = readFileSync(file, 'utf8');
    if (content.includes('@inkpi/')) {
      const updated = content.replaceAll('@inkpi/', '@inkpi/');
      writeFileSync(file, updated, 'utf8');
      changedCount++;
      console.log(`Updated: ${file}`);
    }
  } catch (err) {
    console.error(`Error processing ${file}:`, err);
  }
}

console.log(`\nSuccessfully migrated ${changedCount} files from @inkpi/ back to @inkpi/`);
