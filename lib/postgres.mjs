import {neon} from '@neondatabase/serverless';

/** Translate the small SQLite dialect used by the shared API into PostgreSQL. */
export function translateSql(source){
  if(typeof source!=='string'||!source.trim())throw new TypeError('A SQL statement is required.');
  const ignore=/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i.test(source);
  let sql=source.replace(/^\s*INSERT\s+OR\s+IGNORE\s+INTO\b/i,'INSERT INTO')
    .replace(/json_extract\s*\(\s*data\s*,\s*'\$\.lastAccessMutation'\s*\)/gi,"(data::jsonb ->> 'lastAccessMutation')");
  if(ignore){
    const semicolon=/;\s*$/.test(sql);
    sql=sql.replace(/;\s*$/,'').trimEnd()+' ON CONFLICT DO NOTHING'+(semicolon?';':'');
  }
  if(/^\s*INSERT\s+INTO\s+login_limits\b/i.test(sql)){
    sql=sql.replace(/\bWHEN\s+until\s*</gi,'WHEN login_limits.until<')
      .replace(/\bELSE\s+attempts\s*\+\s*1\b/gi,'ELSE login_limits.attempts+1');
  }

  let result='',mode='',dollar='',parameter=0,blockDepth=0;
  for(let index=0;index<sql.length;index++){
    const character=sql[index],next=sql[index+1];
    if(mode==='single'||mode==='double'){
      result+=character;
      const quote=mode==='single'?"'":'"';
      if(character===quote){if(next===quote){result+=next;index++;}else mode='';}
      continue;
    }
    if(mode==='identifier'){
      if(character==='`'){
        if(next==='`'){result+='`';index++;}else{result+='"';mode='';}
      }else result+=character==='"'?'""':character;
      continue;
    }
    if(mode==='line'){result+=character;if(character==='\n')mode='';continue;}
    if(mode==='block'){
      result+=character;
      if(character==='/'&&next==='*'){result+=next;index++;blockDepth++;}
      else if(character==='*'&&next==='/'){result+=next;index++;if(--blockDepth===0)mode='';}
      continue;
    }
    if(mode==='dollar'){
      if(sql.startsWith(dollar,index)){result+=dollar;index+=dollar.length-1;mode='';}else result+=character;
      continue;
    }
    if(character==="'"){mode='single';result+=character;}
    else if(character==='"'){mode='double';result+=character;}
    else if(character==='`'){mode='identifier';result+='"';}
    else if(character==='-'&&next==='-'){mode='line';result+='--';index++;}
    else if(character==='/'&&next==='*'){mode='block';blockDepth=1;result+='/*';index++;}
    else if(character==='$'&&(dollar=sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/)?.[0])){
      mode='dollar';result+=dollar;index+=dollar.length-1;
    }else if(character==='?')result+=`$${++parameter}`;
    else result+=character;
  }
  return result;
}

function normalizedResult(raw){
  if(!raw||!Array.isArray(raw.rows))throw new Error('HSC database returned an unexpected response.');
  const rows=raw.rows.map(row=>{
    const result={...row};
    if(typeof result.count==='bigint'||(typeof result.count==='string'&&/^\d+$/.test(result.count))){
      const count=Number(result.count);if(Number.isSafeInteger(count))result.count=count;
    }
    return result;
  });
  return {rows,meta:{changes:raw.command==='SELECT'?0:Number(raw.rowCount??0)}};
}

/** D1-shaped access keeps the tested domain and account API shared across hosts. */
export function createDatabase(client){
  if(typeof client?.query!=='function'||typeof client?.transaction!=='function')throw new TypeError('A PostgreSQL query client is required.');
  const statements=new WeakMap();
  function statement(sql,values=[]){
    const parameters=Object.freeze([...values]);
    const execute=async()=>normalizedResult(await client.query(sql,[...parameters]));
    const prepared=Object.freeze({
      bind(...bound){return statement(sql,bound);},
      async first(column){const row=(await execute()).rows[0]??null;return column===undefined?row:row?.[column]??null;},
      async all(){const result=await execute();return {success:true,results:result.rows,meta:result.meta};},
      async run(){return {success:true,meta:(await execute()).meta};},
    });
    statements.set(prepared,{sql,parameters});return prepared;
  }
  return Object.freeze({
    prepare(sql){return statement(translateSql(sql));},
    async batch(items){
      if(!Array.isArray(items))throw new TypeError('A statement array is required.');
      if(items.length===0)return [];
      const selected=items.map(item=>{const query=statements.get(item);if(!query)throw new TypeError('Batch statements must belong to this database.');return query;});
      // Neon query objects are lazy; the transaction sends all statements once.
      // Sequential transaction execution lets each CAS guard observe its update.
      const results=await client.transaction(selected.map(({sql,parameters})=>client.query(sql,[...parameters])),{fullResults:true,arrayMode:false});
      return results.map(raw=>({success:true,meta:normalizedResult(raw).meta}));
    },
  });
}

let cachedConnection,cachedDatabase;
export function getDatabase(connectionString=process.env.DATABASE_URL){
  if(!connectionString)return null;
  if(connectionString===cachedConnection)return cachedDatabase;
  let client;
  try{
    const url=new URL(connectionString);
    if(!['postgres:','postgresql:'].includes(url.protocol)||!url.hostname)throw new Error();
    client=neon(connectionString,{fullResults:true,arrayMode:false});
  }
  catch{throw new Error('HSC database connection configuration is invalid.');}
  cachedDatabase=createDatabase(client);cachedConnection=connectionString;
  return cachedDatabase;
}
