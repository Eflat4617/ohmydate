import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import openapiTS, { astToString } from 'openapi-typescript';

const here = dirname(fileURLToPath(import.meta.url));
const schemaPath = resolve(here, '../../../packages/contracts/openapi.json');
const outputPath = resolve(here, '../src/api/schema.d.ts');

const ast = await openapiTS(schemaPath);
const generated = astToString(ast);
const banner =
  '/* eslint-disable */\n' +
  '// Generated from packages/contracts/openapi.json by `pnpm gen:api`.\n' +
  '// Do not edit by hand; regenerate and commit instead.\n';

await writeFile(outputPath, `${banner}${generated}`, 'utf8');
console.log(`Wrote ${outputPath}`);
