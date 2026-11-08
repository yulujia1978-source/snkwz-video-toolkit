const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const work=path.join(__dirname,'.work');fs.mkdirSync(work,{recursive:true});
const dist=path.join(__dirname,'../dist'),ffmpeg=path.join(dist,'视频去重.app/Contents/Resources/bin/ffmpeg');
const source=path.join(work,'line-preview-source.mp4');
execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=640x360:rate=25:duration=2','-c:v','libx264',source]);
const old=require('./before-1.0.1.cjs'),current=require('../Resources/services/video-dedupe');
const before=path.join(work,'line-before.mp4'),after=path.join(dist,'黑线效果演示.mp4');
for(const [engine,out] of [[old,before],[current,after]]){
 const {args}=engine.command(source,out,engine.normalize({borderSize:8,blackLine:true,hardwareAcceleration:true}),{width:640,height:360,duration:2,hasAudio:false});
 execFileSync(ffmpeg,args,{stdio:'pipe'});
}
execFileSync(ffmpeg,['-y','-v','error','-i',before,'-i',after,'-filter_complex',"[0:v]drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='Before':x=20:y=20:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7[a];[1:v]drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='After - 8px at 90 percent':x=20:y=20:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.7[b];[a][b]hstack=inputs=2",'-frames:v','1',path.join(dist,'黑线效果对比.png')]);
