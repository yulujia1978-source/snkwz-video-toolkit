'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),{createHash}=require('node:crypto');
const {sourceName}=require('./watch-settings.cjs');
const terminal=t=>['completed','partial','failed','cancelled'].includes(t.status);
const video=/\.(mp4|mov|m4v|webm|avi|mkv|ts|mts|m2ts|mpeg|mpg)$/i;
const inside=(parent,child)=>{const rel=path.relative(parent,child);return rel===''||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel));};
const key=(source,stat)=>createHash('sha256').update(JSON.stringify([source,stat.size,stat.mtimeMs])).digest('hex').slice(0,24);
function createAutoQueue({root,processor,createTask,exportOutput,importFile,tickMs=2000,manualTick=false,canEnqueue=()=>true,excludedDirectories=()=>[],isExcludedFile=()=>false}){
 const file=path.join(root,'auto-queue.json'),entries=new Map(),observed=new Map();
 let config=null,enabled=false,activeId=null,lastError='',inFlight=null,closed=false,configuring=false,generation=0,stopReason='',finishedAt=null,sessionStartedAt=0,sessionHadFiles=false;
 function persist(){fs.writeFileSync(file+'.tmp',JSON.stringify({config,stopReason,finishedAt,entries:[...entries.values()]},null,2));fs.renameSync(file+'.tmp',file);}
 const members=entry=>entry.batchIds?entry.batchIds.map(id=>entries.get(id)).filter(Boolean):[entry];
 function mark(entry,status,error){for(const e of members(entry)){e.status=status;if(error)e.error=error;else delete e.error;}}
 try{const saved=JSON.parse(fs.readFileSync(file,'utf8'));config=saved.config||null;stopReason=saved.stopReason||'';finishedAt=saved.finishedAt||null;for(const e of saved.entries||[]){
  if(['queued','processing','saving'].includes(e.status)){const t=processor.tasks.get(e.taskId);e.status=t?.outputs?.length&&t.outputs.every(o=>o.deletedReason==='saved')?'completed':t?.outputs?.some(o=>!o.deletedAt)?'save_failed':'interrupted';}
  entries.set(e.id,e);
 }}catch{}
 const generated=new Set([...entries.values()].flatMap(e=>e.savedPaths||[]).map(p=>path.resolve(p)));
 const excluded=source=>generated.has(path.resolve(source))||isExcludedFile(source);
 function snapshot(){
  const rows=[...entries.values()].filter(e=>!config||inside(config.inputDirectory,e.source));
  const active=activeId?entries.get(activeId):null,t=active&&processor.tasks.get(active.taskId);
  return{enabled,stopReason,finishedAt,active:active?{...active,name:active.batchIds?'合并 '+active.batchIds.length+' 个视频':active.name,progress:t?.progress||0,phase:t?.phase,currentFile:t?.currentFile,speed:t?.speed||0,taskStatus:t?.status}:null,config:config?{...config,pipPath:undefined}:null,lastError,
   counts:{outputs:new Set(rows.filter(e=>e.status==='completed').flatMap(e=>e.savedPaths||[])).size,waiting:rows.filter(e=>e.status==='waiting').length,completed:rows.filter(e=>e.status==='completed').length,failed:rows.filter(e=>['failed','save_failed','interrupted'].includes(e.status)).length,retryable:rows.filter(e=>['failed','interrupted'].includes(e.status)).length,stabilizing:observed.size},
   entries:rows.slice(-100).reverse()};
 }
 async function start(value){if(configuring)throw Error('正在启动自动处理，请稍候');configuring=true;try{return await configure(value);}finally{configuring=false;}}
 async function configure(value){
  const startGeneration=++generation;
  if(closed)throw Error('应用正在退出');if(enabled||activeId)throw Error('请先停止自动处理并等待当前视频完成');if(inFlight)await inFlight;
  if(!value||typeof value.inputDirectory!=='string'||typeof value.outputDirectory!=='string')throw Error('请选择监听文件夹和输出文件夹');
  const inputDirectory=await fsp.realpath(value.inputDirectory),outputDirectory=await fsp.realpath(value.outputDirectory);
  if(!(await fsp.stat(inputDirectory)).isDirectory()||!(await fsp.stat(outputDirectory)).isDirectory())throw Error('请选择有效文件夹');
  if(inputDirectory===outputDirectory)throw Error('监听和输出文件夹不能相同，避免成品再次入队');
  await fsp.access(inputDirectory,fs.constants.R_OK);await fsp.access(outputDirectory,fs.constants.W_OK);
  const settleSeconds=Number(value.settleSeconds??10);if(!Number.isFinite(settleSeconds)||settleSeconds<.05||settleSeconds>600)throw Error('文件稳定等待时间无效');
  if(value.autoStop!==undefined&&typeof value.autoStop!=='boolean')throw Error('自动停止设置无效');
  const options={...value.options,mergeName:sourceName(inputDirectory)};
  if(options.pipOpacity>0){if(typeof value.pipPath!=='string')throw Error('请先选择画中画辅助视频');value.pipPath=await fsp.realpath(value.pipPath);options.pipStoredName=(await importFile(value.pipPath)).storedName;}
  if(options.transition){if(typeof value.transitionPath!=='string')throw Error('请先选择过场视频');value.transitionPath=await fsp.realpath(value.transitionPath);options.transitionStoredName=(await importFile(value.transitionPath)).storedName;}
  // Validate all effect parameters before enabling an unattended session.
  require('./services/video-dedupe').normalize(options);
  if(closed||generation!==startGeneration)throw Error('启动已取消');
  config={inputDirectory,outputDirectory,settleSeconds,autoStop:value.autoStop!==false,options,pipPath:value.pipPath||null,transitionPath:value.transitionPath||null};
  observed.clear();lastError='';stopReason='';finishedAt=null;sessionStartedAt=Date.now();sessionHadFiles=false;
  for(const e of entries.values())if(inside(inputDirectory,e.source)&&e.status==='interrupted'){e.status='waiting';delete e.batchIds;delete e.batchOwner;delete e.taskId;}
  enabled=true;try{persist();}catch(e){enabled=false;throw e;}void tick();return snapshot();
 }
 function stop(){generation++;if(enabled||activeId)stopReason='manual';enabled=false;observed.clear();persist();return snapshot();}
 async function walk(directory,found){
  for(const entry of await fsp.readdir(directory,{withFileTypes:true})){
   if(entry.name.startsWith('.'))continue;
   const source=path.join(directory,entry.name);
   if(excluded(source)||excludedDirectories().some(dir=>inside(dir,source))||source===config.pipPath||source===config.transitionPath)continue;
   if(entry.isSymbolicLink())continue;
   try{if(entry.isDirectory()){if(!/\.(app|bundle|photoslibrary)$/i.test(entry.name))await walk(source,found);}
   else if(entry.isFile()&&video.test(entry.name)){const stat=await fsp.stat(source);if(stat.size>0||config.autoStop!==false||config.options.merge||config.options.mergeUnlimited)found.push({source,stat,id:key(source,stat)});}}catch(e){if(e.code!=='ENOENT')throw e;}
  }
 }
 async function scan(){
  const found=[];await walk(config.inputDirectory,found);if(!enabled)return;
  if(found.length)sessionHadFiles=true;
  const now=Date.now(),present=new Set();let changed=false;
  found.sort((a,b)=>a.source.localeCompare(b.source,'zh-CN',{numeric:true}));
  for(const candidate of found){
   present.add(candidate.id);if(entries.has(candidate.id))continue;
   if(candidate.stat.size===0){if(!observed.has(candidate.id))observed.set(candidate.id,{since:now});continue;}
   const previous=observed.get(candidate.id);
   if(!previous){observed.set(candidate.id,{since:now});continue;}
   if(now-previous.since<config.settleSeconds*1000||now-candidate.stat.mtimeMs<config.settleSeconds*1000)continue;
   entries.set(candidate.id,{id:candidate.id,source:candidate.source,name:path.relative(config.inputDirectory,candidate.source),size:candidate.stat.size,mtimeMs:candidate.stat.mtimeMs,status:'waiting',createdAt:now,savedPaths:[]});
   observed.delete(candidate.id);changed=true;
  }
  for(const id of observed.keys())if(!present.has(id))observed.delete(id);
  if(changed)persist();
 }
 async function saveEntry(entry,task){
  mark(entry,'saving');persist();
  try{
   for(const output of task.outputs||[]){
    if(output.deletedReason==='saved')continue;
    if(output.deletedAt)throw Error('未保存成品已过期，需要重新提交视频');
    if(!entry.batchIds)output.name=path.parse(entry.source).name+path.extname(output.name);
    const result=await exportOutput(task,{file:output.file,directory:config.outputDirectory});
    generated.add(path.resolve(result.path));for(const e of members(entry))e.savedPaths.push(result.path);persist();
   }
   mark(entry,'completed');for(const e of members(entry))e.finishedAt=Date.now();
  }catch(e){mark(entry,'save_failed',e.message);lastError='成品保存失败，已停止自动接收。检查输出文件夹后点击开始重试保存：'+e.message;enabled=false;stopReason='save_failed';}
  persist();
 }
 async function updateActive(){
  if(!activeId)return;
  const entry=entries.get(activeId),task=processor.tasks.get(entry.taskId);
  if(!task){mark(entry,'failed','任务不存在');activeId=null;persist();return;}
  if(!terminal(task)){mark(entry,task.status==='queued'?'queued':'processing');return;}
  if(task.status==='completed'&&task.outputs?.length){
   const changed=[];for(const e of members(entry)){try{if(key(e.source,await fsp.stat(e.source))!==e.id)changed.push(e.id);}catch{changed.push(e.id);}}
   if(changed.length){for(const e of members(entry)){e.status=changed.includes(e.id)?'changed':'waiting';e.error='处理期间源文件有变化，等待稳定后重新入队';delete e.batchOwner;delete e.taskId;}delete entry.batchIds;task.expiresAt=Date.now();processor.cleanup?.();persist();}
   else await saveEntry(entry,task);
  }
  else{mark(entry,'failed',task.error||task.failures?.[0]?.error||'任务已取消或处理失败');for(const e of members(entry))e.finishedAt=Date.now();persist();}
  activeId=null;
 }
 async function pump(){
  if(!enabled||activeId)return;
  // Recover a completed encode before starting more work after an export failure.
  const retry=[...entries.values()].find(e=>inside(config.inputDirectory,e.source)&&e.status==='save_failed'&&!e.batchOwner);
  if(retry){const task=processor.tasks.get(retry.taskId);if(task?.outputs?.some(o=>!o.deletedAt)){activeId=retry.id;await saveEntry(retry,task);activeId=null;return;}mark(retry,'failed','临时成品已过期；点击“重试失败视频”重新处理');persist();}
  if(!canEnqueue()||[...processor.tasks.values()].some(t=>!terminal(t)))return;
  const merging=!!(config.options.merge||config.options.mergeUnlimited);
  if(merging&&observed.size)return;
  const waiting=[...entries.values()].filter(e=>inside(config.inputDirectory,e.source)&&!excluded(e.source)&&e.status==='waiting').sort((a,b)=>a.source.localeCompare(b.source,'zh-CN',{numeric:true}));
  const batch=merging?waiting:waiting.slice(0,1),entry=batch[0];if(!entry)return;
  if(config.options.transition&&batch.length<2){lastError='已启用过场视频，等待至少两个稳定的主视频后合并';return;}
  try{
   for(const e of batch){const stat=await fsp.stat(e.source);if(key(e.source,stat)!==e.id){e.status='changed';persist();return;}}
   const imported=[];for(const e of batch){imported.push(await importFile(e.source));if(!enabled||closed)return;}
   const task=createTask(imported,config.options);
   if(merging){entry.batchIds=batch.map(e=>e.id);for(const e of batch)if(e!==entry)e.batchOwner=entry.id;}
   lastError='';for(const e of batch){e.taskId=task.id;e.status='queued';delete e.error;}activeId=entry.id;persist();
  }catch(e){for(const item of batch){item.status='failed';item.error=e.message;item.finishedAt=Date.now();}persist();}
 }
 function finishIfDrained(){
  if(!enabled||config.autoStop===false||activeId||observed.size)return;
  const rows=[...entries.values()].filter(e=>inside(config.inputDirectory,e.source));
  if(rows.some(e=>['waiting','queued','processing','saving','save_failed','interrupted'].includes(e.status)))return;
  if(!sessionHadFiles&&Date.now()-sessionStartedAt<config.settleSeconds*1000)return;
  enabled=false;finishedAt=Date.now();stopReason=rows.some(e=>e.status==='failed')?'finished_with_errors':rows.length?'completed':'empty';persist();
 }
 async function performTick(){
  try{await updateActive();if(enabled){await scan();await pump();finishIfDrained();}}
  catch(e){lastError='自动处理暂未完成：'+e.message;enabled=false;stopReason='error';try{persist();}catch{}}
 }
 function tick(){if(closed)return Promise.resolve();if(inFlight)return inFlight;inFlight=performTick().finally(()=>inFlight=null);return inFlight;}
 function retryFailed(){for(const e of entries.values())if(config&&inside(config.inputDirectory,e.source)&&['failed','interrupted'].includes(e.status)){e.status='waiting';delete e.error;delete e.batchOwner;delete e.batchIds;}persist();void tick();return snapshot();}
 async function resetHistory(){
  if(enabled||activeId||configuring)throw Error('请先停止此任务并等待当前处理完成');if(inFlight)await inFlight;
  if(enabled||activeId||configuring)throw Error('此任务正在运行');
  const previous=[...entries.values()];fs.writeFileSync(path.join(root,'history-'+Date.now()+'.json'),JSON.stringify({config,entries:previous},null,2));
  entries.clear();observed.clear();lastError='';stopReason='';finishedAt=null;try{persist();}catch(e){for(const entry of previous)entries.set(entry.id,entry);throw e;}return snapshot();
 }
 async function setConfiguration(value){if(enabled||activeId||configuring)throw Error('请先停止此任务并等待当前视频完成');if(inFlight)await inFlight;if(enabled||activeId||configuring)throw Error('此任务正在运行');config=value;observed.clear();persist();}
 const timer=manualTick?null:setInterval(()=>void tick(),tickMs);timer?.unref();
 return{start,stop,snapshot,tick,retryFailed,resetHistory,setConfiguration,dispose(){generation++;enabled=false;closed=true;clearInterval(timer);observed.clear();persist();}};
}
module.exports={createAutoQueue};
