const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {outputFolderName,outputDirectory}=require('../Resources/output-directory.cjs');
test('output folders use the source video name and keep merged episodes together',()=>{
 const task={files:[{name:'第一段.mp4'},{name:"02 ' 视频.mov"}],options:{}};
 assert.equal(outputFolderName(task,{file:'002-internal.mp4',name:'internal.mp4'}),"02 ' 视频");
 task.options={merge:true,mergeName:'系列名'};
 for(const n of [1,2])assert.equal(outputFolderName(task,{file:`merged-${n}.mp4`,name:`系列名-第00${n}集.mp4`}),'系列名');
 task.options.mergeName='../越界/名称';assert.equal(outputFolderName(task,{name:'a.mp4'}),'.._越界_名称');
 task.options.mergeName='..';assert.equal(outputFolderName(task,{name:'a.mp4'}),'视频成品');
});
test('create and reuse output folder; reject file or symlink conflicts without touching their contents',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'vd-output-dir-'));
 try{
  const task={files:[{name:'我的视频.mp4'}],options:{}},out={file:'001-我的视频.mp4',name:'001-我的视频.mp4'};
  const dir=await outputDirectory(root,task,out);assert.equal(path.basename(dir),'我的视频');
  await fs.writeFile(path.join(dir,'old.mp4'),'old');assert.equal(await outputDirectory(root,task,out),dir);assert.equal(await fs.readFile(path.join(dir,'old.mp4'),'utf8'),'old');
  await fs.rm(dir,{recursive:true});await fs.writeFile(dir,'user');await assert.rejects(outputDirectory(root,task,out),/不是普通文件夹/);assert.equal(await fs.readFile(dir,'utf8'),'user');
  await fs.rm(dir);const target=path.join(root,'elsewhere');await fs.mkdir(target);await fs.symlink(target,dir);await assert.rejects(outputDirectory(root,task,out),/不是普通文件夹/);assert.deepEqual(await fs.readdir(target),[]);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
