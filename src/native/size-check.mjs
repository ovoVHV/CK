// Use the installed platform's size recipe and regexes, including menu-derived
// partition/RAM limits. A successful linker alone does not prove the app fits.
export function checkSize(text, policy) {
  const total = expression => {
    let count=0,sum=0;
    for(const match of text.matchAll(new RegExp(expression,'gm'))){
      const value=Number(match[1]);if(!Number.isSafeInteger(value)||value<0)throw Error('Invalid size recipe output');
      count++;sum+=value;
    }
    if(!count||!Number.isSafeInteger(sum))throw Error('Size recipe did not report required sections');
    return sum;
  };
  const flash=total(policy.flashRegex),ram=total(policy.ramRegex);
  for(const [name,used,limit]of [['program',flash,policy.flashLimit],['RAM',ram,policy.ramLimit]]){
    if(!Number.isSafeInteger(limit)||limit<=0)throw Error('Invalid '+name+' size limit');
    if(used>limit)throw Error(`Firmware ${name} size ${used} exceeds selected configuration limit ${limit}`);
  }
  return {flash,ram,flashLimit:policy.flashLimit,ramLimit:policy.ramLimit};
}
