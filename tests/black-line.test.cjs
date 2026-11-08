const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {normalize,command}=require('../Resources/services/video-dedupe');
const bin=path.join(__dirname,'../dist/视频去重.app/Contents/Resources/bin'),ffmpeg=path.join(bin,'ffmpeg'),ffprobe=path.join(bin,'ffprobe');
const ff=args=>execFileSync(ffmpeg,['-v','error',...args],{maxBuffer:16*1024*1024});
function rowMean(rgb,width,y){let total=0;const start=Math.floor(width*.4),end=Math.floor(width*.6);for(let x=start;x<end;x++)for(let c=0;c<3;c++)total+=rgb[(y*width+x)*3+c];return total/((end-start)*3);}
test('black line remains visible inside black border and after compression/resizing; custom position, thickness and opacity apply',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'vd-black-line-'));
 try{
  const src=path.join(root,'white.mp4');ff(['-f','lavfi','-i','color=white:size=320x240:rate=10:duration=0.5','-c:v','libx264',src]);
  const cases=[
   ['border-default',{borderSize:8},336,256],
   ['border-hardware',{borderSize:8,hardwareAcceleration:true},336,256],
   ['compress-border',{borderSize:8,compress:true},320,240],
   ['resize',{borderSize:8,reencode:{resolution:'1280×720',preset:'ultrafast'}},1280,720],
   ['middle',{blackLineY:50,blackLineThickness:12,blackLineOpacity:.5},320,240],
   ['top',{blackLineY:10,blackLineThickness:6},320,240],
   ['transparent',{blackLineOpacity:0},320,240],
  ];
  for(const [name,extra,w,h] of cases){
   const o=normalize({blackLine:true,reencode:{preset:'ultrafast'},...extra}),out=path.join(root,name+'.mp4');
   const {args}=command(src,out,o,{width:320,height:240,duration:.5,hasAudio:false,codec:'h264',copyCompatible:true,fps:10});execFileSync(ffmpeg,args,{stdio:'pipe'});
   const streams=JSON.parse(execFileSync(ffprobe,['-v','error','-show_streams','-of','json',out])).streams;assert.equal(streams[0].width,w);assert.equal(streams[0].height,h);
   const rgb=ff(['-i',out,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
   const y=Math.floor((h-o.blackLineThickness)*o.blackLineY/100),center=y+Math.floor(o.blackLineThickness/2),mean=rowMean(rgb,w,center),expected=255*(1-o.blackLineOpacity);
   assert.ok(Math.abs(mean-expected)<15,`${name}: expected line intensity ${expected}, got ${mean}`);
   assert.ok(rowMean(rgb,w,y-4)>235,`${name}: pixels above the line must stay white`);
   assert.ok(rowMean(rgb,w,y+o.blackLineThickness+4)>235,`${name}: pixels below the line must stay white`);
   if(o.blackLineOpacity===1){let rows=0;for(let j=y-3;j<=y+o.blackLineThickness+3;j++)if(rowMean(rgb,w,j)<20)rows++;assert.ok(Math.abs(rows-o.blackLineThickness)<=1,`${name}: wrong output thickness ${rows}`);}
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('black line rejects invalid geometry and opacity',()=>{
 for(const option of [{blackLineY:-1},{blackLineY:101},{blackLineThickness:0},{blackLineThickness:101},{blackLineOpacity:-.1},{blackLineOpacity:1.1}])assert.throws(()=>normalize(option));
});
