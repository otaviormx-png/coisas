const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "review.js"), "utf8");
const setup = source.slice(0, source.indexOf('document.querySelector("#save").addEventListener'));
const result = vm.runInNewContext(`${setup}
  (() => {
    const record = { professional: "Camilla Assumpção de Carvalho", procedure: "0302050027", cid: "M545" };
    applyProfile(record);
    return record;
  })();`);

assert.equal(result.profileId, "fisio");
assert.equal(result.procedure, "0302050027");
assert.equal(result.cid, "M545");
assert.equal(result.cidRequired, true);

const custom = vm.runInNewContext(`${setup}
  (() => {
    professionalProfiles[normalize("Dra. Nova Profissional")] = {
      name: "Dra. Nova Profissional",
      procedure: "0302050027",
      cidRequired: true,
      label: "Dra. Nova Profissional: regra personalizada"
    };
    const record = { professional: "Dra. Nova Profissional", procedure: "", cid: "" };
    applyProfile(record);
    return record;
  })();`);

assert.equal(custom.profileId, "custom");
assert.equal(custom.procedure, "0302050027");
assert.equal(custom.cidRequired, true);
