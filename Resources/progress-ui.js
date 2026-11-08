function videoProgressValue(value){
 const phase=value.phase;if(phase&&Number.isFinite(phase.progress))return Math.max(0,Math.min(100,phase.progress));
 return Math.max(0,Math.min(100,Number(value.progress)||0));
}
function videoProgressText(value,at=Date.now()){
 const phase=value.phase;
 if(phase){
  const seconds=Math.max(0,Math.floor((at-phase.startedAt)/1000)),minutes=Math.floor(seconds/60);
  const count=Number.isFinite(phase.total)?` · ${phase.completed}/${phase.total} 段`:'';
  const percent=Number.isFinite(phase.progress)?`（本阶段 ${phase.progress}%）`:'';
  const current=phase.code==='vocals'&&phase.currentSegment>phase.completed&&phase.completed<phase.total?` · 正在处理第 ${phase.currentSegment} 段`:'';
  return `${phase.label}${count}${percent}${current} · 本阶段用时 ${minutes} 分 ${seconds%60} 秒`;
 }
 return `${Number(value.progress)||0}%${value.currentFile?' · '+value.currentFile:''}${value.speed?' · '+value.speed.toFixed(1)+' 倍速':''}`;
}
