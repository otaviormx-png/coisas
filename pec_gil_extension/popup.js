const collectButton = document.querySelector('#collect');
const show = text => { document.querySelector('#message').textContent = text; };
async function collectFromTab(tabId, type, file) {
  try { return await chrome.tabs.sendMessage(tabId, { type }); }
  catch (error) {
    if (!/Receiving end does not exist|Could not establish connection/.test(String(error.message))) throw error;
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return chrome.tabs.sendMessage(tabId, { type });
  }
}
collectButton.addEventListener('click', async () => {
  collectButton.disabled = true;
  try {
    const stored = await chrome.storage.local.get({ pecGilBatches: [] });
    if (stored.pecGilBatches.some(b => b.enrichmentStatus === 'processando')) throw Error('Uma coleta ainda está em andamento. Abra a revisão para acompanhar.');
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const agenda = /^https:\/\/esus\.saude\.niteroi\.rj\.gov\.br\/agenda\//.test(tab?.url || '');
    const list = /^https:\/\/esus\.saude\.niteroi\.rj\.gov\.br\/lista-atendimento/.test(tab?.url || '');
    if (!agenda && !list) throw Error('Abra a Lista de atendimentos filtrada para o Raul ou a Agenda dele.');
    show('Lendo as páginas do PEC…');
    const response = await collectFromTab(tab.id, agenda ? 'PEC_GIL_COLLECT_AGENDA' : 'PEC_GIL_COLLECT', agenda ? 'agenda.js' : 'content.js');
    if (!response?.ok) throw Error(response?.error || 'Não foi possível coletar.');
    const batch = { ...GilRules.normalizeBatch(response.batch), id: crypto.randomUUID(), enrichmentStatus: 'processando' };
    batch.records = batch.records.map(r => ({ ...r, gilSelected: false, gilExcluded: Boolean(r.excluded) || /NAO COMPARECEU|ATENDIMENTO NAO REALIZADO/.test(GilRules.norm(r.attendanceStatus)) }));
    await chrome.storage.local.set({ pecGilBatches: [batch, ...stored.pecGilBatches], pecGilCurrentBatch: batch.id });
    // O worker continua após fechar o popup e abre a revisão ao concluir.
    chrome.runtime.sendMessage({ type: 'PEC_GIL_COMPLETE_FROM_LIST', records: batch.records, filters: batch.filters, batchId: batch.id, visible: true }).catch(async error => {
      const latest = await chrome.storage.local.get({ pecGilBatches: [] });
      const current = latest.pecGilBatches.find(b => b.id === batch.id);
      if (current?.enrichmentStatus === 'processando') await chrome.storage.local.set({ pecGilBatches: latest.pecGilBatches.map(b => b.id === batch.id ? { ...b, enrichmentStatus: 'erro', enrichmentProgress: { patient: error.message } } : b) });
    });
    show(`Coleta iniciada: ${batch.records.length} registros do Raul. A revisão abrirá ao terminar.`);
  } catch (error) { show(error.message || String(error)); }
  finally { collectButton.disabled = false; }
});
document.querySelector('#review').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('review.html') }));
