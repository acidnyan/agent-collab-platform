// SPDX-License-Identifier: Apache-2.0
import { it, expect, describe } from 'vitest';
import { happyPath, privilegeScenario, budgetScenario, tamperScenario } from '../examples/two-owner-demo/run-demo.js';
describe('WP-6 two-owner E2E acceptance scenarios',()=>{
  it('happy path: SDK MCP -> isolated execution -> three-stage verification -> SETTLED / VALID',async()=>{const r=await happyPath();expect(r.state).toBe('SETTLED');expect(r.audit).toBe('VALID');expect(r.stages).toEqual(['crypto_budget','schema_isolated_check','owner_approval']);});
  it('blocks unpermitted tools, argument violations, call exhaustion and every attenuation escalation',async()=>{const r=await privilegeScenario();expect(r.status).toBe('CAPABILITY_VIOLATION');expect(r.blocked).toBeGreaterThanOrEqual(12);});
  it('halts over-budget execution and rejects its signed receipt',async()=>expect(await budgetScenario()).toMatchObject({halted:true,event:'VERIFY_REJECT'}));
  it('rejects artifact, schema, relay and audit tampering',async()=>expect(await tamperScenario()).toMatchObject({detected:8,event:'VERIFY_REJECT',audit:'INVALID'}));
});
