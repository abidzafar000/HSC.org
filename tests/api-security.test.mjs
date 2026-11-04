import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase} from '../lib/postgres.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {handleApi} from '../lib/api.mjs';

const password='DisposableSecurityFixture!827';

async function fixture(t){
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8'));
  const full=result=>({rows:result.rows,rowCount:result.affectedRows??result.rows.length});
  let failUserListing=false;
  const db=createDatabase({
    query(sql,parameters){return {sql,parameters,then(resolve,reject){
      if(failUserListing&&sql==='SELECT id,name,email,role,branch_id,active,permissions FROM users ORDER BY name')return Promise.reject(new Error('fetch failed')).then(resolve,reject);
      return pg.query(sql,[...parameters]).then(full).then(resolve,reject);
    }};},
    transaction(queries){return pg.transaction(async tx=>{const results=[];for(const query of queries)results.push(full(await tx.query(query.sql,[...query.parameters])));return results;});},
  });
  await initializeWorkspace(db,{initialAdminPassword:password});
  async function call(path,body,headers={}){
    const response=await handleApi(new Request(`https://hsc.test/api/${path}`,{
      method:body===undefined?'GET':'POST',
      headers:{...(body===undefined?{}:{'content-type':'application/json','origin':'https://hsc.test'}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)}),
    }),db);
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  return {db,call,setUserListingFailure(value){failUserListing=value;}};
}

test('login locks survive caller IP-header rotation, then expire normally without weakening session checks',async t=>{
  const {db,call}=await fixture(t);
  const wrong={email:'admin@hamsun.local',password:'Incorrect password'};
  for(let i=0;i<8;i++)assert.equal((await call('login',wrong,{'cf-connecting-ip':'198.51.100.1'})).status,401);
  assert.equal((await call('login',wrong,{'cf-connecting-ip':'198.51.100.1'})).status,429);
  assert.equal((await call('login',{...wrong,email:' ADMIN@HAMSUN.LOCAL '},{'cf-connecting-ip':'198.51.100.2'})).status,429,'Changing an untrusted proxy header must not reset account throttling');
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM login_limits').first('count'),1);
  await db.prepare('UPDATE login_limits SET until=?').bind(Date.now()-1).run();
  assert.equal((await call('login',wrong,{'cf-connecting-ip':'198.51.100.3'})).status,401,'The lock expires after its cooldown');
  const signedIn=await call('login',{email:'admin@hamsun.local',password},{'cf-connecting-ip':'198.51.100.4'});
  assert.equal(signedIn.status,200);assert.equal(signedIn.body.user.password,undefined);
  assert.match(signedIn.cookie,/HttpOnly/);assert.match(signedIn.cookie,/SameSite=Strict/);assert.match(signedIn.cookie,/Secure/);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM login_limits').first('count'),0,'A successful sign-in clears failed attempts');
  const cookie=signedIn.cookie.split(';')[0];
  assert.equal((await call('state',undefined,{cookie})).status,200);
  await db.prepare('UPDATE sessions SET expires=?').bind(Date.now()-1).run();
  assert.equal((await call('state',undefined,{cookie})).status,401,'An expired server session cannot read business data');
  assert.equal((await call('session',undefined,{cookie})).body.user,null);
  const loggedOut=await call('logout',{}, {cookie});
  assert.equal(loggedOut.status,200);assert.match(loggedOut.cookie,/Max-Age=0/);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM sessions').first('count'),0);
});

test('response-only account reads finish before a product setup and opening quantity can commit',async t=>{
  const {db,call,setUserListingFailure}=await fixture(t);
  const login=await call('login',{email:'admin@hamsun.local',password});
  assert.equal(login.status,200);
  const headers={cookie:login.cookie.split(';')[0]};
  const imported=await call('action',{action:'product.import',payload:{names:['Disposable setup item']}},headers);
  assert.equal(imported.status,200);
  const draft=imported.body.state.products[0];
  const payload={...draft,category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1}],rate:80,reorderLevel:0,active:true,warehouseQuantity:100,warehouseExpectedQuantity:0,warehouseRate:80};
  const stored=()=>db.prepare("SELECT data,revision FROM application WHERE id='main'").first();
  const before=await stored();

  setUserListingFailure(true);
  const interrupted=await call('action',{action:'product.save',payload,revision:before.revision},headers);
  assert.equal(interrupted.status,400);
  assert.equal(interrupted.body.error,'fetch failed');
  assert.deepEqual(await stored(),before,'A failed response-only read must preserve the setup draft, warehouse stock, audit and revision');

  setUserListingFailure(false);
  const saved=await call('action',{action:'product.save',payload,revision:before.revision},headers);
  assert.equal(saved.status,200,JSON.stringify(saved.body));
  assert.equal(saved.body.revision,before.revision+1);
  const product=saved.body.state.products.find(item=>item.id===draft.id);
  assert.equal(product.active,true);assert.equal(product.setupPending,undefined);
  assert.deepEqual(saved.body.state.stock.map(({productId,locationId,qty,avgCost})=>({productId,locationId,qty,avgCost})),[{productId:draft.id,locationId:'WH',qty:100,avgCost:80}]);
  assert.equal(saved.body.state.documents.length,1);
  assert.equal(saved.body.state.documents[0].status,'Completed');
  assert.deepEqual(saved.body.users.map(user=>user.id),['admin']);
  const persisted=await stored();
  assert.equal(persisted.revision,saved.body.revision);
  assert.deepEqual(JSON.parse(persisted.data).stock,saved.body.state.stock);
});
