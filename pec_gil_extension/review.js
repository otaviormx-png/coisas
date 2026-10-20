let batch = null, batches = [], collapsed = new Set(), saving = Promise.resolve();
const $ = id => document.getElementById(id);
const esc = value => String(value || '').replace(/[&<>"']/g,c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dateKey = value => String(value || '').split('/').reverse().join('');
function duplicates() {
  const counts = new Map();
  for (const r of batch?.records || []) if (!r.gilExcluded) counts.set(GilRules.duplicateKey(r),(counts.get(GilRules.duplicateKey(r)) || 0)+1);
  return counts;
}
function visible() {
  const count=duplicates();
  return (batch?.records || []).filter(r => (!$('day').value || r.attendanceDate === $('day').value) &&
    ($('status').value === 'all' || ($('status').value === 'pending' && GilRules.missing(r).length) ||
     ($('status').value === 'duplicate' && count.get(GilRules.duplicateKey(r)) > 1) ||
     ($('status').value === 'excluded' && r.gilExcluded) || ($('status').value === 'selected' && r.gilSelected && !r.gilExcluded)));
}
function render() {
  if (!batch) { $('rows').innerHTML='';$('summary').textContent='Nenhum lote coletado. Abra o PEC e use “Coletar do PEC”.';return; }
  const progress=batch.enrichmentProgress || {};
  const busy=batch.enrichmentStatus==='processando';
  $('progress').textContent=busy ? `Coletando: ${progress.done || 0}/${progress.total || batch.records.length} — ${progress.phase || ''} ${progress.patient || ''}` : batch.enrichmentStatus==='erro' ? `Coleta interrompida: ${progress.patient || 'Confira as pendências.'}` : 'Coleta encerrada. Confira os dados e selecione os atendimentos realizados.';
  $('export').disabled=busy;$('retry').disabled=busy;
  $('summary').textContent=`${batch.records.length} registros | ${batch.records.filter(r=>r.gilSelected&&!r.gilExcluded).length} selecionados | ${batch.records.filter(r=>!r.gilExcluded&&GilRules.missing(r).length).length} com dados pendentes | Nenhum atendimento gravado no GIL.`;
  const groups=new Map();
  for(const r of visible().sort((a,b)=>dateKey(a.attendanceDate).localeCompare(dateKey(b.attendanceDate)) || String(a.attendanceTime).localeCompare(String(b.attendanceTime)))) {
    if(!groups.has(r.attendanceDate))groups.set(r.attendanceDate,[]);groups.get(r.attendanceDate).push(r);
  }
  const count=duplicates();let html='';
  for(const [day, records] of groups) {
    const selectable=records.filter(r=>!r.gilExcluded && !GilRules.missing(r).length);
    const checked=selectable.length>0 && selectable.every(r=>r.gilSelected);
    html+=`<tr class="day"><td><input type="checkbox" data-day-select="${esc(day)}" ${checked?'checked':''} ${!selectable.length?'disabled':''} aria-label="Selecionar dia ${esc(day)}"></td><td colspan="5" data-day-collapse="${esc(day)}">${collapsed.has(day)?'▶':'▼'} ${esc(day)} — ${records.length} registros</td></tr>`;
    if(collapsed.has(day))continue;
    for(const r of records) {
      const missing=GilRules.missing(r), key=esc(GilRules.recordKey(r));
      html+=`<tr class="${r.gilExcluded?'gray':missing.length?'pending':''}"><td><input type="checkbox" data-pick="${key}" ${r.gilSelected&&!r.gilExcluded?'checked':''} ${r.gilExcluded||missing.length?'disabled':''} aria-label="Selecionar ${esc(r.patientName)}"></td><td>${esc(r.attendanceDate)}<div class="sub">${esc(r.attendanceTime)}</div></td><td>${esc(r.patientName)}<div class="sub">Nascimento: ${esc(r.birthDate)||'pendente'} | CPF: ${esc(r.cpf)||'—'} | CNS: ${esc(r.cns)||'—'}</div><div class="sub">${esc(r.registrationError)}</div></td><td>${esc(r.attendanceStatus)}</td><td>${r.gilExcluded?'Excluído':missing.length?`Pendente: ${esc(missing.join(', '))}`:'Dados de identificação disponíveis'}<div class="sub">0301010072 • Z000 • Natureza 3</div>${count.get(GilRules.duplicateKey(r))>1?'<div class="danger">Possível duplicado no mesmo dia</div>':''}</td><td class="actions"><button data-exclude="${key}">${r.gilExcluded?'Reincluir':'Excluir'}</button></td></tr>`;
    }
  }
  $('rows').innerHTML=html;
}
function persist() {
  const id=batch.id, choices=new Map(batch.records.map(r=>[GilRules.recordKey(r), {gilSelected:Boolean(r.gilSelected),gilExcluded:Boolean(r.gilExcluded)}]));
  saving=saving.then(async()=>{
    const stored=await chrome.storage.local.get({pecGilBatches:[]});
    const updated=stored.pecGilBatches.map(b=>b.id===id?{...b,records:b.records.map(r=>({...r,...choices.get(GilRules.recordKey(r))}))}:b);
    await chrome.storage.local.set({pecGilBatches:updated});
  }).catch(error=>{$('feedback').textContent=`Não foi possível salvar: ${error.message}`;});
  return saving;
}
async function load() {
  const stored=await chrome.storage.local.get({pecGilBatches:[],pecGilCurrentBatch:''});
  const previous=batch?.id;batches=stored.pecGilBatches;
  batch=batches.find(b=>b.id===(previous||stored.pecGilCurrentBatch)) || batches[0] || null;
  $('batch').innerHTML=batches.map(b=>`<option value="${esc(b.id)}">${esc(b.filters?.period)} — Raul — ${b.records.length} registros</option>`).join('');
  if(batch)$('batch').value=batch.id;
  const chosen=$('day').value;
  const days=[...new Set((batch?.records||[]).map(r=>r.attendanceDate))].sort((a,b)=>dateKey(a).localeCompare(dateKey(b)));
  $('day').innerHTML='<option value="">Todos os dias</option>'+days.map(d=>`<option>${esc(d)}</option>`).join('');
  $('day').value=days.includes(chosen)?chosen:'';render();
}
$('rows').addEventListener('click',event=>{
  if(!batch)return;
  const target=event.target;
  if(target.dataset.dayCollapse){const day=target.dataset.dayCollapse;collapsed.has(day)?collapsed.delete(day):collapsed.add(day);render();return;}
  if(target.dataset.daySelect){for(const r of visible())if(r.attendanceDate===target.dataset.daySelect&&!r.gilExcluded&&!GilRules.missing(r).length)r.gilSelected=target.checked;}
  else if(target.dataset.pick){const r=batch.records.find(r=>GilRules.recordKey(r)===target.dataset.pick);if(r)r.gilSelected=target.checked;}
  else if(target.dataset.exclude){const r=batch.records.find(r=>GilRules.recordKey(r)===target.dataset.exclude);if(r){r.gilExcluded=!r.gilExcluded;r.gilSelected=false;}}
  else return;
  persist();render();
});
for(const id of ['day','status'])$(id).addEventListener('change',render);
$('batch').addEventListener('change',async()=>{await saving;batch=batches.find(b=>b.id===$('batch').value);await chrome.storage.local.set({pecGilCurrentBatch:batch.id});collapsed.clear();await load();});
$('select').addEventListener('click',()=>{for(const r of visible())if(!r.gilExcluded&&!GilRules.missing(r).length)r.gilSelected=true;persist();render();});
$('clear').addEventListener('click',()=>{for(const r of visible())r.gilSelected=false;persist();render();});
$('retry').addEventListener('click',async()=>{
  if(!batch)return;
  try {
    await saving;
    const records=batch.records.filter(r=>!r.gilExcluded&&GilRules.missing(r).length);
    if(!records.length)throw Error('Não há dados de identificação pendentes.');
    batch.enrichmentStatus='processando';
    const stored=await chrome.storage.local.get({pecGilBatches:[]});
    await chrome.storage.local.set({pecGilBatches:stored.pecGilBatches.map(b=>b.id===batch.id?{...b,enrichmentStatus:'processando'}:b)});
    chrome.runtime.sendMessage({type:'PEC_GIL_RETRY_RECORDS',records,batchId:batch.id,filters:batch.filters,visible:true}).then(response=>{
      if(!response?.ok)throw Error(response?.error||'Não foi possível concluir a busca.');
    }).catch(async error=>{
      $('feedback').textContent=error.message;
      const current=await chrome.storage.local.get({pecGilBatches:[]});
      await chrome.storage.local.set({pecGilBatches:current.pecGilBatches.map(b=>b.id===batch.id?{...b,enrichmentStatus:'erro',enrichmentProgress:{patient:error.message}}:b)});
    });render();
  } catch(error){$('feedback').textContent=error.message;}
});
$('export').addEventListener('click',async()=>{
  try {
    if(!batch)throw Error('Nenhum lote coletado.');
    await saving;
    const data=GilRules.exportPayload(batch);
    const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));
    try{await chrome.downloads.download({url,filename:`PEC_GIL_RAUL_${new Date().toISOString().replace(/[:.]/g,'-')}.json`,saveAs:true});}
    finally{setTimeout(()=>URL.revokeObjectURL(url),60000);}
    $('feedback').textContent=`JSON gerado com ${data.records.length} atendimentos. Importe no programa local para conferir o GIL.`;
  }catch(error){$('feedback').textContent=error.message;}
});
chrome.storage.onChanged.addListener((changes,area)=>{if(area==='local'&&changes.pecGilBatches)load().catch(error=>{$('feedback').textContent=error.message;});});
load().catch(error=>{$('feedback').textContent=error.message;});
