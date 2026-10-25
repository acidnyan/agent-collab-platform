// SPDX-License-Identifier: Apache-2.0
// Public synthetic test seed, never an operational owner credential.
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { canonicalize, digest, signPayload, generateKeyPair, createCapability, signApproval, signUsage, signEnvelope, signAck } from '../packages/core/src/index.js';
import { BilateralLedger } from '../packages/ledger/src/index.js';
const seedHex = '0000000000000000000000000000000000000000000000000000000000000000';
const privateObject = createPrivateKey({ key: Buffer.from('302e020100300506032b657004220420' + seedHex, 'hex'), type: 'pkcs8', format: 'der' });
const raw = Buffer.concat([Buffer.from([0xed,1]),createPublicKey(privateObject).export({format:'der',type:'spki'}).subarray(-32)]);
const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let n=BigInt('0x'+raw.toString('hex')), encoded=''; while(n){encoded=alphabet[Number(n%58n)]+encoded;n/=58n;}
const alice = { did:'did:key:z'+encoded, privateKey:privateObject.export({format:'pem',type:'pkcs8'}).toString() };
const bob=generateKeyPair();
const input = { z: [1e30, 4.5, 0.002, 1e-27], a: '€\r\n日本語😀', nested: { b: true, a: null } };
const timestamp='2026-10-25T00:00:00.000Z';
writeFileSync('conformance/jcs-signing-vectors.json',JSON.stringify({description:'Synthetic all-zero Ed25519 test seed; never use as an owner key. Signature covers {payload,signerDid,canonicalization,payloadDigest,signedAt}.',seedHex,cases:[{input,canonical:canonicalize(input),digest:digest(input),signed:signPayload(input,alice,timestamp)}]},null,2)+'\n');
const taskId='task_examples01';
const cap=createCapability({audience:bob.did,taskId,resource:'mcp://alice/docs/*',allowedTools:['docs/read'],argConstraints:{'docs/read':{type:'object',required:['uri'],properties:{uri:{type:'string'}},additionalProperties:false}},maxCalls:2,notBefore:timestamp,expiresAt:'2099-01-01T00:00:00Z',maxDepth:1},alice);
const usage=signUsage({type:'UsageReceipt',taskId,inputTokens:1,outputTokens:2,totalTokens:3,toolCalls:1,wallTimeMs:100,halted:false},bob);
const approval=signApproval(taskId,'contract_acceptance',{contract:'example'},alice);
const envelope=signEnvelope({taskId,recipientDid:bob.did,seq:0,eventType:'PROPOSE',payload:{example:true}},alice);
const ledger=new BilateralLedger(taskId,[alice.did,bob.did]); const entry=ledger.append('PROPOSE',{example:true},alice,bob);
const examples: Record<string,unknown>={'capability-token':cap,'usage-receipt':usage,'approval-receipt':approval,'envelope':envelope,'audit-entry':entry,'ack-receipt':entry.counterSignature};
for(const [name,example] of Object.entries(examples))writeFileSync('spec/examples/sample-'+name+'.json',JSON.stringify(example,null,2)+'\n');
