import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createDatabase} from '../lib/postgres.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {handleApi} from '../lib/api.mjs';

// Disposable identities only. This fixture never opens a configured cloud connection.
const initialPassword='DisposableAccountFixture!827';
const nextPassword='DisposableAccountChanged!827';
const branchPassword='DisposableBranchAccount!827';

async function fixture(t){
  const pg=new PGlite();t.after(()=>pg.close());
  await pg.exec(readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8'));
  const full=result=>({rows:result.rows,rowCount:result.affectedRows??result.rows.length});
  const db=createDatabase({
    query(sql,parameters){return {sql,parameters,then(resolve,reject){return pg.query(sql,[...parameters]).then(full).then(resolve,reject);}};},
    transaction(queries){return pg.transaction(async tx=>{const results=[];for(const query of queries)results.push(full(await tx.query(query.sql,[...query.parameters])));return results;});},
  });
  await initializeWorkspace(db,{initialAdminPassword:initialPassword});
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
        return {status:response.status,body:await response.json(),disposition:response.headers.get('content-disposition')};
      },
      async action(action,payload){return this.call('action',{action,payload,revision:(await stored()).revision});},
      async saveUser(payload){const result=await this.action('user.save',payload);assert.equal(result.status,200,JSON.stringify(result.body));return result.body;},
    };
  }
  return {db,client,stored};
}

test('account password, backup, scoped access and owner protection workflows persist atomically in PostgreSQL',async t=>{
  const {db,client,stored}=await fixture(t);
  const owner=client(),otherOwnerSession=client(),branch=client(),probe=client();
  for(const connection of [owner,otherOwnerSession])assert.equal((await connection.call('login',{email:'admin@hamsun.local',password:initialPassword})).status,200);

  const beforePassword=await stored();
  const ownerCredential=await db.prepare('SELECT password FROM users WHERE id=?').bind('admin').first('password');
  for(const [payload,status] of [
    [{currentPassword:'Wrong current password',newPassword:nextPassword},403],
    [{currentPassword:initialPassword,newPassword:'short'},400],
    [{currentPassword:initialPassword,newPassword:42},400],
    [{currentPassword:initialPassword,newPassword:initialPassword},400],
  ]){
    const result=await owner.call('password',payload);
    assert.equal(result.status,status,JSON.stringify(result.body));
    assert.deepEqual(await stored(),beforePassword,'An invalid password change must not write audit or revision');
    assert.equal(await db.prepare('SELECT password FROM users WHERE id=?').bind('admin').first('password'),ownerCredential);
  }
  assert.equal((await otherOwnerSession.call('state')).status,200);
  const changed=await owner.call('password',{currentPassword:initialPassword,newPassword:nextPassword});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  assert.equal(changed.body.revision,beforePassword.revision+1);
  assert.equal((await owner.call('state')).status,200,'The current password-change session remains signed in');
  assert.equal((await otherOwnerSession.call('state')).status,401,'Other sessions are revoked');
  assert.equal((await probe.call('login',{email:'admin@hamsun.local',password:initialPassword})).status,401);
  assert.equal((await probe.call('login',{email:'admin@hamsun.local',password:nextPassword})).status,200);
  assert.notEqual(await db.prepare('SELECT password FROM users WHERE id=?').bind('admin').first('password'),ownerCredential);
  assert.equal(changed.body.state.audit.filter(entry=>entry.action==='user.password-change').length,1);

  let backup=await owner.call('backup');
  assert.equal(backup.status,200);assert.equal(backup.body.format,'hamsun-phase1-backup-v1');
  assert.match(backup.disposition,/attachment; filename="hamsun-phase1-backup.json"/);
  assert.ok(backup.body.users.every(user=>!Object.hasOwn(user,'password')));
  assert.ok(!JSON.stringify(backup.body).includes(initialPassword));assert.ok(!JSON.stringify(backup.body).includes(nextPassword));

  let saved=await owner.saveUser({name:'Account workflow branch',email:'account-branch@example.test',role:'branch',branchId:'B1',password:branchPassword,permissions:['dispatches','returns','demands'],active:true});
  const branchId=saved.result.id;
  assert.equal(saved.result.branchId,'B1');assert.equal(saved.result.active,true);
  assert.ok(saved.state.audit.some(entry=>entry.action==='user.create'&&entry.entityId===branchId));
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:branchPassword})).status,200);
  assert.equal((await branch.call('backup')).status,403);
  assert.equal((await branch.action('user.save',{id:branchId,role:'superadmin'})).status,403);
  const beforeInvalidUser=await stored();
  for(const payload of [
    {name:'Duplicate',email:'account-branch@example.test',role:'viewer',password:branchPassword},
    {name:'Invalid branch',email:'invalid-branch@example.test',role:'branch',branchId:'B99',password:branchPassword},
    {id:branchId,permissions:['users']},
    {id:'admin',active:false},
    {id:'admin',role:'admin'},
    {id:'admin',password:'CannotResetOwnHere!827'},
  ]){
    const result=await owner.action('user.save',payload);
    assert.equal(result.status,400,JSON.stringify(result.body));
    assert.deepEqual(await stored(),beforeInvalidUser,'Invalid user changes cannot leave account audit records');
  }
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='superadmin' AND active=1").first('count'),1);

  saved=await owner.saveUser({id:branchId,permissions:['returns']});
  assert.deepEqual(saved.result.permissions,['returns']);
  assert.equal((await branch.call('state')).status,401);
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:branchPassword})).status,200);
  assert.deepEqual((await branch.call('state')).body.user.permissions,['returns']);
  assert.equal((await branch.action('demand.create',{branchId:'B1',lines:[]})).status,403);
  saved=await owner.saveUser({id:branchId,branchId:'B2'});
  assert.equal(saved.result.branchId,'B2');assert.equal((await branch.call('state')).status,401);
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:branchPassword})).status,200);
  assert.equal((await branch.call('state')).body.user.branchId,'B2');
  saved=await owner.saveUser({id:branchId,active:false});
  assert.equal(saved.result.active,false);assert.equal((await branch.call('state')).status,401);
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:branchPassword})).status,401);
  const resetPassword='DisposableBranchReset!827';
  await owner.saveUser({id:branchId,active:true,password:resetPassword});
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:branchPassword})).status,401);
  assert.equal((await branch.call('login',{email:'account-branch@example.test',password:resetPassword})).status,200);
  saved=await owner.saveUser({id:branchId,password:'DisposableBranchResetAgain!827'});
  assert.equal((await branch.call('state')).status,401,'An administrator password reset also revokes active sessions');
  assert.ok(saved.state.audit.some(entry=>entry.action==='user.update'&&entry.entityId===branchId&&entry.detail.includes('Password reset; sessions revoked.')));

  const second=client();
  saved=await owner.saveUser({name:'Second disposable owner',email:'second-owner@example.test',role:'superadmin',password:initialPassword});
  const secondId=saved.result.id;
  assert.equal((await second.call('login',{email:'second-owner@example.test',password:initialPassword})).status,200);
  await second.saveUser({id:'admin',role:'admin'});
  assert.equal((await owner.call('state')).status,401,'Role changes revoke old Super Admin sessions');
  assert.equal((await owner.call('login',{email:'admin@hamsun.local',password:nextPassword})).status,200);
  assert.equal((await owner.call('backup')).status,403,'An administrator cannot export the owner backup');
  assert.equal((await owner.action('user.save',{id:secondId,active:false})).status,403);
  const beforeLastOwner=await stored();
  assert.equal((await second.action('user.save',{id:secondId,active:false})).status,400);
  assert.deepEqual(await stored(),beforeLastOwner);
  assert.equal(await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='superadmin' AND active=1").first('count'),1);
  backup=await second.call('backup');assert.equal(backup.status,200);
  assert.ok(backup.body.users.every(user=>!Object.hasOwn(user,'password')));
});
