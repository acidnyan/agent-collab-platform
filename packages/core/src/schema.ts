// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import type { TaskManifest, Schema } from './types.js';
export function createAjv() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
  (formats as unknown as (a: Ajv2020) => void)(ajv);
  return ajv;
}
export const specDirectory = new URL('../../../spec/', import.meta.url);
export function loadSchema(name: string): Schema {
  if (!/^[a-z-]+$/.test(name)) throw new Error('INVALID_SCHEMA_NAME');
  return JSON.parse(readFileSync(new URL(name + '.schema.json', specDirectory), 'utf8')) as Schema;
}
export function schemaRegistry() {
  const ajv = createAjv();
  for (const f of readdirSync(specDirectory).filter((f) => f.endsWith('.schema.json')))
    ajv.addSchema(loadSchema(f.slice(0, -12)), f.slice(0, -12));
  return ajv;
}
export function validateSchema(name: string, value: unknown): void {
  const ajv = schemaRegistry();
  const validate = ajv.getSchema(name)!;
  if (!validate(value)) throw new Error('SCHEMA_VIOLATION: ' + ajv.errorsText(validate.errors));
}
export function validateManifest(value: unknown): asserts value is TaskManifest {
  validateSchema('task-manifest', value);
}
export function assertSynchronousSchema(schema: unknown): void {
  if (!schema || typeof schema !== 'object') return;
  if (Object.hasOwn(schema, '$async')) throw new Error('ASYNC_SCHEMA_FORBIDDEN');
  for (const value of Object.values(schema)) assertSynchronousSchema(value);
}
export function validateOutput(schema: Schema, value: unknown): boolean {
  assertSynchronousSchema(schema);
  return createAjv().compile(schema)(value) === true;
}
