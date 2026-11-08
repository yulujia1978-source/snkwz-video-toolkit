const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),os=require('node:os');
const {createAutoQueue}=require('../Resources/auto-queue.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function harness(){
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'vd-watch-merge-')),input=path.join(root,'input'),output=path.join(root,'output');await fsp.mkdir(input);await fsp.mkdir(output);
 const tasks=new Map(),started=[],saved=[];let failName=null;
 const make=()=>createAutoQueue({root,manualTick:true,processor:{tasks,cleanup(){}},importFile:async source=>({source,name:path.basename(source),storedName:path.basename(source)}),createTask:(files,options)=>{const t={id:'t'+started.length,status:'processing',files,options,outputs:[]};started.push(t);tasks.set(t.id,t);return t;},exportOutput:async(t,{file,directory})=>{
  if(file===failName)throw Error('disk unavailable');const o=t.outputs.find(o=>o.file===file),dest=path.join(directory,o.name);await fsp.writeFile(dest,'merged result');saved.push(dest);o.deletedAt=Date.now();o.deletedReason='saved';return{path:dest};
 }});
 let q=make();const cfg={inputDirectory:input,outputDirectory:output,settleSeconds:.05,autoStop:false,options:{mergeUnlimited:true,compress:true}};
 return{root,input,output,tasks,started,saved,cfg,get q(){return q;},fail(name){failName=name;},async restart(){q.dispose();q=make();},async close(){q.dispose();await fsp.rm(root,{recursive:true,force:true});},async add(name){await fsp.writeFile(path.join(input,name),'video '+name);},async stable(){await q.tick();await sleep(80);await q.tick();},finish(t,outputs=['complete.mp4']){t.status='completed';t.outputs=outputs.map(name=>({file:name,name}));}};
}
test('merge waits for every observed file, sorts naturally, saves one output, and only batches new arrivals after restart',async()=>{
 const h=await harness();try{
  await h.add('10.mp4');await h.q.start(h.cfg);await h.q.tick();await sleep(80);await h.add('2.mp4');await h.q.tick();
  assert.equal(h.started.length,0,'a newly observed file must hold the whole batch');
  await sleep(80);await h.q.tick();assert.equal(h.started.length,1);const t=h.started[0];assert.deepEqual(t.files.map(f=>f.name),['2.mp4','10.mp4']);assert.equal(t.options.compress,true);assert.equal(t.options.mergeUnlimited,true);
  h.q.stop();h.finish(t);await h.q.tick();assert.equal(h.saved.length,1);assert.equal(path.basename(h.saved[0]),'complete.mp4');assert.equal(h.q.snapshot().counts.completed,2);assert.equal(h.q.snapshot().counts.outputs,1);
  await h.restart();await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,1,'saved input versions must not run twice');
  await h.add('20.mp4');await h.stable();assert.equal(h.started.length,2);assert.deepEqual(h.started[1].files.map(f=>f.name),['20.mp4']);
 }finally{await h.close();}
});
test('a changed member discards the merged result and retries the entire batch after stability',async()=>{
 const h=await harness();try{
  await h.add('1.mp4');await h.add('2.mp4');await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,1);
  await fsp.appendFile(path.join(h.input,'2.mp4'),'changed');h.finish(h.started[0]);await h.q.tick();assert.equal(h.saved.length,0);
  await sleep(80);await h.q.tick();assert.equal(h.started.length,2);assert.equal(h.started[1].files.length,2);
  h.finish(h.started[1]);await h.q.tick();assert.equal(h.q.snapshot().counts.completed,2);assert.equal(h.saved.length,1);
 }finally{await h.close();}
});
test('partial export failure resumes remaining merged parts without encoding or exporting the first part again; redo archives history',async()=>{
 const h=await harness();try{
  await h.add('1.mp4');await h.add('2.mp4');await h.q.start({...h.cfg,options:{merge:true}});await h.stable();
  h.fail('series-第002集.mp4');h.finish(h.started[0],['series-第001集.mp4','series-第002集.mp4']);await h.q.tick();
  assert.equal(h.q.snapshot().enabled,false);assert.equal(h.q.snapshot().counts.failed,2);assert.equal(h.saved.length,1);
  h.fail(null);await h.q.start(h.cfg);await h.q.tick();assert.equal(h.started.length,1);assert.equal(h.saved.length,2);assert.equal(h.q.snapshot().counts.outputs,2);
  await assert.rejects(h.q.resetHistory(),/先停止/);h.q.stop();await h.q.resetHistory();assert.equal(h.q.snapshot().entries.length,0);
  assert.ok((await fsp.readdir(h.root)).some(n=>n.startsWith('history-')));for(const p of h.saved)assert.ok(fs.existsSync(p));
  await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,2);assert.equal(h.started[1].files.length,2);
 }finally{await h.close();}
});
test('empty copying placeholders hold a merge until they contain stable video bytes',async()=>{
 const h=await harness();try{
  await h.add('1.mp4');await fsp.writeFile(path.join(h.input,'2.mp4'),'');await h.q.start(h.cfg);await h.stable();assert.equal(h.started.length,0);assert.equal(h.q.snapshot().counts.stabilizing,1);
  await h.add('2.mp4');await h.stable();assert.equal(h.started.length,1);assert.equal(h.started[0].files.length,2);
 }finally{await h.close();}
});
test('transition helper is excluded from main inputs and a merge waits for at least two main videos',async()=>{
 const h=await harness();try{
  await h.add('transition.mp4');await h.add('1.mp4');await h.q.start({...h.cfg,transitionPath:path.join(h.input,'transition.mp4'),options:{mergeUnlimited:true,transition:true}});await h.stable();assert.equal(h.started.length,0);assert.match(h.q.snapshot().lastError,/至少两个/);
  await h.add('2.mp4');await h.stable();assert.equal(h.started.length,1);assert.equal(h.started[0].files.length,2);assert.equal(h.started[0].options.transitionStoredName,'transition.mp4');assert.equal(h.q.snapshot().lastError,'');
 }finally{await h.close();}
});
