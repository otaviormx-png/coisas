(() => {
  const ATTENDANCE_STATUSES = [
    { key: "ATENDIMENTO REALIZADO", label: "Atendimento realizado", excluded: false },
    { key: "ATENDIMENTO NAO REALIZADO", label: "Atendimento não realizado", excluded: false },
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
    return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  }

  function statusFor(value) {
    const normalized = normalize(value);
    return ATTENDANCE_STATUSES.find(status => normalized === status.key || normalized.includes(status.key)) || null;
  }

  function observationFor(lines) {
    const line = lines.find(item => normalize(item).startsWith("OBSERVACOES"));
    return line ? clean(line.replace(/^[^:]*:\s*/, "")) : "";
  }

  function digits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function agendaDate() {
    const raw = location.pathname.match(/\/(\d{8})$/)?.[1] || "";
    return raw ? `${raw.slice(0, 2)}/${raw.slice(2, 4)}/${raw.slice(4)}` : "";
  }

  function professionalName() {
    const input = document.querySelector('input[placeholder*="profissional" i]');
    if (input?.value) return clean(input.value);
    const main = document.querySelector("main");
    const text = main?.innerText || "";
    return clean((text.match(/Profissional:\s*([^|\n]+)/i) || [])[1]);
  }

  function appointmentButtons() {
    return [...document.querySelectorAll("main button")].filter(button => {
      const text = normalize(button.innerText);
      return Boolean(statusFor(text)) && !text.includes("NAO E POSSIVEL");
    });
  }

  function smallestDetailsContainer(link, patientName) {
    let current = link;
    while (current && current !== document.body) {
      const text = clean(current.innerText);
      if (normalize(text).includes(normalize(patientName)) && current.querySelector?.('a[href*="/gestaoCadastros/cadastro-individual/"]')) return current;
      current = current.parentElement;
    }
    return link.parentElement;
  }

  async function detailsFor(button, patientName) {
    button.click();
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 125));
      const links = [...document.querySelectorAll('a[href*="/gestaoCadastros/cadastro-individual/"]')];
      const match = links.find(link => {
        const container = smallestDetailsContainer(link, patientName);
        return normalize(container?.innerText).includes(normalize(patientName));
      });
      if (!match) continue;
      const container = smallestDetailsContainer(match, patientName);
      const text = clean(container?.innerText);
      const href = new URL(match.getAttribute("href"), location.origin);
      if (!href.pathname.endsWith("/informacoes")) href.pathname = href.pathname.replace(/\/$/, "") + "/informacoes";
      return {
        cadastroUrl: href.href,
        cpf: digits((text.match(/CPF\s*([\d.-]{11,})/i) || [])[1]),
        cns: digits((text.match(/CNS\s*(\d{15})/i) || [])[1]),
        birthDate: clean((text.match(/Data de nascimento\s*(\d{2}\/\d{2}\/\d{4})/i) || [])[1]),
        attendanceTime: clean((text.match(/das\s*(\d{2}:\d{2})\s*às/i) || [])[1])
      };
    }
    return { cadastroUrl: "", cpf: "", cns: "", birthDate: "", attendanceTime: "" };
  }

  async function collectAgenda() {
    const date = agendaDate();
    const professional = professionalName();
    const buttons = appointmentButtons();
    if (!date || !professional) throw new Error("Não foi possível identificar a data e o profissional da Agenda.");
    if (!buttons.length) throw new Error("Nenhum atendimento reconhecido foi encontrado nesta Agenda.");

    const records = [];
    for (const button of buttons) {
      const lines = String(button.innerText || "").split(/\r?\n/).map(clean).filter(Boolean);
      const patientName = clean((lines[0] || "").split("|")[0]);
      if (!patientName) continue;
      const attendanceStatus = statusFor(button.innerText) || statusFor(lines.find(line => statusFor(line)));
      const observation = observationFor(lines);
      const details = await detailsFor(button, patientName);
      records.push({
        sourceKey: normalize([professional, patientName, date, details.attendanceTime, attendanceStatus?.label || ""].join("|")),
        patientName,
        professional,
        attendanceDate: date,
        attendanceTime: details.attendanceTime,
        scheduledTime: details.attendanceTime,
        ageText: "",
        attendanceStatus: attendanceStatus?.label || "Status não identificado",
        excluded: Boolean(attendanceStatus?.excluded),
        observation,
        procedure: "",
        cid: "",
        cpf: details.cpf,
        cns: details.cns,
        birthDate: details.birthDate,
        cadastroUrl: details.cadastroUrl,
        registrationStatus: details.cadastroUrl ? "localizado" : "pendente"
      });
    }

    return {
      schemaVersion: 2,
      source: "PEC - Agenda e cadastro completo",
      sourceUrl: location.href,
      capturedAt: new Date().toISOString(),
      filters: { period: date, professionals: professional },
      ignored: 0,
      pagesRead: 1,
      records: [...new Map(records.map(item => [item.sourceKey, item])).values()]
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "PEC_GIL_COLLECT_AGENDA") return;
    collectAgenda()
      .then(batch => sendResponse({ ok: true, batch }))
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();
