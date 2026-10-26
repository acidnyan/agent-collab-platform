// SPDX-License-Identifier: Apache-2.0
import { readdirSync, readFileSync } from 'node:fs';
import { schemaRegistry, specDirectory } from '../packages/core/src/index.js';
const ajv = schemaRegistry();
for (const name of readdirSync(specDirectory).filter((x) => x.endsWith('.schema.json'))) {
  const schema = JSON.parse(readFileSync(new URL(name, specDirectory), 'utf8'));
  if (!ajv.validateSchema(schema)) throw new Error(name + ': ' + ajv.errorsText());
  ajv.getSchema(name.slice(0, -12));
}
for (const name of readdirSync(new URL('examples/', specDirectory)).filter((x) =>
  x.endsWith('.json'),
)) {
  const kind = name.replace(/^sample-/, '').replace(/\.json$/, '');
  const validate = ajv.getSchema(kind);
  if (!validate) throw new Error('No schema for ' + name);
  if (!validate(JSON.parse(readFileSync(new URL('examples/' + name, specDirectory), 'utf8'))))
    throw new Error(name + ': ' + ajv.errorsText(validate.errors));
}
console.log('All Draft 2020-12 schemas and examples VALID');
