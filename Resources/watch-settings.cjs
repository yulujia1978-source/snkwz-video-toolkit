'use strict';
const path=require('node:path');
function sourceName(directory){return path.basename(path.resolve(directory))||'来源文件夹';}
module.exports={sourceName};
