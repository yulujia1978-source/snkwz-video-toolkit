const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {monitorVocals}=require('./vocal-progress.cjs');
const ENCODE_THREADS = Math.max(1,Math.min(4,require('os').cpus().length - 1));
const MAX_MERGE_SECONDS = 50 * 60;
const RESOLUTIONS = {'3840×2160':[3840,2160],'2560×1440':[2560,1440],'1920×1080':[1920,1080],'1280×720':[1280,720],'1080×1920':[1080,1920],'720×1280':[720,1280]};
const number = (v, fallback, min, max) => { const n = Number(v ?? fallback); if (!Number.isFinite(n) || n < min || n > max) throw Error(`参数超出范围：${v}（${min}–${max}）`); return n; };
function normalize(o = {}) {
  if(o.hardwareAcceleration !== undefined && typeof o.hardwareAcceleration !== 'boolean')throw Error('硬件加速参数无效');
  if(o.compress !== undefined && typeof o.compress !== 'boolean')throw Error('视频压缩参数无效');
  const r = o.compress ? {encoder:'H.265',crf:20,preset:'fast',fps:'original',resolution:'original',audioBitrate:o.reencode?.audioBitrate} : o.reencode || {};
  if(o.transition !== undefined && typeof o.transition !== 'boolean')throw Error('过场视频参数无效');
  if(o.transition && !o.merge && !o.mergeUnlimited)throw Error('插入过场视频需要选择一种合并方式');
  if(o.mergeUnlimited !== undefined && typeof o.mergeUnlimited !== 'boolean')throw Error('不限时长合并参数无效');
  if(o.merge && o.mergeUnlimited)throw Error('请选择一种合并方式');
  if(o.merge !== undefined && typeof o.merge !== 'boolean')throw Error('合并视频参数无效');
  const mergeName=String(o.mergeName||'').trim().replace(/[\\/\0-\x1f]/g,'_').slice(0,120);
  return {...o, mergeName, keepAudio:o.keepAudio===undefined?null:o.keepAudio===true, hardwareAcceleration:o.hardwareAcceleration===true, compress:o.compress === true, merge:o.merge === true, mergeUnlimited:o.mergeUnlimited === true, transition:o.transition === true, crop:number(o.crop,0,0,49), grid:number(o.grid,0,0,100), gridOpacity:number(o.gridOpacity,.12,0,1), pipOpacity:number(o.pipOpacity,0,0,1), borderSize:Math.round(number(o.borderSize,0,0,200)), blackLineY:number(o.blackLineY,90,0,100), blackLineThickness:Math.round(number(o.blackLineThickness,8,1,100)), blackLineOpacity:number(o.blackLineOpacity,1,0,1), contrast:number(o.contrast,1,0.1,3), saturation:number(o.saturation,1,0,3), trimStart:number(o.trimStart,1,0,3600), trimEnd:number(o.trimEnd,1,0,3600), reencode:{encoder:r.encoder==='H.265'?'libx265':'libx264',crf:number(r.crf,22,18,30),preset:['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow'].includes(r.preset)?r.preset:'fast',fps:r.fps&&r.fps!=='original'?number(r.fps,30,1,120):null,audioBitrate:['128k','160k','192k','256k','320k'].includes(String(r.audioBitrate).toLowerCase())?r.audioBitrate.toLowerCase():'160k',resolution:r.resolution}};
}
function command(src, out, o, info, pip, vocals, mergeFormat) {
  const r=o.reencode, args=['-y','-hide_banner','-nostdin','-i',src];
  if(pip) args.push('-stream_loop','-1','-i',pip);
  if(vocals) args.push('-i',vocals);
  const start=o.trim?o.trimStart:0, duration=info.duration-start-(o.trim?o.trimEnd:0);
  if(duration<=0) throw Error('掐头去尾时长不能超过视频时长');
  const unchanged=!mergeFormat&&!pip&&!vocals&&!o.compress&&!o.trim&&!o.mirror&&!o.crop&&!o.grid&&!o.sharpen&&!o.borderSize&&!o.blackLine&&o.contrast===1&&o.saturation===1&&!r.fps&&!RESOLUTIONS[r.resolution];
  if(unchanged&&info.copyCompatible&&info.codec===(r.encoder==='libx265'?'hevc':'h264')){
    args.push('-map','0:v:0','-c:v','copy');
    if(info.hasAudio){args.push('-map','0:a:0');if(o.keepAudio&&info.audioCodec==='aac')args.push('-c:a','copy');else args.push('-c:a','aac','-b:a',r.audioBitrate,'-ar','48000');}else args.push('-an');
    args.push('-t',String(duration),'-movflags','+faststart','-progress','pipe:1','-nostats',out);
    return {args,duration};
  }
  const f=[];
  if(o.trim)f.push(`trim=start=${start}:duration=${duration}`,'setpts=PTS-STARTPTS');
  if(o.mirror)f.push('hflip');
  if(o.crop)f.push(`crop=iw:trunc(ih*(1-${o.crop/100})/2)*2`);
  if(o.contrast!==1||o.saturation!==1)f.push(`eq=contrast=${o.contrast}:saturation=${o.saturation}`);
  if(o.sharpen)f.push('unsharp=5:5:0.6:5:5:0');
  if(o.grid)f.push(`drawgrid=w=iw/${o.grid}:h=ih/${o.grid}:t=1:c=white@${o.gridOpacity}`);
  if(o.borderSize)f.push(`pad=iw+${2*o.borderSize}:ih+${2*o.borderSize}:${o.borderSize}:${o.borderSize}:black`);
  const sizes=RESOLUTIONS;
  if(sizes[r.resolution]){const [w,h]=sizes[r.resolution];f.push(`scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2`,`pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`);}
  if(mergeFormat)f.push(`scale=${mergeFormat.width}:${mergeFormat.height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,`pad=${mergeFormat.width}:${mergeFormat.height}:(ow-iw)/2:(oh-ih)/2`);
  if(o.compress){
    if(o.crop||o.borderSize)f.push(`scale=${info.width}:${info.height}:force_original_aspect_ratio=decrease`,`pad=${info.width}:${info.height}:(ow-iw)/2:(oh-ih)/2`);
    f.push('null');
  }else f.push('scale=trunc(iw/2)*2:trunc(ih/2)*2','setsar=1');
  // Draw on the final canvas, after border/crop/resize, so thickness is in output pixels.
  if(o.blackLine)f.push(`drawbox=x=0:y='(ih-min(ih,${o.blackLineThickness}))*${o.blackLineY/100}':w=iw:h='min(ih,${o.blackLineThickness})':color=black@${o.blackLineOpacity}:t=fill`);
  let graph=`[0:v:0]${f.join(',')}[base]`;
  if(pip){const width=Math.max(2,Math.floor((sizes[r.resolution]?.[0]||info.width)/4/2)*2);graph+=`;[1:v:0]setpts=PTS-STARTPTS,scale=${width}:-2,format=yuva420p,colorchannelmixer=aa=${o.pipOpacity}[pip];[base][pip]overlay=x=W-w-12:y=H-h-12:shortest=1[v]`;}
  else graph+=';[base]null[v]';
  if(mergeFormat&&!info.hasAudio)graph+=`;anullsrc=r=48000:cl=stereo,atrim=duration=${duration}[silence]`;
  args.push('-filter_complex_threads',String(ENCODE_THREADS),'-filter_complex',graph,'-map','[v]');
  if(info.hasAudio){args.push('-map',vocals?`${pip?2:1}:a:0`:'0:a:0');if(o.trim)args.push('-af',`atrim=start=${start}:duration=${duration},asetpts=PTS-STARTPTS`);if(o.keepAudio&&info.audioCodec==='aac'&&!o.trim&&!vocals&&!mergeFormat)args.push('-c:a','copy');else args.push('-c:a','aac','-b:a',r.audioBitrate,'-ar','48000');}
  else if(mergeFormat)args.push('-map','[silence]','-c:a','pcm_s16le');
  else args.push('-an');
  if(mergeFormat){args.push('-ac','2');const a=args.indexOf('-c:a');if(a>=0)args[a+1]='pcm_s16le';if(info.hasAudio){const af=args.indexOf('-af'),filter=`apad,atrim=duration=${duration},asetpts=PTS-STARTPTS`;if(af>=0)args[af+1]+=','+filter;else args.push('-af',filter);}}
  args.push('-t',String(duration),'-c:v',r.encoder,'-threads',String(ENCODE_THREADS),'-crf',String(r.crf),'-preset',r.preset,'-pix_fmt',o.compress&&(info.width%2||info.height%2)?'yuv444p':'yuv420p');
  if(r.encoder==='libx265')args.push('-tag:v','hvc1','-x265-params',`pools=${ENCODE_THREADS}:frame-threads=2`);
  if(o.compress)args.push('-fps_mode','passthrough');
  else if(mergeFormat||r.fps)args.push('-r',String(mergeFormat?.fps||r.fps));
  // Bounded, high-quality intermediates avoid filling the disk with lossless frames.
  if(o.compress&&mergeFormat){args[args.indexOf('-c:v')+1]='libx264';args[args.indexOf('-crf')+1]='18';args[args.indexOf('-preset')+1]='veryfast';const tag=args.indexOf('-tag:v');if(tag>=0)args.splice(tag,2);}
  if(o.hardwareAcceleration&&process.platform==='darwin'&&!(info.width%2||info.height%2)){
    const hevc=!mergeFormat&&r.encoder==='libx265';
    args[args.indexOf('-c:v')+1]=hevc?'hevc_videotoolbox':'h264_videotoolbox';
    for(const flag of ['-crf','-preset']){const at=args.indexOf(flag);if(at>=0)args.splice(at,2);}
    const size=mergeFormat||{width:sizes[r.resolution]?.[0]||info.width,height:sizes[r.resolution]?.[1]||info.height};
    const bitrate=Math.max(2000000,Math.round(size.width*size.height*(r.fps||info.fps||30)*(hevc?.10:.16)));
    args.push('-b:v',String(bitrate),'-allow_sw','0');
  }
  args.push('-movflags','+faststart','-progress','pipe:1','-nostats',out);
  return {args,duration};
}
function createProcessor({root,ffmpeg,demucs,ffprobe,now=Date.now,retentionMs=24*60*60*1000,resolveSource}){
  const tasks=new Map(), processes=new Map(), queue=[];let running=false;
  const dirs={uploads:path.join(root,'uploads'),outputs:path.join(root,'outputs'),work:path.join(root,'work')}, file=path.join(root,'tasks.json');
  for(const dir of Object.values(dirs))fs.mkdirSync(dir,{recursive:true});
  try{for(const t of JSON.parse(fs.readFileSync(file,'utf8'))){if(['queued','processing','paused'].includes(t.status)){t.status='failed';t.error='服务已重启，请重新提交任务';delete t.phase;}tasks.set(t.id,t);}}catch{}
  function save(){fs.writeFileSync(file+'.tmp',JSON.stringify([...tasks.values()],null,2));fs.renameSync(file+'.tmp',file);}
  const activeTasks = new Set(), downloads = new Map();
  const terminal = t => ['completed','partial','failed','cancelled'].includes(t.status);
  function safePath(dir, name) {
    if(typeof name !== 'string' || !name || name === '.' || name === '..' || name !== path.basename(name) || /[\\/\x00]/.test(name)) throw Error('无效的文件路径');
    return path.join(dir, name);
  }
  function outputPath(t, o) { return safePath(safePath(dirs.outputs,t.id),o.file); }
  function refs(t) { return [...(t.files||[]).map(f=>f.storedName),t.options?.pipStoredName,t.options?.transition?t.options.transitionStoredName:null].filter(Boolean); }
  function removeOutput(t,o,reason) {
    const fp=outputPath(t,o);
    if(downloads.get(fp)) return false;
    fs.rmSync(fp,{force:true});
    o.deletedAt=now();o.deletedReason=reason;
    return true;
  }
  function cleanup() {
    const protectedUploads=new Set([...tasks.values()].filter(t=>!terminal(t)||activeTasks.has(t.id)).flatMap(refs));
    let changed=false;
    for(const t of tasks.values()) {
      if(!terminal(t)||activeTasks.has(t.id))continue;
      // Old task records get a full retention window when first migrated.
      if(!t.finishedAt){t.finishedAt=now();changed=true;}
      if(!t.expiresAt){t.expiresAt=t.finishedAt+retentionMs;changed=true;}
      try {
        for(const name of refs(t))if(!protectedUploads.has(name))fs.rmSync(safePath(dirs.uploads,name),{force:true});
        fs.rmSync(safePath(dirs.work,t.id),{recursive:true,force:true});
        for(const o of t.outputs||[])if(!o.deletedAt&&(o.savedAt||now()>=t.expiresAt))changed=removeOutput(t,o,o.savedAt?'saved':'expired')||changed;
        const outDir=safePath(dirs.outputs,t.id);
        if(fs.existsSync(outDir)&&fs.readdirSync(outDir).length===0)fs.rmdirSync(outDir);
        if(t.cleanupError){delete t.cleanupError;changed=true;}
      } catch(e) {t.cleanupError=e.message;changed=true;}
    }
    if(changed)save();
  }
  function acknowledge(t,name,size) {
    if(!terminal(t)||activeTasks.has(t.id))throw Error('任务尚未结束');
    const o=(t.outputs||[]).find(o=>o.file===name);
    if(!o)throw Error('结果不存在');
    if(!Number.isSafeInteger(size)||size<=0||size!==o.outputInfo?.size)throw Error('保存文件大小不匹配，保留服务器副本');
    if(o.deletedAt&&o.deletedReason!=='saved')throw Error('结果已过期');
    o.savedAt=o.savedAt||now();save();cleanup();return o;
  }
  function acquireDownload(t,name) {
    const o=(t.outputs||[]).find(o=>o.file===name);
    if(!o||o.deletedAt||(!activeTasks.has(t.id)&&t.expiresAt&&now()>=t.expiresAt))throw Error('结果已清理或已过期');
    const fp=outputPath(t,o),size=fs.statSync(fp).size;
    downloads.set(fp,(downloads.get(fp)||0)+1);
    let released=false;
    return {path:fp,size,output:o,release({completed=false}={}){if(released)return;released=true;if(completed){o.savedAt=o.savedAt||now();save();}const count=downloads.get(fp)-1;if(count)downloads.set(fp,count);else downloads.delete(fp);cleanup();}};
  }
  function stored(name){if(typeof name!=='string'||name!==path.basename(name)||!/^\d+-[a-f0-9]+\.[a-z0-9]+$/i.test(name))throw Error('无效的上传文件');const p=resolveSource?.(name)||path.join(dirs.uploads,name);if(!fs.existsSync(p))throw Error('上传文件不存在，请重新上传');return p;}
  function validate(files,o){if(!Array.isArray(files)||!files.length)throw Error('请至少选择一个视频');files=files.map(f=>{stored(f.storedName);return{storedName:f.storedName,name:path.basename(String(f.name||'video')).replace(/[\\/\x00-\x1f]/g,'_')}});o=normalize(o);if(o.transition){if(files.length<2)throw Error('插入过场视频需要至少两个主视频');stored(o.transitionStoredName);}if(o.pipOpacity>0)stored(o.pipStoredName);return{files,options:o};}
  async function ready(t){while(t.status==='paused'&&!t.cancelRequested)await new Promise(r=>setTimeout(r,150));if(t.cancelRequested)throw Error('任务已取消');}
  async function run(t,cmd,args,progress,observer){await ready(t);delete t.speed;return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{env:{...process.env,...(cmd===demucs?{PYTHONUNBUFFERED:'1',OMP_NUM_THREADS:String(ENCODE_THREADS),MKL_NUM_THREADS:String(ENCODE_THREADS),OPENBLAS_NUM_THREADS:String(ENCODE_THREADS)}:{}),PATH:[path.dirname(ffmpeg),path.dirname(ffprobe),process.env.PATH||''].join(path.delimiter)}});processes.set(t.id,p);let err='',buffer='',last=0;
    p.stderr.on('data',d=>{err=(err+d).slice(-8000);t.debug=err.split(/\r?\n/).filter(Boolean).slice(-30);});
    p.stdout.on('data',d=>{buffer+=d;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);observer?.stdout(line);if(line.startsWith('speed=')){const speed=Number(line.slice(6).replace('x',''));if(Number.isFinite(speed)&&speed>0)t.speed=speed;}if(line.startsWith('out_time_us=')&&progress){progress(Number(line.split('=')[1])/1e6);if(Date.now()-last>1000){save();last=Date.now();}}}});
    p.on('error',reject);p.on('close',c=>{processes.delete(t.id);if(c!==0)reject(Error(/No space left on device/.test(err)?'处理磁盘空间不足，请释放空间后重试。':err.slice(-1200)||'处理进程已停止'));else resolve();});});}
  async function encode(t,args,progress){
    const at=args.indexOf('-c:v'),codec=args[at+1];
    try{await run(t,ffmpeg,args,progress);}catch(e){
      if(t.cancelRequested||!codec?.endsWith('_videotoolbox'))throw e;
      if(!/videotoolbox|compression session|encoder|hardware/i.test(e.message)||/No space left on device/i.test(e.message))throw e;
      t.logs.push('硬件编码不可用，自动改用快速软件编码');save();
      const fallback=[...args];fallback[at+1]=codec==='hevc_videotoolbox'?'libx265':'libx264';
      const sw=fallback.indexOf('-allow_sw');if(sw>=0)fallback.splice(sw,2);
      fallback.splice(fallback.length-1,0,'-preset','veryfast','-crf','20');
      if(codec==='hevc_videotoolbox'&&!fallback.includes('-x265-params'))fallback.splice(fallback.length-1,0,'-x265-params',`pools=${ENCODE_THREADS}:frame-threads=2`);
      await run(t,ffmpeg,fallback,progress);
    }
  }
  async function probe(t,src){await ready(t);return new Promise((resolve,reject)=>{const p=spawn(ffprobe,['-v','error','-show_streams','-show_data_hash','sha256','-show_format','-of','json',src]);processes.set(t.id,p);let out='';p.stdout.on('data',d=>out+=d);p.stderr.resume();p.on('error',reject);p.on('close',c=>{processes.delete(t.id);try{const j=JSON.parse(out),v=j.streams.find(s=>s.codec_type==='video'&&s.disposition?.attached_pic!==1);if(c||!v||!Number.isFinite(Number(j.format.duration))||Number(j.format.duration)<=0)throw Error('无法读取有效视频');if(!v.codec_name||v.codec_name==='none'||v.codec_name==='unknown')throw Error(`视频编码不受当前 ffmpeg 支持（编码标识：${v.codec_tag_string||'未知'}），请先转换为 H.264 或 H.265 后再处理`);resolve({width:v.width,height:v.height,duration:Number(j.format.duration),codec:v.codec_name,audioCodec:j.streams.find(s=>s.codec_type==='audio')?.codec_name,fps:(()=>{const [n,d]=String(v.avg_frame_rate||'0/1').split('/').map(Number);return Number.isFinite(n/d)&&n/d>0?n/d:30;})(),size:Number(j.format.size),hasAudio:j.streams.some(s=>s.codec_type==='audio'),copyCompatible:['h264','hevc'].includes(v.codec_name)&&j.streams.filter(s=>s.codec_type==='audio').every(s=>s.codec_name==='aac'),signature:JSON.stringify(j.streams.filter(s=>['video','audio'].includes(s.codec_type)).map(s=>Object.fromEntries(['codec_type','codec_name','codec_tag_string','profile','level','width','height','pix_fmt','time_base','sample_rate','channels','channel_layout','extradata_hash'].map(k=>[k,s[k]]))))});}catch(e){reject(e);}});});}
  async function removeBackground(t,src,out,work){
    const info=await probe(t,src);
    if(!info.hasAudio){t.logs.push('视频无音轨，跳过人声分离');return;}
    t.logs.push('最后执行：去背景音乐，保留人声');save();
    fs.mkdirSync(work,{recursive:true});
    // Bound Demucs memory by audio duration; overlap gives the model context at joins.
    const chunkSeconds=300, overlap=2, count=Math.ceil(info.duration/chunkSeconds);
    const pieces=[], chunks=[], previousFile=t.currentFile;
    t.phase={code:'audio_prepare',label:'准备分段音频',completed:0,total:count,progress:0,startedAt:now()};
    for(let i=0;i<count;i++){
      await ready(t);
      const start=i*chunkSeconds, duration=Math.min(chunkSeconds,info.duration-start);
      const from=Math.max(0,start-overlap), until=Math.min(info.duration,start+duration+overlap);
      const chunk=path.join(work,'vocals-'+i);fs.mkdirSync(chunk,{recursive:true});
      const audio=path.join(chunk,'audio-'+i+'.wav'), piece=path.join(work,'vocals-'+i+'.wav');
      t.currentFile=`准备分段音频 ${i+1}/${count}：${previousFile||path.basename(src)}`;
      t.logs.push(`准备音频分段 ${i+1}/${count}（每段最多 5 分钟）`);save();
      await run(t,ffmpeg,['-y','-nostdin','-ss',String(from),'-i',src,'-t',String(until-from),'-vn','-ac','2','-ar','44100',audio]);
      chunks.push({audio,chunk,piece,start,from,duration});
      t.phase.completed=i+1;t.phase.progress=Math.floor((i+1)/count*100);save();
    }
    t.currentFile=`正在分离人声：${count} 段（模型仅加载一次）`;
    t.logs.push('批量人声分离：模型仅加载一次，逐段处理以控制内存');save();
    const separation=path.join(work,'separated');
    // Demucs loads the model once and processes tracks sequentially with jobs=0.
    const monitor=monitorVocals({task:t,chunks,directory:separation,now,onUpdate(){try{save();}catch(e){console.error('人声分离进度记录暂未写入：',e.message);}}});
    try{await run(t,demucs,['--two-stems=vocals','--mp3','-j','0','-n','htdemucs','-o',separation,...chunks.map(c=>c.audio)],undefined,monitor);monitor.finish();}finally{monitor.dispose();}
    t.phase={code:'vocal_trim',label:'整理人声分段',completed:0,total:count,progress:0,startedAt:now()};save();
    for(const [index,c] of chunks.entries()){
      await ready(t);
      const vocals=path.join(separation,'htdemucs',path.parse(c.audio).name,'vocals.mp3');
      if(!fs.existsSync(vocals))throw Error('Demucs 未生成人声文件');
      await run(t,ffmpeg,['-y','-nostdin','-i',vocals,'-af',`atrim=start=${c.start-c.from}:duration=${c.duration},asetpts=PTS-STARTPTS,apad,atrim=duration=${c.duration}`,'-ac','2','-ar','44100','-c:a','pcm_s16le',c.piece]);
      pieces.push(c.piece);fs.rmSync(c.chunk,{recursive:true,force:true});
      fs.rmSync(path.dirname(vocals),{recursive:true,force:true});
      t.phase.completed=index+1;t.phase.progress=Math.floor((index+1)/count*100);save();
    }
    t.currentFile='正在合成人声音轨';t.phase={code:'vocal_mux',label:'合成人声音轨',progress:0,startedAt:now()};save();
    const list=path.join(work,'vocals.txt');
    fs.writeFileSync(list,pieces.map(p=>`file '${path.basename(p)}'`).join('\n'));
    await run(t,ffmpeg,['-y','-nostdin','-i',src,'-f','concat','-safe','0','-i',list,'-map','0:v:0','-map','1:a:0','-c:v','copy','-c:a','aac','-b:a',t.options.reencode.audioBitrate,'-af','apad','-t',String(info.duration),'-movflags','+faststart','-progress','pipe:1','-nostats',out],seconds=>{t.phase.progress=Math.min(99,Math.floor(seconds/info.duration*100));});
    for(const piece of pieces)fs.rmSync(piece,{force:true});fs.rmSync(list,{force:true});
    t.currentFile=previousFile;
    fs.renameSync(out,src);
    t.phase={code:'output',label:'整理成品',progress:null,startedAt:now()};save();
  }
  async function mergeTask(t){
    const work=path.join(dirs.work,t.id,'merge'),outDir=path.join(dirs.outputs,t.id);
    fs.mkdirSync(work,{recursive:true});fs.mkdirSync(outDir,{recursive:true});
    const files=[...t.files];
    if(t.options.transition)files.splice(1,0,{storedName:t.options.transitionStoredName,name:'过场视频'});
    const inputs=[];
    for(const f of files){
      t.currentFile=`检查素材：${f.name}`;save();
      const src=stored(f.storedName),info=await probe(t,src);
      if(!t.options.compress&&(!info.copyCompatible||(inputs.length&&info.signature!==inputs[0].info.signature)))throw Error(`无法直接拼接：${f.name} 的编码、尺寸或音轨参数不兼容。请使用相同参数的素材，或勾选视频压缩以统一格式。`);
      inputs.push({src,info,duration:info.duration});
    }
    const o=t.options;
    const baseName=(o.mergeName||'').trim().replace(/[\\/\0-\x1f]/g,'_');
    const processMerged=(o.compress||o.trim||o.mirror||o.crop||o.grid||o.sharpen||o.borderSize||o.blackLine||o.pipOpacity||o.contrast!==1||o.saturation!==1||o.reencode.fps||RESOLUTIONS[o.reencode.resolution]);
    const incompatible=inputs.some(x=>!x.info.copyCompatible||x.info.signature!==inputs[0].info.signature);
    if(incompatible){
      const format={width:inputs[0].info.width,height:inputs[0].info.height,fps:30};
      t.logs.push(`素材参数不同：压缩模式先统一为 ${format.width}×${format.height}，再合并处理`);save();
      for(let i=0;i<inputs.length;i++){
        const input=inputs[i],target=path.join(work,`normalized-${i}.mkv`);
        t.currentFile=`统一素材 ${i+1}/${inputs.length}`;save();
        const {args,duration}=command(input.src,target,normalize({compress:true,hardwareAcceleration:o.hardwareAcceleration}),input.info,null,null,format);
        t.logs.push(args[args.indexOf('-c:v')+1]==='copy'?'画面无需变更：直接封装，跳过视频编码':args[args.indexOf('-c:v')+1].endsWith('_videotoolbox')?'使用 Apple 硬件编码':'使用软件编码');
        await encode(t,args,seconds=>{t.progress=Math.min(39,Math.round((i+Math.min(1,seconds/duration))/inputs.length*40));});
        input.src=target;input.info=await probe(t,target);
      }
    }
    const list=path.join(work,'concat.txt'),out=path.join(outDir,'merged-001.mp4');
    // Escape quotes in native source paths; originals remain outside the app data directory.
    // Canonical absolute paths also work when the data root uses a macOS /var or volume alias.
    fs.writeFileSync(list,inputs.map(x=>`file '${fs.realpathSync(x.src).split(path.sep).join('/').replace(/'/g,"'\\''")}'\nduration ${x.duration}`).join('\n'));
    const total=inputs.reduce((sum,x)=>sum+x.info.duration,0);
    t.logs.push(processMerged||o.removeMusic?'先合并视频，再执行所选处理':o.merge?'直接合并：不编码，按约 50 分钟在关键帧处分集':'直接合并：复制原始音视频流，不编码、不执行其他处理、不分段');
    if(t.options.transition)t.logs.push('仅在第一个视频后插入一次过场');
    t.currentFile='直接拼接音视频';save();
    try{
      const args=['-y','-hide_banner','-nostdin','-f','concat','-safe','0','-auto_convert','0','-i',list,'-map','0','-c','copy','-progress','pipe:1','-nostats'];
      if(o.keepAudio===false)args.push('-c:a','aac','-b:a',o.reencode.audioBitrate,'-ar','48000');
      if(t.options.merge&&!processMerged&&!o.removeMusic&&total>MAX_MERGE_SECONDS)args.push('-f','segment','-segment_time',String(MAX_MERGE_SECONDS),'-reset_timestamps','1','-segment_start_number','1',path.join(outDir,'merged-%03d.mp4'));
      else args.push(processMerged?path.join(work,incompatible?'joined.mkv':'joined.mp4'):out);
      if(!processMerged)await run(t,ffmpeg,args,seconds=>{t.progress=Math.min(99,Math.round(seconds/total*99));});
      if(processMerged){
        t.currentFile='合并后执行所选处理';t.logs.push(t.currentFile);save();
        const info={...inputs[0].info,duration:inputs.reduce((sum,x)=>sum+x.duration,0)};
        const next=command(list,out,o,info,o.pipOpacity>0?stored(o.pipStoredName):null);
        next.args.splice(next.args.indexOf('-i'),0,'-f','concat','-safe','0','-auto_convert','0');
        if(o.merge){next.args.splice(next.args.length-1,0,'-force_key_frames',`expr:gte(t,n_forced*${MAX_MERGE_SECONDS})`);if(next.args[next.args.indexOf('-c:v')+1]==='libx265')next.args.splice(next.args.length-1,0,'-x265-params','open-gop=0');}
        await encode(t,next.args,seconds=>{t.progress=Math.min(94,50+Math.round(seconds/next.duration*44));});
      }
      for(const input of inputs)if(path.dirname(input.src)===work)fs.rmSync(input.src,{force:true});
      if(o.removeMusic)await removeBackground(t,out,path.join(work,'vocals-output.mp4'),path.join(work,'vocals'));
      if(o.merge&&(processMerged||o.removeMusic)){
        const finalInfo=await probe(t,out);
        if(finalInfo.duration>MAX_MERGE_SECONDS){
          t.currentFile='按约 50 分钟分集';t.logs.push(t.currentFile);save();
          const completed=path.join(work,'completed.mp4');fs.renameSync(out,completed);
          await run(t,ffmpeg,['-y','-hide_banner','-nostdin','-i',completed,'-map','0','-c','copy','-f','segment','-segment_time',String(MAX_MERGE_SECONDS),'-reset_timestamps','1','-segment_start_number','1',path.join(outDir,'merged-%03d.mp4')]);
        }
      }
      const outputs=[];
      for(const name of fs.readdirSync(outDir).filter(n=>/^merged-\d+\.mp4$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]))){
        const outputInfo=await probe(t,path.join(outDir,name));await ready(t);
        const displayName=t.options.merge?(baseName?`${baseName}-第${name.match(/\d+/)[0]}集.mp4`:`第${name.match(/\d+/)[0]}集.mp4`):(baseName?`${baseName}.mp4`:name);
        outputs.push({name:displayName,file:name,outputInfo});
      }
      if(!outputs.length)throw Error('未生成合并视频');
      t.outputs.push(...outputs);t.progress=100;t.status='completed';t.logs.push(`合并完成：${outputs.length} 个视频`);
    }catch(e){for(const name of fs.readdirSync(outDir).filter(n=>/^merged-\d+\.mp4$/.test(n)))fs.rmSync(path.join(outDir,name),{force:true});throw e;}

  }
  async function processTask(t){activeTasks.add(t.id);t.status='processing';t.failures=[];save();
    try{if(t.options.merge||t.options.mergeUnlimited){await mergeTask(t);return;}for(let i=0;i<t.files.length;i++){await ready(t);const f=t.files[i];let outName=String(i+1).padStart(3,'0')+'-'+path.parse(f.name).name+'.mp4',out=path.join(dirs.outputs,t.id,outName),work=path.join(dirs.work,t.id,String(i));fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(work,{recursive:true});delete t.phase;t.currentFile=f.name;t.logs.push(`开始处理 ${i+1}/${t.files.length}：${f.name}`);save();
      try{const src=stored(f.storedName),info=await probe(t,src);let vocals;
        const {args,duration}=command(src,out,t.options,info,t.options.pipOpacity>0?stored(t.options.pipStoredName):null,vocals);
        t.logs.push(args[args.indexOf('-c:v')+1]==='copy'?'画面无需变更：直接封装，跳过视频编码':args[args.indexOf('-c:v')+1].endsWith('_videotoolbox')?'使用 Apple 硬件编码':'使用软件编码');
        await encode(t,args,seconds=>{t.fileProgress=Math.min(99,Math.max(0,Math.round(seconds/duration*100)));t.progress=Math.min(99,Math.round((i+t.fileProgress/100)/t.files.length*100));});
        if(t.options.removeMusic)await removeBackground(t,out,path.join(work,'vocals-output.mp4'),work);
        let outputInfo=await probe(t,out);await ready(t);
        let compression;
        if(t.options.compress){
          const onlyCompression=!t.options.trim&&!t.options.mirror&&!t.options.crop&&!t.options.grid&&!t.options.sharpen&&!t.options.borderSize&&!t.options.blackLine&&!t.options.pipOpacity&&!t.options.removeMusic&&t.options.contrast===1&&t.options.saturation===1;
          if(onlyCompression&&outputInfo.size>=info.size){
            fs.rmSync(out,{force:true});outName=String(i+1).padStart(3,'0')+'-'+path.parse(f.name).name+path.extname(src);
            out=path.join(dirs.outputs,t.id,outName);fs.copyFileSync(src,out);outputInfo=info;
            t.logs.push('原文件已较小，保留原文件，避免容量增加');
          }
          compression={before:info.size,after:outputInfo.size,savedPercent:Math.round((1-outputInfo.size/info.size)*100)};
          t.logs.push(`压缩结果：${compression.savedPercent>0?'容量减少 '+compression.savedPercent+'%':'容量未减小'}，保留分辨率和原始帧时间`);
        }
        t.outputs.push({name:outName,file:outName,inputInfo:info,outputInfo,compression});t.logs.push(`已完成：${outName}`);
      }catch(e){fs.rmSync(out,{force:true});if(t.cancelRequested)throw e;t.failures.push({name:f.name,error:e.message});t.logs.push(`失败：${f.name} · ${e.message}`);}finally{fs.rmSync(work,{recursive:true,force:true});}
      t.progress=Math.round((i+1)/t.files.length*100);save();}
      t.status=t.failures.length?(t.outputs.length?'partial':'failed'):'completed';t.logs.push(`处理结束：成功 ${t.outputs.length}，失败 ${t.failures.length}`);
    }catch(e){t.status=t.cancelRequested?'cancelled':'failed';t.error=e.message;}finally{delete t.phase;t.currentFile='';t.finishedAt=now();t.expiresAt=t.finishedAt+retentionMs;activeTasks.delete(t.id);save();cleanup();}
  }
  async function drain(){if(running)return;running=true;try{while(queue.length){const t=queue.shift();if(!t.cancelRequested)await processTask(t);}}finally{running=false;}}
  function enqueue(t){tasks.set(t.id,t);save();queue.push(t);void drain();}
  function action(t,a){const p=processes.get(t.id);if(a==='pause'&&t.status==='processing'){if(process.platform==='win32')throw Error('当前系统不支持暂停');if(p)p.kill('SIGSTOP');t.status='paused';}else if(a==='resume'&&t.status==='paused'){if(p)p.kill('SIGCONT');t.status='processing';}else if(a==='cancel'&&['queued','processing','paused'].includes(t.status)){t.cancelRequested=true;if(p){if(t.status==='paused')p.kill('SIGCONT');p.kill('SIGTERM');const timer=setTimeout(()=>{if(processes.get(t.id)===p)p.kill('SIGKILL');},3000);timer.unref();}t.status='cancelled';}else throw Error('任务状态已变化，请刷新');t.logs.push({pause:'任务已暂停',resume:'任务已继续',cancel:'任务已取消'}[a]);save();cleanup();}
  cleanup();
  const cleanupTimer=setInterval(()=>{try{cleanup();}catch(e){console.error('视频文件清理失败：',e.message);}},60*1000);
  cleanupTimer.unref();
  return{tasks,validate,enqueue,action,cleanup,acknowledge,acquireDownload,dispose(){clearInterval(cleanupTimer);}};
}
module.exports={normalize,command,createProcessor,MAX_MERGE_SECONDS};
