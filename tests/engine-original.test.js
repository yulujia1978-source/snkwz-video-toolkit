const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const {execFileSync}=require('child_process');
const {normalize,command,createProcessor}=require('../Resources/services/video-dedupe');
const ffmpeg=require('node:path').join(__dirname,'../dist/视频去重.app/Contents/Resources/bin/ffmpeg');
const ffprobe=require('node:path').join(__dirname,'../dist/视频去重.app/Contents/Resources/bin/ffprobe');
test('reject invalid parameters',()=>{assert.throws(()=>normalize({crop:NaN}));assert.throws(()=>normalize({reencode:{fps:'1;bad'}}));});
test('real batch: combined filters, pip loop, silent input, bad input and duplicate names',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-test-'));
 try{
 const p=createProcessor({root,ffmpeg,ffprobe,demucs:'missing-demucs'});
 const src=path.join(root,'uploads','1-ab.mp4');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15:duration=3','-f','lavfi','-i','sine=frequency=440:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',src]);
 const pip=path.join(root,'uploads','2-ab.mp4');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=red:size=80x60:rate=15:duration=0.5','-c:v','libx264',pip]);
 fs.writeFileSync(path.join(root,'uploads','3-ab.mp4'),'invalid');
 const options={trim:true,trimStart:.2,trimEnd:.3,mirror:true,crop:5,grid:5,gridOpacity:.12,sharpen:true,borderSize:8,blackLine:true,pipStoredName:'2-ab.mp4',pipOpacity:.35,reencode:{preset:'ultrafast',resolution:'1280×720'}};
 const input=p.validate([{storedName:'1-ab.mp4',name:'same.mov'},{storedName:'3-ab.mp4',name:'bad.mp4'},{storedName:'2-ab.mp4',name:'same.mov'}],{...options,trim:false});
 assert.throws(()=>p.validate([{storedName:'../secret',name:'x'}],{}));
 const args=command(src,path.join(root,'trim.mp4'),normalize(options),{duration:3,width:320,hasAudio:true},pip).args;
 execFileSync(ffmpeg,args,{stdio:'pipe'});
 const meta=JSON.parse(execFileSync(ffprobe,['-v','error','-show_format','-show_streams','-of','json',path.join(root,'trim.mp4')]));
 assert.equal(meta.streams[0].width,1280);assert.equal(meta.streams[0].height,720);assert.ok(Math.abs(Number(meta.format.duration)-2.5)<.2);assert.ok(meta.streams.some(s=>s.codec_type==='audio'));
 const t={id:'test',...input,status:'queued',progress:0,logs:[],outputs:[]};p.enqueue(t);
 const deadline=Date.now()+30000;while(!['completed','partial','failed'].includes(t.status)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.equal(t.status,'partial',JSON.stringify(t));assert.equal(t.outputs.length,2);assert.equal(t.failures.length,1);assert.notEqual(t.outputs[0].file,t.outputs[1].file);assert.equal(t.outputs[1].outputInfo.hasAudio,false);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('pause and cancel stop the process; queued work continues',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-control-'));
 try{
 const p=createProcessor({root,ffmpeg,ffprobe,demucs:'missing'});
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=30:duration=8','-c:v','libx264','-preset','ultrafast',path.join(root,'uploads','1-aa.mp4')]);
 const input=p.validate([{storedName:'1-aa.mp4',name:'long.mp4'}],{grid:5,reencode:{preset:'veryslow'}});
 const t={id:'cancel-test',...input,status:'queued',progress:0,logs:[],outputs:[]};p.enqueue(t);
 await new Promise(r=>setTimeout(r,150));p.action(t,'pause');assert.equal(t.status,'paused');p.action(t,'cancel');assert.equal(t.status,'cancelled');
 const next={id:'next',...p.validate([{storedName:'1-aa.mp4',name:'next.mp4'}],{reencode:{preset:'ultrafast'}}),status:'queued',progress:0,logs:[],outputs:[]};p.enqueue(next);
 const deadline=Date.now()+20000;while(!['completed','failed'].includes(next.status)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.equal(next.status,'completed');assert.equal(t.outputs.length,0);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('cleanup protects queued inputs and active downloads; acknowledgements and expiry are idempotent',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-cleanup-'));let clock=1000;
 const p=createProcessor({root,ffmpeg,ffprobe,now:()=>clock,retentionMs:10000});
 try{
 const upload=path.join(root,'uploads','1-aa.mp4');fs.writeFileSync(upload,'source');
 const t={id:'finished',status:'completed',files:[{storedName:'1-aa.mp4'}],options:{pipStoredName:'2-aa.mp4'},outputs:[{file:'a.mp4',outputInfo:{size:3}},{file:'b.mp4',outputInfo:{size:3}}]};
 fs.writeFileSync(path.join(root,'uploads','2-aa.mp4'),'pip');
 fs.mkdirSync(path.join(root,'outputs',t.id));for(const o of t.outputs)fs.writeFileSync(path.join(root,'outputs',t.id,o.file),'123');
 fs.mkdirSync(path.join(root,'work',t.id));
 const queued={id:'queued',status:'queued',files:[{storedName:'1-aa.mp4'}]};p.tasks.set(t.id,t);p.tasks.set(queued.id,queued);p.cleanup();
 assert.ok(fs.existsSync(upload));assert.equal(fs.existsSync(path.join(root,'uploads','2-aa.mp4')),false);assert.equal(t.expiresAt,11000);
 assert.equal(fs.existsSync(path.join(root,'work',t.id)),false);
 queued.status='cancelled';p.cleanup();assert.equal(fs.existsSync(upload),false);
 let lease=p.acquireDownload(t,'a.mp4');lease.release();assert.equal(t.outputs[0].deletedAt,undefined,'manual download must not delete');
 assert.throws(()=>p.acknowledge(t,'a.mp4',2));assert.equal(t.outputs[0].deletedAt,undefined);
 lease=p.acquireDownload(t,'a.mp4');p.acknowledge(t,'a.mp4',3);assert.equal(t.outputs[0].deletedAt,undefined);lease.release();assert.equal(t.outputs[0].deletedReason,'saved');
 p.acknowledge(t,'a.mp4',3);assert.equal(fs.existsSync(path.join(root,'outputs',t.id,'a.mp4')),false);
 lease=p.acquireDownload(t,'b.mp4');clock=11001;p.cleanup();assert.ok(fs.existsSync(lease.path));lease.release();assert.equal(t.outputs[1].deletedReason,'expired');assert.throws(()=>p.acquireDownload(t,'b.mp4'));
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('restart cleans interrupted task uploads and grants legacy outputs a full retention window',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-restart-'));
 try{
 fs.mkdirSync(path.join(root,'uploads'));fs.writeFileSync(path.join(root,'uploads','1-aa.mp4'),'x');
 fs.mkdirSync(path.join(root,'outputs','old'),{recursive:true});fs.writeFileSync(path.join(root,'outputs','old','a.mp4'),'123');
 fs.writeFileSync(path.join(root,'tasks.json'),JSON.stringify([{id:'old',status:'processing',files:[{storedName:'1-aa.mp4'}],outputs:[{file:'a.mp4',outputInfo:{size:3}}]}]));
 const p=createProcessor({root,ffmpeg,ffprobe,now:()=>5000,retentionMs:10000});
 assert.equal(p.tasks.get('old').status,'failed');assert.equal(p.tasks.get('old').expiresAt,15000);assert.equal(fs.existsSync(path.join(root,'uploads','1-aa.mp4')),false);assert.ok(fs.existsSync(path.join(root,'outputs','old','a.mp4')));p.dispose();
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
async function waitForTask(t,timeout=60000){
 const deadline=Date.now()+timeout;
 while(!['completed','partial','failed','cancelled'].includes(t.status)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.equal(t.status,'completed',JSON.stringify(t));
}
test('direct merge splits at keyframes and numbers episodes without losing frames',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-merge-limit-'));
 const p=createProcessor({root,ffmpeg,ffprobe});
 try{
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=green:size=16x16:rate=1:duration=3001','-c:v','libx264','-preset','ultrafast',path.join(root,'uploads','1-aa.mp4')]);
 const t={id:'limit',...p.validate([{storedName:'1-aa.mp4',name:'long.mp4'}],{merge:true,reencode:{preset:'ultrafast',fps:1}}),status:'queued',logs:[],outputs:[]};
 p.enqueue(t);await waitForTask(t,120000);
 assert.equal(t.outputs.length,2);
 assert.equal(t.outputs[0].name,'第001集.mp4');assert.equal(t.outputs[1].name,'第002集.mp4');
 assert.equal(t.outputs.reduce((sum,o)=>sum+o.outputInfo.duration,0),3001);
 const count=f=>Number(JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',f])).streams[0].nb_read_frames);
 assert.equal(t.outputs.reduce((sum,o)=>sum+count(path.join(root,'outputs',t.id,o.file)),0),3001);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('failed merge source is not silently skipped',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-merge-bad-'));
 const p=createProcessor({root,ffmpeg,ffprobe});
 try{
 fs.writeFileSync(path.join(root,'uploads','1-aa.mp4'),'invalid');
 const t={id:'bad-merge',...p.validate([{storedName:'1-aa.mp4',name:'bad.mp4'}],{merge:true}),status:'queued',logs:[],outputs:[]};
 p.enqueue(t);
 const deadline=Date.now()+10000;while(!['completed','failed'].includes(t.status)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
 assert.equal(t.status,'failed');assert.equal(t.outputs.length,0);
 assert.equal(fs.existsSync(path.join(root,'work',t.id)),false);
 assert.throws(()=>normalize({merge:'false'}));
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('compression reduces a high bitrate video while preserving dimensions and every frame',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-compress-')),p=createProcessor({root,ffmpeg,ffprobe});
 try{
 const src=path.join(root,'uploads','1-aa.mp4');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30000/1001:duration=3','-c:v','libx264','-crf','0','-preset','ultrafast',src]);
 const meta=f=>JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-count_frames','-show_streams','-of','json',f])).streams[0];
 const before=meta(src);
 const options={compress:true,reencode:{fps:10,resolution:'1280×720',crf:30}};
 const normalized=normalize(options);assert.equal(normalized.reencode.fps,null);assert.equal(normalized.reencode.resolution,'original');
 const t={id:'compress',...p.validate([{storedName:'1-aa.mp4',name:'video.mp4'}],options),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 const o=t.outputs[0],out=path.join(root,'outputs',t.id,o.file);
 const after=meta(out);
 assert.equal(after.width,before.width);assert.equal(after.height,before.height);assert.equal(after.nb_read_frames,before.nb_read_frames);assert.equal(after.avg_frame_rate,before.avg_frame_rate);
 assert.ok(o.outputInfo.size<o.inputInfo.size);assert.ok(o.compression.savedPercent>0);assert.equal(after.codec_name,'hevc');
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('compression keeps the original container and bytes if encoding grows the file',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-compress-small-')),p=createProcessor({root,ffmpeg,ffprobe});
 try{
 const src=path.join(root,'uploads','1-aa.mkv');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=black:size=16x16:rate=1:duration=1','-c:v','libx264','-crf','51',src]);
 const original=fs.readFileSync(src);
 const t={id:'small',...p.validate([{storedName:'1-aa.mkv',name:'tiny.mkv'}],{compress:true}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 const o=t.outputs[0];assert.ok(o.file.endsWith('.mkv'));assert.equal(o.compression.savedPercent,0);assert.deepEqual(fs.readFileSync(path.join(root,'outputs',t.id,o.file)),original);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
test('compression after quick merge preserves variable frame timing and frame count',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-compress-merge-')),p=createProcessor({root,ffmpeg,ffprobe});
 try{
 const src=path.join(root,'uploads','1-aa.mp4');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=20:duration=1.5','-vf',"setpts='if(lt(N,10),N/(10*TB),(1+(N-10)/20)/TB)'",'-fps_mode','vfr','-c:v','libx264','-crf','0',src]);
 const times=f=>JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_frames','-show_entries','frame=best_effort_timestamp_time','-of','json',f])).frames.map(x=>Number(x.best_effort_timestamp_time));
 const before=times(src);fs.copyFileSync(src,path.join(root,'uploads','2-aa.mp4'));
 const t={id:'compress-merge',...p.validate([{storedName:'1-aa.mp4',name:'a.mp4'},{storedName:'2-aa.mp4',name:'b.mp4'}],{compress:true,merge:true}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 const after=times(path.join(root,'outputs',t.id,t.outputs[0].file));assert.equal(after.length,2*before.length);
 for(let i=1;i<before.length;i++)assert.ok(Math.abs((after[i]-after[i-1])-(before[i]-before[i-1]))<.002);
 assert.equal(t.outputs[0].outputInfo.width,64);assert.equal(t.outputs[0].outputInfo.height,48);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('quick merge copies encoded video and performs vocal separation after filters',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-vocals-'));
 const demucs=path.join(root,'demucs');
 fs.writeFileSync(demucs,`#!${process.execPath}
const fs=require('fs'),path=require('path');const args=process.argv.slice(2);for(const src of args.slice(args.indexOf('-o')+2)){const dir=path.join(args[args.indexOf('-o')+1],'htdemucs',path.parse(src).name);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(src,path.join(dir,'vocals.mp3'));}`,{mode:0o755});
 const p=createProcessor({root,ffmpeg,ffprobe,demucs});
 try{
 const make=()=>{const src=path.join(root,'uploads','1-aa.mp4');execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=64x48:rate=10:duration=2','-f','lavfi','-i','sine=frequency=440:duration=2','-c:v','libx264','-c:a','aac',src]);fs.copyFileSync(src,path.join(root,'uploads','2-aa.mp4'));return src;};
 const src=make();
 const packets=f=>JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=data_hash','-of','json',f])).packets.map(p=>p.data_hash);
 const before=packets(src);
 const files=[{storedName:'1-aa.mp4',name:'a.mp4'},{storedName:'2-aa.mp4',name:'b.mp4'}];
 const quick={id:'quick',...p.validate(files,{merge:true}),status:'queued',logs:[],outputs:[]};p.enqueue(quick);await waitForTask(quick);
 assert.deepEqual(packets(path.join(root,'outputs','quick',quick.outputs[0].file)),[...before,...before]);
 make();
 for(const merge of [false]){
 make();const t={id:'vocals-'+merge,...p.validate(files,{merge,trim:true,trimStart:.5,trimEnd:.5,mirror:true,removeMusic:true,reencode:{preset:'ultrafast'}}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 assert.ok(Math.abs(t.outputs[0].outputInfo.duration-(merge?3:1))<.15);
 if(merge)assert.ok(t.logs.indexOf('最后执行：去背景音乐，保留人声')>t.logs.indexOf('所选去重及输出处理完成'));
 assert.equal(t.outputs[0].outputInfo.hasAudio,true);
 }
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('unlimited merge outputs one complete video beyond 50 minutes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-unlimited-'));
 const p=createProcessor({root,ffmpeg,ffprobe});
 try{
 assert.throws(()=>normalize({mergeUnlimited:'true'}));
 assert.throws(()=>normalize({merge:true,mergeUnlimited:true}));
 const src=path.join(root,'uploads','1-aa.mp4');
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=green:size=16x16:rate=1:duration=1501','-c:v','libx264','-preset','ultrafast',src]);
 fs.copyFileSync(src,path.join(root,'uploads','2-aa.mp4'));
 const t={id:'unlimited',...p.validate([{storedName:'1-aa.mp4',name:'a.mp4'},{storedName:'2-aa.mp4',name:'b.mp4'}],{mergeUnlimited:true}),status:'queued',logs:[],outputs:[]};
 p.enqueue(t);await waitForTask(t);
 assert.equal(t.outputs.length,1);
 assert.ok(Math.abs(t.outputs[0].outputInfo.duration-3002)<.1);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('both merge modes insert the ten-second transition exactly once after the first clip',async()=>{
 for(const mode of ['merge','mergeUnlimited']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-transition-')),p=createProcessor({root,ffmpeg,ffprobe});
 try{
 for(const [name,color,size,duration] of [['1-aa.mp4','red','64x48',1],['2-aa.mp4','blue','64x48',1],['3-aa.mp4','lime','64x48',10]])execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i',`color=${color}:size=${size}:rate=10:duration=${duration}`,'-c:v','libx264',path.join(root,'uploads',name)]);
 const files=[{storedName:'1-aa.mp4',name:'red.mp4'},{storedName:'2-aa.mp4',name:'blue.mp4'},{storedName:'1-aa.mp4',name:'red-again.mp4'}];
 const options={[mode]:true,transition:true,transitionStoredName:'3-aa.mp4',reencode:{preset:'ultrafast',fps:10}};
 assert.throws(()=>p.validate(files,{transition:true,transitionStoredName:'3-aa.mp4'}));
 assert.throws(()=>p.validate(files.slice(0,1),options));
 assert.throws(()=>p.validate(files,{...options,transitionStoredName:'../bad'}));
 assert.throws(()=>normalize({transition:'true'}));
 const t={id:'transition',...p.validate(files,options),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 assert.equal(t.outputs.length,1);assert.ok(Math.abs(t.outputs[0].outputInfo.duration-13)<.1);
 const out=path.join(root,'outputs',t.id,t.outputs[0].file);
 for(const [at,channel] of [[.5,0],[5,1],[11.5,2],[12.5,0]]){
 const rgb=execFileSync(ffmpeg,['-v','error','-ss',String(at),'-i',out,'-frames:v','1','-vf','scale=1:1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);assert.ok(rgb[channel]>200,`wrong clip at ${at}: ${rgb}`);
 }
 assert.equal(fs.existsSync(path.join(root,'uploads','3-aa.mp4')),false);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('incompatible sources fail without converting or publishing outputs',async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-incompatible-')),p=createProcessor({root,ffmpeg,ffprobe});
try{
for(const [name,size] of [['1-aa.mp4','64x48'],['2-aa.mp4','80x60']])execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i',`color=red:size=${size}:rate=10:duration=1`,'-c:v','libx264',path.join(root,'uploads',name)]);
const t={id:'bad',...p.validate([{storedName:'1-aa.mp4',name:'a'},{storedName:'2-aa.mp4',name:'b'}],{mergeUnlimited:true}),logs:[],outputs:[],status:'queued'};p.enqueue(t);
while(!['completed','failed'].includes(t.status))await new Promise(r=>setTimeout(r,50));
assert.equal(t.status,'failed');assert.match(t.error,/不兼容/);assert.equal(t.outputs.length,0);
}finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('both merge modes plus compression accept two-pixel mismatch and apply edits',async()=>{
 for(const mode of ['merge','mergeUnlimited']){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-compress-compatible-')),p=createProcessor({root,ffmpeg,ffprobe});
 try{
 for(const [name,size] of [['1-aa.mp4','64x50'],['2-aa.mp4','64x48']])execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=10:duration=2`,'-c:v','libx264',path.join(root,'uploads',name)]);
 const t={id:'compatible',...p.validate([{storedName:'1-aa.mp4',name:'a.mp4'},{storedName:'2-aa.mp4',name:'b.mp4'}],{[mode]:true,compress:true,trim:true,trimStart:.5,trimEnd:.5,mirror:true}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 assert.equal(t.outputs.length,1);const info=t.outputs[0].outputInfo;assert.equal(info.width,64);assert.equal(info.height,50);assert.equal(info.codec,'hevc');assert.ok(Math.abs(info.duration-3)<.1);assert.ok(t.logs.some(x=>x.includes('统一为 64×50')));
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
 }
});

test('episode merge compresses mismatched inputs then splits and numbers the complete result',async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-episodes-')),p=createProcessor({root,ffmpeg,ffprobe});
try{
for(const [name,size] of [['1-aa.mp4','16x16'],['2-aa.mp4','16x18']])execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i',`color=green:size=${size}:rate=1:duration=1501`,'-c:v','libx264','-preset','ultrafast',path.join(root,'uploads',name)]);
const t={id:'episodes',...p.validate([{storedName:'1-aa.mp4',name:'a.mp4'},{storedName:'2-aa.mp4',name:'b.mp4'}],{merge:true,compress:true}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
assert.equal(t.outputs.length,2);assert.deepEqual(t.outputs.map(x=>x.name),['第001集.mp4','第002集.mp4']);assert.ok(t.outputs.every(x=>x.outputInfo.codec==='hevc'&&x.outputInfo.width===16&&x.outputInfo.height===16));
const count=f=>Number(JSON.parse(execFileSync(ffprobe,['-v','error','-select_streams','v:0','-count_frames','-show_entries','stream=nb_read_frames','-of','json',f])).streams[0].nb_read_frames);
assert.equal(t.outputs.reduce((n,o)=>n+count(path.join(root,'outputs',t.id,o.file)),0),3002);
}finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('long vocal separation bounds each Demucs input and preserves duration',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-vocal-chunks-'));
 const demucs=path.join(root,'demucs'),record=path.join(root,'chunks.jsonl');
 fs.writeFileSync(demucs,`#!${process.execPath}
const fs=require('fs'),path=require('path'),cp=require('child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(record)},'loaded\\n');for(const src of args.slice(args.indexOf('-o')+2)){const meta=JSON.parse(cp.execFileSync(${JSON.stringify(ffprobe)},['-v','error','-show_format','-of','json',src]));fs.appendFileSync(${JSON.stringify(record)},meta.format.duration+'\\n');const dir=path.join(args[args.indexOf('-o')+1],'htdemucs',path.parse(src).name);fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(src,path.join(dir,'vocals.mp3'));}`,{mode:0o755});
 const p=createProcessor({root,ffmpeg,ffprobe,demucs});
 try{
 execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','color=red:size=16x16:rate=1:duration=301','-f','lavfi','-i','sine=frequency=440:duration=301','-c:v','libx264','-c:a','aac',path.join(root,'uploads','1-aa.mp4')]);
 const t={id:'chunks',...p.validate([{storedName:'1-aa.mp4',name:'long.mp4'}],{removeMusic:true,reencode:{preset:'ultrafast'}}),status:'queued',logs:[],outputs:[]};p.enqueue(t);await waitForTask(t);
 const records=fs.readFileSync(record,'utf8').trim().split('\n');assert.equal(records.filter(x=>x==='loaded').length,1);const durations=records.filter(x=>x!=='loaded').map(Number);
 assert.equal(durations.length,2);assert.ok(durations.every(d=>d<=304));assert.ok(Math.abs(t.outputs[0].outputInfo.duration-301)<.1);
 assert.ok(t.logs.some(x=>x.includes('2/2')));
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});

test('completed manual transfers delete server copies while interrupted transfers retain them',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-consume-'));
 const p=createProcessor({root,ffmpeg,ffprobe});
 try{
 const t={id:'consume',status:'completed',files:[],outputs:[{file:'a.mp4',outputInfo:{size:3}}]};p.tasks.set(t.id,t);
 fs.mkdirSync(path.join(root,'outputs',t.id));const file=path.join(root,'outputs',t.id,'a.mp4');fs.writeFileSync(file,'123');p.cleanup();
 p.acquireDownload(t,'a.mp4').release();assert.ok(fs.existsSync(file));
 const first=p.acquireDownload(t,'a.mp4'),second=p.acquireDownload(t,'a.mp4');first.release({completed:true});assert.ok(fs.existsSync(file),'another download is still reading');
 second.release();assert.equal(fs.existsSync(file),false);assert.equal(t.outputs[0].deletedReason,'saved');
 first.release({completed:true});assert.equal(fs.existsSync(file),false);
 }finally{p.dispose();fs.rmSync(root,{recursive:true,force:true});}
});
