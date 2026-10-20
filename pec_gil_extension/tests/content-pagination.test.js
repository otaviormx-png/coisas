const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function row(name, date) {
  const item = {
    innerText: `${date} - 09:00\nAtendimento realizado\n${name}\n40 anos\n09:00 | Profissional\nProfissional`,
    querySelectorAll(selector) {
      if (selector === "time") return [time];
      if (selector.includes("Mais opções")) return [{}];
      return [];
    }
  };
  const time = { textContent: `${date} - 09:00`, parentElement: item };
  return { item, time };
}

async function collect(expectedTotal) {
  const pages = [[row("Paciente Um", "04/09/2026")], [row("Paciente Dois", "02/09/2026")]];
  let selected = 0;
  let rendered = 0;
  let listener;
  const main = {
    get innerText() { return `Período: 01/09/2026 até hoje | Profissionais: Profissional\n${expectedTotal} resultados`; },
    querySelectorAll(selector) {
      if (selector === "time") return pages[rendered].map(item => item.time);
      if (selector.includes("Mais opções")) return pages[rendered].map(() => ({}));
      return [];
    }
  };
  const button = direction => ({
    get disabled() { return direction === -1 ? selected === 0 : selected === pages.length - 1; },
    click() {
      selected += direction;
      setTimeout(() => { rendered = selected; }, 650);
    },
    getAttribute() { return null; }
  });
  const document = {
    body: {},
    querySelector(selector) {
      if (selector === "main") return main;
      if (selector === 'input[aria-label="Página atual"]') return { value: String(selected + 1) };
      if (selector === 'button[title="Próxima página"]') return button(1);
      if (selector === 'button[title="Página anterior"]') return button(-1);
      return null;
    },
    querySelectorAll() { return []; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), {
    document,
    location: { href: "https://example.test/lista-atendimento" },
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
    setTimeout,
    Date
  });
  const response = await new Promise(resolve => listener({ type: "PEC_GIL_COLLECT" }, {}, resolve));
  return { response, selected };
}

async function run() {
  const { response, selected } = await collect(2);
  assert.equal(response.ok, true, response.error);
  assert.equal(response.batch.pagesRead, 2);
  assert.equal(response.batch.records.length, 2);
  assert(response.batch.records.some(item => item.attendanceDate === "02/09/2026"));
  assert.equal(selected, 0);

  const incomplete = (await collect(3)).response;
  assert.equal(incomplete.ok, false);
  assert.match(incomplete.error, /Coleta incompleta/);
}

run().catch(error => { console.error(error); process.exitCode = 1; });
