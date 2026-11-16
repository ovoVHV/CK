// CK writes JSON-quoted YAML scalars for user-selected Windows paths. Keep
// parsing intentionally limited to this directory section, never evaluate YAML.
export function cliDirectories(yaml){
 const block=yaml.match(/^directories:\s*\r?\n((?:[ \t].*\r?\n|\s*\r?\n)*)/m)?.[1]||'';
 const values={};
 for(const line of block.split(/\r?\n/)){
  const m=line.match(/^\s+(data|user|downloads):\s*(.+?)\s*$/);if(!m)continue;
  if(m[1] in values)throw Error('Duplicate CLI directory key');
  const value=m[2];
  if(value.startsWith('"'))values[m[1]]=JSON.parse(value);
  else if(value.startsWith("'")){if(!value.endsWith("'"))throw Error('Invalid CLI directory string');values[m[1]]=value.slice(1,-1).replaceAll("''","'");}
  else values[m[1]]=value.replace(/\s+#.*$/,'');
  if(typeof values[m[1]]!=='string'||/[\r\n\0]/.test(values[m[1]]))throw Error('Invalid CLI directory path');
 }
 return values;
}
