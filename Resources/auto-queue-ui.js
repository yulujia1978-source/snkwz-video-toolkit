const autoRows=new Map(),autoDraftKey='video-dedupe-auto-drafts';
let autoRequestPending=false,autoPollTimer=null,autoPollInFlight=false,autoRevision=0,autoLastState={groups:[],counts:{}},autoNameCounter=0,autoGlobalError='';
window.autoRunActive=false;
const autoNames={waiting:'等待处理',queued:'排队中',processing:'处理中',saving:'正在保存',completed:'已保存',failed:'处理失败',save_failed:'保存失败',interrupted:'上次中断',changed:'文件已变化'};
function autoMessage(message){$('autoStatus').textContent=message;}
function autoFailure(row,error){
 const message=error?.message||String(error);if(row)row.error=message;
 autoGlobalError=(row?row.name+'：':'')+message;
}
function showAutoFeedback(){
 const target=$('autoStatus');target.setAttribute('tabindex','-1');target.scrollIntoView({block:'center',behavior:'smooth'});target.focus({preventScroll:true});
}
function storeAutoDrafts(){try{sessionStorage.setItem(autoDraftKey,JSON.stringify([...autoRows.values()].filter(r=>r.draft).map(r=>({name:r.name,inputDirectory:r.inputDirectory,outputDirectory:r.outputDirectory,settleSeconds:r.settleSeconds,autoStop:r.autoStop}))));}catch{}}
function autoButton(label,action,secondary=true){const b=document.createElement('button');b.type='button';b.textContent=label;if(secondary)b.className='secondary';b.onclick=action;return b;}
function createAutoRow(value={}){
 const row={id:value.id||'draft-'+Math.random().toString(36).slice(2),draft:!value.id,name:value.name||'任务 '+ ++autoNameCounter,inputDirectory:value.inputDirectory||value.config?.inputDirectory||null,outputDirectory:value.outputDirectory||value.config?.outputDirectory||null,settleSeconds:value.settleSeconds??value.config?.settleSeconds??10,autoStop:value.autoStop??value.config?.autoStop??true,state:value.id?value:null,error:'',dirty:false};
 const n=Number(row.name.match(/任务\s*(\d+)/)?.[1]);if(Number.isFinite(n))autoNameCounter=Math.max(autoNameCounter,n);
 const node=document.createElement('section');node.className='watch-task';row.node=node;
 const header=document.createElement('div');header.className='watch-head';const title=document.createElement('h3');title.textContent=row.name;row.title=title;
 row.remove=autoButton('移除',()=>autoAction('remove',row));header.append(title,row.remove);node.append(header);
 const grid=document.createElement('div');grid.className='grid';
 for(const [kind,label] of [['input','监听文件夹'],['output','保存路径']]){const cell=document.createElement('div');row[kind+'Button']=autoButton('选择'+label,()=>chooseAutoDirectory(row,kind));row[kind+'Path']=document.createElement('p');row[kind+'Path'].className='hint';row[kind+'Path'].style.overflowWrap='anywhere';cell.append(row[kind+'Button'],row[kind+'Path']);grid.append(cell);}
 const wait=document.createElement('label');wait.append('文件连续 ');row.settle=document.createElement('input');Object.assign(row.settle,{type:'number',min:'3',max:'600',value:String(row.settleSeconds)});wait.append(row.settle,' 秒未变化后入队');row.settle.onchange=()=>{if(!row.settle.checkValidity())return row.settle.reportValidity();row.settleSeconds=Number(row.settle.value);row.dirty=true;void autoAction('save',row);};grid.append(wait);const finishLabel=document.createElement('label');row.finishToggle=document.createElement('input');row.finishToggle.type='checkbox';row.finishToggle.checked=row.autoStop;row.finishToggle.onchange=()=>{row.autoStop=row.finishToggle.checked;row.dirty=true;void autoAction('save',row);};finishLabel.append(row.finishToggle,' 完成后自动停止');grid.append(finishLabel);node.append(grid);
 const actions=document.createElement('div');actions.className='actions';row.start=autoButton('开始此任务',()=>autoAction('start',row),false);row.stop=autoButton('停止此任务',()=>autoAction('stop',row));row.stop.className='warn';row.retry=autoButton('失败重新入队',()=>autoAction('retry',row));row.reveal=autoButton('打开输出文件夹',()=>native({action:'reveal',path:row.outputDirectory}));actions.append(row.start,row.stop,row.retry,row.reveal);node.append(actions);
 row.status=document.createElement('p');row.status.className='hint';row.status.setAttribute('role','status');node.append(row.status);
 row.settings=document.createElement('p');row.settings.className='hint';node.append(row.settings);
 row.redo=autoButton('重做全部（保留原成品）',()=>autoAction('reset',row));actions.append(row.redo);
 const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='处理记录';row.history=document.createElement('div');row.history.style.cssText='max-height:180px;overflow:auto';details.append(summary,row.history);node.append(details);
 autoRows.set(row.id,row);$('autoGroups').append(node);updateAutoRow(row);return row;
}
function updateAutoRow(row){
 if(row.inputDirectory){row.name=row.inputDirectory.split('/').filter(Boolean).at(-1)||'来源文件夹';row.title.textContent=row.name;row.title.style.overflowWrap='anywhere';}
 const s=row.state,c=s?.counts||{waiting:0,completed:0,failed:0,retryable:0},locked=autoRequestPending||s?.enabled||!!s?.active;
 row.inputPath.textContent=row.inputDirectory||'尚未选择监听文件夹';row.outputPath.textContent=row.outputDirectory ? row.outputDirectory+'（自动创建同名文件夹）' : '尚未选择保存路径';
 row.inputButton.disabled=locked;row.outputButton.disabled=locked;row.settle.disabled=locked;row.remove.disabled=locked;row.finishToggle.disabled=!!locked;row.finishToggle.checked=row.autoStop;
 if(document.activeElement!==row.settle)row.settle.value=row.settleSeconds;
 row.redo.disabled=!!locked||row.draft;
 const effective=s?.config?.options;row.settings.textContent=effective?((s.enabled||s.active?'本次参数：':'上次参数：')+(effective.mergeUnlimited?'完整合并':effective.merge?'分集合并（约50分钟）':'逐个处理')+' · 视频压缩'+(effective.compress?'开启':'关闭')+' · '+(effective.compress?'H.265':effective.reencode?.encoder||'H.264')+' · '+(effective.hardwareAcceleration?'Apple硬件编码':'软件编码')+' · '+(s.config.autoStop!==false?'完成后自动停止':'持续监听')+((effective.merge||effective.mergeUnlimited)?' · 合并名称：'+effective.mergeName:'')):'启动时采用上方勾选的合并、压缩和其他处理参数';
 row.start.disabled=!!locked;row.stop.disabled=autoRequestPending||!s?.enabled;row.retry.disabled=locked||!c.retryable;row.reveal.disabled=!row.outputDirectory;
 row.status.style.color=row.error||s?.lastError?'#b91c1c':'';
 row.start.textContent=autoRequestPending?'请稍候…':s?.enabled?'运行中':!row.inputDirectory||!row.outputDirectory?'选择文件夹并开始':'开始此任务';
 row.status.textContent=(s?.enabled?(s.active?'正在处理':s.config?.autoStop!==false?'正在检查和排队':'正在监听'):s?.active?'已停止接收，正在完成当前视频':s?.stopReason==='completed'?'处理完成，已自动停止':s?.stopReason==='finished_with_errors'?'处理结束，有失败视频，已自动停止':s?.stopReason==='empty'?'无待处理视频，已自动停止':row.draft?'请分别选择两个文件夹':'已停止')+` · 等待 ${c.waiting} · 已处理 ${c.completed} · 成品 ${c.outputs||0} · 失败/中断 ${c.failed}`+(c.stabilizing?` · 等待稳定 ${c.stabilizing}`:'')+(s?.active?` · ${s.active.name} · ${videoProgressText(s.active)}`:'')+(s?.lastError?' · '+s.lastError:'')+(row.error?' · '+row.error:'');
 row.history.replaceChildren();for(const e of s?.entries||[]){const item=document.createElement('div');item.className='file';const name=document.createElement('span'),detail=document.createElement('span');name.textContent=e.name;detail.textContent=(autoNames[e.status]||e.status)+(e.error?'：'+e.error:'');item.append(name,detail);row.history.append(item);}if(!s?.entries?.length)row.history.textContent='此任务暂无处理记录。';
}
function renderAutoQueue(state){
 autoLastState=state;window.autoRunActive=!!(state.enabled||state.active);
 const ids=new Set((state.groups||[]).map(g=>g.id));
 for(const row of [...autoRows.values()])if(!row.draft&&!ids.has(row.id)){row.node.remove();autoRows.delete(row.id);}
 for(const group of state.groups||[]){let row=autoRows.get(group.id);if(!row)row=createAutoRow(group);row.state=group;row.name=group.name;row.title.textContent=group.name;if(!row.dirty){row.inputDirectory=group.config.inputDirectory;row.outputDirectory=group.config.outputDirectory;row.settleSeconds=group.config.settleSeconds;row.autoStop=group.config.autoStop!==false;}}
 for(const row of autoRows.values())updateAutoRow(row);
 $('autoAddGroup').disabled=autoRequestPending;$('autoStartAll').disabled=autoRequestPending||![...autoRows.values()].some(r=>!r.state?.enabled&&!r.state?.active);$('autoStopAll').disabled=autoRequestPending||!state.enabled;
 $('autoStatus').style.color=autoGlobalError?'#b91c1c':'';$('autoStatus').setAttribute('role',autoGlobalError?'alert':'status');
 const c=state.counts||{};autoMessage(`已配置 ${(state.groups||[]).length} 个任务 · 正在监听 ${(state.groups||[]).filter(g=>g.enabled).length} 个 · 等待 ${c.waiting||0} · 已处理 ${c.completed||0} · 成品 ${c.outputs||0} · 失败/中断 ${c.failed||0}`+(autoGlobalError?' · '+autoGlobalError:''));
}
async function pollAutoQueue(){if(autoPollInFlight||autoRequestPending)return;autoPollInFlight=true;const revision=autoRevision;try{const state=await api('/auto-queue');if(revision===autoRevision)renderAutoQueue(state);}catch(e){autoMessage('状态读取失败：'+e.message);}finally{autoPollInFlight=false;clearTimeout(autoPollTimer);autoPollTimer=setTimeout(pollAutoQueue,2000);}}
async function persistAutoRow(row){
 if(!row.inputDirectory||!row.outputDirectory){storeAutoDrafts();return;}
 const value={name:row.name,inputDirectory:row.inputDirectory,outputDirectory:row.outputDirectory,settleSeconds:row.settleSeconds,autoStop:row.autoStop};
 const result=await api('/auto-queue/groups'+(row.draft?'':'/update'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...value,...(row.draft?{}:{id:row.id})})});
 if(row.draft){autoRows.delete(row.id);row.id=result.createdId;row.draft=false;autoRows.set(row.id,row);}row.dirty=false;storeAutoDrafts();renderAutoQueue(result);
}
async function chooseAutoDirectory(row,kind){
 if(autoRequestPending)return;autoRequestPending=true;autoRevision++;row.error='';autoGlobalError='';for(const r of autoRows.values())updateAutoRow(r);
 try{const input=kind==='input',value=await native({action:'directory',prompt:input?'选择此任务的监听文件夹':'选择此任务的输出文件夹',message:row.name+'：'+(input?'此文件夹中的视频归属于这一组任务。':'这一组任务的成品只保存到此文件夹。')});if(value){row[kind+'Directory']=value;row.dirty=true;await persistAutoRow(row);}}
 catch(e){autoFailure(row,e);}finally{autoRequestPending=false;autoRevision++;renderAutoQueue(autoLastState);storeAutoDrafts();if(autoGlobalError)showAutoFeedback();void pollAutoQueue();}
}
function autoProcessingOptions(){
 if(busy||saving)throw Error('请等待手动任务完成后再启动自动任务');
 for(const control of controls)if(!control.disabled&&!['file','button'].includes(control.type)&&!control.checkValidity()){control.reportValidity();throw Error('请检查上方处理参数');}
 const o=options();if(o.merge&&o.mergeUnlimited)throw Error('请选择一种合并方式');if(o.transition&&!o.merge&&!o.mergeUnlimited)throw Error('过场视频需要勾选一种合并方式');
 const pipPath=$('pipPicker').files[0]?.nativePath;if(o.pipOpacity>0&&!pipPath)throw Error('请先选择本机画中画辅助视频');const transitionPath=$('transitionPicker').files[0]?.nativePath;if(o.transition&&!transitionPath)throw Error('请先选择本机过场视频');return{options:o,pipPath,transitionPath};
}
async function startAutoRow(row,settings,chooseMissing=false){
 if(chooseMissing)for(const kind of ['input','output'])if(!row[kind+'Directory']){
  const input=kind==='input',value=await native({action:'directory',prompt:input?'选择监听文件夹':'选择保存路径',message:row.name+'：'+(input?'请选择需要自动处理的视频文件夹。':'请选择保存位置，系统会自动创建以视频名或合并来源名命名的子文件夹。')});
  if(!value)throw Error('已取消选择'+(input?'监听文件夹':'输出文件夹')+'，任务尚未启动');
  row[kind+'Directory']=value;row.dirty=true;storeAutoDrafts();updateAutoRow(row);
 }
 if(!row.inputDirectory||!row.outputDirectory)throw Error('请先选择'+(!row.inputDirectory&&!row.outputDirectory?'监听文件夹和输出文件夹':!row.inputDirectory?'监听文件夹':'输出文件夹')+'，添加空白任务后需要分别选择两个文件夹');
 row.settleSeconds=Number(row.settle.value);
 if(!Number.isFinite(row.settleSeconds)||row.settleSeconds<3||row.settleSeconds>600)throw Error('文件稳定时间需为 3–600 秒');
 if(row.draft||row.dirty)await persistAutoRow(row);
 const result=await api('/auto-queue/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:row.id,inputDirectory:row.inputDirectory,outputDirectory:row.outputDirectory,settleSeconds:row.settleSeconds,autoStop:row.autoStop,...settings})});row.dirty=false;renderAutoQueue(result);
}
async function autoAction(action,row){
 if(autoRequestPending)return;autoRequestPending=true;autoRevision++;autoGlobalError='';if(row)row.error='';renderAutoQueue(autoLastState);
 try{
  if(action==='save')await persistAutoRow(row);
  else if(action==='start')await startAutoRow(row,autoProcessingOptions(),true);
  else if(action==='startAll'){const settings=autoProcessingOptions();for(const r of [...autoRows.values()])if(!r.state?.enabled&&!r.state?.active){try{r.error='';await startAutoRow(r,settings);}catch(e){autoFailure(r,e);}}}
  else if(action==='remove'&&row.draft){row.node.remove();autoRows.delete(row.id);storeAutoDrafts();}
  else{const route=action==='remove'?'/auto-queue/groups/remove':'/auto-queue/'+(action==='stopAll'?'stop':action);const result=await api(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(row?{id:row.id}:{})});renderAutoQueue(result);}
 }catch(e){autoFailure(row,e);}
 finally{autoRequestPending=false;autoRevision++;renderAutoQueue(autoLastState);storeAutoDrafts();if(autoGlobalError)showAutoFeedback();void pollAutoQueue();}
}
$('autoAddGroup').onclick=()=>{createAutoRow();storeAutoDrafts();renderAutoQueue(autoLastState);};
$('autoStartAll').onclick=()=>autoAction('startAll');$('autoStopAll').onclick=()=>autoAction('stopAll');
$('openAutoQueue').onclick=()=>$('autoQueuePanel').scrollIntoView({behavior:'smooth',block:'start'});
(async()=>{try{const state=await api('/auto-queue');renderAutoQueue(state);try{for(const draft of JSON.parse(sessionStorage.getItem(autoDraftKey)||'[]'))createAutoRow(draft);}catch{}if(!autoRows.size)createAutoRow();renderAutoQueue(state);}catch(e){autoMessage(e.message);if(!autoRows.size)createAutoRow();}finally{void pollAutoQueue();}})();
