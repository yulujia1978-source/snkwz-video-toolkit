const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {createAutoQueue}=require('../Resources/auto-queue.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'vd-auto-unit-')),input=path.join(root,'input'),output=path.join(input,'output');await fsp.mkdir(output,{recursive:true});return{root,input,output};}
async function eventually(fn,timeout=2500){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await sleep(15);}assert.fail('timed out waiting for queue');}
test('auto queue waits for stability, serializes jobs, finishes current on stop and remembers successes',async()=>{
 const {root,input,output}=await setup();const tasks=new Map();let sequence=0;const imports=new Map();
 const create=()=>createAutoQueue({root,processor:{tasks},tickMs:10,importFile:async source=>{imports.set(source,true);return{source};},createTask:([file])=>{const t={id:'t'+ ++sequence,status:'processing',outputs:[],source:file.source};tasks.set(t.id,t);return t;},exportOutput:async(t,{directory})=>{t.outputs[0].deletedReason='saved';return{path:path.join(directory,path.basename(t.source))};}});
 let q=create();const cfg={inputDirectory:input,outputDirectory:output,settleSeconds:.08,options:{}};
 try{
  await fsp.writeFile(path.join(input,'01.mp4'),'first');await fsp.writeFile(path.join(input,'02.mp4'),'second');
  await q.start(cfg);await sleep(35);assert.equal(sequence,0);await eventually(()=>sequence===1);assert.equal(q.snapshot().active.name,'01.mp4');await sleep(120);assert.equal(sequence,1,'next video cannot start concurrently');
  q.stop();const first=tasks.get('t1');first.status='completed';first.outputs=[{file:'1',name:'01.mp4'}];await eventually(()=>q.snapshot().counts.completed===1);assert.equal(sequence,1,'stop must finish current without starting the next');
  q.dispose();q=create();assert.equal(q.snapshot().enabled,false);await q.start(cfg);await eventually(()=>sequence===2);assert.equal(q.snapshot().active.name,'02.mp4');
  const second=tasks.get('t2');second.status='completed';second.outputs=[{file:'2',name:'02.mp4'}];await eventually(()=>q.snapshot().counts.completed===2);await sleep(150);assert.equal(sequence,2,'completed fingerprints must not requeue');
 }finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('save failure stops intake and retries the existing output without encoding again',async()=>{
 const {root,input,output}=await setup();const tasks=new Map();let sequence=0,fail=true;
 const q=createAutoQueue({root,processor:{tasks},tickMs:10,importFile:async source=>({source}),createTask:()=>{const t={id:'t'+ ++sequence,status:'completed',outputs:[{file:'out',name:'001-video.mp4'}]};tasks.set(t.id,t);return t;},exportOutput:async t=>{if(fail)throw Error('disk unavailable');t.outputs[0].deletedReason='saved';return{path:path.join(output,'video.mp4')};}});
 const cfg={inputDirectory:input,outputDirectory:output,settleSeconds:.05,options:{}};
 try{await fsp.writeFile(path.join(input,'video.mp4'),'video');await q.start(cfg);await eventually(()=>q.snapshot().entries[0]?.status==='save_failed');assert.equal(q.snapshot().enabled,false);assert.equal(sequence,1);fail=false;await q.start(cfg);await eventually(()=>q.snapshot().counts.completed===1);assert.equal(sequence,1,'retry saving must reuse the encoded result');}
 finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('folder validation, merge validation and concurrent start protection',async()=>{
 const {root,input,output}=await setup();const q=createAutoQueue({root,processor:{tasks:new Map()},tickMs:10000,importFile:async()=>({}),createTask:()=>{},exportOutput:async()=>{}});
 try{
  await assert.rejects(q.start({inputDirectory:input,outputDirectory:input}),/不能相同/);
  await assert.rejects(q.start({inputDirectory:input,outputDirectory:output,options:{merge:true,mergeUnlimited:true}}),/一种合并方式/);
  const results=await Promise.allSettled([q.start({inputDirectory:input,outputDirectory:output}),q.start({inputDirectory:input,outputDirectory:output})]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 }finally{q.stop();await q.tick();q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('source changed during encoding is not exported and is queued again after stabilizing',async()=>{
 const {root,input,output}=await setup();const tasks=new Map();let sequence=0,exports=0;
 const q=createAutoQueue({root,processor:{tasks,cleanup(){}},tickMs:10,importFile:async()=>({}),createTask:()=>{const t={id:'t'+ ++sequence,status:'processing',outputs:[]};tasks.set(t.id,t);return t;},exportOutput:async()=>{exports++;return{path:'out'};}});
 try{const source=path.join(input,'growing.mp4');await fsp.writeFile(source,'first');await q.start({inputDirectory:input,outputDirectory:output,settleSeconds:.05,options:{}});await eventually(()=>sequence===1);await fsp.appendFile(source,'more bytes');const t=tasks.get('t1');t.status='completed';t.outputs=[{file:'out',name:'out.mp4'}];await eventually(()=>sequence===2);assert.equal(exports,0);assert.ok(q.snapshot().entries.some(e=>e.status==='changed'));}
 finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('restart after export acknowledgement remembers success even if history was not committed yet',async()=>{
 const {root,input,output}=await setup();const config={inputDirectory:input,outputDirectory:output,settleSeconds:10,options:{}};
 await fsp.writeFile(path.join(root,'auto-queue.json'),JSON.stringify({config,entries:[{id:'e',source:path.join(input,'done.mp4'),name:'done.mp4',status:'saving',taskId:'t',savedPaths:[]}]}));
 const q=createAutoQueue({root,processor:{tasks:new Map([['t',{status:'completed',outputs:[{deletedReason:'saved',deletedAt:Date.now()}]}]])},importFile:async()=>{},createTask:()=>{},exportOutput:async()=>{}});
 try{assert.equal(q.snapshot().enabled,false);assert.equal(q.snapshot().counts.completed,1);assert.equal(q.snapshot().counts.failed,0);}finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('recursive scan ignores hidden files, symlinks and empty files while allowing original videos in output folders; sorts episode numbers naturally',async()=>{
 const {root,input,output}=await setup(),tasks=new Map(),started=[];
 const q=createAutoQueue({root,processor:{tasks},manualTick:true,importFile:async source=>({source}),createTask:([f])=>{const t={id:'t'+started.length,status:'processing',outputs:[]};started.push(f.source);tasks.set(t.id,t);return t;},exportOutput:async()=>({path:'saved'})});
 try{
  await fsp.mkdir(path.join(input,'nested'));await fsp.mkdir(path.join(input,'.hidden'));
  for(const name of ['10.mp4','2.MOV','nested/3.mkv','.hidden/4.mp4','.secret.mp4','output/5.mp4','notes.txt'])await fsp.writeFile(path.join(input,name),'video');
  await fsp.writeFile(path.join(input,'empty.mp4'),'');await fsp.symlink(path.join(input,'2.MOV'),path.join(input,'linked.mp4'));
  await q.start({inputDirectory:input,outputDirectory:output,settleSeconds:.05});await q.tick();await sleep(80);await q.tick();
  assert.deepEqual(q.snapshot().entries.map(e=>e.name).sort(),['10.mp4','2.MOV','nested/3.mkv','output/5.mp4'].sort());
  assert.equal(path.basename(started[0]),'2.MOV');
  tasks.get('t0').status='completed';tasks.get('t0').outputs=[{file:'out',name:'out.mp4'}];await q.tick();assert.equal(path.basename(started[1]),'10.mp4');
 }finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
test('a disconnected watch directory reports an error, stops intake and resumes after restoration',async()=>{
 const {root,input,output}=await setup(),externalOutput=path.join(root,'external-output');await fsp.mkdir(externalOutput);
 const q=createAutoQueue({root,processor:{tasks:new Map()},manualTick:true,importFile:async()=>{},createTask:()=>{},exportOutput:async()=>{}}),offline=path.join(root,'offline');
 try{
  const cfg={inputDirectory:input,outputDirectory:externalOutput,settleSeconds:.05};await q.start(cfg);await q.tick();
  await fsp.rename(input,offline);await q.tick();assert.equal(q.snapshot().enabled,false);assert.match(q.snapshot().lastError,/ENOENT/);
  await fsp.rename(offline,input);await q.start(cfg);await q.tick();assert.equal(q.snapshot().enabled,true);assert.equal(q.snapshot().lastError,'');
 }finally{q.dispose();await fsp.rm(root,{recursive:true,force:true});}
});
