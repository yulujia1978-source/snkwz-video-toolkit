const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {createProcessor}=require('../Resources/services/video-dedupe');
const bins=path.join(__dirname,'../dist/视频去重.app/Contents/Resources/bin');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,timeout=12000){const end=Date.now()+timeout;while(Date.now()<end){if(fn())return;await sleep(20);}assert.fail('vocal stage did not advance');}
function fixture(delay){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-vocal-engine-')),demucs=path.join(root,'demucs');
 fs.writeFileSync(demucs,`#!${process.execPath}
const fs=require('fs'),path=require('path');
(async()=>{const args=process.argv.slice(2),at=args.indexOf('-o');for(const src of args.slice(at+2)){
 console.log('Separating track '+src);process.stderr.write('100%| model pass complete\\r');
 await new Promise(r=>setTimeout(r,${delay}));
 const out=path.join(args[at+1],'htdemucs',path.parse(src).name);fs.mkdirSync(out,{recursive:true});fs.copyFileSync(src,path.join(out,'vocals.mp3'));
 await new Promise(r=>setTimeout(r,2500));
}})().catch(e=>{console.error(e);process.exitCode=1;});`,{mode:0o755});
 const p=createProcessor({root,ffmpeg:path.join(bins,'ffmpeg'),ffprobe:path.join(bins,'ffprobe'),demucs});
 execFileSync(path.join(bins,'ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',path.join(root,'uploads','1-aa.mp4')]);
 fs.copyFileSync(path.join(root,'uploads','1-aa.mp4'),path.join(root,'uploads','2-aa.mp4'));
 const t={id:'vocal-test',...p.validate([{name:'1.mp4',storedName:'1-aa.mp4'},{name:'2.mp4',storedName:'2-aa.mp4'}],{mergeUnlimited:true,compress:true,removeMusic:true,hardwareAcceleration:true}),status:'queued',progress:0,logs:[],outputs:[]};
 p.enqueue(t);return{root,p,t};
}
test('a real audio pipeline exposes vocal output counts before completion and clears stage data after saving its result',async()=>{
 const {root,p,t}=fixture(400);try{
  await until(()=>t.phase?.code==='vocals'&&t.phase.currentSegment===1);
  assert.equal(t.phase.completed,0);assert.equal(t.phase.progress,0);p.action(t,'pause');await sleep(600);assert.equal(t.status,'paused');assert.equal(t.phase.completed,0);p.action(t,'resume');assert.equal(t.progress,94,'old overall percentage is distinct from live stage progress');
  await until(()=>t.phase?.code==='vocals'&&t.phase.completed===1);assert.equal(t.status,'processing');assert.equal(t.phase.progress,99,'a written segment does not imply process exit');
  await until(()=>t.status==='completed');assert.equal(t.phase,undefined);assert.equal(t.outputs.length,1);assert.equal(t.outputs[0].outputInfo.hasAudio,true);assert.ok(Math.abs(t.outputs[0].outputInfo.duration-2)<.2);
 }finally{if(!['completed','failed','cancelled'].includes(t.status))p.action(t,'cancel');p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('cancelling during vocal inference closes the child and removes its progress phase',async()=>{
 const {root,p,t}=fixture(30000);try{
  await until(()=>t.phase?.code==='vocals'&&t.phase.currentSegment===1);p.action(t,'cancel');await until(()=>t.status==='cancelled'&&!t.phase);
  assert.equal(t.outputs.length,0);await sleep(1100);assert.equal(t.phase,undefined,'a disposed observer must not recreate a cancelled phase');
 }finally{if(!['completed','failed','cancelled'].includes(t.status))p.action(t,'cancel');p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
