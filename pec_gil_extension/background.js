importScripts('rules.js');

function waitForTab(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    let finished = false;
    const cleanup = () => {
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removed);
    };
    const finish = (error) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      finish(new Error("Tempo esgotado ao abrir a página do PEC."));
    }, timeoutMs);
    const listener = (updatedId, changeInfo) => {
      if (updatedId !== tabId || changeInfo.status !== "complete") return;
      finish();
    };
    const removed = removedId => {
      if (removedId === tabId) finish(new Error("A aba de coleta do PEC foi fechada."));
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") finish();
    }).catch(error => finish(error));
  });
}

function isMissingTabError(error) {
  return /No tab with id|No tab found|Invalid tab ID|aba de coleta do PEC foi fechada/i.test(String(error?.message || error));
}

async function createWorkTab() {
  const tab = await chrome.tabs.create({ url: "https://esus.saude.niteroi.rj.gov.br/agenda", active: true });
  await waitForTab(tab.id);
  return tab;
}

async function ensureWorkTab(tab) {
  if (tab?.id) {
    try {
      return await chrome.tabs.get(tab.id);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
    }
  }
  return createWorkTab();
}

function normalize(value) {
  return String(value || "").replace(/\s+/g, " ").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function agendaPathDate(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[1]}${match[2]}${match[3]}` : "";
}

function dateToBr(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getDate()).padStart(2, "0")}/${String(date.getMonth() + 1).padStart(2, "0")}/${date.getFullYear()}`;
}

function dateFromBr(value) {
  const match = String(value || "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return null;
  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function datesFromFilter(filters, records) {
  const period = String(filters?.period || "");
  const matches = period.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
  let start = dateFromBr(matches[0]);
  let end = dateFromBr(matches[1] || matches[0]);
  if (normalize(period).includes("HOJE")) {
    end = new Date();
    if (!start) start = new Date(end);
  }
  if (!start || !end) {
    const dates = [...new Set(records.map(record => record.attendanceDate).filter(Boolean))].map(dateFromBr).filter(Boolean).sort((a, b) => a - b);
    if (dates.length) {
      start = dates[0];
      end = dates[dates.length - 1];
    }
  }
  if (!start || !end) return [];
  if (end < start) [start, end] = [end, start];
  const result = [];
  for (const cursor = new Date(start); cursor <= end && result.length < 93; cursor.setDate(cursor.getDate() + 1)) {
    result.push(dateToBr(cursor));
  }
  return result;
}

function professionalsFromFilter(filters, records) {
  const configured = String(filters?.professionals || "")
    .split(/\s*,\s*/)
    .map(value => value.trim())
    .filter(Boolean);
  const fromRecords = records.map(record => record.professional).filter(Boolean);
  return [...new Set([...configured, ...fromRecords])];
}

function agendaDatesForFilter(records, filters) {
  const periodDates = datesFromFilter(filters, records);
  if (periodDates.length <= 1) return periodDates;
  return [...new Set(records.map(record => record.attendanceDate).filter(Boolean))];
}

function agendaGroups(records, filters) {
  const groups = new Map();
  const add = (professional, date) => {
    if (!professional || !date) return;
    const key = `${normalize(professional)}|${date}`;
    if (!groups.has(key)) groups.set(key, { professional, date, records: [] });
  };
  records.forEach(record => add(record.professional, record.attendanceDate));
  const dates = agendaDatesForFilter(records, filters);
  if (dates.length <= 1) {
    professionalsFromFilter(filters, records).forEach(professional => dates.forEach(date => add(professional, date)));
  }
  return [...groups.values()];
}

async function waitForAgendaId(tabId, timeoutMs = 12000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    const match = tab.url?.match(/\/agenda\/(\d+)\/\d{8}/);
    if (match) return match[1];
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("O profissional não foi localizado na Agenda.");
}

async function resolveProfessionalId(professional) {
  const cache = await chrome.storage.local.get({ pecGilProfessionalIds: {} });
  const key = normalize(professional);
  if (cache.pecGilProfessionalIds[key]) return cache.pecGilProfessionalIds[key];

  let tab;
  try {
    tab = await chrome.tabs.create({ url: "https://esus.saude.niteroi.rj.gov.br/agenda", active: false });
    await waitForTab(tab.id);
    const selection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [professional],
      func: async name => {
        let input = null;
        for (let attempt = 0; attempt < 60; attempt += 1) {
          input = document.querySelector('input[placeholder*="profissional" i]');
          if (input) break;
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        if (!input) throw new Error("Campo de profissional não encontrado.");
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        input.focus();
        const norm = value => String(value || "").replace(/\s+/g, " ").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
        const wanted = norm(name);
        for (let attempt = 0; attempt < 60; attempt += 1) {
          const options = [...document.querySelectorAll('[role="option"]')];
          const option = options.find(item => {
            const text = norm(item.innerText);
            return text.startsWith(wanted + " -") || text === wanted;
          });
          if (option) {
            option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
            option.click();
            return true;
          }
          await new Promise(resolve => setTimeout(resolve, 150));
        }
        return false;
      }
    });
    if (!selection?.[0]?.result) throw new Error(`Profissional não encontrado na Agenda: ${professional}`);
    const id = await waitForAgendaId(tab.id);
    const ids = { ...cache.pecGilProfessionalIds, [key]: id };
    await chrome.storage.local.set({ pecGilProfessionalIds: ids });
    return id;
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function collectAgendaAt(professionalId, attendanceDate) {
  const datePath = agendaPathDate(attendanceDate);
  if (!datePath) throw new Error(`Data inválida: ${attendanceDate}`);
  let tab;
  try {
    tab = await chrome.tabs.create({
      url: `https://esus.saude.niteroi.rj.gov.br/agenda/${professionalId}/${datePath}`,
      active: false
    });
    await waitForTab(tab.id);
    let injected = false;
    let lastError = "A Agenda ainda não terminou de carregar.";
    for (let attempt = 0; attempt < 24; attempt += 1) {
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { type: "PEC_GIL_COLLECT_AGENDA" });
      } catch (error) {
        const text = String(error?.message || error);
        if (!text.includes("Receiving end does not exist") && !text.includes("Could not establish connection")) throw error;
        if (!injected) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["agenda.js"] });
          injected = true;
        }
        response = null;
      }
      if (response?.ok && response.batch?.records?.length) return response.batch.records;
      lastError = response?.error || lastError;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(lastError || "Não foi possível ler a Agenda.");
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function openVisibleTab(tabId, url) {
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTab(tabId);
  // O evento "complete" do navegador pode ocorrer antes de o PEC terminar
  // de preencher a tela. A leitura abaixo ainda fará novas tentativas.
  await new Promise(resolve => setTimeout(resolve, 1200));
}

async function selectProfessionalInTab(tabId, professional) {
  await openVisibleTab(tabId, "https://esus.saude.niteroi.rj.gov.br/agenda");
  const selection = await chrome.scripting.executeScript({
    target: { tabId },
    args: [professional],
    func: async name => {
      let input = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        input = document.querySelector('input[placeholder*="profissional" i]');
        if (input) break;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (!input) throw new Error("Campo de profissional não encontrado.");
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.focus();
      const norm = value => String(value || "").replace(/\s+/g, " ").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      const wanted = norm(name);
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const option = [...document.querySelectorAll('[role="option"]')].find(item => {
          const text = norm(item.innerText);
          return text.startsWith(wanted + " -") || text === wanted;
        });
        if (option) {
          option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
          option.click();
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      return false;
    }
  });
  if (!selection?.[0]?.result) throw new Error(`Profissional não encontrado na Agenda: ${professional}`);
  return waitForAgendaId(tabId);
}

async function collectAgendaInTab(tabId, professionalId, attendanceDate) {
  const datePath = agendaPathDate(attendanceDate);
  if (!datePath) throw new Error(`Data inválida: ${attendanceDate}`);
  await openVisibleTab(tabId, `https://esus.saude.niteroi.rj.gov.br/agenda/${professionalId}/${datePath}`);
  let injected = false;
  let lastError = "A Agenda ainda não terminou de carregar.";
  for (let attempt = 0; attempt < 30; attempt += 1) {
    let response;
    try {
      response = await chrome.tabs.sendMessage(tabId, { type: "PEC_GIL_COLLECT_AGENDA" });
    } catch (error) {
      const text = String(error?.message || error);
      if (!text.includes("Receiving end does not exist") && !text.includes("Could not establish connection")) throw error;
      if (!injected) {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["agenda.js"] });
        injected = true;
      }
    }
    if (response?.ok && response.batch?.records?.length) return response.batch.records;
    lastError = response?.error || lastError;
    await new Promise(resolve => setTimeout(resolve, 700));
  }
  throw new Error(lastError || "Não foi possível ler a Agenda.");
}

async function readCadastroUntilReady(tabId, maxAttempts = 60) {
  let best = {};
  let lastError = "";
  let lastSignature = "";
  let stableAttempts = 0;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const results = await chrome.scripting.executeScript({ target: { tabId }, files: ["cadastro_parser.js"] });
      const data = results?.[0]?.result || {};
      if (cadastroScore(data) >= cadastroScore(best)) best = data;
      // No GIL, falta de endereço não deve disparar uma segunda busca de identidade.
      if (data.patientName && GilRules.validDate(data.birthDate) && ['M','F'].includes(data.sex)
          && (GilRules.digits(data.cpf).length === 11 || GilRules.digits(data.cns).length === 15)) {
        return { ...data, registrationStatus: 'completo', registrationError: '' };
      }
      if (data.registrationStatus === "completo") return data;
      const signature = JSON.stringify([
        data.patientName, data.cpf, data.cns, data.birthDate, data.sex,
        data.postalCode, data.neighborhood, data.street, data.number
      ]);
      if (data.patientName && signature === lastSignature) stableAttempts += 1;
      else stableAttempts = 0;
      lastSignature = signature;
      // Se a página já mostrou o paciente e permaneceu igual por seis
      // segundos, os campos ausentes provavelmente não existem no cadastro.
      // Seguir adiante evita esperar o limite máximo em cada paciente.
      if (data.patientName && stableAttempts >= 12) break;
    } catch (error) {
      if (isMissingTabError(error)) throw error;
      // Em conexão lenta o PEC pode trocar o conteúdo da página durante a
      // leitura. Isso não encerra a coleta; aguardamos e tentamos novamente.
      lastError = error?.message || String(error);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (best.patientName) {
    return {
      ...best,
      registrationStatus: "pendente",
      registrationError: best.registrationError || "O cadastro abriu, mas não terminou de carregar todos os campos. Tente novamente."
    };
  }
  throw new Error(lastError || "O cadastro abriu, mas os campos não ficaram disponíveis.");
}

async function enrichOneInTab(tabId, record) {
  if (!record.cadastroUrl) return { ...record, registrationStatus: "pendente", registrationError: "Cadastro completo não localizado" };
  try {
    await openVisibleTab(tabId, record.cadastroUrl);
    const data = await readCadastroUntilReady(tabId);
    return { ...record, ...data, cadastroUrl: record.cadastroUrl, cadastroSource: record.cadastroSource || "Agenda" };
  } catch (error) {
    if (isMissingTabError(error)) throw error;
    return { ...record, registrationStatus: "pendente", registrationError: error?.message || String(error) };
  }
}

async function searchCadastroInTab(tabId, record) {
  const query = record.cpf || record.cns || record.patientName;
  await openVisibleTab(tabId, "https://esus.saude.niteroi.rj.gov.br/gestaoCadastros/cadastro-individual");
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    args: [query, record.patientName, record.ageText, record.attendanceDate, record.birthDate || ''],
    func: async (searchValue, wantedName, wantedAgeText, attendanceDate, wantedBirthDate) => {
      const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const normalize = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const ageYearsFromText = value => {
        const match = clean(value).match(/(\d+)\s*anos?/i);
        return match ? Number(match[1]) : null;
      };
      const birthDateFromText = value => {
        const match = clean(value).match(/Data\s+de\s+nascimento\s*:?\s*(\d{2}\/\d{2}\/\d{4})/i);
        return match ? match[1] : "";
      };
      const ageAtDate = (birthDate, date) => {
        const birth = clean(birthDate).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        const target = clean(date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        if (!birth || !target) return null;
        let age = Number(target[3]) - Number(birth[3]);
        if (Number(target[2]) < Number(birth[2]) || (Number(target[2]) === Number(birth[2]) && Number(target[1]) < Number(birth[1]))) age -= 1;
        return age;
      };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      let input = null;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        input = document.querySelector('input[name="nomeCpfCns"]');
        if (input) break;
        await sleep(150);
      }
      if (!input || !setter) return { ok: false, error: "Campo Nome/CNS/CPF não encontrado no Cadastro individual." };
      setter.call(input, searchValue);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      const searchButton = [...document.querySelectorAll("button")]
        .find(button => normalize(button.innerText) === normalize("Buscar cadastro"));
      if (!searchButton) return { ok: false, error: "Botão Buscar cadastro não encontrado." };
      searchButton.click();

      let candidates = [];
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const buttons = [...document.querySelectorAll("button")]
          .filter(button => normalize(button.innerText) === normalize("Visualizar"));
        candidates = buttons.map((button, index) => {
          let card = button.parentElement;
          while (card && card !== document.body && !card.querySelector("h3")) card = card.parentElement;
          const heading = card?.querySelector("h3");
          const text = clean(card?.innerText);
          const birthDate = birthDateFromText(text);
          return { index, name: clean(heading?.innerText), text, birthDate, ageYears: ageYearsFromText(text) ?? ageAtDate(birthDate, attendanceDate) };
        }).filter(item => item.name);
        if (candidates.length || /Nenhum cadastro|nenhum resultado/i.test(document.body.innerText)) break;
        await sleep(200);
      }

      if (!candidates.length) return { ok: false, error: "Nenhum cadastro encontrado pelo nome, CPF ou CNS." };
      const wanted = normalize(wantedName);
      const wantedAge = ageYearsFromText(wantedAgeText);
      const exact = candidates.filter(item => normalize(item.name) === wanted);
      const ageMatches = wantedAge === null ? [] : candidates.filter(item => item.ageYears === wantedAge);
      const exactAgeMatches = wantedAge === null ? [] : exact.filter(item => item.ageYears === wantedAge);
      let selected = null;
      let matchMethod = "";
      const documentQuery = clean(searchValue).replace(/\D/g,'');
      const documentMatches = [11,15].includes(documentQuery.length) ? candidates.filter(item => {
        const label=documentQuery.length===11?'CPF':'CNS';
        const match=item.text.match(new RegExp(label+'\\s*([0-9.\\-]+)','i'));
        return (match?.[1] || '').replace(/\D/g,'')===documentQuery;
      }) : [];
      const birthMatches=exact.filter(item=>wantedBirthDate&&item.birthDate===wantedBirthDate);
      if (documentMatches.length === 1) {
        selected=documentMatches[0];matchMethod='documento exato';
      } else if (birthMatches.length === 1) {
        selected=birthMatches[0];matchMethod='nome e nascimento';
      } else if (exact.length === 1 && !wantedBirthDate && (wantedAge===null || exact[0].ageYears===wantedAge)) {
        selected = exact[0];
        matchMethod = "nome exato";
      } else if (!wantedBirthDate && exactAgeMatches.length === 1) {
        selected = exactAgeMatches[0];
        matchMethod = "nome e idade";
      }
      if (!selected) {
        const ageMessage = wantedAge === null ? "" : `; ${ageMatches.length} compatível(is) com ${wantedAge} ano(s)`;
        return {
          ok: false,
          error: "A busca encontrou " + candidates.length + " cadastros parecidos" + ageMessage + "; confirme manualmente no PEC.",
          candidates: candidates.map(item => item.name)
        };
      }
      const button = [...document.querySelectorAll("button")]
        .filter(item => normalize(item.innerText) === normalize("Visualizar"))[selected.index];
      if (!button) return { ok: false, error: "O resultado do cadastro não pôde ser aberto." };
      button.click();
      return { ok: true, selectedName: selected.name, selectedText: selected.text, matchMethod };
    }
  });
  const selection = result?.[0]?.result;
  if (!selection?.ok) return selection || { ok: false, error: "Não foi possível pesquisar o cadastro." };
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const current = await chrome.tabs.get(tabId);
    if (/\/gestaoCadastros\/cadastro-individual\/\d+\/informacoes/.test(current.url || "")) {
      return { ...selection, cadastroUrl: current.url };
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return { ok: false, error: "O cadastro foi localizado, mas a página completa não abriu." };
}

function cadastroScore(record) {
  return ["cpf", "cns", "birthDate", "sex", "postalCode", "neighborhood", "street"]
    .reduce((score, field) => score + (record?.[field] ? 1 : 0), 0);
}

async function enrichWithCadastroRecovery(tabId, record) {
  let firstAttempt = null;
  if (record.cadastroUrl) firstAttempt = await enrichOneInTab(tabId, record);
  if (firstAttempt?.registrationStatus === "completo") return firstAttempt;

  let searchResult;
  try {
    searchResult = await searchCadastroInTab(tabId, record);
  } catch (error) {
    if (isMissingTabError(error)) throw error;
    searchResult = { ok: false, error: error?.message || String(error) };
  }
  if (searchResult?.ok && searchResult.cadastroUrl) {
    const recovered = await enrichOneInTab(tabId, { ...record, cadastroUrl: searchResult.cadastroUrl, cadastroSource: "Cadastro individual", cadastroMatchMethod: searchResult.matchMethod || "" });
    if (!firstAttempt || recovered.registrationStatus === "completo" || cadastroScore(recovered) > cadastroScore(firstAttempt)) {
      return recovered;
    }
  }
  if (firstAttempt) return firstAttempt;
  const prefix = record.attendanceType === "demanda-espontanea"
    ? "Demanda espontânea: "
    : "Cadastro não localizado: ";
  return { ...record, registrationStatus: "pendente", registrationError: prefix + (searchResult?.error || "confirme manualmente no PEC") };
}

async function updateStoredProgress(batchId, records, progress) {
  if (!batchId) return;
  const stored = await chrome.storage.local.get({ pecGilBatches: [] });
  const current = stored.pecGilBatches.find(item => item.id === batchId);
  if (!current) return;
  const mergedByKey = new Map();
  for (const item of current.records || []) mergedByKey.set(storedRecordKey(item), mergeStoredRecord(mergedByKey.get(storedRecordKey(item)), item));
  for (const item of records || []) mergedByKey.set(storedRecordKey(item), mergeStoredRecord(mergedByKey.get(storedRecordKey(item)), item));
  const merged = [...mergedByKey.values()];
  const batches = stored.pecGilBatches.map(item => item.id === batchId
    ? { ...item, records: merged, enrichmentStatus: progress.status || "processando", enrichmentProgress: progress }
    : item);
  await chrome.storage.local.set({ pecGilBatches: batches, pecGilCurrentBatch: batchId });
}

async function openReviewWhenFinished() {
  const reviewUrl = chrome.runtime.getURL("review.html");
  const existing = await chrome.tabs.query({ url: reviewUrl }).catch(() => []);
  const tab = existing?.[0];
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return tab;
  }
  return chrome.tabs.create({ url: reviewUrl, active: true });
}

async function completeFromListVisible(records, batchId, filters = {}, includeAgendaOnly = true) {
  const activeRecords = records.filter(record => GilRules.isRaul(record.professional) && !(record.gilExcluded ?? record.excluded));
  const groups = agendaGroups(activeRecords, filters);
  for (const record of activeRecords) {
    const group = groups.find(item => normalize(item.professional) === normalize(record.professional) && item.date === record.attendanceDate);
    if (group && !group.records.some(item => item.sourceKey === record.sourceKey)) group.records.push(record);
  }
  if (!groups.length) {
    await updateStoredProgress(batchId, [], { status: "concluido", done: 0, total: 0, phase: "Nenhum atendimento para complementar", patient: "" });
    await openReviewWhenFinished();
    return;
  }
  let total = activeRecords.length;
  const linked = [];
  let done = 0;
  let tab;
  const useWorkTab = async action => {
    tab = await ensureWorkTab(tab);
    try {
      return await action(tab.id);
    } catch (error) {
      if (!isMissingTabError(error)) throw error;
      tab = await createWorkTab();
      return action(tab.id);
    }
  };
  try {
    tab = await createWorkTab();
    await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Iniciando", patient: "" });
    for (const group of groups.values()) {
      try {
        await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: `Abrindo Agenda: ${group.professional}`, patient: "" });
        const professionalId = await useWorkTab(tabId => selectProfessionalInTab(tabId, group.professional));
        const agendaRecords = await useWorkTab(tabId => collectAgendaInTab(tabId, professionalId, group.date));
        const available = [...agendaRecords];
        for (const source of group.records) {
          const progress = { status: "processando", done, total, phase: "Abrindo cadastro", patient: source.patientName };
          await updateStoredProgress(batchId, linked, progress);
          let index = available.findIndex(item => normalize(item.patientName) === normalize(source.patientName) && item.scheduledTime === source.scheduledTime);
          if (index < 0) index = available.findIndex(item => normalize(item.patientName) === normalize(source.patientName));
          if (index < 0) {
            await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Buscando cadastro", patient: source.patientName });
            linked.push(await useWorkTab(tabId => enrichWithCadastroRecovery(tabId, source)));
          } else {
            const match = available.splice(index, 1)[0];
            await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Conferindo cadastro completo", patient: source.patientName });
            linked.push(await useWorkTab(tabId => enrichWithCadastroRecovery(tabId, { ...source, ...match, sourceKey: source.sourceKey, attendanceDate: source.attendanceDate, attendanceTime: source.attendanceTime, professional: source.professional, attendanceType: source.attendanceType || match.attendanceType, cadastroSource: "Agenda" })));
          }
          done += 1;
          await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Cadastro processado", patient: source.patientName });
        }
        if (includeAgendaOnly) {
          for (const match of available) {
            if (!GilRules.isRaul(match.professional)) continue;
            const agendaOnly = { ...match, sourceKey: `${match.sourceKey}|AGENDA`, cadastroSource: "Agenda", attendanceType: match.attendanceType || "agendado", gilSelected: false, gilExcluded: Boolean(match.excluded) || /NAO COMPARECEU|ATENDIMENTO NAO REALIZADO/.test(normalize(match.attendanceStatus)) };
            if (agendaOnly.excluded) linked.push(agendaOnly);
            else linked.push(await useWorkTab(tabId => enrichWithCadastroRecovery(tabId, agendaOnly)));
            done += 1;
            total += 1;
            await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Incluindo paciente encontrado na Agenda", patient: agendaOnly.patientName });
          }
        }
      } catch (error) {
        for (const source of group.records) {
          if (!linked.some(item => item.sourceKey === source.sourceKey)) {
            linked.push({ ...source, registrationStatus: "pendente", registrationError: error?.message || String(error) });
            done += 1;
            await updateStoredProgress(batchId, linked, { status: "processando", done, total, phase: "Falha na Agenda", patient: source.patientName });
          }
        }
      }
    }
    await updateStoredProgress(batchId, linked, { status: "concluido", done: total, total, phase: "Concluído", patient: "" });
    await openReviewWhenFinished();
  } catch (error) {
    for (const source of activeRecords) {
      if (!linked.some(item => item.sourceKey === source.sourceKey)) linked.push({ ...source, registrationStatus: "pendente", registrationError: error?.message || String(error) });
    }
    await updateStoredProgress(batchId, linked, { status: "erro", done: linked.length, total, phase: "Erro", patient: error?.message || String(error) });
    await openReviewWhenFinished();
  }
}

async function completeFromList(records) {
  const activeRecords = records.filter(record => !record.excluded);
  const groups = new Map();
  for (const record of activeRecords) {
    const key = `${normalize(record.professional)}|${record.attendanceDate}`;
    if (!groups.has(key)) groups.set(key, { professional: record.professional, date: record.attendanceDate, records: [] });
    groups.get(key).records.push(record);
  }

  const linked = [];
  for (const group of groups.values()) {
    try {
      const professionalId = await resolveProfessionalId(group.professional);
      const agendaRecords = await collectAgendaAt(professionalId, group.date);
      const available = [...agendaRecords];
      for (const source of group.records) {
        let index = available.findIndex(item => normalize(item.patientName) === normalize(source.patientName) && item.scheduledTime === source.scheduledTime);
        if (index < 0) index = available.findIndex(item => normalize(item.patientName) === normalize(source.patientName));
        if (index < 0) {
          linked.push({ ...source, registrationStatus: "pendente", registrationError: "Não localizado na Agenda; pode ser demanda espontânea" });
          continue;
        }
        const match = available.splice(index, 1)[0];
        linked.push({ ...source, ...match, sourceKey: source.sourceKey, attendanceDate: source.attendanceDate, attendanceTime: source.attendanceTime, professional: source.professional });
      }
    } catch (error) {
      for (const source of group.records) {
        linked.push({ ...source, registrationStatus: "pendente", registrationError: error?.message || String(error) });
      }
    }
  }
  return enrichRecords(linked);
}

async function enrichOne(record) {
  if (!record.cadastroUrl) return { ...record, registrationStatus: "pendente", registrationError: "Cadastro completo não localizado" };
  let tab;
  try {
    tab = await chrome.tabs.create({ url: record.cadastroUrl, active: false });
    await waitForTab(tab.id);
    const data = await readCadastroUntilReady(tab.id);
    return { ...record, ...data, cadastroUrl: record.cadastroUrl, cadastroSource: record.cadastroSource || "Agenda" };
  } catch (error) {
    return { ...record, registrationStatus: "pendente", registrationError: error?.message || String(error) };
  } finally {
    if (tab?.id) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function enrichRecords(records) {
  const result = [];
  for (const record of records) {
    result.push(await enrichOne(record));
  }
  return result;
}

function storedRecordKey(record) {
  if (record?.sourceKey) return `source:${record.sourceKey}`;
  return `fallback:${normalize([
    record?.professional,
    record?.patientName,
    record?.attendanceDate,
    record?.attendanceTime,
    record?.attendanceStatus,
    record?.attendanceType
  ].join("|"))}`;
}

function mergeStoredRecord(current, fresh) {
  if (!current) return fresh;
  return {
    ...current,
    ...fresh,
    procedure: current.procedure || fresh.procedure || "",
    cid: GilRules.defaults.cid,
    gilSelected: Boolean(current.gilSelected),
    gilExcluded: current.gilExcluded ?? fresh.gilExcluded ?? Boolean(fresh.excluded)
  };
}

async function updateStoredBatch(batchId, records) {
  if (!batchId) return;
  const stored = await chrome.storage.local.get({ pecGilBatches: [] });
  const current = stored.pecGilBatches.find(item => item.id === batchId);
  if (!current) return;
  const mergedByKey = new Map();
  for (const item of current.records || []) mergedByKey.set(storedRecordKey(item), mergeStoredRecord(mergedByKey.get(storedRecordKey(item)), item));
  for (const item of records || []) mergedByKey.set(storedRecordKey(item), mergeStoredRecord(mergedByKey.get(storedRecordKey(item)), item));
  const merged = [...mergedByKey.values()];
  const batches = stored.pecGilBatches.map(item => item.id === batchId ? { ...item, records: merged, enrichmentStatus: "concluido" } : item);
  await chrome.storage.local.set({ pecGilBatches: batches, pecGilCurrentBatch: batchId });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!['PEC_GIL_ENRICH', 'PEC_GIL_COMPLETE_FROM_LIST', 'PEC_GIL_RETRY_RECORDS'].includes(message?.type)) return;
  if ((message.records || []).some(record => !GilRules.isRaul(record.professional))) {
    sendResponse({ ok: false, error: 'Esta extensão aceita somente o Raul.' });
    return;
  }
  message = { ...message, filters: { ...message.filters, professionals: GilRules.defaults.professional } };
  if (message?.type === "PEC_GIL_ENRICH") {
    enrichRecords(message.records || [])
      .then(records => sendResponse({ ok: true, records }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type !== "PEC_GIL_COMPLETE_FROM_LIST" && message?.type !== "PEC_GIL_RETRY_RECORDS") return;
  if (message.visible) {
    completeFromListVisible(
      message.records || [],
      message.batchId,
      message.filters || {},
      message.type !== "PEC_GIL_RETRY_RECORDS"
    )
      .then(() => sendResponse({ ok: true, started: true }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  completeFromList(message.records || [])
    .then(async records => {
      await updateStoredBatch(message.batchId, records);
      sendResponse({ ok: true, records });
    })
    .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
