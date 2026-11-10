import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../packages/contracts/openapi.json');
const outputPath = resolve(here, '../src/api/schema.d.ts');

const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const ast = await openapiTS(schema);
const generated = astToString(ast);
const banner =
  '// Generated from packages/contracts/openapi.json by `pnpm gen:api`.\n' +
  '// Do not edit by hand; regenerate and commit instead.\n';

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${banner}${generated}`, 'utf8');
console.log(`Wrote ${outputPath}`);
