const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');

class Element {
 constructor(){this.children=[];this.files=[];this.disabled=false;this.value='';this.style={};}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this.children=children;}
 setAttribute(){}
 remove(){}
 scrollIntoView(){}
 focus(){}
 checkValidity(){return true;}
 click(){if(!this.disabled)return this.onclick?.();}
}
async function setup(){
 const elements=new Map(),groups=[],starts=[],directories=['/inputA','/outputA','/inputB','/outputB'];
 const $=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
 const snapshot=()=>JSON.parse(JSON.stringify({groups,enabled:groups.some(g=>g.enabled),counts:{}}));
 const context=vm.createContext({window:{},document:{createElement:()=>new Element()},sessionStorage:{getItem:()=>null,setItem(){}},$,busy:false,saving:false,controls:[],options:()=>({merge:false,mergeUnlimited:true,transition:false,compress:true,grid:3,pipOpacity:0}),native:async()=>directories.shift(),setTimeout:()=>0,clearTimeout(){},api:async(route,request)=>{
  const body=JSON.parse(request?.body||'{}');
  if(route==='/auto-queue/groups'){groups.push({id:'watch-'+groups.length,name:body.name,config:body,enabled:false});return {...snapshot(),createdId:groups.at(-1).id};}
  if(route==='/auto-queue/groups/update'){const group=groups.find(g=>g.id===body.id);group.config={...group.config,...body};}
  if(route==='/auto-queue/start'){starts.push(body);const group=groups.find(g=>g.id===body.id);group.enabled=true;group.config.options=body.options;}
  if(route==='/auto-queue/stop')for(const g of groups)if(!body.id||body.id===g.id)g.enabled=false;
  return snapshot();
 }});
 vm.runInContext(fs.readFileSync(require.resolve('../Resources/progress-ui.js'),'utf8')+fs.readFileSync(require.resolve('../Resources/auto-queue-ui.js'),'utf8')+'\nglobalThis.ui={autoRows,chooseAutoDirectory,autoAction};',context);
 await new Promise(setImmediate);
 return{context,$,groups,starts,...context.ui};
}
test('folder selection immediately unlocks Add Task and all groups receive the selected merge and compression options',async()=>{
 const h=await setup(),first=[...h.autoRows.values()][0];
 await h.chooseAutoDirectory(first,'input');await h.chooseAutoDirectory(first,'output');
 assert.equal(first.draft,false);assert.equal(h.$('autoAddGroup').disabled,false);
 assert.equal(h.$('autoStartAll').disabled,false);assert.equal(first.start.disabled,false);
 h.$('autoAddGroup').click();const second=[...h.autoRows.values()].find(r=>r!==first);
 assert.ok(second,'Add Task must work immediately after picking a directory');
 await h.chooseAutoDirectory(second,'input');await h.chooseAutoDirectory(second,'output');
 await h.$('autoStartAll').click();
 assert.equal(h.groups.length,2);assert.equal(h.groups.filter(g=>g.enabled).length,2);assert.match(first.settings.textContent,/本次参数：完整合并.*视频压缩开启/);assert.equal(first.redo.disabled,true);
 for(const start of h.starts){assert.equal(start.options.merge,false);assert.equal(start.options.mergeUnlimited,true);assert.equal(start.options.compress,true);assert.equal(start.options.transition,false);assert.equal(start.options.grid,3);}
 assert.equal(vm.runInContext('options().mergeUnlimited',h.context),true,'manual settings remain intact');
 await h.autoAction('stopAll');assert.equal(first.redo.disabled,false);await first.start.click();
 assert.equal(h.groups[0].enabled,true);assert.equal(h.groups[1].enabled,false);
});

test('Start All reports missing directories and a single card guides selection then starts',async()=>{
 const h=await setup(),row=[...h.autoRows.values()][0];
 assert.equal(row.start.disabled,false);assert.equal(h.$('autoStartAll').disabled,false);
 await h.$('autoStartAll').click();assert.match(h.$('autoStatus').textContent,/任务 1：请先选择监听文件夹和输出文件夹/);assert.equal(h.starts.length,0);
 await row.start.click();assert.equal(h.starts.length,1);assert.equal(h.groups[0].enabled,true);
 assert.equal(h.groups[0].config.inputDirectory,'/inputA');assert.equal(h.groups[0].config.outputDirectory,'/outputA');
});
test('card start cancellation and server rejection both show the actual error',async()=>{
 const h=await setup(),row=[...h.autoRows.values()][0];
 vm.runInContext('native=async()=>null',h.context);
 await row.start.click();assert.match(h.$('autoStatus').textContent,/已取消选择监听文件夹/);assert.equal(h.starts.length,0);assert.equal(row.start.disabled,false);
 row.inputDirectory='/input';row.outputDirectory='/output';
 vm.runInContext("api=async()=>{throw Error('没有文件夹访问权限')}",h.context);
 await row.start.click();assert.match(h.$('autoStatus').textContent,/没有文件夹访问权限/);assert.equal(row.start.disabled,false);
});

test('card title follows the chosen source and completed sessions show stopped rather than monitoring',async()=>{
 const h=await setup(),row=[...h.autoRows.values()][0];await h.chooseAutoDirectory(row,'input');assert.equal(row.title.textContent,'inputA');await h.chooseAutoDirectory(row,'output');
 assert.equal(row.finishToggle.checked,true);await row.start.click();assert.equal(h.starts[0].autoStop,true);
 const g=h.groups[0];g.enabled=false;g.stopReason='completed';g.counts={waiting:0,completed:2,outputs:1,failed:0,retryable:0};h.context.completedState={groups:h.groups,enabled:false,active:null,counts:g.counts};
 vm.runInContext('renderAutoQueue(completedState)',h.context);assert.match(row.status.textContent,/处理完成，已自动停止/);assert.equal(h.context.window.autoRunActive,false);assert.equal(row.stop.disabled,true);assert.equal(row.start.disabled,false);
 row.autoStop=false;row.dirty=true;await h.autoAction('save',row);await row.start.click();assert.equal(h.starts[1].autoStop,false);assert.match(row.settings.textContent,/持续监听/);
});
