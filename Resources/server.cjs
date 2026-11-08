'use strict';
const http=require('node:http'), fs=require('node:fs'), fsp=fs.promises, path=require('node:path');
const {randomBytes,timingSafeEqual}=require('node:crypto');
const {pipeline}=require('node:stream/promises');
const {createProcessor}=require('./services/video-dedupe');
const {outputDirectory}=require('./output-directory.cjs');
const root=process.env.VD_DATA_ROOT;
const token=process.env.VD_TOKEN;
if(!root||!token)throw Error('Missing desktop configuration');
const tools=process.env.VD_TOOLS||path.join(__dirname,'bin');
const demucs=process.env.DEMUCS_BIN||path.join(require('node:os').homedir(),'Library/Python/3.9/bin/demucs');
const nativeSources=new Map();
const processor=createProcessor({resolveSource:name=>nativeSources.get(name),root,ffmpeg:path.join(tools,'ffmpeg'),ffprobe:path.join(tools,'ffprobe'),demucs});
const api='/api/admin/video-dedupe';
const pendingImports=new Set();
const send=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
async function body(req){let value='',size=0;for await(const chunk of req){size+=chunk.length;if(size>2*1024*1024)throw Error('请求过大');value+=chunk;}return JSON.parse(value||'{}');}
function validToken(value){const a=Buffer.from(value||''),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b);}
const video=/\.(mp4|mov|m4v|webm|avi|mkv|ts|mts|m2ts|mpeg|mpg)$/i;
async function importFile(src){
 if(typeof src!=='string'||!path.isAbsolute(src)||!video.test(src))throw Error('请选择有效的视频文件');
 const info=await fsp.stat(src);if(!info.isFile())throw Error('输入不是文件');
 const storedName=`${Date.now()}-${randomBytes(8).toString('hex')}${path.extname(src).toLowerCase()}`;
 await fsp.access(src,fs.constants.R_OK);
 nativeSources.set(storedName,src);
 pendingImports.add(storedName);
 return {name:path.basename(src),storedName,size:info.size};
}
function createTask(files,options){
 if(options?.removeMusic&&!fs.existsSync(demucs))throw Error('人声分离需要安装 Demucs，当前 Mac 未检测到');
 const input=processor.validate(files,{...options,hardwareAcceleration:options?.hardwareAcceleration!==false,keepAudio:options?.keepAudio!==false,trim:false,mirror:false});
 const task={id:`vd-${Date.now()}-${randomBytes(8).toString('hex')}`,status:'queued',progress:0,...input,logs:['本地任务已创建'],debug:[],outputs:[]};
 processor.enqueue(task);for(const f of [...input.files,{storedName:input.options.pipStoredName},{storedName:input.options.transitionStoredName}])pendingImports.delete(f.storedName);return task;
}
async function exportOutput(t,b){
 if(!['completed','partial','failed','cancelled'].includes(t.status))throw Error('任务尚未结束');
 if(typeof b.directory!=='string'||!path.isAbsolute(b.directory)||!(await fsp.stat(b.directory)).isDirectory())throw Error('保存文件夹无效');
 const lease=processor.acquireDownload(t,b.file);let dest,created=false;
 try{
  const directory=await outputDirectory(b.directory,t,lease.output);
  const name=path.basename(lease.output.name).replace(/[\\/\x00-\x1f]/g,'_'),ext=path.extname(name),stem=path.basename(name,ext);
  for(let i=0;;i++){dest=path.join(directory,i?`${stem} (${i})${ext}`:name);try{await fsp.copyFile(lease.path,dest,fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);created=true;break;}catch(e){if(e.code!=='EEXIST')throw e;}}
  const handle=await fsp.open(dest,'r+');try{await handle.sync();if((await handle.stat()).size!==lease.size)throw Error('保存大小校验失败');}finally{await handle.close();}
  lease.release();const output=processor.acknowledge(t,b.file,lease.size);return{output,path:dest,directory};
 }catch(e){if(created)await fsp.rm(dest,{force:true});throw e;}finally{lease.release();}
}
const autoQueue=require('./auto-queue-manager.cjs').createAutoQueueManager({root,processor,createTask,exportOutput,importFile,tickMs:Number(process.env.VD_WATCH_TICK_MS)||2000});
const server=http.createServer(async(req,res)=>{
 try{
 const host=`127.0.0.1:${server.address().port}`,origin=`http://${host}`;
 if(req.headers.host!==host)return send(res,403,{error:'无效主机'});
 const url=new URL(req.url,origin);
 if(req.method==='GET'&&url.pathname==='/video-dedupe.html'){
  if(!validToken(url.searchParams.get('token')))return send(res,403,{error:'无效会话'});
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'"});res.end(await fsp.readFile(path.join(__dirname,'video-dedupe.html')));return;
 }
 if(!validToken(req.headers['x-desktop-token'])||(req.headers.origin&&req.headers.origin!==origin))return send(res,403,{error:'无效会话'});
 if(url.pathname==='/desktop.js'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(await fsp.readFile(path.join(__dirname,'desktop.js')));return;}
 if(url.pathname===api+'/capabilities')return send(res,200,{demucs:fs.existsSync(demucs)});
 if(url.pathname===api+'/discard-imports'&&req.method==='POST'){
  const b=await body(req);if(!Array.isArray(b.names))throw Error('无效文件列表');
  for(const name of b.names)if(pendingImports.has(name)){await fsp.rm(path.join(root,'uploads',name),{force:true});pendingImports.delete(name);nativeSources.delete(name);}
  return send(res,200,{ok:true});
 }
 if(url.pathname===api+'/import'&&req.method==='POST'){const b=await body(req);return send(res,200,{file:await importFile(b.path)});}
 if(url.pathname===api+'/upload'&&req.method==='POST'){
  const name=path.basename(url.searchParams.get('fileName')||'video.mp4');if(!video.test(name))throw Error('视频格式无效');
  const storedName=`${Date.now()}-${randomBytes(8).toString('hex')}${path.extname(name).toLowerCase()}`,dest=path.join(root,'uploads',storedName);
  try{await pipeline(req,fs.createWriteStream(dest,{flags:'wx'}));}catch(e){await fsp.rm(dest,{force:true});throw e;}
  pendingImports.add(storedName);return send(res,200,{file:{name,storedName,size:(await fsp.stat(dest)).size}});
 }
 if(url.pathname===api+'/auto-queue'&&req.method==='GET')return send(res,200,autoQueue.snapshot());
 if(url.pathname===api+'/auto-queue/start'&&req.method==='POST'){const b=await body(req);if(b.options?.removeMusic&&!fs.existsSync(demucs))throw Error('当前 Mac 未检测到 Demucs，请取消人声分离选项');return send(res,200,await autoQueue.start(b));}
 if(url.pathname===api+'/auto-queue/stop'&&req.method==='POST')return send(res,200,await autoQueue.stop((await body(req)).id));
 if(url.pathname===api+'/auto-queue/reset'&&req.method==='POST')return send(res,200,await autoQueue.resetHistory((await body(req)).id));
 if(url.pathname===api+'/auto-queue/retry'&&req.method==='POST')return send(res,200,await autoQueue.retryFailed((await body(req)).id));
 if(url.pathname===api+'/auto-queue/groups'&&req.method==='POST')return send(res,200,await autoQueue.add(await body(req)));
 if(url.pathname===api+'/auto-queue/groups/update'&&req.method==='POST')return send(res,200,await autoQueue.update(await body(req)));
 if(url.pathname===api+'/auto-queue/groups/remove'&&req.method==='POST')return send(res,200,await autoQueue.remove((await body(req)).id));
 if(url.pathname===api+'/tasks'&&req.method==='POST'){const b=await body(req);return send(res,200,{task:createTask(b.files,b.options)});}
 const match=url.pathname.match(/^\/api\/admin\/video-dedupe\/tasks\/([^/]+)(?:\/(pause|resume|cancel|saved|export))?$/);
 if(match){const t=processor.tasks.get(match[1]);if(!t)return send(res,404,{error:'任务不存在'});
  if(!match[2]&&req.method==='GET')return send(res,200,{task:t});
  if(req.method==='POST'){
   if(['pause','resume','cancel'].includes(match[2])){processor.action(t,match[2]);return send(res,200,{task:t});}
   const b=await body(req);
   if(match[2]==='saved')return send(res,200,{output:processor.acknowledge(t,b.file,b.size)});
   if(match[2]==='export')return send(res,200,await exportOutput(t,b));
  }
 }
 send(res,404,{error:'接口不存在'});
 }catch(e){if(!res.headersSent)send(res,400,{error:e.message});else res.destroy();}
});
server.listen(0,'127.0.0.1',()=>process.stdout.write(JSON.stringify({port:server.address().port})+'\n'));
let shuttingDown=false;
function shutdown(){if(shuttingDown)return;shuttingDown=true;try{autoQueue.dispose();}catch{}for(const t of processor.tasks.values())if(['queued','processing','paused'].includes(t.status))try{processor.action(t,'cancel');}catch{}processor.dispose();for(const name of pendingImports)try{fs.rmSync(path.join(root,'uploads',name),{force:true});}catch{}server.close();setTimeout(()=>process.exit(0),3500).unref();}
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
// Parent closes stdin on termination, including a native shell crash.
process.stdin.resume();process.stdin.on('end',shutdown);
