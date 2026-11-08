'use strict';
const fs=require('node:fs'),path=require('node:path');
// Demucs may run several model passes per track. Track output files, rather than
// interpreting each tqdm 100% bar as a completed audio segment.
function monitorVocals({task,chunks,directory,now=Date.now,onUpdate=()=>{},intervalMs=1000}){
 const startedAt=now(),stable=new Map(),confirmed=new Set();let closed=false,current=-1,lastKey='';
 const phase={code:'vocals',label:'人声分离',completed:0,total:chunks.length,currentSegment:null,progress:0,startedAt,updatedAt:startedAt};
 task.phase=phase;
 const output=i=>path.join(directory,'htdemucs',path.parse(chunks[i].audio).name,'vocals.mp3');
 function signature(i){try{const s=fs.statSync(output(i));return s.isFile()&&s.size>0?`${s.size}:${s.mtimeMs}`:null;}catch{return null;}}
 function publish(finished=false){
  if(closed||task.phase!==phase)return;
  const completed=confirmed.size,progress=finished?100:Math.min(99,Math.floor(completed/chunks.length*100));
  const key=`${completed}:${current}:${progress}`;if(key===lastKey)return;lastKey=key;
  Object.assign(phase,{completed,currentSegment:current>=0?current+1:null,progress,updatedAt:now()});
  task.currentFile=`人声分离：已生成 ${completed}/${chunks.length} 段${current>=0&&current+1>completed&&completed<chunks.length?`，正在处理第 ${current+1} 段`:''}`;
  onUpdate();
 }
 function poll(){
  if(closed)return;
  for(let i=0;i<chunks.length;i++){
   if(confirmed.has(i))continue;
   const value=signature(i);if(value&&stable.get(i)===value)confirmed.add(i);
   if(value)stable.set(i,value);else stable.delete(i);
  }
  publish();
 }
 function stdout(line){
  if(closed||!line.startsWith('Separating track '))return;
  const file=path.basename(line.slice('Separating track '.length).trim());
  const index=chunks.findIndex(c=>path.basename(c.audio)===file);if(index<0||index<current)return;
  current=index;
  // A subsequent track starts only after Demucs has finished writing the previous one.
  for(let i=0;i<index;i++)if(signature(i))confirmed.add(i);
  publish();
 }
 function finish(){
  if(closed)return;
  for(let i=0;i<chunks.length;i++){if(!signature(i))throw Error(`人声分离第 ${i+1} 段未生成有效人声文件`);confirmed.add(i);}
  publish(true);
 }
 publish();const timer=intervalMs>0?setInterval(poll,intervalMs):null;timer?.unref();
 return{poll,stdout,finish,dispose(){closed=true;if(timer)clearInterval(timer);}};
}
module.exports={monitorVocals};
