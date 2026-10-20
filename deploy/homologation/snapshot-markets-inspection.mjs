// Deliberately mirrors the current guard; does not coerce, omit or accept data.
export function marketsShapeRejection(raw) {
 const kind=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
 const object=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
 if(!object(raw))return null;
 const problem=(path,value,expected,marketIndex)=>({path,actualType:kind(value),expected,...(Number.isSafeInteger(raw.FixtureId)&&raw.FixtureId>0?{fixtureId:raw.FixtureId}:{}),...(marketIndex===undefined?{}:{marketIndex}),...(Array.isArray(value)?{length:value.length}:{})});
 if(raw.Markets===undefined)return null;
 if(!Array.isArray(raw.Markets))return problem('Markets',raw.Markets,'array_or_absent');
 for(let i=0;i<raw.Markets.length;i++){
  const m=raw.Markets[i];
  if(!object(m))return problem(`Markets[${i}]`,m,'object',i);
  if(m.Bets!==undefined&&!Array.isArray(m.Bets))return problem(`Markets[${i}].Bets`,m.Bets,'array_or_absent',i);
 }
 return null;
}
