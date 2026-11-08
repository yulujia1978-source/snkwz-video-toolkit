const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {createAutoQueueManager}=require('../Resources/auto-queue-manager.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function eventually(fn,timeout=3000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await sleep(10);}assert.fail('manager timed out');}
async function setup(){const root=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'vd-groups-'))),inputA=path.join(root,'A'),inputB=path.join(root,'B'),outputA=path.join(root,'outA'),outputB=path.join(root,'outB');for(const p of [inputA,inputB,outputA,outputB])await fsp.mkdir(p);return{root,inputA,inputB,outputA,outputB};}
function harness(root){const tasks=new Map(),started=[],saved=[];const factory=()=>createAutoQueueManager({root,processor:{tasks},tickMs:10,importFile:async source=>({source}),createTask:([file])=>{const t={id:'t'+(started.length+1),source:file.source,status:'processing',outputs:[]};started.push(t);tasks.set(t.id,t);return t;},exportOutput:async(t,{directory})=>{const dest=path.join(directory,path.basename(t.source));await fsp.copyFile(t.source,dest);t.outputs[0].deletedReason='saved';t.outputs[0].deletedAt=Date.now();saved.push({source:t.source,dest});return{path:dest};}});return{tasks,started,saved,factory,complete(t){t.outputs=[{file:'out',name:path.basename(t.source)}];t.status='completed';}};}
test('independent folder pairs route correctly and share one fair serial scheduler',async()=>{
 const v=await setup(),h=harness(v.root),m=h.factory();
 try{
  for(const p of [v.inputA,v.inputB])for(const n of ['01.mp4','02.mp4'])await fsp.writeFile(path.join(p,n),p);
  const cfgA={inputDirectory:v.inputA,outputDirectory:v.outputA,settleSeconds:.05,autoStop:false},cfgB={inputDirectory:v.inputB,outputDirectory:v.outputB,settleSeconds:.05,autoStop:false};
  const a=(await m.add(cfgA)).createdId,b=(await m.add(cfgB)).createdId;await m.start({id:a});await m.start({id:b});
  for(let i=0;i<4;i++){await eventually(()=>h.started.length===i+1);assert.equal(path.dirname(h.started[i].source),i%2?v.inputB:v.inputA,'both groups must receive turns');await sleep(30);assert.equal(h.started.length,i+1,'next encode must wait');h.complete(h.started[i]);}
  await eventually(()=>m.snapshot().counts.completed===4);for(const item of h.saved)assert.equal(path.dirname(item.dest),path.dirname(item.source)===v.inputA?v.outputA:v.outputB);
  await m.stop(a);await fsp.writeFile(path.join(v.inputA,'03.mp4'),'A');await fsp.writeFile(path.join(v.inputB,'03.mp4'),'B');await eventually(()=>h.started.length===5);assert.equal(path.dirname(h.started[4].source),v.inputB);h.complete(h.started[4]);await eventually(()=>m.snapshot().counts.completed===5);await sleep(100);assert.equal(h.started.length,5);
  await m.stop();m.dispose();const restored=h.factory();assert.equal(restored.snapshot().groups.length,2);assert.equal(restored.snapshot().enabled,false);assert.equal(restored.snapshot().counts.completed,5);restored.dispose();
 }finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
test('parent paths and historical output roots are allowed; only identical pair directories are rejected',async()=>{
 const v=await setup(),h=harness(v.root);await fsp.writeFile(path.join(v.root,'auto-queues.json'),JSON.stringify({groups:[],excludedOutputs:[v.root,v.inputA]}));const m=h.factory();
 try{
  const a=(await m.add({inputDirectory:v.inputA,outputDirectory:v.root,settleSeconds:.05,autoStop:false})).createdId;
  await m.start({id:a});await m.stop(a);
  const b=(await m.add({inputDirectory:v.root,outputDirectory:v.outputB})).createdId;
  await assert.rejects(m.update({id:b,inputDirectory:v.outputB,outputDirectory:v.outputB}),/同一个目录/);
  await fsp.symlink(v.inputA,path.join(v.root,'alias'));
  await assert.rejects(m.add({inputDirectory:path.join(v.root,'alias'),outputDirectory:v.inputA}),/同一个目录/);
  assert.equal(m.snapshot().groups.length,2);
 }finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
test('generated files are skipped across groups, removal and restart; unrelated videos remain readable',async()=>{
 const v=await setup(),h=harness(v.root);let m=h.factory();const nested=path.join(v.inputA,'results');await fsp.mkdir(nested);
 try{
  await fsp.writeFile(path.join(v.inputB,'video.mp4'),'original');
  const a=(await m.add({inputDirectory:v.inputA,outputDirectory:v.outputA,settleSeconds:.05,autoStop:false})).createdId;
  const b=(await m.add({inputDirectory:v.inputB,outputDirectory:nested,settleSeconds:.05,autoStop:false})).createdId;
  await m.start({id:a});await m.start({id:b});await eventually(()=>h.started.length===1);h.complete(h.started[0]);await eventually(()=>m.snapshot().counts.completed===1);await sleep(160);assert.equal(h.started.length,1);
  await m.stop();await m.remove(b);m.dispose();m=h.factory();
  await fsp.writeFile(path.join(nested,'new-source.mp4'),'new source');await m.start({id:a});await eventually(()=>h.started.length===2);assert.equal(path.basename(h.started[1].source),'new-source.mp4');h.complete(h.started[1]);await eventually(()=>m.snapshot().counts.completed===1);await sleep(160);assert.equal(h.started.length,2,'saved files remain excluded after removal and restart');
 }finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
test('legacy single-pair configuration and completion records migrate without starting automatically',async()=>{
 const v=await setup(),cfg={inputDirectory:v.inputA,outputDirectory:v.outputA,settleSeconds:10,options:{}};
 await fsp.writeFile(path.join(v.root,'auto-queue.json'),JSON.stringify({config:cfg,entries:[{id:'old',source:path.join(v.inputA,'old.mp4'),name:'old.mp4',status:'completed',savedPaths:[]}]}));
 const h=harness(v.root),m=h.factory();try{const s=m.snapshot();assert.equal(s.groups.length,1);assert.equal(s.groups[0].config.inputDirectory,v.inputA);assert.equal(s.counts.completed,1);assert.equal(s.enabled,false);assert.ok(fs.existsSync(path.join(v.root,'auto-queue.json')));assert.ok(fs.existsSync(path.join(v.root,'auto-queues.json')));}finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
test('a merge group waiting for a new file to stabilize does not block another ready group',async()=>{
 const v=await setup(),tasks=new Map(),started=[];
 const m=createAutoQueueManager({root:v.root,processor:{tasks},tickMs:100000,importFile:async source=>({source}),createTask:files=>{const t={id:'t'+started.length,status:'processing',files,outputs:[]};started.push(t);tasks.set(t.id,t);return t;},exportOutput:async()=>({path:'saved'})});
 try{
  await fsp.writeFile(path.join(v.inputA,'1.mp4'),'a');await fsp.writeFile(path.join(v.inputB,'1.mp4'),'b');
  const a=(await m.add({inputDirectory:v.inputA,outputDirectory:v.outputA,settleSeconds:.05,autoStop:false})).createdId,b=(await m.add({inputDirectory:v.inputB,outputDirectory:v.outputB,settleSeconds:.05,autoStop:false})).createdId;
  await m.start({id:a,options:{mergeUnlimited:true}});await m.start({id:b});await m.tick();await sleep(80);await fsp.writeFile(path.join(v.inputA,'2.mp4'),'new');await m.tick();
  assert.equal(started.length,1);assert.equal(path.dirname(started[0].files[0].source),v.inputB);
 }finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
test('names and merge output names follow source folders; each group stops independently by default',async()=>{
 const v=await setup(),h=harness(v.root),m=h.factory();try{
  await fsp.writeFile(path.join(v.inputA,'1.mp4'),'a');await fsp.writeFile(path.join(v.inputB,'1.mp4'),'b');
  const a=(await m.add({name:'任务99',inputDirectory:v.inputA,outputDirectory:v.outputA,settleSeconds:.05})).createdId,b=(await m.add({name:'错误标题',inputDirectory:v.inputB,outputDirectory:v.outputB,settleSeconds:.05})).createdId;
  await m.start({id:a,options:{mergeUnlimited:true,mergeName:'上方旧名称'}});await m.start({id:b});await eventually(()=>h.started.length===1);
  let state=m.snapshot();assert.equal(state.groups[0].name,'A');assert.equal(state.groups[0].config.options.mergeName,'A');assert.equal(state.groups[0].config.autoStop,true);assert.equal(state.groups[1].name,'B');
  const firstId=path.dirname(h.started[0].source)===v.inputA?a:b;h.complete(h.started[0]);await eventually(()=>h.started.length===2&&!m.snapshot().groups.find(g=>g.id===firstId).enabled);state=m.snapshot();assert.equal(state.groups.find(g=>g.id===firstId).enabled,false);assert.equal(state.groups.find(g=>g.id===firstId).stopReason,'completed');assert.equal(state.enabled,true);
  h.complete(h.started[1]);await eventually(()=>!m.snapshot().enabled);state=m.snapshot();assert.equal(state.active,null);assert.equal(state.counts.completed,2);assert.ok(state.groups.every(g=>g.stopReason==='completed'));
  m.dispose();const restored=h.factory();assert.ok(restored.snapshot().groups.every(g=>g.stopReason==='completed'));restored.dispose();
 }finally{m.dispose();await fsp.rm(v.root,{recursive:true,force:true});}
});
