const message = document.querySelector("#message");
const collectButton = document.querySelector("#collect");

function show(text, kind = "") {
  message.textContent = text;
  message.className = `message ${kind}`;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function collectFromTab(tabId, type, file) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type });
  } catch (error) {
    const message = String(error?.message || error);
    if (!message.includes("Receiving end does not exist") && !message.includes("Could not establish connection")) {
      throw error;
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: [file] });
    return await chrome.tabs.sendMessage(tabId, { type });
  }
}

async function saveBatch(batch) {
  const stored = await chrome.storage.local.get({ pecBpaBatches: [] });
  const completed = { ...batch, id: crypto.randomUUID() };
  const batches = [completed, ...stored.pecBpaBatches].slice(0, 30);
  await chrome.storage.local.set({ pecBpaBatches: batches, pecBpaCurrentBatch: completed.id });
  return completed;
}

async function refreshSavedBatch(batchId, records) {
  const stored = await chrome.storage.local.get({ pecBpaBatches: [] });
  const batches = stored.pecBpaBatches.map(item => item.id === batchId ? { ...item, records } : item);
  await chrome.storage.local.set({ pecBpaBatches: batches, pecBpaCurrentBatch: batchId });
}

document.querySelector("#collect").addEventListener("click", async () => {
  collectButton.disabled = true;
  show("Lendo os atendimentos…");
  try {
    const tab = await activeTab();
    const isList = tab?.url?.startsWith("https://esus.saude.niteroi.rj.gov.br/lista-atendimento");
    const isAgenda = /^https:\/\/esus\.saude\.niteroi\.rj\.gov\.br\/agenda\//.test(tab?.url || "");
    if (!isList && !isAgenda) {
      throw new Error("Abra a Lista de atendimentos ou uma Agenda do PEC.");
    }
    const response = isAgenda
      ? await collectFromTab(tab.id, "PEC_BPA_COLLECT_AGENDA", "agenda.js")
      : await collectFromTab(tab.id, "PEC_BPA_COLLECT", "content.js");
    if (!response?.ok) throw new Error(response?.error || "Não foi possível ler os atendimentos.");
    if (!response.batch.records.length && !(response.batch.filters?.period && response.batch.filters?.professionals)) {
      throw new Error("Nenhum atendimento reconhecido e nenhum filtro de período/profissional foi encontrado na página.");
    }

    let sourceBatch = response.batch;
    if (isAgenda) {
      const recordsToEnrich = sourceBatch.records.filter(record => !record.excluded);
      show(`Abrindo ${recordsToEnrich.length} cadastro(s) completo(s)…`);
      const enriched = recordsToEnrich.length
        ? await chrome.runtime.sendMessage({ type: "PEC_BPA_ENRICH", records: recordsToEnrich })
        : { ok: true, records: [] };
      if (!enriched?.ok) throw new Error(enriched?.error || "Não foi possível completar os cadastros.");
      const enrichedByKey = new Map((enriched.records || []).map(record => [record.sourceKey, record]));
      sourceBatch = { ...sourceBatch, records: sourceBatch.records.map(record => enrichedByKey.get(record.sourceKey) || record) };
    } else {
      sourceBatch = {
        ...sourceBatch,
        source: "PEC - Lista, Agenda e cadastro completo",
        schemaVersion: 2,
        enrichmentStatus: "processando"
      };
    }
    const batch = await saveBatch(sourceBatch);
    const professionals = new Set(batch.records.map(item => item.professional).filter(Boolean)).size;
    if (!isAgenda) {
      chrome.runtime.sendMessage({
        type: "PEC_BPA_COMPLETE_FROM_LIST",
        records: batch.records,
        filters: batch.filters,
        batchId: batch.id,
        visible: true
      }).catch(() => {});
    }
    show(`${batch.records.length} atendimento(s), ${professionals} profissional(is), coleta iniciada. A aba de revisão abrirá automaticamente quando terminar.`, "success");
  } catch (error) {
    show(error?.message || String(error), "error");
  } finally {
    collectButton.disabled = false;
  }
});

document.querySelector("#review").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("review.html") });
});

(async () => {
  const tab = await activeTab();
  if (/^https:\/\/esus\.saude\.niteroi\.rj\.gov\.br\/agenda\//.test(tab?.url || "")) {
    collectButton.textContent = "Coletar Agenda e cadastros completos";
  }
})();
