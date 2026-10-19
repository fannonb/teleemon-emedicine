import { readFileSync, statSync } from 'node:fs';
import { validateMigration } from '../packages/core/src/migration';

// Deliberately offline: validation never signs in or writes patient records.
const filename = process.argv[2];
if (!filename) throw new Error('Usage: npm run migration:validate -- <normalized-export.json>');
if (statSync(filename).size > 10 * 1024 * 1024) throw new Error('Export exceeds the 10 MB staging limit. Split the export.');
const result = validateMigration(JSON.parse(readFileSync(filename, 'utf8')));
// Only row numbers, fields and counts are printed; no patient values.
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.valid ? 0 : 1;
