import {readFileSync} from 'node:fs';
import {getDatabase} from '../lib/postgres.mjs';
import {initializeWorkspace} from '../lib/bootstrap.mjs';
import {ensureOwnerAccess} from '../lib/access.mjs';

try{
  const db=getDatabase();
  if(!db)throw new Error('DATABASE_URL is required; connect the HSC resource first.');
  const schema=readFileSync(new URL('../postgres/schema.sql',import.meta.url),'utf8');
  const statements=schema.split(';').map(sql=>sql.trim()).filter(Boolean);
  await db.batch(statements.map(sql=>db.prepare(sql)));
  await initializeWorkspace(db);await ensureOwnerAccess(db);
  const record=await db.prepare("SELECT data,revision FROM application WHERE id='main'").first();
  const state=JSON.parse(record.data);
  const users=await db.prepare('SELECT COUNT(*) AS count FROM users').first();
  console.log(JSON.stringify({resource:'HSC',schema:'ready',revision:record.revision,users:users.count,locations:state.locations.map(({id,name})=>({id,name})),products:state.products.length,stock:state.stock.length,documents:state.documents.length}));
}catch(error){
  console.error('HSC database setup failed. '+(error.message==='DATABASE_URL is required; connect the HSC resource first.'?error.message:'Check the connected database and server configuration.'));
  process.exitCode=1;
}
