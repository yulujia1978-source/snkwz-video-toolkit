const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../Resources/desktop.js'),'utf8');
const check=source.slice(source.indexOf('async function desktopQuitState(){'));
async function state(engine,{busy=false,saving=false}={}){
 const context=vm.createContext({busy,saving,api:async()=>engine});vm.runInContext(check,context);return JSON.parse(JSON.stringify(await vm.runInContext('desktopQuitState()',context)));
}
test('fresh quit state distinguishes completed tasks, continuous monitoring, pending files and real processing',async()=>{
 assert.deepEqual(await state({enabled:false,active:null,counts:{waiting:0,stabilizing:0}}),{processing:false,watching:false,pending:0});
 assert.deepEqual(await state({enabled:true,active:null,counts:{waiting:0,stabilizing:0}}),{processing:false,watching:true,pending:0});
 assert.deepEqual(await state({enabled:true,active:null,counts:{waiting:2,stabilizing:1}}),{processing:false,watching:true,pending:3});
 assert.equal((await state({enabled:true,active:{status:'saving'},counts:{}})).processing,true);
 assert.equal((await state({enabled:false,active:null,counts:{}},{saving:true})).processing,true);
 assert.equal((await state({enabled:false,active:null,counts:{}},{busy:true})).processing,true);
});
