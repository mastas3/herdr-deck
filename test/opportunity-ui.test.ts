import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { test } from 'bun:test';
import { createOpportunityService } from '../src/opportunity-service';

test('Opportunity forms integrate with persistence, economics, provenance and demand gates', async () => {
const source = readFileSync(new URL('../public/js/opportunities.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('// ── Opportunities:'), source.indexOf('// ── end Opportunities'));
const dir = mkdtempSync(join(tmpdir(), 'op-ui-contract-')); const service = createOpportunityService({dir});
const root:any = {innerHTML:'', querySelector:()=>null, querySelectorAll:()=>[]};
const document:any = {activeElement:null}; const errors:string[]=[];
const context:any = {S:{mode:'opportunities'}, document, URL, Intl, Date, Number, String, Set, Map, console, clearTimeout, setTimeout, queueMicrotask, CSS:{escape:(x:any)=>x}, ICON:{plus:'',bulb:''}, $:()=>root, modeHTML:()=>{}, toast:(m:any,bad:any)=>{if(bad)errors.push(m);}, esc:(x:any)=>String(x??'').replace(/[&<>"']/g,(c:string)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)), api:(path:any,body:any)=>service.handle(path,body), FormData:class {rows:any;constructor(form:any){this.rows=form.values;}entries(){return Object.entries(this.rows).flatMap(([k,v])=>Array.isArray(v)?v.map(x=>[k,x]):[[k,v]])[Symbol.iterator]();}[Symbol.iterator](){return this.entries();}get(k:string){return this.rows[k]??null;}getAll(k:string){const v=this.rows[k];return v==null?[]:Array.isArray(v)?v:[v];}}};
root.addEventListener=()=>{};
vm.createContext(context); vm.runInContext(block+`;globalThis.testUI={opportunitiesBody,opportunitySubmit,opportunityEconomicsInput,opportunityEconomicsResult};`,context);
const form=(kind:string,values:any)=>{const error={textContent:'',hidden:true};const status={textContent:''};const button={disabled:false,isConnected:true};return {values,dataset:{opform:kind,dirty:'true'},querySelector:(s:string)=>s.includes('opformerror')?error:s.includes('opformstatus')?status:button,isConnected:true,error,status};};
async function submit(kind:string,values:any){const f=form(kind,values);await context.testUI.opportunitySubmit(f);if(f.error.textContent)throw new Error(kind+': '+f.error.textContent);return context.S.opp.items.find((x:any)=>x.id===context.S.opp.selected);}
try {
 const list:any=await service.handle('/api/opportunities',{});context.S.opp.industries=list.industries;context.S.opp.loaded=true;
 let html=context.testUI.opportunitiesBody();if(!html.includes('Start with a problem worth solving'))throw new Error('empty state absent');
 let item=await submit('create',{title:'A <b>test</b> concept',buyer:'Workshop owner',industry:'manufacturing',mode:'markets',problem:'Manual handoffs cost time',mechanism:'A completion packet'});
 item=await submit('summary',{title:item.title,buyer:item.buyer,industry:item.industry,mode:item.mode,summary:'Summary',problem:item.problem,mechanism:item.mechanism,outcome:'Less admin',unknowns:'Price sensitivity\nReachability',notes:'Local plan'});
 if(item.unknowns.length!==2)throw new Error('unknowns not saved');
 item=await submit('source',{id:'',url:'https://example.org/report',title:'Original report',kind:'customer',access:'opened',excerpt:'Original passage',publishedAt:'2026-01-01',error:'Small sample',attest:'on'});
 if(item.sources[0].publishedAt!==Date.parse('2026-01-01')||item.sources[0].error!=='Small sample')throw new Error('source date or limitation lost');
 const sourceId=item.sources[0].id;
 item=await submit('source',{id:sourceId,url:'https://example.org/report',title:'Original report',kind:'customer',access:'opened',excerpt:'Original passage',publishedAt:'',error:'Date unknown',attest:'on'});
 if(item.sources[0].publishedAt!==null)throw new Error('unknown source date was invented');
 item=await submit('claim',{id:'',text:'Owner reports repeated work',dimension:'problem',status:'observed',supportingSourceIds:[sourceId],opposingSourceIds:[],attest:'on'});
 item=await submit('review',{dimension:'problem',sourceIds:[sourceId],notes:'Specific buyer relevance remains narrow',attest:'on'});
 item=await submit('revenue',{valuePattern:'episodic',buyer:'Workshop owner',frequency:'occasional',newMarket:'on'});
 const econ={model:'subscription',currency:'USD',billingPeriodMonths:'1',activeCustomers:'50',pricePerCustomer:'99',variableCostPerCustomer:'25',fixedMonthlyCost:'300',founderHoursPerMonth:'20',founderHourlyRate:'50',cac:'240',monthlyChurn:'4',newCustomersPerMonth:'2',startupCost:'0',setupFee:'0',onboardingCost:'0',refundRate:'0',paymentFeeRate:'0',paymentFeeFixed:'0',hoursPerCustomer:'0',onboardingHoursPerCustomer:'0',salesHoursPerNewCustomer:'0',availableHoursPerMonth:'80',unitsPerCustomer:''};
 item=await submit('economics',econ);if(Math.abs(item.analysis.steadyState.economicSurplus-1920)>0.0001)throw new Error('economics fixture mismatch');
 item=await submit('financial-evidence',{inputKey:'pricePerCustomer',basis:'observed',observedAt:new Date().toISOString().slice(0,10),note:'Checked offer in a fixture, not realized sales',sourceIds:[sourceId],attest:'on'});
 if(item.economics.pricePerCustomer.basis!=='observed'||item.economics.pricePerCustomer.sourceIds[0]!==sourceId)throw new Error('financial provenance missing');
 const unchanged=context.testUI.opportunityEconomicsInput(form('economics',econ));if(unchanged.pricePerCustomer.basis!=='observed')throw new Error('unchanged observed provenance lost');
 const changed=context.testUI.opportunityEconomicsInput(form('economics',{...econ,pricePerCustomer:'109'}));if(changed.pricePerCustomer.basis!=='assumed')throw new Error('changed price should become assumption');
 item=await submit('experiment',{kind:'buying-signal',hypothesis:'Buyers request trial',segment:'Workshop owner',channel:'Referral',offer:'Trial at 99',minParticipants:'5',minSuccesses:'2',minNetRevenue:'',minRepeatCustomers:'',failureCriteria:'Fewer than 2 requests',budget:'0',currency:'USD',startsAt:'',endsAt:''});
 item=await submit('result',{experimentId:item.experiments[0].id,denominator:'5',successes:'2',payingCustomers:'',revenue:'',refunds:'',repeatCustomers:'',repeatPayments:'',windowDays:'',evidenceReference:'local/test-result',notes:'Test fixture',attest:'on'});
 if(item.stage!=='buying-signal')throw new Error('experiment did not promote');
 for(const section of ['summary','demand','alternatives','economics','revenue','experiments']){context.S.opp.section=section;html=context.testUI.opportunitiesBody();if(html.includes('<b>test</b>'))throw new Error(section+' unescaped title');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);if(new Set(ids).size!==ids.length)throw new Error(section+' duplicate ids: '+ids.filter((v,i)=>ids.indexOf(v)!==i).join(','));}

} finally {clearTimeout(context.S.opp.timer);service.close();rmSync(dir,{recursive:true,force:true});}

});
