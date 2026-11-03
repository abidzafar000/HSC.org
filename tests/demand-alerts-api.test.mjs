import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase} from '../lib/postgres.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {hashPassword} from '../lib/access.mjs';
import {handleApi} from '../lib/api.mjs';

const password='DisposableDemandAlerts!827';

async function fixture(t){
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8'));
  let readHook=null;
  const full=result=>({rows:result.rows,rowCount:result.affectedRows??result.rows.length});
  const db=createDatabase({
    query(sql,parameters){return {sql,parameters,then(resolve,reject){return pg.query(sql,[...parameters]).then(async result=>{
      if(readHook&&sql==="SELECT * FROM application WHERE id='main'"&&--readHook.remaining===0){const callback=readHook.callback;readHook=null;await callback(pg);}
      return full(result);
    }).then(resolve,reject);}};},
    transaction(queries){return pg.transaction(async tx=>{const results=[];for(const query of queries)results.push(full(await tx.query(query.sql,[...query.parameters])));return results;});},
  });
  await initializeWorkspace(db,{initialAdminPassword:password});
  const credential=await hashPassword(password);
  for(const [id,role,branchId,permissions] of [
    ['warehouse','warehouse',null,'["demands"]'],
    ['reviewer','admin',null,'["demands"]'],
    ['missing','warehouse',null,'["stock"]'],
    ['buyer','purchasing',null,'["purchases"]'],
    ['branch','branch','B1',null],
  ])await db.prepare('INSERT INTO users(id,email,name,role,branch_id,password,permissions) VALUES(?,?,?,?,?,?,?)').bind(id,`${id}@example.test`,id,role,branchId,credential,permissions).run();
  const state=JSON.parse((await db.prepare("SELECT data FROM application WHERE id='main'").first()).data);
  state.products.push({id:'P1',sku:'ALERT-PCS',name:'Private catalogue item',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1}],rate:9999,reorderLevel:0,active:true});
  state.suppliers.push({id:'S1',name:'Private supplier',contact:'Do not expose supplier contacts',active:true});
  state.locations.find(location=>location.id==='B1').address='Do not expose branch address';
  await db.prepare("UPDATE application SET data=? WHERE id='main'").bind(JSON.stringify(state)).run();
  const stored=()=>db.prepare("SELECT data,revision FROM application WHERE id='main'").first();
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
        return {status:response.status,body:await response.json(),cacheControl:response.headers.get('cache-control')};
      },
      async action(action,payload){const result=await this.call('action',{action,payload,revision:(await stored()).revision});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;},
    };
  }
  return {db,client,stored,afterEndpointRead(callback){readHook={remaining:3,callback};}};
}

const lines=[{productId:'P1',qty:5,unit:'pc'}];

test('demand alert polling is scoped, minimal, read-only and tracks distinct submissions through the PostgreSQL API',async t=>{
  const {db,client,stored,afterEndpointRead}=await fixture(t);
  const owner=client(),warehouse=client(),reviewer=client(),branch=client(),missing=client(),buyer=client();
  assert.equal((await client().call('demand-alerts')).status,401);
  for(const [connection,email] of [[owner,'admin@hamsun.local'],[warehouse,'warehouse@example.test'],[reviewer,'reviewer@example.test'],[branch,'branch@example.test'],[missing,'missing@example.test'],[buyer,'buyer@example.test']])assert.equal((await connection.call('login',{email,password})).status,200);
  for(const connection of [branch,missing,buyer])assert.equal((await connection.call('demand-alerts')).status,403);
  assert.deepEqual((await owner.call('demand-alerts')).body.alerts,[]);

  let result=await branch.action('demand.create',{branchId:'B1',lines,note:'Do not expose demand notes'});
  const draft=result.state.demands[0];
  assert.equal(draft.status,'Draft');
  assert.deepEqual((await owner.call('demand-alerts')).body.alerts,[],'Unsubmitted drafts must not notify');
  result=await branch.action('demand.submit',{id:draft.id});
  assert.equal(result.state.demands.find(row=>row.id===draft.id).status,'Pending approval','The submission response contains the new pending state');
  let poll=await owner.call('demand-alerts');
  assert.equal(poll.status,200);assert.equal(poll.cacheControl,'no-store');
  assert.deepEqual(Object.keys(poll.body).sort(),['alerts','revision']);
  assert.equal(poll.body.alerts.length,1);
  const alert=poll.body.alerts[0],firstKey=alert.eventKey;
  assert.equal(alert.id,firstKey);assert.equal(alert.demandId,draft.id);assert.equal(alert.reference,draft.reference);
  assert.equal(alert.branchId,'B1');assert.equal(alert.branchName,'Hamsun FSL');assert.equal(alert.itemCount,1);
  assert.deepEqual(Object.keys(alert).sort(),['branchId','branchName','createdByName','demandId','eventKey','id','itemCount','reference','submittedAt']);
  assert.ok(!JSON.stringify(poll.body).includes('Private catalogue item'));
  assert.ok(!JSON.stringify(poll.body).includes('Do not expose'));
  assert.equal((await warehouse.call('demand-alerts')).body.alerts[0].eventKey,firstKey);
  assert.equal((await reviewer.call('demand-alerts')).body.alerts[0].eventKey,firstKey);
  const before=await stored();
  assert.deepEqual((await owner.call('demand-alerts')).body,poll.body);
  assert.deepEqual(await stored(),before,'Polling must not change business data, audit or revision');

  const own=await owner.action('demand.create',{branchId:'B2',lines,submit:true});
  assert.equal((await owner.call('demand-alerts')).body.alerts.some(row=>row.demandId===own.result.id),false,'A reviewer is not notified about their own request');
  assert.equal((await warehouse.call('demand-alerts')).body.alerts.some(row=>row.demandId===own.result.id),true);
  await warehouse.action('demand.reject',{id:draft.id,reason:'Confirm requested quantity'});
  assert.equal((await owner.call('demand-alerts')).body.alerts.some(row=>row.demandId===draft.id),false);
  await branch.action('demand.reopen',{id:draft.id,reason:'Quantity confirmed'});
  assert.equal((await owner.call('demand-alerts')).body.alerts.some(row=>row.demandId===draft.id),false);
  await branch.action('demand.submit',{id:draft.id});
  poll=await owner.call('demand-alerts');
  const resubmitted=poll.body.alerts.find(row=>row.demandId===draft.id);
  assert.ok(resubmitted);assert.notEqual(resubmitted.eventKey,firstKey,'Resubmission is a new notification even for the same demand');
  assert.equal((await owner.call('demand-alerts')).body.alerts.find(row=>row.demandId===draft.id).eventKey,resubmitted.eventKey);

  await db.prepare('UPDATE users SET permissions=? WHERE id=?').bind('[]','warehouse').run();
  assert.equal((await warehouse.call('demand-alerts')).status,403,'A current session cannot bypass a removed demands grant');
  await db.prepare('UPDATE users SET permissions=? WHERE id=?').bind('["demands"]','warehouse').run();
  afterEndpointRead(pg=>pg.query('UPDATE users SET permissions=$1 WHERE id=$2',['[]','warehouse']));
  assert.equal((await warehouse.call('demand-alerts')).status,403,'Permission must be checked again after reading the application');
  await db.prepare('UPDATE users SET permissions=? WHERE id=?').bind('["demands"]','warehouse').run();
  afterEndpointRead(pg=>pg.query('DELETE FROM sessions WHERE user_id=$1',['warehouse']));
  assert.equal((await warehouse.call('demand-alerts')).status,401,'Revocation during the poll must not return stale alerts');
  assert.equal((await warehouse.call('demand-alerts')).status,401);
});
