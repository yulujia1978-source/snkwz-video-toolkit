const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {createAutoQueue}=require('../Resources/auto-queue.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'vd-finish-')),input=path.join(root,'来源剧名（两集）'),output=path.join(root,'成品');await fsp.mkdir(input);await fsp.mkdir(output);
 const tasks=new Map(),started=[],saved=[];let gate=null;
 const make=()=>createAutoQueue({root,manualTick:true,processor:{tasks},importFile:async source=>({source}),createTask:(files,options)=>{const t={id:'t'+started.length,status:'processing',files,options,outputs:[]};started.push(t);tasks.set(t.id,t);return t;},exportOutput:async(t,{file})=>{
  if(gate)await gate;const o=t.outputs.find(o=>o.file===file),dest=path.join(output,o.name);await fsp.writeFile(dest,'saved');o.deletedAt=Date.now();o.deletedReason='saved';saved.push(dest);return{path:dest};
 }});
 let q=make();return{root,input,output,started,saved,tasks,get q(){return q;},cfg:{inputDirectory:input,outputDirectory:output,settleSeconds:.05,options:{}},add:name=>fsp.writeFile(path.join(input,name),'video'),finish(t,names=['engine-prefix.mp4']){t.status='completed';t.outputs=names.map(name=>({file:name,name}));},async stable(){await q.tick();await sleep(80);await q.tick();},holdSaving(p){gate=p;},reload(){q.dispose();q=make();},async close(){q.dispose();await fsp.rm(root,{recursive:true,force:true});}};
}
test('default auto-stop waits for all sources and final save, persists completion, and requires an explicit restart for new arrivals',async()=>{
 const h=await setup();try{
  await h.add('01-源视频.mp4');await h.add('02-源视频.mov');await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,1);
  h.finish(h.started[0]);await h.q.tick();assert.equal(h.started.length,2);assert.equal(h.q.snapshot().enabled,true);
  let release;h.holdSaving(new Promise(r=>release=r));h.finish(h.started[1]);const saving=h.q.tick();await sleep(15);
  assert.equal(h.q.snapshot().enabled,true);assert.equal(h.q.snapshot().active.status,'saving');release();await saving;h.holdSaving(null);
  let state=h.q.snapshot();assert.equal(state.enabled,false);assert.equal(state.active,null);assert.equal(state.stopReason,'completed');assert.equal(state.counts.completed,2);assert.equal(state.counts.outputs,2);assert.ok(state.finishedAt);
  assert.deepEqual(h.saved.map(p=>path.basename(p)),['01-源视频.mp4','02-源视频.mp4']);
  h.reload();assert.equal(h.q.snapshot().stopReason,'completed');assert.equal(h.q.snapshot().enabled,false);
  await h.q.start(h.cfg);await h.q.tick();assert.equal(h.q.snapshot().enabled,false);assert.equal(h.started.length,2,'existing saved versions must not encode again');
  await h.add('03-新增.mp4');await h.q.tick();assert.equal(h.started.length,2);await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,3);
  h.finish(h.started[2]);await h.q.tick();assert.equal(h.q.snapshot().enabled,false);assert.equal(h.q.snapshot().counts.completed,3);
 }finally{await h.close();}
});
test('empty folders stop after the stability window but zero-byte copying placeholders keep the session open',async()=>{
 const h=await setup();try{
  await h.q.start(h.cfg);await h.q.tick();assert.equal(h.q.snapshot().enabled,true);await sleep(80);await h.q.tick();assert.equal(h.q.snapshot().stopReason,'empty');
  await fsp.writeFile(path.join(h.input,'copying.mp4'),'');await h.q.start(h.cfg);await h.stable();assert.equal(h.q.snapshot().enabled,true);assert.equal(h.q.snapshot().counts.stabilizing,1);assert.equal(h.started.length,0);
  await h.add('copying.mp4');await h.stable();h.finish(h.started[0]);await h.q.tick();assert.equal(h.q.snapshot().stopReason,'completed');
 }finally{await h.close();}
});
test('failed sources do not prevent successful sources finishing; the stopped result explicitly retains failures',async()=>{
 const h=await setup();try{
  await h.add('1.mp4');await h.add('2.mp4');await h.q.start(h.cfg);await h.stable();h.started[0].status='failed';h.started[0].error='bad video';await h.q.tick();h.finish(h.started[1]);await h.q.tick();
  assert.equal(h.q.snapshot().enabled,false);assert.equal(h.q.snapshot().stopReason,'finished_with_errors');assert.equal(h.q.snapshot().counts.failed,1);
  h.q.retryFailed();await h.q.tick();await h.q.start(h.cfg);await h.q.tick();assert.equal(h.started.length,3);h.finish(h.started[2]);await h.q.tick();assert.equal(h.q.snapshot().stopReason,'completed');assert.equal(h.q.snapshot().counts.failed,0);
 }finally{await h.close();}
});
