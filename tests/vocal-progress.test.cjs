const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {monitorVocals}=require('../Resources/services/video-dedupe/vocal-progress.cjs');
const ui=fs.readFileSync(require.resolve('../Resources/progress-ui.js'),'utf8');
test('real output counts advance phase progress; model bars and empty or still-changing files cannot mark completion',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-vocal-progress-'));let clock=1000,updates=0;
 const t={progress:94},chunks=[0,1,2].map(i=>({audio:path.join(root,`audio-${i}.wav`)}));
 const m=monitorVocals({task:t,chunks,directory:root,now:()=>clock,onUpdate:()=>updates++,intervalMs:0});
 const write=(i,bytes)=>{const dir=path.join(root,'htdemucs',`audio-${i}`);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'vocals.mp3'),bytes);};
 try{
  m.stdout('100%| complete model pass');m.stdout('Separating track '+chunks[0].audio);assert.equal(t.phase.completed,0);assert.equal(t.phase.progress,0);
  write(0,'');m.poll();m.poll();assert.equal(t.phase.completed,0,'zero-byte files are not output');
  write(0,'audio');m.poll();write(0,'audio still growing');m.poll();assert.equal(t.phase.completed,0,'a changed signature must remain pending');
  clock+=1000;m.poll();assert.equal(t.phase.completed,1);assert.equal(t.phase.progress,33);
  m.stdout('Separating track '+chunks[1].audio);write(1,'second');m.stdout('Separating track '+chunks[2].audio);assert.equal(t.phase.completed,2);assert.equal(t.phase.currentSegment,3);
  assert.throws(()=>m.finish(),/第 3 段/);write(2,'last');m.poll();m.poll();assert.equal(t.phase.completed,3);assert.equal(t.phase.progress,99,'process exit must precede phase 100%');m.finish();assert.equal(t.phase.progress,100);
  const n=updates;m.dispose();m.stdout('Separating track '+chunks[0].audio);m.poll();assert.equal(updates,n,'a cancelled or finished observer must not keep updating');
 }finally{m.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('manual and automatic views show segment progress and elapsed time instead of the stale overall 94%',()=>{
 const context=vm.createContext({});vm.runInContext(ui,context);
 context.input={progress:94,phase:{code:'vocals',label:'人声分离',total:40,completed:22,currentSegment:23,progress:55,startedAt:1000}};
 const text=vm.runInContext('videoProgressText(input,62000)',context);assert.match(text,/22\/40/);assert.match(text,/本阶段 55%/);assert.match(text,/第 23 段/);assert.match(text,/1 分 1 秒/);assert.doesNotMatch(text,/94%/);assert.equal(vm.runInContext('videoProgressValue(input)',context),55);
 const later=vm.runInContext('videoProgressText(input,63000)',context);assert.match(later,/1 分 2 秒/,'elapsed time keeps changing between segment outputs');
 context.input={progress:100,currentFile:'完成'};assert.equal(vm.runInContext('videoProgressValue(input)',context),100);
});
