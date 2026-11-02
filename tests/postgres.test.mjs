import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase,getDatabase} from '../lib/postgres.mjs';
import {handleApi} from '../lib/api.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {hashPassword} from '../lib/access.mjs';

const testOwnerPassword='DisposableFixtureOnly!827';

/** Use actual PostgreSQL parsing/transactions behind the Neon's lazy query shape. */
async function fixture(t){
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8'));
  const calls={single:0,transactions:0};
  const full=result=>({rows:result.rows,rowCount:result.affectedRows??result.rows.length,command:result.affectedRows===undefined?'SELECT':'UPDATE'});
  const client={
    query(sql,parameters){
      return {sql,parameters,then(resolve,reject){calls.single++;return pg.query(sql,[...parameters]).then(full).then(resolve,reject);}};
    },
    transaction(queries){calls.transactions++;return pg.transaction(async tx=>{const results=[];for(const query of queries)results.push(full(await tx.query(query.sql,[...query.parameters])));return results;});},
  };
  const db=createDatabase(client);
  const user=(id,email=`${id}@example.test`)=>db.prepare('INSERT INTO users(id,email,name,role,password) VALUES(?,?,?,?,?)').bind(id,email,id,'viewer','test-hash');
  return {db,pg,calls,user};
}

test('PostgreSQL adapter preserves SQL literals while binding values and ignores duplicate bootstrap inserts',async t=>{
  const {db,user}=await fixture(t);
  const row=await db.prepare(`SELECT '?' AS literal, ?::text AS parameter, 'O''Reilly?' AS quoted, $$dollar?$$ AS dollar -- ?\n /* ? */`).bind('bound value').first();
  assert.deepEqual(row,{literal:'?',parameter:'bound value',quoted:"O'Reilly?",dollar:'dollar?'});
  assert.equal((await user('owner').run()).meta.changes,1);
  const duplicate=db.prepare('INSERT OR IGNORE INTO users(id,email,name,role,password) VALUES(?,?,?,?,?);').bind('owner','different@example.test','Changed','admin','different-hash');
  assert.equal((await duplicate.run()).meta.changes,0);
  const sameEmail=db.prepare('INSERT OR IGNORE INTO users(id,email,name,role,password) VALUES(?,?,?,?,?)').bind('second','owner@example.test','Second','admin','other-hash');
  assert.equal((await sameEmail.run()).meta.changes,0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),1);
  assert.equal((await db.prepare('SELECT name FROM users WHERE id=?').bind('owner').first()).name,'owner');
});

test('guarded account writes observe the CAS update and only one stale-revision transaction commits',async t=>{
  const {db,user,calls}=await fixture(t);
  await db.prepare('INSERT INTO application(id,data,revision) VALUES(?,?,0)').bind('main','{}').run();
  const guard="EXISTS (SELECT 1 FROM application WHERE id='main' AND revision=? AND json_extract(data,'$.lastAccessMutation')=?)";
  const batch=(marker,id)=>db.batch([
    db.prepare("UPDATE application SET data=?,revision=revision+1 WHERE id='main' AND revision=?").bind(JSON.stringify({lastAccessMutation:marker}),0),
    db.prepare(`INSERT INTO users(id,email,name,role,password) SELECT ?,?,?,?,? WHERE ${guard}`).bind(id,`${id}@example.test`,id,'viewer','test-hash',1,marker),
  ]);
  const results=await Promise.all([batch('first','A'),batch('second','B')]);
  assert.deepEqual(results.map(result=>result[0].meta.changes).sort(),[0,1]);
  assert.deepEqual(results.map(result=>result[1].meta.changes).sort(),[0,1]);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),1);
  assert.equal((await db.prepare("SELECT revision FROM application WHERE id='main'").first()).revision,1);
  const before=calls.single;
  const insert=db.prepare('INSERT INTO users(id,email,name,role,password) VALUES(?,?,?,?,?)');
  const left=insert.bind('left','left@example.test','Left','viewer','h'),right=insert.bind('right','right@example.test','Right','viewer','h');
  assert.equal(calls.single,before,'Preparing statements must not execute a request');
  await db.batch([left,right]);
  assert.equal(calls.single,before,'Batch queries must execute only inside one transaction');
  assert.deepEqual((await db.prepare('SELECT id FROM users WHERE id IN (?,?) ORDER BY id').bind('left','right').all()).results.map(row=>row.id),['left','right']);
});

test('a failed account write rolls the entire state transaction back',async t=>{
  const {db,user}=await fixture(t);
  await user('owner').run();
  await db.prepare('INSERT INTO application(id,data,revision) VALUES(?,?,0)').bind('main','{"kept":true}').run();
  await assert.rejects(db.batch([
    db.prepare("UPDATE application SET data=?,revision=revision+1 WHERE id='main'").bind('{"kept":false}'),
    user('owner'),
  ]));
  assert.deepEqual(await db.prepare("SELECT data,revision FROM application WHERE id='main'").first(),{data:'{"kept":true}',revision:0});
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),1);
});

test('login rate limits update and expire correctly using PostgreSQL upsert semantics',async t=>{
  const {db}=await fixture(t);
  const limit=db.prepare('INSERT INTO login_limits(id,attempts,until) VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET attempts=CASE WHEN until<? THEN 1 ELSE attempts+1 END,until=?');
  const until=Date.now()+900000;
  await limit.bind('login',until,Date.now(),until).run();
  await limit.bind('login',until,Date.now(),until).run();
  assert.equal((await db.prepare('SELECT attempts FROM login_limits WHERE id=?').bind('login').first()).attempts,2);
  await limit.bind('login',until+1800000,until+1,until+1800000).run();
  assert.equal((await db.prepare('SELECT attempts FROM login_limits WHERE id=?').bind('login').first()).attempts,1);
});

test('database configuration and batch ownership fail safely before a request executes',async t=>{
  assert.equal(getDatabase(''),null);
  assert.throws(()=>getDatabase('not-a-valid-url-secret'),error=>!error.message.includes('not-a-valid-url-secret'));
  const first=await fixture(t),second=await fixture(t);
  await assert.rejects(first.db.batch([second.user('other')]),/belong to this database/);
  assert.equal(first.calls.transactions,0);assert.equal(second.calls.single,0);
});

test('an empty database requires an explicit bootstrap credential before it writes any owner or workspace',async t=>{
  const {db,calls}=await fixture(t);
  for(const initialAdminPassword of [null,'','short']){
    await assert.rejects(initializeWorkspace(db,{initialAdminPassword}),error=>error.status===503&&error.message.includes('HSC_INITIAL_ADMIN_PASSWORD'));
  }
  assert.equal(calls.transactions,0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),0);
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM application').first('count'),0);
  await initializeWorkspace(db,{initialAdminPassword:testOwnerPassword});
  const owner=await db.prepare("SELECT * FROM users WHERE id='admin'").first();
  assert.equal(owner.role,'superadmin');
  assert.notEqual(owner.password,testOwnerPassword);
  assert.equal(owner.password,await hashPassword(testOwnerPassword,owner.password.split(':')[0]));
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),1);
  const state=JSON.parse((await db.prepare("SELECT data FROM application WHERE id='main'").first()).data);
  for(const key of ['products','suppliers','stock','documents','ledger','audit','losses'])assert.deepEqual(state[key],[]);
});

test('an initialized database retains owner credentials and business records without a bootstrap credential',async t=>{
  const {db,calls}=await fixture(t);
  await initializeWorkspace(db,{initialAdminPassword:testOwnerPassword});
  await db.prepare("UPDATE users SET name=?,password=? WHERE id='admin'").bind('Existing owner','existing-credential-hash').run();
  const before=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  const state=JSON.parse(before.data);
  state.products.push({id:'existing-product',name:'Existing item'});
  state.stock.push({productId:'existing-product',locationId:'WH',qty:9,avgCost:20});
  await db.prepare("UPDATE application SET data=?,revision=? WHERE id='main'").bind(JSON.stringify(state),7).run();
  const saved=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  const transactions=calls.transactions;
  await initializeWorkspace(db,{initialAdminPassword:null});
  await initializeWorkspace(db,{initialAdminPassword:'DifferentSetupCredential!'});
  assert.deepEqual(await db.prepare("SELECT * FROM application WHERE id='main'").first(),saved);
  const owner=await db.prepare("SELECT * FROM users WHERE id='admin'").first();
  assert.equal(owner.name,'Existing owner');
  assert.equal(owner.password,'existing-credential-hash');
  assert.equal(calls.transactions,transactions);
});

test('the shared API initializes, authenticates, posts warehouse stock and receives scoped branch stock on PostgreSQL',async t=>{
  const {db}=await fixture(t);
  await initializeWorkspace(db,{initialAdminPassword:testOwnerPassword});
  function client(){
    let cookie='';
    return {
      async call(path,body){
        const response=await handleApi(new Request(`http://hsc.test/api/${path}`,{method:body===undefined?'GET':'POST',headers:{...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})}),db);
        const received=response.headers.get('set-cookie');if(received)cookie=received.split(';')[0];
        return {status:response.status,body:await response.json()};
      },
      async action(action,payload,revision){const result=await this.call('action',{action,payload,revision});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;},
    };
  }
  const owner=client(),branch=client();
  assert.equal((await owner.call('login',{email:'admin@hamsun.local',password:testOwnerPassword})).status,200);
  let current=(await owner.call('state')).body;
  assert.equal(current.user.role,'superadmin');assert.equal(current.users.length,1);assert.deepEqual(current.state.products,[]);
  current=await owner.action('product.save',{sku:'PG-PACKET',name:'PostgreSQL packets',category:'Packaging',baseUnit:'pc',units:[{name:'pc',factor:1},{name:'Carton (12)',factor:12}]},current.revision);
  const productId=current.result.id;
  current=await owner.action('user.save',{name:'PG Branch',email:'branch@example.test',role:'branch',branchId:'B1',password:'BranchTest123!',active:true},current.revision);
  assert.equal((await branch.call('login',{email:'branch@example.test',password:'BranchTest123!'})).status,200);
  current=await owner.action('stock.add',{locationId:'WH',postNow:true,override:true,note:'PostgreSQL opening balance',lines:[{productId,qty:2,unit:'Carton (12)',rate:900}]},current.revision);
  assert.equal(current.state.stock.find(row=>row.productId===productId&&row.locationId==='WH').qty,24);
  assert.equal(current.state.stock.find(row=>row.productId===productId&&row.locationId==='WH').avgCost,75);
  current=await owner.action('transfer.create',{branchId:'B1',submit:true,lines:[{productId,qty:1,unit:'Carton (12)'}]},current.revision);
  const id=current.result.id;
  current=await owner.action('document.approve',{id,override:true,reason:'PostgreSQL shipment verification'},current.revision);
  current=await owner.action('document.dispatch',{id},current.revision);
  const received=await branch.action('document.receive',{id,lines:[{productId,receivedQty:12,damagedQty:0}]},current.revision);
  assert.equal(received.state.stock.length,1);assert.equal(received.state.stock[0].locationId,'B1');assert.equal(received.state.stock[0].qty,12);
  assert.equal(received.state.stock[0].avgCost,undefined);assert.equal(received.state.documents.find(row=>row.id===id).status,'Completed');
  assert.equal(await db.prepare('SELECT COUNT(*) AS count FROM users').first('count'),2);
});
