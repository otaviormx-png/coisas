(() => {
  const norm = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();
  const digits = value => String(value || '').replace(/\D/g, '');
  const isRaul = value => ['RAUL PIMENTEL KASTRUP', 'RAUL KASTRUP'].includes(norm(value));
  const defaults = { professional: 'Raul Pimentel Kastrup', gilProfessional: 'RAUL KASTRUP', matricula: '52573220', unit: '001273400', procedure: '0301010072', cid: 'Z000', natureza: '3' };
  function validDate(value) {
    const m = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return false;
    const date = new Date(+m[3], +m[2] - 1, +m[1]);
    return date.getFullYear() === +m[3] && date.getMonth() === +m[2] - 1 && date.getDate() === +m[1];
  }
  function missing(record) {
    const fields = [];
    if (!isRaul(record.professional)) fields.push('profissional não autorizado');
    if (!norm(record.patientName)) fields.push('nome');
    if (!validDate(record.attendanceDate)) fields.push('data do atendimento');
    if (!validDate(record.birthDate)) fields.push('nascimento exato');
    if (!['M', 'F', '1', '2'].includes(String(record.sex || ''))) fields.push('sexo');
    if (/cadastros parecidos|confirme manualmente|mais de um|hom[oô]nimo/i.test(record.registrationError || '')) fields.push('identidade precisa de confirmação');
    return fields;
  }
  function recordKey(record) { return record.sourceKey || [norm(record.patientName), record.attendanceDate, record.attendanceTime].join('|'); }
  function duplicateKey(record) { return [norm(record.patientName), record.attendanceDate, defaults.procedure].join('|'); }
  function normalizeBatch(raw) {
    const records = (raw.records || []).filter(r => isRaul(r.professional)).map(r => ({ ...r, procedure: defaults.procedure, cid: defaults.cid }));
    const names = String(raw.filters?.professionals || '').split(',').map(s => s.trim());
    if (!records.length && !names.some(isRaul)) throw Error('Selecione o Raul nos filtros do PEC. Esta extensão não coleta os outros profissionais.');
    return { ...raw, records, filters: { ...raw.filters, professionals: defaults.professional }, discardedProfessionals: (raw.records || []).length - records.length };
  }
  function exportPayload(batch) {
    if (batch.enrichmentStatus === 'processando') throw Error('Aguarde a coleta terminar antes de exportar.');
    const records = (batch.records || []).filter(r => r.gilSelected && !r.gilExcluded);
    if (!records.length) throw Error('Selecione os atendimentos que você confirma terem sido realizados.');
    const seen = new Set();
    for (const record of records) {
      const absent = missing(record);
      if (absent.length) throw Error(`${record.patientName}: falta ${absent.join(', ')}.`);
      const key = duplicateKey(record);
      if (seen.has(key)) throw Error(`${record.patientName}: mesmo atendimento repetido em ${record.attendanceDate}. Desmarque uma das linhas.`);
      seen.add(key);
    }
    return { schemaVersion: 1, destination: 'GIL_RAUL', ...defaults, period: batch.filters?.period || '',
      capturedAt: batch.capturedAt, selectionConfirmedAt: new Date().toISOString(), databaseWritten: false,
      summary: { total: records.length, dates: [...new Set(records.map(r => r.attendanceDate))], professionals: [defaults.professional] },
      records: records.map(r => ({ ...r, professional: defaults.professional, procedure: defaults.procedure, cid: defaults.cid,
        natureza: defaults.natureza, sex: ['M', '1'].includes(r.sex) ? '1' : '2', age: r.age || r.ageText || '', selected: true })) };
  }
  const api = { norm, digits, isRaul, defaults, validDate, missing, recordKey, duplicateKey, normalizeBatch, exportPayload };
  if (typeof module !== 'undefined') module.exports = api;
  else globalThis.GilRules = api;
})();
