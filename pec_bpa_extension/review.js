const DEFAULT_PROFILES = [
  { id: "daniella", match: ["DANIELA", "DANIELLA"], label: "Daniella Murteira Salles: 0205010032 — ecocardiografia transtorácica, sem CID", procedure: "0205010032", cidRequired: false, cpfRequired: true },
  { id: "samir", match: ["SAMIR"], label: "Samir: procedimento manual, sem CID", procedure: "", cidRequired: false, cpfRequired: false },
  { id: "bruna", match: ["BRUNA MEDINA"], label: "Bruna: padrão 0301010366 ou ajuste manual, CID dispensado", procedure: "0301010366", cidRequired: false, cpfRequired: false },
  { id: "fisio", match: ["FISIOTER", "FISIO", "MONICA PEDROSA", "CRISTIANE DE OLIVEIRA NASCIMENTO", "CAMILLA ASSUMPCAO DE CARVALHO"], label: "Fisioterapia: 0302050027 fixo, CID obrigatório", procedure: "0302050027", cidRequired: true, cpfRequired: false }
];

let batches = [];
let batch = null;
let collapsedDays = new Set();
let saveTimer = null;
let cloneCounter = 0;
let unitAddress = {};
let professionalProfiles = {};

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalize(value) {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

const UNIT_ADDRESS_INPUTS = {
  postalCode: "unitPostalCode",
  residenceMunicipalityCode: "unitMunicipalityCode",
  streetType: "unitStreetType",
  street: "unitStreet",
  number: "unitNumber",
  complement: "unitComplement",
  neighborhood: "unitNeighborhood"
};

function unitAddressFromForm() {
  return Object.fromEntries(Object.entries(UNIT_ADDRESS_INPUTS).map(([field, id]) => {
    const value = document.querySelector(`#${id}`)?.value || "";
    return [field, ["postalCode", "residenceMunicipalityCode", "streetType"].includes(field) ? digits(value) : clean(value)];
  }));
}

function fillUnitAddressForm(address = {}) {
  Object.entries(UNIT_ADDRESS_INPUTS).forEach(([field, id]) => {
    const input = document.querySelector(`#${id}`);
    if (input) input.value = address[field] || "";
  });
}

function unitAddressMissing(address = unitAddress) {
  const missing = [];
  if (digits(address.postalCode).length !== 8) missing.push("CEP com 8 dígitos");
  if (!clean(address.street)) missing.push("logradouro");
  if (!clean(address.neighborhood)) missing.push("bairro");
  if (!clean(address.number)) missing.push("número");
  return missing;
}

function patientCoreIsComplete(record) {
  const hasDocument = digits(record.cpf).length === 11 || digits(record.cns).length === 15;
  return Boolean(clean(record.patientName) && hasDocument && clean(record.birthDate) && ["F", "M"].includes(clean(record.sex)));
}

function needsUnitAddress(record) {
  return patientCoreIsComplete(record) && (!digits(record.postalCode) || !clean(record.neighborhood) || !clean(record.street));
}

function applyUnitAddress(record) {
  for (const field of Object.keys(UNIT_ADDRESS_INPUTS)) {
    if (!clean(record[field])) record[field] = unitAddress[field] || "";
  }
  record.unitAddressApplied = true;
  record.addressSource = "Endereço da unidade (contingência)";
  if (patientCoreIsComplete(record) && digits(record.postalCode).length === 8 && clean(record.neighborhood) && clean(record.street)) {
    record.registrationStatus = "completo";
    record.registrationError = "";
  }
}

function profileFor(name) {
  const key = normalize(name);
  const custom = professionalProfiles[key];
  if (custom) {
    return {
      id: "custom",
      label: custom.label || `${custom.name}: regra personalizada`,
      procedure: digits(custom.procedure),
      cidRequired: Boolean(custom.cidRequired),
      cpfRequired: Boolean(custom.cpfRequired)
    };
  }
  return DEFAULT_PROFILES.find(profile => profile.match.some(part => key.includes(part))) || {
    id: "manual", label: "Manual: procedimento para conferir, CID dispensado", procedure: "", cidRequired: false, cpfRequired: false
  };
}

function updateProfessionalProfileForm(professionals = []) {
  const select = document.querySelector("#profileProfessional");
  if (!select) return;
  const current = select.value;
  const names = [...new Set(professionals.map(clean).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR"));
  select.innerHTML = names.length
    ? names.map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("")
    : '<option value="">Nenhum profissional coletado</option>';
  select.disabled = !names.length;
  select.value = names.includes(current) ? current : (names[0] || "");
  const saved = professionalProfiles[normalize(select.value)] || {};
  const procedure = document.querySelector("#profileProcedure");
  const cidRequired = document.querySelector("#profileCidRequired");
  if (procedure) procedure.value = saved.procedure || "";
  if (cidRequired) cidRequired.checked = Boolean(saved.cidRequired);
}

function applyProfile(record) {
  const profile = profileFor(record.professional);
  record.profileId = profile.id;
  record.profileLabel = profile.label;
  record.cidRequired = profile.cidRequired;
  record.cpfRequired = profile.cpfRequired;
  if (!digits(record.procedure) && profile.procedure) record.procedure = profile.procedure;
}

function identity(record) {
  return digits(record.cpf) || digits(record.cns) || normalize(record.patientName);
}

function duplicateIdentity(record) {
  return normalize(record.patientName) || identity(record);
}

function isNoShow(record) {
  return normalize(record.attendanceStatus).includes("NAO COMPARECEU");
}

function isNotPerformed(record) {
  return normalize(record.attendanceStatus).includes("ATENDIMENTO NAO REALIZADO");
}

function matchesStatusFilter(record, selectedStatus) {
  if (!selectedStatus) return true;
  if (selectedStatus === "no-show") return isNoShow(record);
  if (selectedStatus === "not-performed") return isNotPerformed(record);
  return record.reviewStatus === selectedStatus;
}

function originKey(record) {
  if (record.cadastroSource === "Agenda") return "agenda";
  if (record.cadastroSource === "Cadastro individual") return "cadastro";
  if (record.registrationStatus !== "completo") return "pendente";
  return "cadastro";
}

function originLabel(record) {
  if (record.cadastroSource === "Agenda") return "Agenda";
  if (record.cadastroSource === "Cadastro individual") return "Cadastro individual";
  if (record.registrationStatus === "completo") return "Cadastro completo";
  return "Ainda não localizado";
}

function evaluateRecords() {
  const seen = new Map();
  for (const record of batch.records) {
    applyProfile(record);
    // Lotes antigos podem ter sido coletados antes desta regra existir.
    // O usuário ainda pode reincluir o atendimento manualmente.
    if (isNotPerformed(record) && record.reactivated !== true) record.excluded = true;
    if (record.excluded) {
      record.reviewStatus = "excluded";
      record.reviewMessage = "Excluído da exportação";
      continue;
    }
    const procedure = digits(record.procedure);
    const cid = normalize(record.cid).replace(/[^A-Z0-9]/g, "");
    record.procedure = procedure;
    record.cid = cid;
    // Só é duplicado quando a mesma pessoa, no mesmo profissional e dia,
    // apresenta exatamente o mesmo procedimento. Outro dia ou outro
    // procedimento representa um novo atendimento.
    const duplicateKey = [duplicateIdentity(record), record.attendanceDate, normalize(record.professional), procedure].join("|");
    const cpf = digits(record.cpf);
    const cns = digits(record.cns);
    record.semCpfCivil = cpf.length === 11 ? "N" : cns.length === 15 ? "S" : "";
    if (procedure && seen.has(duplicateKey)) {
      record.reviewStatus = "duplicate";
      record.reviewMessage = "Duplicado no lote";
    } else if (record.registrationStatus !== "completo") {
      record.reviewStatus = "pending";
      record.reviewMessage = "Cadastro incompleto";
    } else if (record.cpfRequired && cpf.length !== 11) {
      record.reviewStatus = "pending";
      record.reviewMessage = "CPF obrigatório";
    } else if (cpf.length !== 11 && cns.length !== 15) {
      record.reviewStatus = "pending";
      record.reviewMessage = "Falta CPF/CNS";
    } else if (!procedure) {
      record.reviewStatus = "pending";
      record.reviewMessage = "Falta procedimento";
    } else if (record.cidRequired && !cid) {
      record.reviewStatus = "pending";
      record.reviewMessage = "Falta CID";
    } else {
      record.reviewStatus = "reviewed";
      record.reviewMessage = "Lista revisada";
    }
    if (procedure) seen.set(duplicateKey, record.sourceKey);
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}

function render() {
  if (!batch) return;
  evaluateRecords();
  const professionals = [...new Set(batch.records.map(item => clean(item.professional)).filter(Boolean))].sort();
  const professionalFilter = document.querySelector("#professionalFilter");
  const selectedProfessional = professionalFilter.value;
  professionalFilter.innerHTML = '<option value="">Todos os profissionais</option>' + professionals
    .map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join("");
  professionalFilter.value = professionals.includes(selectedProfessional) ? selectedProfessional : "";
  updateProfessionalProfileForm(professionals);
  const selectedStatus = document.querySelector("#statusFilter").value;
  const selectedOrigin = document.querySelector("#originFilter").value;
  const visibleRecords = batch.records
    .map((record, index) => ({ record, index }))
    .filter(item => (!professionalFilter.value || item.record.professional === professionalFilter.value)
      && matchesStatusFilter(item.record, selectedStatus)
      && (!selectedOrigin || originKey(item.record) === selectedOrigin))
    .sort((a, b) => a.record.professional.localeCompare(b.record.professional, "pt-BR") || a.record.attendanceDate.localeCompare(b.record.attendanceDate));

  document.querySelector("#summary").textContent = `${batch.filters?.period || "Período não identificado"} · ${professionals.length} profissional(is) · ${batch.records.length} atendimento(s) · ${batch.pagesRead || 1} página(s)`;
  const breakdown = new Map();
  batch.records.forEach(record => {
    const key = `${record.professional || "Profissional não informado"}|${record.attendanceDate || "Data não informada"}`;
    if (!breakdown.has(key)) breakdown.set(key, { professional: record.professional || "Profissional não informado", date: record.attendanceDate || "Data não informada", total: 0, pending: 0, reviewed: 0, duplicate: 0, excluded: 0 });
    const item = breakdown.get(key);
    item.total += 1;
    if (record.reviewStatus === "pending") item.pending += 1;
    else if (record.reviewStatus === "duplicate") item.duplicate += 1;
    else if (record.reviewStatus === "excluded") item.excluded += 1;
    else if (record.reviewStatus === "reviewed") item.reviewed += 1;
  });
  document.querySelector("#breakdown").innerHTML = `<div class="breakdown-grid">${[...breakdown.values()].sort((a, b) => a.date.localeCompare(b.date) || a.professional.localeCompare(b.professional, "pt-BR")).map(item => `<span class="breakdown-item"><strong>${escapeHtml(item.date)}</strong> · ${escapeHtml(item.professional)}<small>${item.total} total · ${item.reviewed} revisados · ${item.pending} pendentes · ${item.duplicate} duplicados · ${item.excluded} excluídos</small></span>`).join("")}</div>`;
  const syncNotice = document.querySelector("#syncNotice");
  const progress = batch.enrichmentProgress;
  const retryButton = document.querySelector("#retryPending");
  if (retryButton) retryButton.disabled = batch.enrichmentStatus === "processando";
  if (syncNotice) {
    if (batch.enrichmentStatus === "processando" && progress) {
      const total = progress.total || batch.records.length;
      const patient = progress.patient ? ` — ${progress.patient}` : "";
      syncNotice.textContent = `Coleta em andamento: ${progress.done || 0}/${total} — ${progress.phase || "processando"}${patient}`;
    } else if (batch.enrichmentStatus === "erro") {
      syncNotice.textContent = `A coleta terminou com pendências. ${progress?.phase || "Revise os registros marcados."}`;
    } else if (batch.enrichmentStatus === "concluido") {
      syncNotice.textContent = "Coleta concluída: os cadastros encontrados foram preenchidos com CPF, CNS e residência. Revise, exclua ou duplique atendimentos antes de enviar ao BPA.";
    } else {
      syncNotice.textContent = "A coleta feita pela Agenda abre os cadastros completos e traz CPF, CNS e residência. Esta versão ainda não grava no BPA.";
    }
  }
  document.querySelector("#rows").innerHTML = visibleRecords.map(({ record, index }) => {
    const manualSearchButton = record.excluded || record.registrationStatus === "completo"
      ? ""
      : '<button type="button" class="manual-search" data-index="' + index + '">Buscar cadastro</button>';
    return `
    <tr class="${record.reviewStatus}">
      <td><input class="row-select" type="checkbox" data-index="${index}"></td>
      <td>${escapeHtml(record.attendanceDate)}<small>${escapeHtml(record.attendanceTime)}</small>${record.attendanceType === "demanda-espontanea" ? '<small>DEMANDA ESPONTÂNEA</small>' : ""}</td>
      <td>${escapeHtml(record.patientName)}<small>${escapeHtml(record.ageText)}</small><small>Status PEC: ${escapeHtml(record.attendanceStatus || "não informado")}</small>${record.observation ? `<small>Observação: ${escapeHtml(record.observation)}</small>` : ""}<small>CPF ${escapeHtml(record.cpf || "—")} · CNS ${escapeHtml(record.cns || "—")}</small><small>${escapeHtml([record.postalCode, record.neighborhood, record.street, record.number].filter(Boolean).join(" · ") || "Endereço pendente")}</small><small>Origem: ${escapeHtml(originLabel(record))}</small>${record.unitAddressApplied ? '<small class="diagnostic">Endereço da unidade aplicado como contingência</small>' : ""}${record.registrationError ? `<small class="diagnostic">${escapeHtml(record.registrationError)}</small>` : ""}${manualSearchButton}</td>
      <td>${escapeHtml(record.professional)}</td>
      <td><input class="cell-input procedure" data-index="${index}" value="${escapeHtml(record.procedure)}" inputmode="numeric" maxlength="10"></td>
      <td><input class="cell-input cid" data-index="${index}" value="${escapeHtml(record.cid)}" maxlength="10" ${record.cidRequired ? "" : 'placeholder="dispensado"'}></td>
      <td><span class="rule">${escapeHtml(record.profileLabel)}</span></td>
      <td><span class="status ${record.reviewStatus}">${escapeHtml(record.reviewMessage)}</span></td>
    </tr>`;
  }).join("");

  const rowsElement = document.querySelector("#rows");
  const rowsByDay = new Map();
  [...rowsElement.querySelectorAll("tr")].forEach(row => {
    const index = Number(row.querySelector(".row-select")?.dataset.index);
    const date = batch.records[index]?.attendanceDate || "Data não informada";
    if (!rowsByDay.has(date)) rowsByDay.set(date, []);
    rowsByDay.get(date).push(row);
  });
  rowsElement.innerHTML = "";
  [...rowsByDay.entries()].sort((a, b) => {
    const keyA = a[0].split("/").reverse().join("");
    const keyB = b[0].split("/").reverse().join("");
    return keyA.localeCompare(keyB);
  }).forEach(([date, rows]) => {
    const collapsed = collapsedDays.has(date);
    const header = document.createElement("tr");
    header.className = "day-header";
    const cell = document.createElement("td");
    cell.colSpan = 8;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "day-toggle";
    toggle.dataset.day = date;
    toggle.setAttribute("aria-expanded", String(!collapsed));
    const chevron = document.createElement("span");
    chevron.className = "day-chevron";
    chevron.textContent = collapsed ? "▸" : "▾";
    toggle.appendChild(chevron);
    toggle.appendChild(document.createTextNode(` ${date} `));
    const count = document.createElement("small");
    count.textContent = `${rows.length} atendimento(s)`;
    toggle.appendChild(count);
    toggle.addEventListener("click", () => {
      if (collapsedDays.has(date)) collapsedDays.delete(date);
      else collapsedDays.add(date);
      render();
    });
    const controls = document.createElement("div");
    controls.className = "day-header-controls";
    controls.appendChild(toggle);
    const selectLabel = document.createElement("label");
    selectLabel.className = "day-select-label";
    const selectDay = document.createElement("input");
    selectDay.type = "checkbox";
    selectDay.className = "day-select";
    selectDay.setAttribute("aria-label", `Selecionar todos os atendimentos de ${date}`);
    selectLabel.appendChild(selectDay);
    selectLabel.appendChild(document.createTextNode("Selecionar dia"));
    selectDay.addEventListener("click", event => event.stopPropagation());
    selectDay.addEventListener("change", event => {
      rows.forEach(row => {
        const checkbox = row.querySelector(".row-select");
        if (checkbox) checkbox.checked = event.target.checked;
      });
    });
    controls.appendChild(selectLabel);
    cell.appendChild(controls);
    header.appendChild(cell);
    rowsElement.appendChild(header);
    rows.forEach(row => {
      row.style.display = collapsed ? "none" : "";
      rowsElement.appendChild(row);
    });
  });

  const counts = batch.records.reduce((acc, item) => { acc[item.reviewStatus] = (acc[item.reviewStatus] || 0) + 1; return acc; }, {});
  document.querySelector("#counts").textContent = `Revisados: ${counts.reviewed || 0} · Pendentes: ${counts.pending || 0} · Duplicados: ${counts.duplicate || 0} · Excluídos: ${counts.excluded || 0}`;
  bindInputs();
}

function bindInputs() {
  document.querySelectorAll(".procedure").forEach(input => input.addEventListener("input", event => {
    batch.records[Number(event.target.dataset.index)].procedure = event.target.value;
    scheduleSave();
  }));
  document.querySelectorAll(".procedure").forEach(input => input.addEventListener("change", () => {
    render();
  }));
  document.querySelectorAll(".cid").forEach(input => input.addEventListener("input", event => {
    batch.records[Number(event.target.dataset.index)].cid = event.target.value;
    scheduleSave();
  }));
  document.querySelectorAll(".cid").forEach(input => input.addEventListener("change", () => {
    render();
  }));
  document.querySelectorAll(".manual-search").forEach(button => button.addEventListener("click", () => {
    const record = batch.records[Number(button.dataset.index)];
    retryRecords(record ? [record] : []);
  }));
}

async function save() {
  const index = batches.findIndex(item => item.id === batch.id);
  if (index >= 0) batches[index] = batch;
  await chrome.storage.local.set({ pecBpaBatches: batches, pecBpaCurrentBatch: batch.id });
  const saveState = document.querySelector("#saveState");
  if (saveState) saveState.textContent = `Salvo automaticamente às ${new Date().toLocaleTimeString("pt-BR")}.`;
}

function scheduleSave() {
  const saveState = document.querySelector("#saveState");
  if (saveState) saveState.textContent = "Salvando…";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), 700);
}

function pendingCadastroRecords() {
  return batch.records.filter(record => !record.excluded && record.registrationStatus !== "completo");
}

async function retryRecords(records) {
  if (!records.length) return;
  batch.enrichmentStatus = "processando";
  batch.enrichmentProgress = { status: "processando", done: 0, total: records.length, phase: "Reprocessando cadastros", patient: records[0].patientName || "" };
  await save();
  render();
  document.querySelector("#retryPending").disabled = true;
  chrome.runtime.sendMessage({ type: "PEC_BPA_RETRY_RECORDS", records, batchId: batch.id, visible: true })
    .then(response => {
      if (response && response.ok === false) alert(response.error || "Não foi possível iniciar a nova tentativa.");
    })
    .catch(error => alert(error?.message || String(error)));
}

function download(name, type, content) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename: name, saveAs: true }, () => setTimeout(() => URL.revokeObjectURL(url), 30000));
}

function fileStamp() {
  const firstDate = batch.records[0]?.attendanceDate?.split("/").reverse().join("") || "sem-data";
  const professional = normalize(batch.filters?.professionals || "profissional").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${firstDate}_${professional}`;
}

const BPA_SHEET_LIMIT = 99;

function dateSortKey(value) {
  return String(value || "").split("/").reverse().join("");
}

function buildBpaPlan(records) {
  const groups = new Map();
  records.filter(record => !record.excluded).forEach(record => {
    const key = normalize(record.professional);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  });
  const sheets = [];
  for (const groupRecords of groups.values()) {
    const ordered = [...groupRecords].sort((a, b) => dateSortKey(a.attendanceDate).localeCompare(dateSortKey(b.attendanceDate)) || normalize(a.patientName).localeCompare(normalize(b.patientName), "pt-BR"));
    let sheet = null;
    let professionalSheetNumber = 0;
    for (const record of ordered) {
      const patientIdentity = identity(record);
      const uniquePatientPerSheet = profileFor(record.professional).id === "bruna";
      if (!sheet || sheet.records.length >= BPA_SHEET_LIMIT || (uniquePatientPerSheet && sheet.identities.has(patientIdentity))) {
        professionalSheetNumber += 1;
        sheet = {
          folha: professionalSheetNumber,
          professional: record.professional,
          attendanceDate: record.attendanceDate,
          cidRequired: Boolean(record.cidRequired),
          records: [],
          identities: new Set(),
          attendanceDates: new Set(),
          procedures: new Set()
        };
        sheets.push(sheet);
      }
      sheet.records.push(record);
      sheet.identities.add(patientIdentity);
      sheet.attendanceDates.add(record.attendanceDate);
      sheet.procedures.add(digits(record.procedure));
    }
  }
  return sheets.map(({ identities, attendanceDates, procedures, ...sheet }) => ({
    ...sheet,
    attendanceDates: [...attendanceDates].sort((a, b) => dateSortKey(a).localeCompare(dateSortKey(b))),
    procedures: [...procedures].filter(Boolean).sort(),
    procedure: procedures.size === 1 ? [...procedures][0] : "",
    total: sheet.records.length,
    records: sheet.records.map(record => ({
      ...record,
      semCpfCivil: digits(record.cpf).length === 11 ? "N" : digits(record.cns).length === 15 ? "S" : ""
    }))
  }));
}

function buildExportSummary(records, bpaSheets, filters = {}) {
  const dates = [...new Set(records.map(record => record.attendanceDate || "Data não informada"))]
    .sort((a, b) => dateSortKey(a).localeCompare(dateSortKey(b)));
  const grouped = new Map();
  for (const record of records) {
    const professional = record.professional || "Profissional não informado";
    if (!grouped.has(professional)) {
      grouped.set(professional, {
        nome: professional,
        atendimentos: 0,
        dias: new Set(),
        procedimentos: new Set()
      });
    }
    const item = grouped.get(professional);
    item.atendimentos += 1;
    item.dias.add(record.attendanceDate || "Data não informada");
    if (record.procedure) item.procedimentos.add(record.procedure);
  }
  return {
    periodo: filters.period || "",
    totalAtendimentos: records.length,
    totalFolhasBpa: bpaSheets.length,
    dias: dates,
    profissionais: [...grouped.values()]
      .sort((a, b) => normalize(a.nome).localeCompare(normalize(b.nome), "pt-BR"))
      .map(item => ({
        nome: item.nome,
        atendimentos: item.atendimentos,
        dias: [...item.dias].sort((a, b) => dateSortKey(a).localeCompare(dateSortKey(b))),
        procedimentos: [...item.procedimentos].sort()
      }))
  };
}

function selectedRecords() {
  return [...document.querySelectorAll(".row-select:checked")]
    .map(box => batch.records[Number(box.dataset.index)])
    .filter(Boolean);
}

function cloneRecord(record) {
  cloneCounter += 1;
  return {
    ...record,
    sourceKey: `${record.sourceKey || identity(record)}|COPIA|${Date.now()}|${cloneCounter}`,
    excluded: false,
    reviewStatus: "pending",
    reviewMessage: "Confira o procedimento",
    registrationError: ""
  };
}

function exportCandidateRecords() {
  evaluateRecords();
  return batch.records.filter(record => !record.excluded && record.reviewStatus !== "duplicate");
}

function renderSheetPreview() {
  if (!batch) return;
  const records = exportCandidateRecords();
  const sheets = buildBpaPlan(records);
  const pending = records.filter(record => record.reviewStatus === "pending");
  const excluded = batch.records.filter(record => record.excluded).length;
  const duplicates = batch.records.filter(record => record.reviewStatus === "duplicate").length;
  const ready = records.length - pending.length;

  document.querySelector("#previewSummary").textContent = `${sheets.length} folha(s) · ${records.length} atendimento(s) na prévia · ${ready} pronto(s) · ${pending.length} pendente(s)`;
  document.querySelector("#previewWarnings").innerHTML = pending.length
    ? `<div class="preview-warning">A exportação ainda está bloqueada: ${pending.length} atendimento(s) precisam de conferência. Corrija procedimento, CID ou cadastro na tela principal e clique em <strong>Atualizar prévia</strong>.</div>`
    : `<div class="preview-message">Prévia pronta para exportação. ${excluded} excluído(s) e ${duplicates} duplicado(s) não entrarão no arquivo do BPA.</div>`;

  const list = document.querySelector("#previewSheetList");
  if (!sheets.length) {
    list.innerHTML = '<div class="preview-empty">Nenhuma folha pode ser montada ainda. Confira os atendimentos e preencha os procedimentos.</div>';
    return;
  }
  list.innerHTML = sheets.map(sheet => `
    <article class="sheet-card">
      <div class="sheet-header">
        <div><strong>Folha ${sheet.folha}</strong> · ${escapeHtml(sheet.professional || "Profissional não informado")}
          <small>Data(s): ${escapeHtml(sheet.attendanceDates?.join(", ") || sheet.attendanceDate || "não informada")} · Procedimento(s): ${escapeHtml(sheet.procedures?.join(", ") || sheet.procedure || "não informado")}</small>
        </div>
        <span class="sheet-total">${sheet.total} atendimento(s)</span>
      </div>
      <table class="preview-table">
        <thead><tr><th>Paciente</th><th>Identificação</th><th>CID</th><th>Situação</th></tr></thead>
        <tbody>${sheet.records.map(record => {
          const identification = [
            record.cpf ? `CPF ${record.cpf}` : "",
            record.cns ? `CNS ${record.cns}` : "",
            `Sem CPF/Civil: ${record.semCpfCivil || "—"}`
          ].filter(Boolean).join(" · ");
          const statusClass = record.reviewStatus === "pending" ? "pending" : "reviewed";
          const statusText = record.reviewStatus === "pending" ? record.reviewMessage : "Pronto";
          return `<tr><td>${escapeHtml(record.patientName)}<small>${escapeHtml(record.attendanceTime || "")}</small><small>Status PEC: ${escapeHtml(record.attendanceStatus || "não informado")}</small>${record.observation ? `<small>Observação: ${escapeHtml(record.observation)}</small>` : ""}</td><td>${escapeHtml(identification)}</td><td>${escapeHtml(record.cid || "—")}</td><td><span class="preview-status ${statusClass}">${escapeHtml(statusText)}</span></td></tr>`;
        }).join("")}</tbody>
      </table>
    </article>`).join("");
}

function openSheetPreview() {
  renderSheetPreview();
  const modal = document.querySelector("#sheetPreviewModal");
  modal.hidden = false;
  modal.setAttribute("aria-hidden", "false");
}

function closeSheetPreview() {
  const modal = document.querySelector("#sheetPreviewModal");
  modal.hidden = true;
  modal.setAttribute("aria-hidden", "true");
}

document.querySelector("#save").addEventListener("click", async () => {
  await save();
  document.querySelector("#save").textContent = "Rascunho salvo";
  setTimeout(() => document.querySelector("#save").textContent = "Salvar rascunho", 1500);
});

document.querySelector("#saveUnitAddress").addEventListener("click", async () => {
  unitAddress = unitAddressFromForm();
  const missing = unitAddressMissing();
  const status = document.querySelector("#unitAddressStatus");
  if (missing.length) {
    status.textContent = `Ainda falta: ${missing.join(", ")}.`;
    return;
  }
  await chrome.storage.local.set({ pecBpaUnitAddress: unitAddress });
  status.textContent = "Endereço salvo. Será usado somente quando faltar residência no PEC.";
});

document.querySelector("#exportJson").addEventListener("click", async () => {
  let records = exportCandidateRecords();
  const addressCandidates = records.filter(needsUnitAddress);
  if (addressCandidates.length) {
    const missingConfiguration = unitAddressMissing();
    if (missingConfiguration.length) {
      document.querySelector(".unit-address").open = true;
      alert(
        `${addressCandidates.length} paciente(s) precisam do endereço da unidade. ` +
        `Preencha antes de exportar: ${missingConfiguration.join(", ")}.`
      );
      return;
    }
    const confirmed = confirm(
      `${addressCandidates.length} paciente(s) estão sem residência no PEC. ` +
      `Aplicar o endereço configurado da unidade antes da exportação?`
    );
    if (!confirmed) return;
    addressCandidates.forEach(applyUnitAddress);
    evaluateRecords();
    await save();
    render();
    records = exportCandidateRecords();
  }
  const pending = records.filter(item => item.reviewStatus === "pending");
  if (pending.length) {
    document.querySelector("#professionalFilter").value = "";
    document.querySelector("#statusFilter").value = "pending";
    document.querySelector("#originFilter").value = "";
    collapsedDays.clear();
    render();
    const details = pending.slice(0, 8).map(item => `${item.patientName || "Paciente sem nome"}: ${item.reviewMessage}`).join("\n");
    alert(`${pending.length} atendimento(s) pendente(s). O lote já preenchido foi preservado.\n\n${details}\n\nA tela está filtrada para mostrar apenas as pendências.`);
    document.querySelector("#rows tr.pending")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  await save();
  const professionalGroups = Object.fromEntries([...new Set(records.map(item => item.professional))].sort().map(professional => [
    professional,
    records.filter(item => item.professional === professional)
  ]));
  const bpaSheets = buildBpaPlan(records);
  const payload = {
    ...batch,
    exportedAt: new Date().toISOString(),
    exportType: "PEC_BPA_FILA_PARA_PREENCHIMENTO",
    records,
    professionalGroups,
    professionalProfiles,
    bpaSheets,
    resumo: buildExportSummary(records, bpaSheets, batch.filters || {}),
    addressContingency: {
      appliedRecords: records.filter(record => record.unitAddressApplied).length,
      label: "Endereço da unidade (contingência)"
    },
    bpaRules: {
      oneProfessionalPerSheet: true,
      oneDatePerSheet: false,
      oneProcedurePerSheet: false,
      maxPatientsPerSheet: BPA_SHEET_LIMIT,
      noRepeatedPatientIdentityInSheet: false,
      noRepeatedPatientIdentityInSheetFor: ["Bruna Medina Valladares"],
      cpf11DigitsMeansSemCpfCivilN: true,
      cns15DigitsMeansSemCpfCivilS: true
    }
  };
  download(`PEC_BPA_${fileStamp()}.json`, "application/json;charset=utf-8", JSON.stringify(payload, null, 2));
});

document.querySelector("#exportCsv").addEventListener("click", () => {
  evaluateRecords();
  const header = ["Data", "Hora", "Paciente", "Profissional", "Status PEC", "Observacao", "CPF", "CNS", "CEP", "Bairro", "Procedimento", "CID", "Origem", "Origem endereco", "Situacao", "Incluido"];
  const quote = value => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const lines = [header, ...batch.records.map(item => [item.attendanceDate, item.attendanceTime, item.patientName, item.professional, item.attendanceStatus, item.observation, item.cpf, item.cns, item.postalCode, item.neighborhood, item.procedure, item.cid, originLabel(item), item.addressSource || "PEC", item.reviewMessage, item.excluded ? "N" : "S"])];
  download(`PEC_BPA_${fileStamp()}.csv`, "text/csv;charset=utf-8", "\ufeff" + lines.map(row => row.map(quote).join(";")).join("\r\n"));
});

document.querySelector("#duplicateSelected").addEventListener("click", async () => {
  const selected = selectedRecords().filter(record => !record.excluded);
  if (!selected.length) {
    alert("Selecione pelo menos um atendimento para duplicar.");
    return;
  }
  const copies = selected.map(cloneRecord);
  const firstIndex = batch.records.findIndex(record => record === selected[0]);
  batch.records.splice(firstIndex + 1, 0, ...copies);
  await save();
  render();
});

document.querySelector("#excludeSelected").addEventListener("click", async () => {
  const selected = selectedRecords().filter(record => !record.excluded);
  if (!selected.length) {
    alert("Selecione pelo menos um atendimento para excluir.");
    return;
  }
  selected.forEach(record => { record.excluded = true; record.reactivated = false; });
  await save();
  render();
});

document.querySelector("#includeSelected").addEventListener("click", async () => {
  const selected = selectedRecords().filter(record => record.excluded);
  if (!selected.length) {
    alert("Filtre por Excluídos e selecione os atendimentos que deseja reincluir.");
    return;
  }
  selected.forEach(record => { record.excluded = false; record.reactivated = true; });
  await save();
  render();
});

document.querySelector("#removeSelected").addEventListener("click", async () => {
  const selected = selectedRecords();
  if (!selected.length) {
    alert("Selecione pelo menos um atendimento para remover da lista.");
    return;
  }
  const confirmed = confirm(`Remover ${selected.length} atendimento(s) definitivamente deste lote? Essa ação não poderá ser desfeita pela tela.`);
  if (!confirmed) return;
  const selectedSet = new Set(selected);
  batch.records = batch.records.filter(record => !selectedSet.has(record));
  await save();
  render();
});

document.querySelector("#openPreview").addEventListener("click", openSheetPreview);
document.querySelector("#refreshPreview").addEventListener("click", renderSheetPreview);
document.querySelector("#closePreview").addEventListener("click", closeSheetPreview);
document.querySelector("#sheetPreviewModal").addEventListener("click", event => {
  if (event.target.id === "sheetPreviewModal") closeSheetPreview();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !document.querySelector("#sheetPreviewModal").hidden) closeSheetPreview();
});

document.querySelector("#applyBulk").addEventListener("click", () => {
  const procedure = digits(document.querySelector("#bulkProcedure").value);
  const cid = normalize(document.querySelector("#bulkCid").value).replace(/[^A-Z0-9]/g, "");
  document.querySelectorAll(".row-select:checked").forEach(box => {
    const record = batch.records[Number(box.dataset.index)];
    if (!record || record.excluded) return;
    if (procedure) record.procedure = procedure;
    if (cid) record.cid = cid;
  });
  scheduleSave();
  render();
});

document.querySelector("#retryPending").addEventListener("click", () => {
  const records = pendingCadastroRecords();
  if (!records.length) {
    alert("Não há cadastro pendente para tentar novamente.");
    return;
  }
  retryRecords(records);
});

document.querySelector("#collapseDays").addEventListener("click", () => {
  collapsedDays = new Set(batch.records.map(record => record.attendanceDate || "Data não informada"));
  render();
});

document.querySelector("#expandDays").addEventListener("click", () => {
  collapsedDays = new Set();
  render();
});

document.querySelector("#selectAll").addEventListener("change", event => {
  document.querySelectorAll(".row-select").forEach(box => { box.checked = event.target.checked; });
});

document.querySelector("#selectFiltered").addEventListener("click", () => {
  const visible = [...document.querySelectorAll(".row-select")];
  visible.forEach(box => { box.checked = true; });
  document.querySelector("#selectAll").checked = visible.length > 0;
});

document.querySelector("#batchSelect").addEventListener("change", event => {
  batch = batches.find(item => item.id === event.target.value);
  collapsedDays = new Set();
  render();
});

document.querySelector("#professionalFilter").addEventListener("change", () => render());
document.querySelector("#statusFilter").addEventListener("change", () => render());
document.querySelector("#originFilter").addEventListener("change", () => render());

document.querySelector("#profileProfessional").addEventListener("change", event => {
  const saved = professionalProfiles[normalize(event.target.value)] || {};
  document.querySelector("#profileProcedure").value = saved.procedure || "";
  document.querySelector("#profileCidRequired").checked = Boolean(saved.cidRequired);
});

document.querySelector("#saveProfessionalProfile").addEventListener("click", async () => {
  const name = clean(document.querySelector("#profileProfessional").value);
  const procedure = digits(document.querySelector("#profileProcedure").value);
  const cidRequired = document.querySelector("#profileCidRequired").checked;
  const status = document.querySelector("#professionalProfileStatus");
  if (!name) {
    status.textContent = "Cole primeiro um atendimento desse profissional pelo navegador.";
    return;
  }
  if (procedure && procedure.length !== 10) {
    status.textContent = "O procedimento precisa ter 10 dígitos.";
    return;
  }
  professionalProfiles[normalize(name)] = {
    name,
    procedure,
    cidRequired,
    cpfRequired: Boolean(professionalProfiles[normalize(name)]?.cpfRequired),
    label: `${name}: regra personalizada${procedure ? ` — ${procedure}` : ""}${cidRequired ? ", CID obrigatório" : ", CID dispensado"}`
  };
  await chrome.storage.local.set({ pecBpaProfessionalProfiles: professionalProfiles });
  if (batch) {
    batch.records.filter(record => normalize(record.professional) === normalize(name)).forEach(applyProfile);
    await save();
    render();
  }
  status.textContent = `Regra salva para ${name}. O navegador já reconhece esse profissional neste lote.`;
});

(async () => {
  const stored = await chrome.storage.local.get({ pecBpaBatches: [], pecBpaCurrentBatch: "", pecBpaUnitAddress: {}, pecBpaProfessionalProfiles: {} });
  unitAddress = stored.pecBpaUnitAddress || {};
  professionalProfiles = stored.pecBpaProfessionalProfiles || {};
  fillUnitAddressForm(unitAddress);
  batches = stored.pecBpaBatches;
  if (!batches.length) {
    document.querySelector("#summary").textContent = "Nenhum lote coletado. Abra a Lista de atendimentos e use a extensão.";
    document.querySelector("#retryPending").disabled = true;
    document.querySelector("#exportJson").disabled = true;
    document.querySelector("#exportCsv").disabled = true;
    document.querySelector("#openPreview").disabled = true;
    return;
  }
  batch = batches.find(item => item.id === stored.pecBpaCurrentBatch) || batches[0];
  const select = document.querySelector("#batchSelect");
  select.innerHTML = batches.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.filters?.period || item.capturedAt)} — ${escapeHtml(item.filters?.professionals || "sem profissional")}</option>`).join("");
  select.value = batch.id;
  render();
})();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.pecBpaBatches?.newValue || !batch) return;
  const updated = changes.pecBpaBatches.newValue.find(item => item.id === batch.id);
  if (!updated) return;
  batch = updated;
  render();
});
