const fs=require('node:fs/promises'); const path=require('node:path');
async function atomicWrite(file, content, mode=0o600) {
  const dir=path.dirname(file); await fs.mkdir(dir,{recursive:true}); const tmp=path.join(dir,`.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try { await fs.writeFile(tmp,content,{mode,flag:'wx'}); await fs.rename(tmp,file); } catch(e) { await fs.rm(tmp,{force:true}).catch(()=>{}); throw e; }
}
module.exports={atomicWrite};
