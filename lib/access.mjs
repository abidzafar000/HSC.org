import {normalizePermissions,rolePermissions} from './permissions.mjs';
const encoder=new TextEncoder();
const hex=bytes=>Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
export const randomToken=()=>hex(crypto.getRandomValues(new Uint8Array(32)));
export const digest=async token=>hex(await crypto.subtle.digest('SHA-256',encoder.encode(token)));
export const ACCESS_ROLES=['superadmin','admin','warehouse','purchasing','branch','viewer'];
export async function hashPassword(password,salt=randomToken()) {
  const key=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:encoder.encode(salt),iterations:100000},key,256);
  return `${salt}:${hex(bits)}`;
}
export function safeEqual(a,b){if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;}
export function publicUser(u){return {id:u.id,name:u.name,email:u.email,role:u.role,branchId:u.branchId??u.branch_id??null,active:u.active!==0&&u.active!==false,permissions:normalizePermissions(u.role,u.permissions)};}
export async function listUsers(db){const result=await db.prepare('SELECT id,name,email,role,branch_id,active,permissions FROM users ORDER BY name').all();return result.results.map(publicUser);}
export function problem(message,status=400){const error=new Error(message);error.status=status;return error;}
const requireAccess=(condition,message,status=400)=>{if(!condition)throw problem(message,status);};
const now=()=>new Date().toISOString();
function accountAudit(state,user,action,target,detail){state.audit.unshift({id:`AUD_${crypto.randomUUID()}`,at:now(),userId:user.id,userName:user.name,role:user.role,action,entityId:target.id,reference:target.email,branchId:null,detail});}
const commitGuard='EXISTS (SELECT 1 FROM application WHERE id=\'main\' AND revision=? AND json_extract(data,\'$.lastAccessMutation\')=?)';

/** Keep account changes and their business audit record in the same D1 transaction. */
async function commitAccess(db,record,state,commands){
  const operation=crypto.randomUUID();
  state.lastAccessMutation=operation;
  const revision=record.revision+1;
  const results=await db.batch([
    db.prepare("UPDATE application SET data=?,revision=revision+1 WHERE id='main' AND revision=?").bind(JSON.stringify(state),record.revision),
    ...commands(commitGuard,[revision,operation]),
  ]);
  if(results[0].meta.changes!==1)throw problem('Another user updated these records. Refresh and try again.',409);
  return revision;
}

export async function ensureOwnerAccess(db){
  for(let attempt=0;attempt<3;attempt++){
    const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
    const state=JSON.parse(record.data);
    if(state.accessSchemaVersion>=1)return;
    const owner=await db.prepare("SELECT * FROM users WHERE id='admin' AND email='admin@hamsun.local'").first();
    requireAccess(owner,'The owner account is missing. Contact the application owner.',503);
    state.accessSchemaVersion=1;
    accountAudit(state,{id:'system',name:'System',role:'superadmin'},'access.owner-superadmin',owner,'Existing owner account granted Super Admin rights. Password and session retained.');
    try{
      await commitAccess(db,record,state,(guard,args)=>[db.prepare(`UPDATE users SET role='superadmin',active=1 WHERE id=? AND ${guard}`).bind(owner.id,...args)]);
      return;
    }catch(error){if(error.status!==409)throw error;}
  }
  throw problem('Records changed during access setup. Refresh and try again.',409);
}

export async function saveAccount(db,actor,payload,expectedRevision,sessionHash){
  const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  const current=await db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id=? AND users.active=1 AND sessions.token=? AND sessions.expires>?').bind(actor.id,sessionHash,Date.now()).first();
  requireAccess(current?.role==='superadmin','Only an active Super Admin session can manage users and access.',403);
  actor=publicUser(current);
  requireAccess(expectedRevision===undefined||record.revision===expectedRevision,'Another user updated these records. Refresh and try again.',409);
  const state=JSON.parse(record.data);
  const existing=payload.id?await db.prepare('SELECT * FROM users WHERE id=?').bind(String(payload.id)).first():null;
  requireAccess(!payload.id||existing,'User account does not exist.');
  const name=String(payload.name??existing?.name??'').trim().slice(0,100);
  const email=String(payload.email??existing?.email??'').trim().toLowerCase();
  const role=payload.role??existing?.role??'viewer';
  requireAccess(payload.active===undefined||typeof payload.active==='boolean','Active status must be true or false.');
  const active=payload.active===undefined?(existing?existing.active!==0:true):payload.active===true;
  const branchId=role==='branch'?String(payload.branchId??existing?.branch_id??''):null;
  requireAccess(name&&email.length<=160&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),'Enter a name and valid email address.');
  requireAccess(ACCESS_ROLES.includes(role),'Choose a supported role.');
  requireAccess(payload.permissions===undefined||payload.permissions===null||Array.isArray(payload.permissions),'Permissions must be a list of allowed modules.');
  if(Array.isArray(payload.permissions))requireAccess(payload.permissions.every(key=>typeof key==='string'&&rolePermissions(role).includes(key)),'Choose only modules permitted for this role.');
  const permissionsValue=role==='superadmin'?null:payload.permissions===undefined?(existing?.role===role?existing.permissions??null:null):payload.permissions===null?null:JSON.stringify(normalizePermissions(role,payload.permissions));
  const permissions=normalizePermissions(role,permissionsValue);
  requireAccess(role!=='branch'||state.locations.some(l=>l.type==='branch'&&l.id===branchId),'Select the branch this user may access.');
  const duplicate=await db.prepare('SELECT id FROM users WHERE email=?').bind(email).first();
  requireAccess(!duplicate||duplicate.id===existing?.id,'An account with that email already exists.');
  requireAccess(existing?.id!==actor.id||(active&&role==='superadmin'),'You cannot deactivate or remove your own Super Admin access.');
  if(existing?.role==='superadmin'&&existing.active!==0&&(!active||role!=='superadmin')){
    const others=await db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='superadmin' AND active=1 AND id<>?").bind(existing.id).first();
    requireAccess(others.count>0,'At least one active Super Admin is required.');
  }
  const password=payload.password;
  requireAccess(password===undefined||typeof password==='string','Enter the password as text.');
  const changingPassword=typeof password==='string'&&password.length>0;
  requireAccess(existing||changingPassword,'Set an initial password for the new user.');
  if(changingPassword){
    requireAccess(password.length>=10&&password.length<=256,'Use a password of 10 to 256 characters.');
    requireAccess(existing?.id!==actor.id,'Use Security to change your own password.');
  }
  const credential=changingPassword?await hashPassword(password):existing.password;
  const target={id:existing?.id??`USER_${crypto.randomUUID()}`,name,email,role,branchId,active,permissions};
  const changedPermissions=!!existing&&JSON.stringify(normalizePermissions(existing.role,existing.permissions))!==JSON.stringify(permissions);
  const changedScope=existing&&(existing.role!==role||existing.branch_id!==branchId||existing.active!==(active?1:0)||changedPermissions);
  const detail=existing?`Updated ${email}. Role: ${existing.role} → ${role}; branch: ${existing.branch_id??'all permitted locations'} → ${branchId??'all permitted locations'}; active: ${active}; modules: ${permissions.join(', ')||'none'}.${changedPermissions?' Module permissions changed; sessions revoked.':''}${changingPassword?' Password reset; sessions revoked.':''}`:`Created ${email}; role ${role}${branchId?`; branch ${branchId}`:''}; active ${active}; modules: ${permissions.join(', ')||'none'}.`;
  accountAudit(state,actor,existing?'user.update':'user.create',target,detail);
  const revision=await commitAccess(db,record,state,(guard,args)=>[
    existing?db.prepare(`UPDATE users SET name=?,email=?,role=?,branch_id=?,active=?,password=?,permissions=? WHERE id=? AND ${guard}`).bind(name,email,role,branchId,active?1:0,credential,permissionsValue,target.id,...args):db.prepare(`INSERT INTO users(id,name,email,role,branch_id,active,password,permissions) SELECT ?,?,?,?,?,?,?,? WHERE ${guard}`).bind(target.id,name,email,role,branchId,active?1:0,credential,permissionsValue,...args),
    ...(changedScope||changingPassword?[db.prepare(`DELETE FROM sessions WHERE user_id=? AND ${guard}`).bind(target.id,...args)]:[]),
  ]);
  return {state,revision,result:target};
}

export async function changeOwnPassword(db,user,payload,currentSessionHash){
  requireAccess(typeof payload.currentPassword==='string'&&typeof payload.newPassword==='string','Enter your current and new passwords.');
  requireAccess(payload.currentPassword.length<=256,'Current password is too long.');
  requireAccess(payload.newPassword.length>=10&&payload.newPassword.length<=256,'Use a password of 10 to 256 characters.');
  const record=await db.prepare("SELECT * FROM application WHERE id='main'").first();
  const found=await db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id=? AND users.active=1 AND sessions.token=? AND sessions.expires>?').bind(user.id,currentSessionHash,Date.now()).first();
  requireAccess(found,'Your account is not active.',401);
  const check=await hashPassword(payload.currentPassword,found.password.split(':')[0]);
  requireAccess(safeEqual(check,found.password),'Current password is incorrect.',403);
  requireAccess(payload.currentPassword!==payload.newPassword,'Choose a new password different from the current password.');
  const password=await hashPassword(payload.newPassword);
  const state=JSON.parse(record.data);
  accountAudit(state,user,'user.password-change',user,'Password changed by the account holder. Other sessions revoked.');
  const revision=await commitAccess(db,record,state,(guard,args)=>[
    db.prepare(`UPDATE users SET password=? WHERE id=? AND ${guard}`).bind(password,user.id,...args),
    db.prepare(`DELETE FROM sessions WHERE user_id=? AND token<>? AND ${guard}`).bind(user.id,currentSessionHash,...args),
  ]);
  return {state,revision};
}
