import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase} from '../lib/postgres.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {hashPassword} from '../lib/access.mjs';
import {handleApi} from '../lib/api.mjs';

// Isolated PostgreSQL fixture. These credentials and records have no live access.
const password='DisposableInlineGRN!827';

async function fixture(t){
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8'));
  const full=result=>({rows:result.rows,rowCount:result.affectedRows??result.rows.length});
  const db=createDatabase({
    query(sql,parameters){return {sql,parameters,then(resolve,reject){return pg.query(sql,[...parameters]).then(full).then(resolve,reject);}};},
    transaction(queries){return pg.transaction(async tx=>{const results=[];for(const query of queries)results.push(full(await tx.query(query.sql,[...query.parameters])));return results;});},
  });
  await initializeWorkspace(db,{initialAdminPassword:password});
  const credential=await hashPassword(password);
  for(const [id,role,branchId,permissions] of [
    ['buyer','purchasing',null,'["purchases"]'],
    ['denied','purchasing',null,'[]'],
    ['branch','branch','B1',null],
  ])await db.prepare('INSERT INTO users(id,email,name,role,branch_id,password,permissions) VALUES(?,?,?,?,?,?,?)').bind(id,`${id}@example.test`,id,role,branchId,credential,permissions).run();
  const state=JSON.parse((await db.prepare("SELECT data FROM application WHERE id='main'").first()).data);
  state.suppliers.push({id:'S1',name:'Disposable GRN supplier',active:true});
  state.products.push({id:'PENDING',sku:'ITEM-0001',name:'Pending API item',category:'',baseUnit:'',units:[],rate:null,reorderLevel:0,active:false,setupPending:true});
  await db.prepare("UPDATE application SET data=? WHERE id='main'").bind(JSON.stringify(state)).run();
  function client(){
    let cookie='';
    return {
      async call(path,body){
        const response=await handleApi(new Request(`http://hsc.test/api/${path}`,{
          method:body===undefined?'GET':'POST',
          headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json','origin':'http://hsc.test'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)}),
        }),db);
        const received=response.headers.get('set-cookie');if(received)cookie=received.split(';')[0];
        return {status:response.status,body:await response.json()};
      },
      action(action,payload,revision){return this.call('action',{action,payload,revision});},
    };
  }
  const stored=()=>db.prepare("SELECT data,revision FROM application WHERE id='main'").first();
  return {db,client,stored};
}

const newLine=(name,extra={})=>({productId:'',newProduct:{name,category:'Packaging',baseUnit:'pc'},unit:'pc',qty:5,rate:20,discount:0,tax:0,...extra});
const purchase=lines=>({supplierId:'S1',freight:0,lines});

test('GRN API creates ready products atomically with scoped purchasing access and posts stock only once after approval',async t=>{
  const {client,stored}=await fixture(t);
  const owner=client(),buyer=client(),branch=client(),denied=client();
  for(const [connection,email] of [[owner,'admin@hamsun.local'],[buyer,'buyer@example.test'],[branch,'branch@example.test'],[denied,'denied@example.test']])assert.equal((await connection.call('login',{email,password})).status,200);
  let current=(await buyer.call('state')).body;
  assert.deepEqual(current.user.permissions,['purchases']);
  assert.equal(current.state.products.some(row=>row.id==='PENDING'),false,'Pending setup records remain hidden from operational users');

  async function unchanged(connection,action,payload,status=400){
    const before=await stored();
    const result=await connection.action(action,payload,before.revision);
    assert.equal(result.status,status,JSON.stringify(result.body));
    assert.deepEqual(await stored(),before,'Failed validation/authorization must preserve products, documents, audit and revision');
    return result;
  }
  await unchanged(buyer,'product.save',{sku:'BYPASS',name:'Forbidden master',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1}]},403);
  await unchanged(branch,'grn.create',purchase([newLine('Branch cannot purchase')]),403);
  await unchanged(denied,'grn.create',purchase([newLine('No module permission')]),403);
  await unchanged(buyer,'grn.create',purchase([newLine('Invalid quantity creates no master',{qty:0})]));
  await unchanged(buyer,'grn.create',purchase([newLine('Pending API item')]));
  await unchanged(buyer,'grn.create',purchase([newLine('Repeated API name'),newLine(' repeated   api NAME ')]));
  await unchanged(branch,'return.create',{branchId:'B1',note:'Cannot add masters through returns',lines:[newLine('Return bypass')]});

  let result=await buyer.action('grn.create',purchase([newLine('Inline API packets')]),current.revision);
  assert.equal(result.status,200,JSON.stringify(result.body));
  current=result.body;
  const docId=current.result.id,firstId=current.result.lines[0].productId;
  assert.equal(current.result.status,'Draft');
  assert.equal(current.result.lines[0].newProduct,undefined,'Stored lines are normal product references');
  const first=current.state.products.find(row=>row.id===firstId);
  assert.equal(first.name,'Inline API packets');assert.equal(first.active,true);assert.equal(first.baseUnit,'pc');assert.equal(first.rate,20);
  assert.deepEqual(first.units,[{name:'pc',factor:1}]);
  let persisted=JSON.parse((await stored()).data);
  assert.equal(persisted.products.length,2);assert.deepEqual(persisted.stock,[]);assert.deepEqual(persisted.ledger,[]);
  assert.equal(persisted.audit.some(row=>row.action==='product.create'&&row.entityId===firstId&&row.userId==='buyer'),true);
  await unchanged(buyer,'grn.create',purchase([newLine('  INLINE   API packets ')]));
  await unchanged(buyer,'document.update',{id:docId,lines:[{productId:firstId,unit:'pc',qty:5,rate:20},newLine('Failed update item',{rate:0})]});

  result=await buyer.action('document.update',{id:docId,lines:[{productId:firstId,unit:'pc',qty:5,rate:20},newLine('Second inline API packets',{qty:2,rate:30})]},current.revision);
  assert.equal(result.status,200,JSON.stringify(result.body));current=result.body;
  const secondId=current.result.lines[1].productId;
  assert.notEqual(secondId,firstId);
  persisted=JSON.parse((await stored()).data);
  assert.equal(persisted.products.length,3);assert.deepEqual(persisted.stock,[]);
  const savedLines=current.result.lines.map(({productId,unit,qty,rate,discount,tax})=>({productId,unit,qty,rate,discount,tax}));
  result=await buyer.action('document.update',{id:docId,lines:savedLines},current.revision);
  assert.equal(result.status,200,JSON.stringify(result.body));current=result.body;
  assert.equal(JSON.parse((await stored()).data).products.length,3,'Saving an edited draft reuses its created product IDs');
  result=await buyer.action('document.submit',{id:docId},current.revision);
  assert.equal(result.status,200,JSON.stringify(result.body));current=result.body;
  await unchanged(buyer,'document.approve',{id:docId},403);
  result=await owner.action('document.approve',{id:docId},current.revision);
  assert.equal(result.status,200,JSON.stringify(result.body));current=result.body;
  assert.equal(current.result.status,'Completed');
  assert.deepEqual(current.state.stock.map(({locationId,productId,qty,avgCost})=>({locationId,productId,qty,avgCost})).sort((a,b)=>a.avgCost-b.avgCost),[
    {locationId:'WH',productId:firstId,qty:5,avgCost:20},
    {locationId:'WH',productId:secondId,qty:2,avgCost:30},
  ]);
  assert.equal(current.state.ledger.length,2);
  await unchanged(owner,'document.approve',{id:docId});
});
