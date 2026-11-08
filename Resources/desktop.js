// Native macOS adapters. The processing UI and engine retain the original options.
const native=message=>window.webkit.messageHandlers.native.postMessage(message);
const refreshStateKey='video-dedupe-refresh-state';
let refreshedState={};
try{refreshedState=JSON.parse(sessionStorage.getItem(refreshStateKey)||'{}');sessionStorage.removeItem(refreshStateKey);}catch{}
if(Array.isArray(refreshedState.selected))selected.push(...refreshedState.selected.filter(f=>typeof f.nativePath==='string'));
window.showDirectoryPicker=async()=>{const directory=await native({action:'directory'});if(!directory)throw Error('已取消选择');return {directory};};
for(const [id,folder] of [['filePicker',false],['folderPicker',true],['pipPicker',false],['transitionPicker',false]]){
 const input=$(id);input.type='button';input.value=folder?'选择视频文件夹…':id==='filePicker'?'选择视频文件…':'选择辅助视频…';
 let nativeFiles=Array.isArray(refreshedState[id])?refreshedState[id].filter(f=>typeof f.nativePath==='string'):[];if(nativeFiles.length)input.value=nativeFiles[0].name;Object.defineProperty(input,'files',{get:()=>nativeFiles});
 input.onclick=async()=>{if(busy)return;try{const files=await native({action:'files',folder,multiple:['filePicker','folderPicker'].includes(id)});if(!files?.length)return;if(id==='filePicker'||id==='folderPicker')pick(files);else{nativeFiles=files;input.value=files[0].name;}}catch(e){status(e.message);}};
}
let desktopImports=[];
const browserUpload=upload;
upload=async(f,index,total)=>{
 if(!f.nativePath){const imported=await browserUpload(f,index,total);desktopImports.push(imported.storedName);return imported;}
 status(`导入 ${index}/${total}：${f.name}`);
 const imported=(await api('/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:f.nativePath}),signal:AbortSignal.timeout(24*3600*1000)})).file;desktopImports.push(imported.storedName);return imported;
};
let lastOutputDirectory=refreshedState.lastOutputDirectory||null;
saveAll=async(t,dir)=>{
 saving=true;$('start').disabled=true;let count=0;
 try{const outputs=t.outputs.filter(o=>!o.deletedAt);for(const o of outputs){
  const result=await api('/tasks/'+t.id+'/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:o.file,directory:dir.directory}),signal:AbortSignal.timeout(24*3600*1000)});
  Object.assign(o,result.output);count++;lastOutputDirectory=result.directory||dir.directory;results(t);status(`已保存 ${count}/${outputs.length} 个视频至 ${lastOutputDirectory}`);
 }}catch(e){status(`保存失败（已保存 ${count} 个）：${e.message}。可以重新选择文件夹保存剩余成品。`);}
 finally{saving=false;$('start').disabled=busy;results(t);if(!t.outputs.some(o=>!o.deletedAt))localStorage.removeItem('video-dedupe-active');}
};
results=t=>{
 const container=$('results');container.replaceChildren();
 const outputs=t.outputs||[],remaining=outputs.filter(o=>!o.deletedAt);
 const text=document.createElement('p');text.className='hint';text.textContent=`成品 ${outputs.length} 个 · 已保存 ${outputs.filter(o=>o.deletedReason==='saved').length} 个。未保存的临时成品保留 24 小时。`;container.append(text);
 if(terminal.includes(t.status)&&remaining.length){const retry=document.createElement('button');retry.textContent='选择文件夹并保存剩余成品';retry.disabled=saving;retry.onclick=async()=>{try{await saveAll(t,await window.showDirectoryPicker());}catch(e){status(e.message);}};container.append(retry);}
 if(lastOutputDirectory){const reveal=document.createElement('button');reveal.className='secondary';reveal.textContent='在 Finder 中打开';reveal.onclick=()=>native({action:'reveal',path:lastOutputDirectory});container.append(reveal);}
 for(const o of outputs){const row=document.createElement('p');row.textContent=o.name+' · '+(o.deletedReason==='saved'?'已保存':o.deletedAt?'临时文件已清理':'等待保存');container.append(row);}
 for(const f of t.failures||[]){const row=document.createElement('p');row.textContent='处理失败：'+f.name+' · '+f.error;container.append(row);}
};
// Remove retired settings so old preferences cannot re-enable these operations.
try{const settings=JSON.parse(localStorage.getItem(KEY)||'{}');for(const key of ['trim','trimStart','trimEnd','mirror'])delete settings[key];localStorage.setItem(KEY,JSON.stringify(settings));}catch{}
// Persist settings independently of the random local service port.
const storedSet=Storage.prototype.setItem,storedRemove=Storage.prototype.removeItem;
Storage.prototype.setItem=function(key,value){storedSet.call(this,key,value);if(this===localStorage&&[KEY,'video-dedupe-active'].includes(key))void native({action:'persist',key,value:String(value)});};
Storage.prototype.removeItem=function(key){storedRemove.call(this,key);if(this===localStorage&&[KEY,'video-dedupe-active'].includes(key))void native({action:'persist',key,value:null});};
try{localStorage.setItem(KEY,localStorage.getItem(KEY)||'{}');}catch{}
api('/capabilities').then(c=>{if(!c.demucs){$('removeMusic').checked=false;$('removeMusic').disabled=true;$('removeMusic').parentElement.parentElement.querySelector('.hint').textContent='可选功能：需在此 Mac 安装 Demucs 与人声分离模型。';}}).catch(e=>status(e.message));

const desktopStart=startProcessing;
startProcessing=async()=>{desktopImports=[];await desktopStart();if(!task&&desktopImports.length)try{await api('/discard-imports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({names:desktopImports})});}catch{}};
$('start').onclick=startProcessing;

async function refreshUI(){
 const button=$('refreshUI');if(button.disabled)return;button.disabled=true;
 try{
  if(saving){status('正在保存视频，已保留当前进度…');return;}
  if(busy){if(task){clearTimeout(timer);await refresh();}else status('正在导入视频，请稍候…');return;}
  if(selected.some(f=>!f.nativePath)){show();status('文件列表已刷新，已保留导入的视频。');return;}
  localStorage.setItem(KEY,JSON.stringify({...JSON.parse(localStorage.getItem(KEY)||'{}'),...Object.fromEntries(controls.filter(e=>!['file','button'].includes(e.type)).map(e=>[e.id,e.type==='checkbox'?e.checked:e.value])),speedDefaultsVersion:1}));
  sessionStorage.setItem(refreshStateKey,JSON.stringify({selected,pipPicker:[...$('pipPicker').files],transitionPicker:[...$('transitionPicker').files],lastOutputDirectory,taskId:task?.id}));
  await native({action:'persist',key:KEY,value:localStorage.getItem(KEY)||'{}'});
  window.location.reload();
 }catch(e){status('刷新失败：'+e.message);}
 finally{button.disabled=false;}
}
$('refreshUI').onclick=refreshUI;
document.addEventListener('keydown',e=>{if(e.metaKey&&e.key.toLowerCase()==='r'){e.preventDefault();void refreshUI();}});
show();
if(!task&&refreshedState.taskId){task={id:refreshedState.taskId};lock(true);void refresh();}

// Always consult the engine before deciding whether quitting will interrupt work.
async function desktopQuitState(){
 const state=await api('/auto-queue');
 return{processing:!!(busy||saving||state.active),watching:!!state.enabled,pending:(state.counts?.waiting||0)+(state.counts?.stabilizing||0)};
}
