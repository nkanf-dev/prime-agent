import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strict as assert } from "node:assert";
import { pathToFileURL } from "node:url";
import { NativeMeshTransport, nativeMeshAgentId, nativeMeshRequestId } from "../src/modes/daemon/native-mesh/transport.ts";

// Run with Bun and an explicit local EnvInHands checkout. Never uses a live NAS.
const root = process.env.NATIVE_MESH_ENVINHANDS_ROOT;
if (!root) throw new Error("Set NATIVE_MESH_ENVINHANDS_ROOT to a local EnvInHands checkout");
const load = (path) => import(pathToFileURL(join(root, "src", path)).href);
const { createNativeMeshApi, NativeMesh, qualifiedAgentId, meshRequestId } = await load("integrations/native-mesh.ts");
const { createAgentBus } = await load("agent-bus.ts");
const { createMutationAudit } = await load("mutation-audit.ts");
const dir = mkdtempSync(join(tmpdir(), "native-mesh-cross-check-"));
const token = "integration-test-token"; const dbPath = join(dir,"test.sqlite");
const mesh = createNativeMeshApi({dbPath,token}); const bus = createAgentBus({dbPath,token});
const audit = createMutationAudit({dbPath,token,machineId:"test-service",requireSignedMutations:true});
const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch: req => audit.dispatch(req, r => new URL(r.url).pathname === "/v1/native-mesh/agents" ? mesh.fetch(r) : bus.fetch(r))});
try {
 const url = `http://127.0.0.1:${server.port}`;
 const registration = Buffer.from(JSON.stringify({registrationId:"integration",agentId:"test-agent",sessionId:"test-session",machineId:"test-host",signature:"declared-not-crypto"})).toString("base64url");
 const client = new NativeMeshTransport({url,token,registration});
 const legacy = new NativeMesh({baseUrl:url,token,fetch: async (input, init) => {
   const headers = new Headers(init?.headers); headers.set("x-envinhands-registration", registration); headers.set("x-envinhands-operation-id", crypto.randomUUID()); return fetch(input,{...init,headers});
 }});
 const a = nativeMeshAgentId("one","same"); const b = qualifiedAgentId("two","same");
 assert.equal(a,qualifiedAgentId("one","same")); assert.notEqual(a,b);
 assert.equal(nativeMeshRequestId(a,"request"),meshRequestId(a,"request"));
 await client.register({hostId:"one",agentId:"same",parentId:null,name:"one",state:"active"});
 await legacy.register({hostId:"two",agentId:"same",parentId:null,name:"two",state:"active"});
 assert.equal((await client.discover()).length,2); assert.equal((await legacy.discover()).length,2);
 const receipt = await client.store({from:a,to:b,callerMessageId:"request",text:"hello"});
 assert.equal(receipt.deliveryStatus,"stored"); const incoming=await legacy.pull(b); assert.equal(incoming.length,1);
 await legacy.ack(incoming[0].requestId); assert.equal((await client.pending(b)).length,0);
 await legacy.send({senderId:b,recipientId:a,messageId:"response",text:"world"});
 const reverse=await client.pending(a); assert.equal(reverse.length,1); assert.equal(reverse[0].text,"world");
 await client.acknowledge(reverse[0].requestId); assert.equal((await legacy.pull(a)).length,0);
 console.log("cross-repository HTTP integration passed: strict audit, registration, discover, both-direction storage/pull/ack");
} finally { await server.stop(true); audit.close(); bus.close(); mesh.close(); rmSync(dir,{recursive:true,force:true}); }
