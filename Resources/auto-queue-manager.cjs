'use strict';
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),{randomBytes}=require('node:crypto');
const {createAutoQueue}=require('./auto-queue.cjs'),{normalize}=require('./services/video-dedupe');
const {sourceName}=require('./watch-settings.cjs');
function createAutoQueueManager({root,processor,createTask,exportOutput,importFile,tickMs=2000}){
 const file=path.join(root,'auto-queues.json'),base=path.join(root,'watch-groups'),groups=new Map(),excludedFiles=new Set();
 fs.mkdirSync(base,{recursive:true});let closed=false,dispatchId=null,cursor=0,inFlight=null,mutation=Promise.resolve();
 const remember=entries=>{for(const entry of entries||[])for(const saved of entry.savedPaths||[])if(path.isAbsolute(saved))excludedFiles.add(path.resolve(saved));};
 // Recover exact saved files, including removed groups and archived completion records.
 for(const dir of fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()))for(const name of fs.readdirSync(path.join(base,dir.name)).filter(n=>n==='auto-queue.json'||/^history-.*\.json$/.test(n))){try{remember(JSON.parse(fs.readFileSync(path.join(base,dir.name,name),'utf8')).entries);}catch{}}
 const serial=fn=>{const job=mutation.then(()=>{if(closed)throw Error('应用正在退出');return fn();});mutation=job.catch(()=>{});return job;};
 function persist(){fs.writeFileSync(file+'.tmp',JSON.stringify({excludedFiles:[...excludedFiles],groups:[...groups.values()].map(g=>({id:g.id,name:g.name,config:g.config}))},null,2));fs.renameSync(file+'.tmp',file);}
 function attach(metadata){
  if(!/^[a-z0-9-]+$/.test(metadata.id))throw Error('任务编号无效');const directory=path.join(base,metadata.id);fs.mkdirSync(directory,{recursive:true});
  const g={...metadata,name:sourceName(metadata.config.inputDirectory)};g.queue=createAutoQueue({root:directory,processor,createTask,exportOutput:async(...args)=>{const result=await exportOutput(...args);excludedFiles.add(path.resolve(result.path));persist();return result;},importFile,manualTick:true,canEnqueue:()=>dispatchId===g.id,isExcludedFile:source=>excludedFiles.has(path.resolve(source))});groups.set(g.id,g);return g;
 }
 if(fs.existsSync(file)){
  const saved=JSON.parse(fs.readFileSync(file,'utf8'));for(const output of saved.excludedFiles||[])excludedFiles.add(path.resolve(output));for(const g of saved.groups||[])attach(g);
 }else{
  const legacy=path.join(root,'auto-queue.json');
  if(fs.existsSync(legacy)){const saved=JSON.parse(fs.readFileSync(legacy,'utf8'));remember(saved.entries);if(saved.config){const id='legacy';fs.mkdirSync(path.join(base,id),{recursive:true});fs.copyFileSync(legacy,path.join(base,id,'auto-queue.json'));attach({id,name:'任务 1',config:saved.config});persist();}}
 }
 function snapshot(){
  const rows=[...groups.values()].map(g=>({...g.queue.snapshot(),id:g.id,name:g.name,config:{...g.config,pipPath:undefined}}));
  const counts={outputs:0,waiting:0,completed:0,failed:0,retryable:0,stabilizing:0};for(const g of rows)for(const key of Object.keys(counts))counts[key]+=g.counts[key]||0;
  return{groups:rows,enabled:rows.some(g=>g.enabled),active:rows.find(g=>g.active)?.active||null,counts,config:rows[0]?.config||null,lastError:rows.filter(g=>g.lastError).map(g=>g.name+'：'+g.lastError).join('；'),entries:rows.flatMap(g=>g.entries.map(e=>({...e,groupId:g.id,groupName:g.name}))).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,100)};
 }
 async function validate(value,exceptId){
  if(!value||typeof value.inputDirectory!=='string'||typeof value.outputDirectory!=='string')throw Error('每个任务都需要选择一个监听文件夹和一个输出文件夹');
  const inputDirectory=await fsp.realpath(value.inputDirectory),outputDirectory=await fsp.realpath(value.outputDirectory);
  if(!(await fsp.stat(inputDirectory)).isDirectory()||!(await fsp.stat(outputDirectory)).isDirectory())throw Error('请选择有效文件夹');
  await fsp.access(inputDirectory,fs.constants.R_OK);await fsp.access(outputDirectory,fs.constants.W_OK);
  if(value.autoStop!==undefined&&typeof value.autoStop!=='boolean')throw Error('自动停止设置无效');
  const config={inputDirectory,outputDirectory,settleSeconds:Number(value.settleSeconds??10),autoStop:value.autoStop!==false,options:{...value.options,mergeName:sourceName(inputDirectory)},pipPath:value.pipPath||null,transitionPath:value.transitionPath||null};
  if(!Number.isFinite(config.settleSeconds)||config.settleSeconds<.05||config.settleSeconds>600)throw Error('文件稳定等待时间无效');
  normalize(config.options);
  if(inputDirectory===outputDirectory)throw Error('监听文件夹和保存路径不能是同一个目录，请选择不同目录');
  return config;
 }
 async function addInternal(value){const config=await validate(value);const id='watch-'+randomBytes(8).toString('hex'),name=sourceName(config.inputDirectory);const g=attach({id,name,config});await g.queue.setConfiguration(config);persist();return g;}
 const requireGroup=id=>{const g=groups.get(id);if(!g)throw Error('任务不存在');return g;};
 function add(value){return serial(async()=>{const g=await addInternal(value);return{...snapshot(),createdId:g.id};});}
 function update(value){return serial(async()=>{const g=requireGroup(value.id);const config=await validate({...g.config,...value},g.id);await g.queue.setConfiguration(config);g.config=config;g.name=sourceName(config.inputDirectory);persist();return snapshot();});}
 function start(value){return serial(async()=>{
  let g=value.id?requireGroup(value.id):groups.values().next().value;if(!g)g=await addInternal(value);
  const config=await validate({...g.config,...value},g.id);await g.queue.start(config);g.config=config;g.name=sourceName(config.inputDirectory);try{persist();}catch(e){g.queue.stop();throw e;}void tick();return snapshot();
 });}
 function stop(id){return serial(async()=>{if(id)requireGroup(id).queue.stop();else for(const g of groups.values())g.queue.stop();return snapshot();});}
 function retryFailed(id){return serial(async()=>{if(id)requireGroup(id).queue.retryFailed();else for(const g of groups.values())g.queue.retryFailed();return snapshot();});}
 function remove(id){return serial(async()=>{const g=requireGroup(id),state=g.queue.snapshot();if(state.enabled||state.active)throw Error('请先停止此任务并等待当前视频完成，再移除');await g.queue.tick();g.queue.dispose();groups.delete(id);persist();return snapshot();});}
 function resetHistory(id){return serial(async()=>{const g=requireGroup(id);await g.queue.resetHistory();return snapshot();});}
 async function runTick(){
  const rows=[...groups.values()];dispatchId=null;
  for(const g of rows){if(closed)return;await g.queue.tick();}
  if([...processor.tasks.values()].some(t=>!['completed','partial','failed','cancelled'].includes(t.status)))return;
  for(let offset=0;offset<rows.length;offset++){
   const index=(cursor+offset)%rows.length,g=rows[index],state=g.queue.snapshot();
   if(state.enabled&&!state.active&&state.counts.waiting){dispatchId=g.id;try{await g.queue.tick();}finally{dispatchId=null;}if(g.queue.snapshot().active){cursor=(index+1)%rows.length;break;}}
  }
 }
 function tick(){if(closed)return Promise.resolve();if(inFlight)return inFlight;inFlight=runTick().catch(e=>console.error('自动任务检查失败：',e.message)).finally(()=>{dispatchId=null;inFlight=null;});return inFlight;}
 const timer=setInterval(()=>void tick(),tickMs);timer.unref();
 return{snapshot,add,update,start,stop,retryFailed,resetHistory,remove,tick,dispose(){closed=true;clearInterval(timer);dispatchId=null;for(const g of groups.values())try{g.queue.dispose();}catch{}persist();}};
}
module.exports={createAutoQueueManager};
