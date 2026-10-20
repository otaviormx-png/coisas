(() => {
  const clean = value => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  const normalize = value => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const digits = value => String(value || "").replace(/\D/g, "");
  const lines = String(document.querySelector("main")?.innerText || "").split(/\r?\n/).map(clean).filter(Boolean);
  const labels = new Set([
    "CPF", "Nº NIS (PIS/PASEP)", "CNS", "DNV", "Data de nascimento", "Sexo", "Estado civil", "Raça/cor",
    "Tipo sanguíneo", "Nome da mãe", "Nome do pai", "Orientação sexual", "Identidade de gênero", "Nacionalidade",
    "Município de nascimento", "País de residência", "CEP", "Estado", "Município", "Bairro", "Tipo de logradouro",
    "Logradouro", "Número", "Complemento", "Ponto de referência", "Está em situação de rua"
  ].map(normalize));

  function section(start, end) {
    const from = lines.findIndex(line => normalize(line) === normalize(start));
    const to = end ? lines.findIndex((line, index) => index > from && normalize(line) === normalize(end)) : lines.length;
    return from >= 0 ? lines.slice(from + 1, to > from ? to : lines.length) : [];
  }

  function valueAfter(source, label) {
    const index = source.findIndex(line => normalize(line) === normalize(label));
    if (index < 0 || index + 1 >= source.length) return "";
    const value = source[index + 1];
    return labels.has(normalize(value)) ? "" : value;
  }

  const personal = section("Dados pessoais", "Contatos");
  const residence = section("Residência", "Informações sociodemográficas");
  const heading = clean(document.querySelector("main h2")?.innerText).split("|")[0].trim();
  const cpf = digits(valueAfter(personal, "CPF"));
  const cns = digits(valueAfter(personal, "CNS"));
  const raceText = valueAfter(personal, "Raça/cor");
  const raceMap = { BRANCA: "01", PRETA: "02", PARDA: "03", AMARELA: "04", INDIGENA: "05", "SEM INFORMACAO": "99" };
  const sexText = normalize(valueAfter(personal, "Sexo"));
  const nationalityText = valueAfter(personal, "Nacionalidade");
  const municipality = valueAfter(residence, "Município");
  const streetSituation = normalize(valueAfter(residence, "Está em situação de rua"));
  const missingFields = [];
  if (!cpf && !cns) missingFields.push("CPF/CNS");
  if (!valueAfter(personal, "Data de nascimento")) missingFields.push("data de nascimento");
  if (!sexText) missingFields.push("sexo");
  if (!digits(valueAfter(residence, "CEP"))) missingFields.push("CEP");
  if (!valueAfter(residence, "Bairro")) missingFields.push("bairro");
  if (!valueAfter(residence, "Logradouro")) missingFields.push("logradouro");
  const result = {
    patientName: heading,
    citizenId: location.pathname.match(/cadastro-individual\/(\d+)/)?.[1] || "",
    cpf,
    cns,
    birthDate: valueAfter(personal, "Data de nascimento"),
    sex: sexText.startsWith("F") ? "F" : sexText.startsWith("M") ? "M" : "",
    raceColorText: raceText,
    raceColorCode: raceMap[normalize(raceText)] || "",
    nationalityText,
    nationalityCode: normalize(nationalityText) === "BRASILEIRA" ? "010" : "",
    residenceMunicipality: municipality,
    residenceMunicipalityCode: normalize(municipality) === "NITEROI" ? "330330" : "",
    postalCode: digits(valueAfter(residence, "CEP")),
    neighborhood: valueAfter(residence, "Bairro"),
    streetType: valueAfter(residence, "Tipo de logradouro"),
    street: valueAfter(residence, "Logradouro"),
    number: valueAfter(residence, "Número"),
    complement: valueAfter(residence, "Complemento"),
    streetSituation: streetSituation === "SIM" ? "S" : streetSituation === "NAO" ? "N" : ""
  };
  result.semCpfCivil = cpf.length === 11 ? "N" : cns.length === 15 ? "S" : "";
  result.missingFields = missingFields;
  result.registrationStatus = result.patientName && !missingFields.length ? "completo" : "pendente";
  result.registrationError = missingFields.length ? `Campos ausentes no cadastro: ${missingFields.join(", ")}` : "";
  return result;
})();
