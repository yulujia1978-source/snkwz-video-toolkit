'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
function outputFolderName(task,output){
 const merged=task.options?.merge||task.options?.mergeUnlimited;
 const index=Number(output.file?.match(/^(\d+)-/)?.[1])-1;
 const source=task.files?.[index]?.name||task.files?.[0]?.name;
 const raw=merged?(task.options.mergeName||path.parse(source||output.name).name):path.parse(source||output.name).name;
 const name=String(raw).replace(/[\\/\x00-\x1f:]/g,'_').trim();
 return !name||name==='.'||name==='..'?'视频成品':name;
}
async function outputDirectory(parent,task,output){
 const base=await fs.realpath(parent),directory=path.join(base,outputFolderName(task,output));
 try{await fs.mkdir(directory);}catch(e){if(e.code!=='EEXIST')throw e;}
 const stat=await fs.lstat(directory);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('同名输出路径不是普通文件夹，请更换保存路径或重命名冲突项');
 return directory;
}
module.exports={outputFolderName,outputDirectory};
