const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process'),{performance}=require('node:perf_hooks');
const work=path.join(__dirname,'.work');fs.mkdirSync(work,{recursive:true});
const bin=path.join(__dirname,'../dist/视频去重.app/Contents/Resources/bin'),ffmpeg=path.join(bin,'ffmpeg'),ffprobe=path.join(bin,'ffprobe');
const fixture=path.join(work,'fixture.mp4');
if(!fs.existsSync(fixture))execFileSync(ffmpeg,['-y','-v','error','-f','lavfi','-i','testsrc2=size=1080x1920:rate=30:duration=12','-f','lavfi','-i','sine=frequency=440:duration=12','-c:v','libx264','-preset','ultrafast','-crf','18','-c:a','aac',fixture],{stdio:'ignore'});
const before=require('./before-1.0.1.cjs'),after=require('../Resources/services/video-dedupe');
const info={width:1080,height:1920,duration:12,hasAudio:true,audioCodec:'aac',codec:'h264',fps:30};
const common={grid:5,gridOpacity:.12,borderSize:8,blackLine:true};
const rows=[];
for(const [name,engine,options] of [['before-cpu',before,{hardwareAcceleration:false,reencode:{preset:'fast'}}],['after-default',after,{hardwareAcceleration:true,keepAudio:true,reencode:{preset:'veryfast'}}],['after-software',after,{hardwareAcceleration:false,keepAudio:true,reencode:{preset:'veryfast'}}]]){
 const out=path.join(work,name+'.mp4');const {args}=engine.command(fixture,out,engine.normalize({...common,...options}),info);
 const start=performance.now();execFileSync(ffmpeg,args,{stdio:'pipe',timeout:120000,maxBuffer:1024*1024});const seconds=(performance.now()-start)/1000;
 const meta=JSON.parse(execFileSync(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',out]));const v=meta.streams.find(s=>s.codec_type==='video');
 rows.push({name,seconds:+seconds.toFixed(3),width:v.width,height:v.height,frames:+v.nb_read_frames,duration:+meta.format.duration,codec:v.codec_name,bytes:+meta.format.size});
 console.log(JSON.stringify(rows.at(-1)));
}
fs.writeFileSync(path.join(__dirname,'speed-results.json'),JSON.stringify({fixture:'12s, 1080x1920, 30fps, grid+8px border+black lines',rows,speedup:rows[0].seconds/rows[1].seconds},null,2));
