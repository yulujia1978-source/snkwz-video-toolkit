const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=fs.promises,os=require('node:os'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const app=path.join(__dirname,'../dist/视频去重.app/Contents/Resources');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

test('save merged output to the source parent without old directory blocks or reprocessing the generated file',async()=>{
 const temp=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'vd-parent-output-'))),root=path.join(temp,'data'),input=path.join(temp,'我的系列');await fsp.mkdir(input);await fsp.mkdir(root);
 await fsp.writeFile(path.join(root,'auto-queues.json'),JSON.stringify({groups:[],excludedOutputs:[temp]}));
 const ff=path.join(app,'bin/ffmpeg');execFileSync(ff,['-v','error','-f','lavfi','-i','color=red:size=160x120:rate=15:duration=1','-c:v','libx264',path.join(input,'1.mp4')]);await fsp.copyFile(path.join(input,'1.mp4'),path.join(input,'2.mp4'));
 let server=await launch(root);
 try{
  const id=(await server.request('/auto-queue/groups',{inputDirectory:input,outputDirectory:temp,settleSeconds:.15,autoStop:false})).createdId;
  await server.request('/auto-queue/start',{id,options:{mergeUnlimited:true}});await eventually(async()=> (await server.request('/auto-queue')).counts.completed===2);
  const saved=(await server.request('/auto-queue')).entries[0].savedPaths[0];assert.equal(saved,path.join(input,'我的系列.mp4'));assert.ok((await fsp.stat(saved)).size>0);
  await sleep(600);assert.equal((await server.request('/auto-queue')).entries.length,2,'generated video inside the input must be skipped');
  await server.close();server=await launch(root);await server.request('/auto-queue/start',{id});await sleep(600);const state=await server.request('/auto-queue');assert.equal(state.entries.length,2);assert.equal(state.counts.completed,2);assert.equal(state.active,null);
 }finally{await server.close();await fsp.rm(temp,{recursive:true,force:true});}
});
async function eventually(fn,timeout=15000){const until=Date.now()+timeout;while(Date.now()<until){if(await fn())return;await sleep(35);}assert.fail('automatic processing timed out');}
async function launch(root){const child=spawn(path.join(app,'bin/node'),[path.join(app,'server.cjs')],{env:{...process.env,VD_DATA_ROOT:root,VD_TOKEN:'watch-test',VD_TOOLS:path.join(app,'bin'),VD_WATCH_TICK_MS:'25'},stdio:['pipe','pipe','pipe']});let errors='';child.stderr.on('data',d=>errors+=d);const port=await new Promise((resolve,reject)=>{let buffer='';child.stdout.on('data',d=>{buffer+=d;if(buffer.includes('\n'))resolve(JSON.parse(buffer.trim()).port);});child.on('exit',()=>reject(Error(errors)));});return{child,async request(route,body){const response=await fetch(`http://127.0.0.1:${port}/api/admin/video-dedupe`+route,{method:body?'POST':'GET',headers:{'X-Desktop-Token':'watch-test','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();assert.equal(response.status,200,JSON.stringify(data));return data;},async close(){if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.stdin.end();await done;}};}
test('real automatic folder processing: stable files, next video after failure, safe export, stop, restart and no duplicate work',async()=>{
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'vd-auto-desktop-')),root=path.join(temp,'data'),input=path.join(temp,'input'),output=path.join(input,'成品');await fsp.mkdir(output,{recursive:true});
 const fixture=path.join(temp,'fixture.mp4');execFileSync(path.join(app,'bin/ffmpeg'),['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15:duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',fixture]);
 const bytes=await fsp.readFile(fixture),hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),source=path.join(input,"01-first ' 视频.mp4");
 let server=await launch(root);
 const cfg={inputDirectory:input,outputDirectory:output,settleSeconds:.2,autoStop:false,options:{hardwareAcceleration:true,blackLine:true,borderSize:8,keepAudio:true}};
 try{
  await fsp.writeFile(path.join(output,"用户文件.txt"),'existing user file');
  await server.request('/auto-queue/start',cfg);
  await fsp.writeFile(source,bytes.subarray(0,1000));await sleep(70);assert.equal((await server.request('/auto-queue')).entries.length,0,'writing file must not process early');await fsp.appendFile(source,bytes.subarray(1000));
  await eventually(async()=> (await server.request('/auto-queue')).counts.completed===1);
  assert.equal(hash(source),hash(fixture));assert.equal(await fsp.readFile(path.join(output,"用户文件.txt"),'utf8'),'existing user file');
  await fsp.writeFile(path.join(input,'02-bad.mp4'),'not a valid video');await fsp.copyFile(fixture,path.join(input,'03-next.mp4'));
  await eventually(async()=>{const s=await server.request('/auto-queue');return s.counts.completed===2&&s.counts.failed===1;});
  let state=await server.request('/auto-queue');for(const e of state.entries.filter(e=>e.status==='completed'))assert.equal(path.basename(path.dirname(e.savedPaths[0])),path.parse(e.source).name);assert.equal(state.enabled,true);assert.equal(state.entries.length,3,'output subfolder must never feed back into the queue');
  for(const entry of state.entries.filter(e=>e.status==='completed')){const media=JSON.parse(execFileSync(path.join(app,'bin/ffprobe'),['-v','error','-show_streams','-of','json',entry.savedPaths[0]]));assert.equal(media.streams.find(s=>s.codec_type==='video').width,336);assert.ok(media.streams.some(s=>s.codec_type==='audio'));}
  await server.request('/auto-queue/stop',{});await fsp.copyFile(fixture,path.join(input,'04-later.mp4'));await sleep(350);assert.equal((await server.request('/auto-queue')).entries.length,3);
  await server.request('/auto-queue/start',cfg);await eventually(async()=> (await server.request('/auto-queue')).counts.completed===3);assert.equal((await server.request('/auto-queue')).entries.length,4);
  await server.close();server=await launch(root);state=await server.request('/auto-queue');assert.equal(state.enabled,false,'relaunch must wait for explicit start');assert.equal(state.counts.completed,3);
  await server.request('/auto-queue/start',cfg);await sleep(500);state=await server.request('/auto-queue');assert.equal(state.counts.completed,3);assert.equal(state.entries.length,4,'completed files must remain skipped after a restart');assert.equal(hash(source),hash(fixture));
 }finally{await server.close();await fsp.rm(temp,{recursive:true,force:true});}
});
test('multiple folder pairs independently route real videos, stop separately and survive relaunch',async()=>{
 const temp=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'vd-multi-desktop-'))),root=path.join(temp,'data');
 const dirs={};for(const key of ['inputA','inputB','outputA','outputB']){dirs[key]=path.join(temp,key);await fsp.mkdir(dirs[key]);}
 for(const [input,size] of [[dirs.inputA,'320x240'],[dirs.inputB,'160x120']])execFileSync(path.join(app,'bin/ffmpeg'),['-v','error','-f','lavfi','-i',`testsrc2=size=${size}:rate=15:duration=1`,'-c:v','libx264',path.join(input,'episode.mp4')]);
 let server=await launch(root);const configA={inputDirectory:dirs.inputA,outputDirectory:dirs.outputA,settleSeconds:.15,autoStop:false},configB={inputDirectory:dirs.inputB,outputDirectory:dirs.outputB,settleSeconds:.15,autoStop:false};
 try{
  const a=(await server.request('/auto-queue/groups',configA)).createdId,b=(await server.request('/auto-queue/groups',configB)).createdId;
  await server.request('/auto-queue/start',{id:a,options:{hardwareAcceleration:true,borderSize:8}});await server.request('/auto-queue/start',{id:b,options:{hardwareAcceleration:true,crop:10}});
  await eventually(async()=>{const state=await server.request('/auto-queue');assert.ok(state.groups.filter(g=>g.active?.taskStatus==='processing').length<=1,'all groups must share serial encoding');return state.groups.every(g=>g.counts.completed===1);});
  let state=await server.request('/auto-queue');assert.equal(state.groups.length,2);
  for(const [id,output,w,h] of [[a,dirs.outputA,336,256],[b,dirs.outputB,160,108]]){const group=state.groups.find(g=>g.id===id),saved=group.entries[0].savedPaths[0];assert.equal(path.dirname(saved),path.join(output,'episode'));const meta=JSON.parse(execFileSync(path.join(app,'bin/ffprobe'),['-v','error','-show_streams','-of','json',saved]));assert.equal(meta.streams[0].width,w);assert.equal(meta.streams[0].height,h);}
  await server.request('/auto-queue/stop',{id:a});await fsp.copyFile(path.join(dirs.inputA,'episode.mp4'),path.join(dirs.inputA,'next.mp4'));await fsp.copyFile(path.join(dirs.inputB,'episode.mp4'),path.join(dirs.inputB,'next.mp4'));
  await eventually(async()=> (await server.request('/auto-queue')).groups.find(g=>g.id===b).counts.completed===2);state=await server.request('/auto-queue');assert.equal(state.groups.find(g=>g.id===a).counts.completed,1);assert.equal(state.groups.find(g=>g.id===b).enabled,true);
  await server.request('/auto-queue/groups/remove',{id:a});assert.ok(fs.existsSync(path.join(dirs.inputA,'episode.mp4')));assert.ok(fs.existsSync(path.join(dirs.outputA,'episode','episode.mp4')));
  await server.close();server=await launch(root);state=await server.request('/auto-queue');assert.equal(state.groups.length,1);assert.equal(state.groups[0].id,b);assert.equal(state.enabled,false);assert.equal(state.counts.completed,2);
  await server.request('/auto-queue/start',{id:b});await sleep(450);assert.equal((await server.request('/auto-queue')).counts.completed,2);
 }finally{await server.close();await fsp.rm(temp,{recursive:true,force:true});}
});
test('automatic complete merge applies compression, episode merge splits at 50 minutes, and redo preserves existing outputs',async()=>{
 const temp=await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(),'vd-auto-real-merge-'))),root=path.join(temp,'data'),dirs={};
 for(const key of ['inputA','inputB','outputA','outputB']){dirs[key]=path.join(temp,key);await fsp.mkdir(dirs[key]);}
 const ff=path.join(app,'bin/ffmpeg'),probe=path.join(app,'bin/ffprobe');
 for(const [name,color] of [['2.mp4','red'],['10.mp4','blue']])execFileSync(ff,['-v','error','-f','lavfi','-i',`color=${color}:size=320x240:rate=15:duration=1`,'-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','libx264','-c:a','aac',path.join(dirs.inputA,name)]);
 for(const name of ['1.mp4','2.mp4'])execFileSync(ff,['-v','error','-f','lavfi','-i','color=green:size=16x16:rate=1:duration=1501','-c:v','libx264','-g','1',path.join(dirs.inputB,name)]);
 const server=await launch(root);
 try{
  const a=(await server.request('/auto-queue/groups',{inputDirectory:dirs.inputA,outputDirectory:dirs.outputA,settleSeconds:.15})).createdId;
  const b=(await server.request('/auto-queue/groups',{inputDirectory:dirs.inputB,outputDirectory:dirs.outputB,settleSeconds:.15})).createdId;
  await server.request('/auto-queue/start',{id:a,options:{mergeUnlimited:true,mergeName:'完整成品',compress:true,keepAudio:true,hardwareAcceleration:true}});
  await server.request('/auto-queue/start',{id:b,options:{merge:true,mergeName:'分集成品'}});
  await eventually(async()=>{const s=await server.request('/auto-queue');return s.counts.completed===4&&!s.enabled&&!s.active;},30000);
  let state=await server.request('/auto-queue'),ga=state.groups.find(g=>g.id===a),gb=state.groups.find(g=>g.id===b);
  assert.equal(ga.name,'inputA');assert.equal(gb.name,'inputB');assert.equal(ga.config.options.mergeName,'inputA');assert.equal(gb.config.options.mergeName,'inputB');assert.equal(ga.stopReason,'completed');assert.equal(gb.stopReason,'completed');assert.equal(ga.counts.outputs,1);assert.equal(gb.counts.outputs,2);assert.equal(ga.entries[0].taskId,ga.entries[1].taskId);assert.equal(gb.entries[0].taskId,gb.entries[1].taskId);
  const complete=path.join(dirs.outputA,'inputA','inputA.mp4'),meta=JSON.parse(execFileSync(probe,['-v','error','-show_format','-show_streams','-of','json',complete]));
  assert.equal(meta.streams[0].codec_name,'hevc');assert.equal(meta.streams[0].width,320);assert.ok(Math.abs(Number(meta.format.duration)-2)<.15);assert.ok(meta.streams.some(s=>s.codec_type==='audio'));
  const pixel=at=>execFileSync(ff,['-v','error','-ss',String(at),'-i',complete,'-vf','scale=1:1','-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1']);
  const red=pixel(.3),blue=pixel(1.3);assert.ok(red[0]>red[2]+100);assert.ok(blue[2]>blue[0]+100,'numeric order must put 2.mp4 before 10.mp4');
  const episodes=(await fsp.readdir(path.join(dirs.outputB,'inputB'))).sort();assert.deepEqual(episodes,['inputB-第001集.mp4','inputB-第002集.mp4']);
  const durations=episodes.map(name=>Number(JSON.parse(execFileSync(probe,['-v','error','-show_format','-of','json',path.join(dirs.outputB,'inputB',name)])).format.duration));assert.ok(Math.abs(durations.reduce((a,b)=>a+b,0)-3002)<.1);
  const oldHash=createHash('sha256').update(await fsp.readFile(complete)).digest('hex');
  await server.request('/auto-queue/stop',{id:a});await server.request('/auto-queue/reset',{id:a});state=await server.request('/auto-queue');assert.equal(state.groups.find(g=>g.id===a).entries.length,0);assert.ok(fs.existsSync(complete));
  await server.request('/auto-queue/start',{id:a,options:{mergeUnlimited:true,mergeName:'完整成品',compress:true,hardwareAcceleration:true}});
  await eventually(async()=> (await server.request('/auto-queue')).groups.find(g=>g.id===a).counts.completed===2);
  assert.ok(fs.existsSync(path.join(dirs.outputA,'inputA','inputA (1).mp4')));assert.equal(createHash('sha256').update(await fsp.readFile(complete)).digest('hex'),oldHash);
 }finally{await server.close();await fsp.rm(temp,{recursive:true,force:true});}
});
test('native merge handles a noncanonical macOS data root and quoted source paths while applying effects and compression',async()=>{
 const temp=await fsp.mkdtemp(path.join(os.tmpdir(),'vd-native-alias-')),root=path.join(temp,'data'),input=path.join(temp,"input ' 视频"),output=path.join(temp,'output');await fsp.mkdir(input);await fsp.mkdir(output);
 const ff=path.join(app,'bin/ffmpeg'),probe=path.join(app,'bin/ffprobe'),first=path.join(input,"01 ' 视频.mp4");
 execFileSync(ff,['-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15:duration=1','-c:v','libx264',first]);await fsp.copyFile(first,path.join(input,"02 ' 视频.mp4"));
 const server=await launch(root);
 try{
  const id=(await server.request('/auto-queue/groups',{inputDirectory:input,outputDirectory:output,settleSeconds:.15})).createdId;
  await server.request('/auto-queue/start',{id,options:{mergeUnlimited:true,compress:true,blackLine:true,grid:3,hardwareAcceleration:true}});
  await eventually(async()=> (await server.request('/auto-queue')).counts.completed===2);
  const state=await server.request('/auto-queue');assert.equal(state.counts.outputs,1);const dest=state.groups[0].entries[0].savedPaths[0];
  const meta=JSON.parse(execFileSync(probe,['-v','error','-show_streams','-show_format','-of','json',dest]));assert.equal(meta.streams[0].codec_name,'hevc');assert.ok(Math.abs(Number(meta.format.duration)-2)<.15);
 }finally{await server.close();await fsp.rm(temp,{recursive:true,force:true});}
});
