(() => {
  const ATTENDANCE_STATUSES = [
    { key: "ATENDIMENTO REALIZADO", label: "Atendimento realizado", excluded: false },
    { key: "ATENDIMENTO NAO REALIZADO", label: "Atendimento não realizado", excluded: true },
    { key: "NAO COMPARECEU", label: "Não compareceu", excluded: true },
    { key: "AGUARDANDO ATENDIMENTO", label: "Aguardando atendimento", excluded: false },
    { key: "EM ATENDIMENTO", label: "Em atendimento", excluded: false },
    { key: "PRESENTE NA UNIDADE", label: "Presente na unidade", excluded: false },
    { key: "ESCUTA INICIAL", label: "Escuta inicial", excluded: false }
  ];

  function clean(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalize(value) {
    return clean(value)
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase();
  }

  function statusFor(value) {
    const normalized = normalize(value);
    return ATTENDANCE_STATUSES.find(status => normalized === status.key || normalized.includes(status.key)) || null;
  }

  function linesOf(element) {
    return String(element?.innerText || "")
      .split(/\r?\n/)
      .map(clean)
      .filter(Boolean);
  }

  function findRow(timeElement) {
    let current = timeElement;
    while (current && current !== document.body) {
      const menus = current.querySelectorAll?.('button[title="Mais opções"], button[data-testid="Button.Dropdown"]').length || 0;
      if (menus === 1) return current;
      current = current.parentElement;
    }
    return null;
  }

  function extractPatientName(timeElement, row, lines, statusIndex) {
    const dateGroup = timeElement.parentElement?.parentElement;
    const patientGroup = dateGroup?.nextElementSibling;
    const structuralName = clean(patientGroup?.querySelector("span")?.textContent);
    if (structuralName && !statusFor(structuralName)) {
      return structuralName;
    }
    return clean(lines[statusIndex + 1]);
  }

  function extractSummary(mainText) {
    const period = clean((mainText.match(/Período:\s*([^|\n]+)/i) || [])[1]);
    const professionals = clean((mainText.match(/Profissionais:\s*([^|\n]+)/i) || [])[1]);
    return { period, professionals };
  }

  function parseDateTime(value) {
    const match = clean(value).match(/^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}:\d{2})$/);
    return match ? { date: match[1], time: match[2] } : { date: "", time: "" };
  }

  function collectPage() {
    const main = document.querySelector("main");
    if (!main) throw new Error("A área principal da Lista de atendimentos não foi encontrada.");

    const summary = extractSummary(main.innerText || "");
    const records = [];
    const seenRows = new Set();
    let ignored = 0;

    for (const timeElement of main.querySelectorAll("time")) {
      const row = findRow(timeElement);
      if (!row || seenRows.has(row)) continue;
      const occurred = [...row.querySelectorAll("time")]
        .map(element => ({ element, ...parseDateTime(element.textContent) }))
        .find(item => item.date);
      if (!occurred) continue;
      seenRows.add(row);
      const lines = linesOf(row);
      const statusIndex = lines.findIndex(line => statusFor(line));
      if (statusIndex < 0) {
        ignored += 1;
        continue;
      }

      const attendanceStatus = statusFor(lines[statusIndex]);
      const patientName = extractPatientName(occurred.element, row, lines, statusIndex);
      const age = clean(lines[statusIndex + 2]);
      const scheduledLine = lines.find(line => /^\d{1,2}:\d{2}\s*\|?/.test(line));
      const scheduledTime = clean((scheduledLine?.match(/^(\d{1,2}:\d{2})/) || [])[1]);
      const attendanceType = lines.some(line => normalize(line) === normalize("DEMANDA ESPONTÂNEA"))
        ? "demanda-espontanea"
        : "agendado";
      const professional = summary.professionals && !summary.professionals.includes(",")
        ? summary.professionals
        : clean(lines[lines.length - 1]);

      if (!patientName) {
        ignored += 1;
        continue;
      }
      records.push({
        sourceKey: normalize([professional, patientName, occurred.date, occurred.time, attendanceStatus.label].join("|")),
        patientName,
        professional,
        attendanceDate: occurred.date,
        attendanceTime: occurred.time,
        scheduledTime,
        attendanceType,
        ageText: age,
        attendanceStatus: attendanceStatus.label,
        excluded: attendanceStatus.excluded,
        procedure: "",
        cid: "",
        cpf: "",
        cns: "",
        registrationStatus: "pendente"
      });
    }

    const rowCount = main.querySelectorAll('button[title="Mais opções"], button[data-testid="Button.Dropdown"]').length;
    return { summary, ignored, rowCount, records };
  }

  function pageButton(title) {
    return document.querySelector(`button[title="${title}"]`);
  }

  function isDisabled(button) {
    return !button || button.disabled || button.getAttribute("aria-disabled") === "true";
  }

  function currentPage() {
    const labelled = document.querySelector('input[aria-label="Página atual"]');
    if (labelled?.value) return Number(labelled.value) || 1;
    const inputs = [...document.querySelectorAll("main input")];
    const candidate = inputs.find(input => /^\d+$/.test(input.value || ""));
    return Number(candidate?.value) || 1;
  }

  function pageSignature() {
    const main = document.querySelector("main");
    const seen = new Set();
    return [...(main?.querySelectorAll("time") || [])]
      .map(time => findRow(time))
      .filter(row => row && !seen.has(row) && seen.add(row))
      .map(row => clean(row.innerText))
      .join("|");
  }

  async function clickAndWait(button) {
    const before = pageSignature();
    button.click();
    let changedAt = 0;
    let last = "";
    for (let attempt = 0; attempt < 200; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = pageSignature();
      if (after && after !== before) {
        if (after !== last) changedAt = Date.now();
        if (Date.now() - changedAt >= 400) return;
      } else {
        changedAt = 0;
      }
      last = after;
    }
    throw new Error("Os atendimentos da próxima página não carregaram no PEC. Confira a Lista e tente novamente.");
  }

  function totalResults() {
    const text = document.querySelector("main")?.innerText || "";
    const matches = [...text.matchAll(/\b([\d.]+)\s+resultados?\b/gi)];
    return matches.length ? Number(matches[matches.length - 1][1].replace(/\./g, "")) : null;
  }

  async function goToFirstPage() {
    let guard = 0;
    while (!isDisabled(pageButton("Página anterior")) && guard < 100) {
      await clickAndWait(pageButton("Página anterior"));
      guard += 1;
    }
  }

  async function collectAllPages() {
    await goToFirstPage();
    const expectedTotal = totalResults();
    const combined = new Map();
    let ignored = 0;
    let filters = { period: "", professionals: "" };
    let pagesRead = 0;
    let rowsRead = 0;

    while (pagesRead < 200) {
      const page = collectPage();
      if (page.ignored || page.records.length !== page.rowCount) {
        throw new Error(`A página ${currentPage()} tem ${page.rowCount} atendimento(s), mas só ${page.records.length} foram lidos. Atualize a Lista e tente novamente.`);
      }
      filters = page.summary;
      ignored += page.ignored;
      rowsRead += page.rowCount;
      page.records.forEach(record => combined.set(record.sourceKey, record));
      pagesRead += 1;

      const next = pageButton("Próxima página");
      if (isDisabled(next)) break;
      await clickAndWait(next);
    }

    if (expectedTotal !== null && (rowsRead !== expectedTotal || combined.size !== expectedTotal)) {
      throw new Error(`Coleta incompleta: o PEC mostra ${expectedTotal} resultado(s), mas a extensão leu ${rowsRead} linha(s) e ${combined.size} atendimento(s) distintos. Confira a paginação e tente novamente.`);
    }

    await goToFirstPage();
    return {
      schemaVersion: 1,
      source: "PEC - Lista de atendimentos",
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      filters,
      ignored,
      pagesRead,
      expectedTotal,
      records: [...combined.values()]
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "PEC_BPA_COLLECT") return;
    collectAllPages()
      .then(batch => sendResponse({ ok: true, batch }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
