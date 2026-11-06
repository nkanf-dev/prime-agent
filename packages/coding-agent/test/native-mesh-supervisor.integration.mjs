import {spawn} from 'node:child_process';
import {mkdirSync,readFileSync,writeFileSync,rmSync,existsSync,mkdtempSync,readdirSync} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import {join, resolve} from 'node:path';
import {DaemonClient} from '../src/modes/daemon/daemon-client.ts';
import {nativeMeshAgentId} from '../src/modes/daemon/native-mesh/transport.ts';
import {NativeMeshOperations} from '../src/modes/daemon/native-mesh/operations.ts';
// Optional cross-repository process test. Run with Node + tsx loader and
// NATIVE_MESH_ENVINHANDS_ROOT pointing to a local EnvInHands checkout.
const envRoot = process.env.NATIVE_MESH_ENVINHANDS_ROOT;
if (!envRoot) throw new Error('Set NATIVE_MESH_ENVINHANDS_ROOT to a local checkout');
const proot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const root=mkdtempSync(join(tmpdir(), 'native-mesh-process-')), token='test-only';
const probe=createServer();
await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
const port=probe.address().port;
await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
const envbase={...process.env, HOME:join(root,'home'), XDG_CONFIG_HOME:join(root,'xdg-config'), XDG_CACHE_HOME:join(root,'xdg-cache'), XDG_DATA_HOME:join(root,'xdg-data'), PYTHONPATH:join(proot,'packages/coding-agent/skills/agent-message/src'), PYTHONDONTWRITEBYTECODE:'1', TSX_TSCONFIG_PATH:proot+'/tsconfig.json',PI_OFFLINE:'1'};
for (const k of Object.keys(envbase)) if ((k.startsWith('PRIME_AGENT_') && k !== 'PRIME_AGENT_KERNEL_PYTHON') || k.startsWith('RLM_') || k.startsWith('ENVINHANDS_') || k.startsWith('PRIME_MESH_TEST_')) delete envbase[k];
const kids=[], clients=[], logs={};
// test-policy: allow wall-clock-timer -- Real separate processes and remote polling have no shared deterministic clock; this bounded cadence checks eventual state, not timing behavior.
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const broker=spawn('bun',[join(envRoot,'src/server.ts')],{env:{...envbase,ENVINHANDS_TOKEN:token,ENVINHANDS_DB:root+'/bus.sqlite',ENVINHANDS_HOST:'127.0.0.1',ENVINHANDS_PORT:String(port)},stdio:['ignore','pipe','pipe']}); kids.push(broker);
broker.stderr.on('data',b=>logs.broker=(logs.broker||'')+b);
async function create(i) {
 const dir=join(root,'agent'+i), socket=join(root,`s${i}.sock`); mkdirSync(dir,{recursive:true});
 const env={...envbase,PRIME_AGENT_CODING_AGENT_DIR:dir,PRIME_AGENT_TEAM_CODING_AGENT_DIR:dir,PRIME_AGENT_TEAM_MESH_URL:`http://127.0.0.1:${port}`,PRIME_AGENT_TEAM_MESH_TOKEN:token,PRIME_AGENT_TEAM_MACHINE_ID:'host-'+i,...(i === 'a' ? {PRIME_MESH_TEST_PYTHON:'1'} : {})};
 const p=spawn(process.execPath,['--import',proot+'/node_modules/tsx/dist/loader.mjs',proot+'/packages/coding-agent/test/fixtures/mesh-supervisor.ts',socket,root],{env,stdio:['ignore','pipe','pipe']}); kids.push(p); logs[i]=''; p.stdout.on('data',b=>logs[i]+=b); p.stderr.on('data',b=>logs[i]+=b);
 let client=new DaemonClient(socket); for(let n=0;n<80;n++){if(p.exitCode!==null) throw Error('daemon exit '+i+' '+logs[i]); try{await client.connect(200);await client.waitForHello(1000); break}catch{client.close();client=new DaemonClient(socket); await wait(100)}}
 clients.push(client); const resp=await client.request({type:'create',name:'agent-'+i},30000); if(!resp.success) throw Error('create '+i+': '+resp.error); console.log('CREATE',i,JSON.stringify(resp.data)); return {client,session:resp.data};
}
try {
 for(let n=0;n<40;n++){try {let r=await fetch(`http://127.0.0.1:${port}/v1/native-mesh/agents`,{headers:{authorization:'Bearer '+token}}); if(r.ok)break;}catch{} await wait(100)}
 const [a,b]=await Promise.all([create('a'),create('b')]);
 let as=a.session.session??a.session, bs=b.session.session??b.session;
 const aid=nativeMeshAgentId('host-a',as.sessionId), bid=nativeMeshAgentId('host-b',bs.sessionId);
 let registered=false;
 for(let n=0;n<60;n++){const r=await fetch(`http://127.0.0.1:${port}/v1/native-mesh/agents`,{headers:{authorization:'Bearer '+token}});const data=await r.json();if(data.agents?.some(x=>x.id===aid)&&data.agents?.some(x=>x.id===bid)){registered=true;console.log('REGISTERED',JSON.stringify(data));break} await wait(500)}
 if(!registered)throw Error('timeout waiting for registration');
 const workers=join(root,'agenta','daemon-workers');
 const descriptors=readdirSync(workers,{withFileTypes:true}).filter(e=>e.isDirectory()).flatMap(d =>
  readdirSync(join(workers,d.name)).filter(n=>n.endsWith('.json')).map(n => JSON.parse(readFileSync(join(workers,d.name,n),'utf8'))));
 const tokenForWorker=descriptors.find(d=>d.rootSessionId === as.sessionId)?.authenticationToken ??
  descriptors.find(d=>typeof d.authenticationToken === 'string')?.authenticationToken;
 if(!tokenForWorker)throw Error('source worker descriptor not found');
 let peerSeen=false;
 for(let n=0;n<40;n++){
  const peers=await a.client.request({type:'list_agent_peers',workerToken:tokenForWorker},5000);
  if(peers.success && peers.data?.peers?.some(p=>p.sessionId === bid && p.sessionName === 'host-b/agent-b')) { peerSeen=true; break; }
  await wait(500);
 }
 if(!peerSeen)throw Error('remote peer not present in worker roster');
 // Run the real bundled Python skill inside the source worker's AgentSession kernel.
 const pythonOperationId='python-op-é-stable', pythonMessage='python skill native mesh';
 const pythonReceiptFile=join(root,'python-receipts.json');
 const pythonCode=`import json, agent_message
from pathlib import Path
assert Path(agent_message.__file__).resolve() == Path(${JSON.stringify(join(proot,'packages/coding-agent/skills/agent-message/src/agent_message/__init__.py'))}).resolve(), agent_message.__file__
receipts = []
for _ in range(2):
    receipts.append(await agent_message.send(${JSON.stringify(pythonMessage)}, receiver_role="sibling", receiver_name=${JSON.stringify(bid)}, operation_id=${JSON.stringify(pythonOperationId)}))
with open(${JSON.stringify(pythonReceiptFile)}, "w", encoding="utf-8") as file:
    json.dump(receipts, file, ensure_ascii=False)
print("PYTHON_AGENT_MESSAGE_OK")`;
 writeFileSync(join(root,'agenta','python-agent-message.json'), JSON.stringify({code:pythonCode}));
 const prompted=await a.client.request({type:'prompt_and_wait',activeSessionId:as.activeSessionId??as.id,message:'Run the Python agent message test'},120000);
 if(!prompted.success || !existsSync(pythonReceiptFile)) throw Error(`Python AgentSession call failed: ${JSON.stringify(prompted)}; session=${existsSync(as.sessionFile) ? readFileSync(as.sessionFile,'utf8') : 'missing'}`);
 const receipts=JSON.parse(readFileSync(pythonReceiptFile,'utf8'));
 if(receipts.length!==2 || receipts.some(r=>r.operationId!==pythonOperationId || r.deliveryStatus!=='stored' || r.deliveredAt) || receipts[0].id!==receipts[1].id)
  throw Error(`Python receipt/retry mismatch: ${JSON.stringify(receipts)}`);
 let pythonEntries=[];
 for(let n=0;n<80;n++){
  if(existsSync(bs.sessionFile)) pythonEntries=readFileSync(bs.sessionFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
   .filter(entry=>entry.type==='custom_message' && entry.details?.id===`agentmsg_native-mesh:${receipts[0].id}`);
  if(pythonEntries.length)break;
  await wait(500);
 }
 if(pythonEntries.length!==1 || pythonEntries[0].details?.message!==pythonMessage) throw Error('Python delivery missing or duplicated');
 let pythonAck=false;
 for(let n=0;n<40;n++){
  const r=await fetch(`http://127.0.0.1:${port}/v1/messages?to=${bid}`,{headers:{authorization:'Bearer '+token}});
  const data=await r.json();
  if(r.ok && Array.isArray(data.messages) && !data.messages.some(m=>m.requestId===receipts[0].id)){pythonAck=true;break;}
  await wait(500);
 }
 if(!pythonAck)throw Error('broker did not acknowledge Python delivery');
 const pythonReplay=readFileSync(bs.sessionFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
  .filter(entry=>entry.type==='custom_message' && entry.details?.id===`agentmsg_native-mesh:${receipts[0].id}`);
 if(pythonReplay.length!==1)throw Error('Python retry duplicated the persisted message');
 console.log('PYTHON_OPERATION_ID_ACK_AND_RETRY',true);
 // Reproduce process death exactly after durable bind, before enqueue.
 const descriptorDir=join(workers,readdirSync(workers,{withFileTypes:true}).find(e=>e.isDirectory()).name);
 const opsDir=join(descriptorDir,'native-mesh-operations');
 const fault=spawn(process.execPath,['--import',proot+'/node_modules/tsx/dist/loader.mjs','--input-type=module','-e',
  `import {NativeMeshOperations} from ${JSON.stringify(new URL('../src/modes/daemon/native-mesh/operations.ts',import.meta.url).href)}; new NativeMeshOperations(process.argv[1]).bind({from:process.argv[2],to:process.argv[3],text:'fault-boundary',operationId:'fault-op'}); process.kill(process.pid,'SIGKILL');`,opsDir,aid,bid], {env:envbase,stdio:'ignore'});
 await new Promise(resolve => fault.once('exit',resolve));
 if(fault.signalCode !== 'SIGKILL')throw Error('fault process was not killed after bind');
 const operations=new NativeMeshOperations(opsDir);
 const faultBinding=operations.get(aid,'fault-op');
 if(!faultBinding || !operations.pending().length)throw Error('durable pre-enqueue intent missing');
 let faultDelivered=false;
 for(let n=0;n<50;n++){
  if(existsSync(bs.sessionFile) && readFileSync(bs.sessionFile,'utf8').includes('fault-boundary')){faultDelivered=true;break;}
  await wait(500);
 }
 if(!faultDelivered)throw Error('supervisor failed to recover pre-enqueue intent');
 console.log('FAULT_BOUNDARY_RECOVERED',true);
 const command={type:'send_message',fromActiveSessionId:as.activeSessionId??as.id,agentOrigin:true,targetActiveSessionId:bid,message:'temporary e2e native mesh',nativeMeshOperationId:'process-test-stable'};
 const sent=await a.client.request(command,30000); console.log('SEND',JSON.stringify(sent)); if(!sent.success || sent.data?.deliveryStatus !== 'stored' || sent.data?.operationId !== command.nativeMeshOperationId || sent.data?.deliveredAt) throw Error('invalid stored receipt');
 let entries=[]; for(let n=0;n<80;n++){
  if(existsSync(bs.sessionFile)) {
   entries=readFileSync(bs.sessionFile,'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.type === 'custom_message' && entry.details?.id === `agentmsg_native-mesh:${sent.data.id}`);
   if(entries.length) break;
  }
  await wait(500);
 }
 if(entries.length !== 1 || entries[0].details?.message !== 'temporary e2e native mesh' ||
  entries[0].details?.fromRelationship !== 'sibling') throw Error('invalid persisted delivery');
 console.log('PERSISTED',true);
 let acknowledged=false;
 for(let n=0;n<40;n++){
  const r=await fetch(`http://127.0.0.1:${port}/v1/messages?to=${bid}`,{headers:{authorization:'Bearer '+token}});
  const data=await r.json();
  if(r.ok && Array.isArray(data.messages) && !data.messages.some(m => m.requestId === sent.data.id)) { acknowledged=true; break; }
  await wait(500);
 }
 if(!acknowledged)throw Error('broker did not acknowledge persisted delivery');
 console.log('ACKNOWLEDGED',true);
 const retried=await a.client.request(command,30000);
 if(!retried.success || retried.data?.id !== sent.data.id || retried.data?.deliveryStatus !== 'stored')
  throw Error('retry did not preserve the broker request ID');
 const replayed=readFileSync(bs.sessionFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
  .filter(entry => entry.type === 'custom_message' && entry.details?.id === `agentmsg_native-mesh:${sent.data.id}`);
 if(replayed.length !== 1) throw Error('retry duplicated the persisted message');
 console.log('IDEMPOTENT_RETRY',true);
} catch(e){console.error('FAIL',e);process.exitCode=1} finally {
 for(const c of clients){try{await c.request({type:'shutdown',force:true},3000)}catch{} c.close()}
 for(const k of kids){if(k.exitCode===null)k.kill('SIGTERM')}
 for(const k of kids){if(k.exitCode===null)k.kill('SIGKILL')};
 await Promise.all(kids.map(k => k.exitCode !== null || k.signalCode !== null ? Promise.resolve() : new Promise(resolve => k.once('exit',resolve))));
 if (process.exitCode) console.error('LOGS',JSON.stringify(logs));
 rmSync(root,{recursive:true,force:true});
}
