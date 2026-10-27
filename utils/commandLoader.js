const fs = require('node:fs'); const path = require('node:path');
function loadCommands(dir, logger=console) {
  const safeDir = path.resolve(dir); const commands = new Map(); const errors=[];
  fs.mkdirSync(safeDir,{recursive:true});
  for (const entry of fs.readdirSync(safeDir,{withFileTypes:true})) {
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.startsWith('.')) continue;
    const file = path.resolve(safeDir, entry.name);
    if (path.dirname(file)!==safeDir) { errors.push({file:entry.name,error:'Invalid path'}); continue; }
    try {
      const resolved=require.resolve(file); delete require.cache[resolved]; const cmd=require(file);
      if (!cmd || typeof cmd.name!=='string' || !/^[\p{L}\p{N}_-]{1,32}$/u.test(cmd.name) || typeof cmd.execute!=='function' || !Array.isArray(cmd.aliases || [])) throw new Error('Invalid command schema');
      const names=[cmd.name,...(cmd.aliases||[])].map(x=>String(x).toLowerCase());
      if (new Set(names).size!==names.length || names.some(n=>commands.has(n))) throw new Error('Duplicate command name or alias');
      const normalized={...cmd, name:cmd.name.toLowerCase(), aliases:(cmd.aliases||[]).map(x=>String(x).toLowerCase()), file:entry.name};
      for(const n of names) commands.set(n,normalized);
    } catch(err) { errors.push({file:entry.name,error:err.message}); logger.error?.('COMMAND_LOAD_FAILED',{file:entry.name,error:err.message}); }
  }
  return { commands, errors, unique:[...new Set(commands.values())] };
}
module.exports={loadCommands};
