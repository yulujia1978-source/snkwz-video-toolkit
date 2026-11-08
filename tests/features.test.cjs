const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {createProcessor}=require('../Resources/services/video-dedupe');
const bins=path.join(__dirname,'../dist/视频去重.app/Contents/Resources/bin');
const ffmpeg=path.join(bins,'ffmpeg'),ffprobe=path.join(bins,'ffprobe');
const demucs=path.join(os.homedir(),'Library/Python/3.9/bin/demucs');
const ff=args=>execFileSync(ffmpeg,['-v','error',...args],{maxBuffer:16*1024*1024});
const frame=file=>ff(['-i',file,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
function meanDifference(a,b){assert.equal(a.length,b.length);let total=0;for(let i=0;i<a.length;i++)total+=Math.abs(a[i]-b[i]);return total/a.length;}
function pixels(data,w,x,y,width,height){const values=[];for(let j=y;j<y+height;j++)for(let i=x;i<x+width;i++)values.push(...data.subarray((j*w+i)*3,(j*w+i)*3+3));return Buffer.from(values);}
async function complete(p,t,timeout=30000){p.enqueue(t);const until=Date.now()+timeout;while(!['completed','partial','failed','cancelled'].includes(t.status)&&Date.now()<until)await new Promise(r=>setTimeout(r,100));if(!['completed','partial','failed','cancelled'].includes(t.status)){p.action(t,'cancel');await new Promise(r=>setTimeout(r,3500));}assert.equal(t.status,'completed',JSON.stringify(t));return path.join(p.testRoot,'outputs',t.id,t.outputs[0].file);}
function task(p,id,options){return{id,...p.validate([{storedName:'1-aa.mp4',name:'fixture.mp4'}],options),status:'queued',progress:0,logs:[],outputs:[]};}
test('remaining visual features individually change decoded pixels and retain duration/audio',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-features-')),fixture=path.join(root,'fixture.mp4'),pip=path.join(root,'pip.mp4');
 const p=createProcessor({root:path.join(root,'data'),ffmpeg,ffprobe,demucs});p.testRoot=path.join(root,'data');
 try{
  ff(['-f','lavfi','-i','testsrc2=size=320x240:rate=15:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-crf','18','-c:a','aac',fixture]);
  ff(['-f','lavfi','-i','color=red:size=80x60:rate=15:duration=0.3','-c:v','libx264',pip]);
  const run=async(id,opts)=>{fs.copyFileSync(fixture,path.join(p.testRoot,'uploads','1-aa.mp4'));if(opts.pipOpacity)fs.copyFileSync(pip,path.join(p.testRoot,'uploads','2-aa.mp4'));const t=task(p,id,{...opts,reencode:{preset:'ultrafast'}}),out=await complete(p,t);const info=t.outputs[0].outputInfo;assert.ok(Math.abs(info.duration-1)<.15);assert.equal(info.hasAudio,true);return{frame:frame(out),info};};
  const base=await run('base',{});
  for(const [id,opts] of [['grid',{grid:5,gridOpacity:.5}],['color',{contrast:1.2,saturation:0}],['sharpen',{sharpen:true}],['blackLine',{blackLine:true}],['pip',{pipOpacity:.5,pipStoredName:'2-aa.mp4'}]]){
   const result=await run(id,opts);assert.equal(result.info.width,320);assert.equal(result.info.height,240);
   const diff=meanDifference(result.frame,base.frame);assert.ok(diff>.15,`${id}: no visible pixel change (${diff})`);
   if(id==='color'){let chroma=0;for(let i=0;i<result.frame.length;i+=3)chroma+=Math.abs(result.frame[i]-result.frame[i+1])+Math.abs(result.frame[i+1]-result.frame[i+2]);assert.ok(chroma/(result.frame.length/3)<12,'desaturation must yield grayscale: '+chroma/(result.frame.length/3));}
   if(id==='blackLine'){const before=pixels(base.frame,320,20,210,280,4),after=pixels(result.frame,320,20,210,280,4);assert.ok(after.reduce((s,v)=>s+v,0)<before.reduce((s,v)=>s+v,0)*.4,'line at 90% darkens picture pixels');}
   if(id==='pip')assert.ok(meanDifference(pixels(result.frame,320,230,170,70,50),pixels(base.frame,320,230,170,70,50))>10,'overlay must appear in bottom-right');
  }
  const crop=await run('crop',{crop:10});assert.equal(crop.info.height,216);assert.equal(crop.info.width,320);
  const border=await run('border',{borderSize:8});assert.equal(border.info.width,336);assert.equal(border.info.height,256);const edge=pixels(border.frame,336,0,0,336,6);assert.ok(edge.reduce((s,v)=>s+v,0)/edge.length<4);
  const combined=await run('combined',{grid:5,crop:5,contrast:1.1,saturation:1.1,sharpen:true,borderSize:8,blackLine:true,pipOpacity:.35,pipStoredName:'2-aa.mp4'});assert.equal(combined.info.width,336);assert.equal(combined.info.height,244);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('installed Demucs performs actual model inference and produces a playable vocal track',{skip:!process.env.VD_TEST_DEMUCS,timeout:150000},async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-real-demucs-'));const p=createProcessor({root,ffmpeg,ffprobe,demucs});p.testRoot=root;
 try{ff(['-f','lavfi','-i','testsrc2=size=160x120:rate=10:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',path.join(root,'uploads','1-aa.mp4')]);const t=task(p,'real-demucs',{removeMusic:true,reencode:{preset:'ultrafast'}});await complete(p,t,120000);assert.equal(t.outputs[0].outputInfo.hasAudio,true);assert.ok(Math.abs(t.outputs[0].outputInfo.duration-1)<.2);assert.ok(t.logs.some(line=>line.includes('人声分离')));}finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('H.264 and H.265 encode with software and Apple hardware; FPS and resolution apply',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-codecs-')),fixture=path.join(root,'fixture.mp4');
 const p=createProcessor({root:path.join(root,'data'),ffmpeg,ffprobe,demucs});p.testRoot=path.join(root,'data');
 try{ff(['-f','lavfi','-i','testsrc2=size=320x240:rate=15:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',fixture]);
  for(const encoder of ['H.264','H.265'])for(const hardwareAcceleration of [false,true]){
   fs.copyFileSync(fixture,path.join(p.testRoot,'uploads','1-aa.mp4'));
   const t=task(p,encoder.replace('.','')+'-'+hardwareAcceleration,{hardwareAcceleration,reencode:{encoder,fps:25,resolution:'1280×720',preset:'veryfast'}});
   const out=await complete(p,t);const info=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-of','json',out]));const v=info.streams.find(s=>s.codec_type==='video');
   assert.equal(v.codec_name,encoder==='H.264'?'h264':'hevc');assert.equal(v.width,1280);assert.equal(v.height,720);assert.equal(v.avg_frame_rate,'25/1');assert.ok(info.streams.some(s=>s.codec_type==='audio'));
   if(hardwareAcceleration)assert.equal(t.logs.some(line=>line.includes('硬件编码不可用')),false,'native hardware must encode without software fallback');
  }
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
