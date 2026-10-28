using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

public sealed class ImportadorForm : Form
{
    readonly string mode;
    readonly string root = AppDomain.CurrentDomain.BaseDirectory;
    readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 128 * 1024 * 1024, RecursionLimit = 100 };
    readonly Dictionary<string, TextBox> fields = new Dictionary<string, TextBox>();
    readonly Dictionary<string, Button> buttons = new Dictionary<string, Button>();
    Dictionary<string, object> state;
    Dictionary<string, object> bindings = new Dictionary<string, object>();
    List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
    GroupBox connection;
    DataGridView grid;
    Label status;
    CheckBox strict, coringa, deleteSource, automaticLogin;
    Process worker;
    StreamWriter input;
    bool busy, populating, canSimulate, simulated, unsavedChanges;
    int requestId;
#if QA
    bool qaMode;
#endif

    static readonly Dictionary<string, string> Labels = new Dictionary<string, string> {
        {"dsn","Banco (servidor:caminho)"},{"user","Usuário Firebird (banco)"},{"password","Senha Firebird (banco)"},{"competence","Competência AAAAMM"},
        {"cnes","CNES"},{"unit","Unidade GIL"},{"matricula","Matrícula Raul"},{"specialty","Especialidade"},
        {"client","Cliente fbclient.dll"},{"gbak","GBAK do servidor"},{"backup_dir","Backups e recibos"},
        {"patientName","Nome do paciente"},{"attendanceDate","Data do atendimento"},{"professional","Profissional"},
        {"cpf","CPF"},{"cns","CNS"},{"birthDate","Nascimento"},{"sex","Sexo (M/F ou 1/2)"},{"procedure","Procedimento"},{"cid","CID"},
        {"postalCode","CEP"},{"residenceMunicipalityCode","Município IBGE"},{"neighborhood","Bairro"},
        {"streetType","Tipo de logradouro"},{"street","Logradouro"},{"number","Número"},{"complement","Complemento"},
        {"raceColorCode","Raça/cor (código)"},{"nationalityCode","Nacionalidade"},{"ethnicityCode","Etnia"},{"streetSituation","Situação de rua S/N"}
    };

    static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
    static object Get(Dictionary<string, object> obj, string key) { object value; return obj != null && obj.TryGetValue(key, out value) ? value : null; }
    static string S(object value) { return value == null ? "" : Convert.ToString(value, CultureInfo.InvariantCulture); }
    static bool B(object value) { return value != null && Convert.ToBoolean(value, CultureInfo.InvariantCulture); }
    static int N(object value) { return value == null ? 0 : Convert.ToInt32(value, CultureInfo.InvariantCulture); }
    static List<Dictionary<string, object>> Rows(object value) { return (value as object[] ?? new object[0]).Select(Map).ToList(); }
    static string Key(string value) { var b = new StringBuilder(); foreach (char c in (value ?? "").Normalize(NormalizationForm.FormD)) if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark) b.Append(c); return System.Text.RegularExpressions.Regex.Replace(b.ToString().ToUpperInvariant(), @"\s+", " ").Trim(); }
    static Dictionary<string, object> Obj(params object[] pairs) { var d = new Dictionary<string, object>(); for (int i = 0; i < pairs.Length; i += 2) d[(string)pairs[i]] = pairs[i + 1]; return d; }

    public ImportadorForm(string selectedMode)
    {
        mode = selectedMode;
        Text = mode == "bpa" ? "Revisão PEC para BPA-I — aplicativo local" : "Revisão PEC para GIL — Raul — aplicativo local";
        Size = new Size(1320, 850); MinimumSize = new Size(1100, 700); StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 10);
        var banner = new Label { Dock = DockStyle.Top, Height = 72, Padding = new Padding(15, 10, 10, 5),
            BackColor = Color.FromArgb(18, 59, 73), ForeColor = Color.White,
            Text = mode == "bpa" ? "Revisão PEC para BPA-I\r\nJanela local · sem navegador e sem servidor HTTP" : "Revisão PEC para GIL — Raul\r\nUso opcional. Confira explicitamente o banco antes de conectar." };
        connection = new GroupBox { Text = "Conexão e configurações do lote", Dock = DockStyle.Top, Height = mode == "bpa" ? 205 : 235 };
        var layout = MakeLayout();
        var keys = new List<string> { "dsn", "user", "password" };
        keys.AddRange(mode == "bpa" ? new[] { "competence", "cnes" } : new[] { "unit", "matricula", "specialty" });
        keys.AddRange(new[] { "client", "gbak", "backup_dir" });
        for (int i = 0; i < keys.Count; i++) {
            var key = keys[i]; var box = AddField(layout, key, "", i);
            box.UseSystemPasswordChar = key == "password";
            box.TextChanged += delegate { InvalidatePreview(); };
            fields[key] = box;
        }
        connection.Controls.Add(layout);
        var actions = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 49, Padding = new Padding(10, 7, 5, 5) };
        var names = new[] { "open", "links", "preview", "simulate", "commit", "draft", "close" };
        var captions = new[] { "Abrir JSON", "Vínculos BPA", "Gerar prévia", "Simular sem gravar", "Gravar lote", "Salvar rascunho", "Encerrar" };
        for (int i = 0; i < names.Length; i++) {
            if (names[i] == "links" && mode != "bpa") continue;
            var btn = new Button { Text = captions[i], AutoSize = true, Height = 31, Padding = new Padding(5, 0, 5, 0) };
            buttons[names[i]] = btn; actions.Controls.Add(btn);
        }
        buttons["commit"].BackColor = Color.FromArgb(0, 108, 105); buttons["commit"].ForeColor = Color.White;
        var options = new FlowLayoutPanel { Dock = DockStyle.Top, Height = 62, Padding = new Padding(12, 3, 5, 3) };
        strict = new CheckBox { Text = "Bloquear textos acima dos limites do BPA", AutoSize = true, Visible = mode == "bpa" };
        coringa = new CheckBox { Text = "Permitir prontuário 9 para identificação conferida sem cadastro", AutoSize = true, Visible = mode == "gil" };
        deleteSource = new CheckBox { Text = "Excluir JSON após gravação e conferência", AutoSize = true, Checked = true };
        automaticLogin = new CheckBox { Text = "Login automático protegido pelo Windows", AutoSize = true, Checked = true };
        automaticLogin.CheckedChanged += delegate { if (!populating) { FillAutomaticLogin(); InvalidatePreview(); } };
        fields["dsn"].Leave += delegate { FillAutomaticLogin(); };
        strict.CheckedChanged += delegate { InvalidatePreview(); }; coringa.CheckedChanged += delegate { InvalidatePreview(); };
        options.Controls.AddRange(new Control[] { strict, coringa, deleteSource, automaticLogin });
        status = new Label { Dock = DockStyle.Top, Height = 68, Padding = new Padding(12, 6, 5, 5), BackColor = Color.FromArgb(237, 246, 246), Text = "Abra o JSON exportado pela extensão. Nenhum banco foi alterado." };
        grid = new DataGridView { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false,
            RowHeadersVisible = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false,
            AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill, BackgroundColor = Color.White };
        string[] columnNames = { "name", "date", "professional", "procedure", "cid", "status", "location", "detail" };
        string[] headings = { "Paciente", "Data", "Profissional", "Procedimento", "CID", "Situação", "Folha/lote", "Conferência" };
        for (int i = 0; i < columnNames.Length; i++) grid.Columns.Add(columnNames[i], headings[i]);
        grid.Columns["detail"].FillWeight = 220; grid.Columns["name"].FillWeight = 150; grid.Columns["date"].FillWeight = 70;
        grid.Columns["cid"].FillWeight=45;grid.Columns["procedure"].FillWeight=90;
        grid.Columns.Add(new DataGridViewButtonColumn { Name = "edit", HeaderText = "", FillWeight = 65 });
        grid.CellContentClick += delegate(object sender, DataGridViewCellEventArgs e) { if (!busy && e.RowIndex >= 0 && e.ColumnIndex >= 0 && grid.Columns[e.ColumnIndex].Name == "edit") EditRecord((int)grid.Rows[e.RowIndex].Tag); };
        var footer = new Label { Dock = DockStyle.Bottom, Height = 40, Padding = new Padding(12, 7, 5, 5), Text = "Use a conta do banco Firebird, não o login MESTRE da tela do BPA. Gere a prévia e simule antes de gravar." };
        Controls.AddRange(new Control[] { grid, footer, status, options, actions, connection, banner });
        buttons["open"].Click += async delegate {
            if(!await ConfirmUnsaved())return;
            using (var dialog = new OpenFileDialog { Filter = "Revisão PEC (*.json)|*.json", Title = "Abrir o JSON revisado da extensão" }) {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                status.Text = "Lendo o JSON...";
                var result = await Request("open", Obj("path", dialog.FileName));
                if (result != null) { unsavedChanges=false;Populate(result); status.Text = records.Count + " registros carregados. Confira a conexão e gere a prévia."; }
            }
        };
        if (mode == "bpa") buttons["links"].Click += async delegate {
            status.Text = "Lendo os vínculos cadastrados no BPA...";
            var result = await RequestValue("links", RequestData());
            if (result != null) { var setup=Map(result);ShowBindings(Rows(Get(setup,"links")),Map(Get(setup,"suggestions"))); var saved = await Request("settings", RequestData()); if (saved != null) Populate(saved);if(S(Get(setup,"warning")).Length>0)status.Text=S(Get(setup,"warning")); }
        };
        buttons["preview"].Click += async delegate {
            status.Text = "Conferindo o banco e preparando a prévia...";
            var result = await Request("preview", RequestData());
            if (result != null) { Populate(result); int existing = Rows(Get(result, "rows")).Count(r => S(Get(r, "status")) == "EXISTENTE"); status.Text = N(Get(result, "new")) + " novos | " + existing + " existentes | " + N(Get(result, "pending")) + " pendentes. Confira os dados antes de simular.\r\n"+S(Get(result,"setupWarning")); }
        };
        buttons["simulate"].Click += async delegate {
            status.Text = "Simulando o lote. As alterações serão desfeitas...";
            var result = await Request("simulate", RequestData());
            if (result != null) { Populate(Map(Get(result, "state"))); status.Text = "Simulação concluída: " + N(Get(Map(Get(result, "result")), "new")) + " atendimentos conferidos. A transação foi desfeita."; }
        };
        buttons["commit"].Click += async delegate {
            if (!simulated) return;
            if (MessageBox.Show(this, "Gravar " + N(Get(state, "new")) + " atendimentos?\r\n\r\nConfira unidade e competência. Feche o BPA/GIL. Será feito backup antes da transação.", "Confirmar gravação", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
            var data = RequestData(); data["confirm"] = true; data["deleteSource"] = deleteSource.Checked;
            status.Text = "Criando backup, gravando e conferindo...";
            var result = await Request("commit", data);
            if (result != null) {
                unsavedChanges=false;Populate(Map(Get(result, "state"))); var receipt = Map(Get(result, "result"));
                string message = "Gravação conferida: " + N(Get(receipt, "new")) + " atendimentos.\r\nBackup: " + S(Get(receipt, "backup"));
                if (B(Get(receipt, "sourceDeleted"))) message += "\r\nJSON de entrada excluído.";
                if (Get(receipt, "cleanupWarning") != null) message += "\r\n" + S(Get(receipt, "cleanupWarning"));
                status.Text = message; MessageBox.Show(this, message + "\r\nLimpe separadamente o rascunho da extensão no Chrome.", "Gravação conferida", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        };
        buttons["draft"].Click += async delegate {
            using (var dialog = new SaveFileDialog { Filter = "JSON (*.json)|*.json", FileName = "revisao_pec_rascunho.json", OverwritePrompt = true }) {
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                if (await Request("saveDraft", Obj("path", dialog.FileName, "records", records.ToArray())) != null){unsavedChanges=false; status.Text = "Rascunho salvo. Guarde-o apenas enquanto necessário.";}
            }
        };
        buttons["close"].Click += delegate { Close(); };
        Shown += async delegate {
            try { StartWorker(); var result = await Request("state", Obj()); if (result != null) Populate(result); }
            catch (Exception e) { MessageBox.Show(this, e.Message, "Não foi possível abrir o importador", MessageBoxButtons.OK, MessageBoxIcon.Error); Close(); }
        };
        FormClosing += async delegate(object sender, FormClosingEventArgs e) {
            if (busy) { e.Cancel = true; MessageBox.Show(this, "Aguarde a operação terminar antes de fechar.", "Operação em andamento"); return; }
            if(unsavedChanges){e.Cancel=true;if(await ConfirmUnsaved())Close();return;}
            fields["password"].Clear();
            if (worker != null) { try { if (!worker.HasExited) { if (input != null) input.Close(); if (!worker.WaitForExit(2000)) worker.Kill(); } } catch { } worker.Dispose(); }
            records.Clear(); state = null;
        };
        UpdateButtons();
    }

    TableLayoutPanel MakeLayout() {
        var layout = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, Padding = new Padding(10), AutoScroll = true };
        foreach (float width in new float[] { 18, 32, 18, 32 }) layout.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, width));
        return layout;
    }
    TextBox AddField(TableLayoutPanel layout, string key, string value, int index) {
        var label = new Label { Text = Labels.ContainsKey(key) ? Labels[key] : key, AutoSize = true, Anchor = AnchorStyles.Left };
        var box = new TextBox { Text = value, Dock = DockStyle.Fill };
        layout.Controls.Add(label, (index % 2) * 2, index / 2); layout.Controls.Add(box, (index % 2) * 2 + 1, index / 2);
        return box;
    }
    void InvalidatePreview() { if (populating) return; canSimulate = simulated = false; if (status != null) status.Text = "Dados alterados. Gere uma nova prévia antes de simular ou gravar."; UpdateButtons(); }
    void UpdateButtons() {
        if (connection == null || grid == null || strict == null || deleteSource == null || !buttons.ContainsKey("commit")) return;
        foreach (var pair in buttons) pair.Value.Enabled = !busy;
        foreach (var key in new[] { "preview", "draft", "links" }) if (buttons.ContainsKey(key)) buttons[key].Enabled = !busy && records.Count > 0;
        buttons["simulate"].Enabled = !busy && canSimulate; buttons["commit"].Enabled = !busy && simulated;
        connection.Enabled = grid.Enabled = strict.Enabled = coringa.Enabled = deleteSource.Enabled = automaticLogin.Enabled = !busy;
    }
    Dictionary<string, object> RequestData() {
        var cfg = Obj(); foreach (var key in new[] { "dsn", "user", "client", "gbak", "backup_dir" }) cfg[key] = fields[key].Text.Trim();
        var opts = new Dictionary<string, object>(Map(Get(state, "options")));
        foreach (var key in new[] { "competence", "cnes", "unit", "matricula", "specialty" }) if (fields.ContainsKey(key)) opts[key] = fields[key].Text.Trim();
        opts["bindings"] = bindings; opts["allow_coringa"] = coringa.Checked; opts["strict_text"] = strict.Checked;opts["remember_login"]=automaticLogin.Checked;
        return Obj("config", cfg, "options", opts, "password", fields["password"].Text, "records", records.ToArray());
    }
    void Populate(Dictionary<string, object> next) {
        state = next; records = Rows(Get(next, "records")); var opts = Map(Get(next, "options")); bindings = new Dictionary<string, object>(Map(Get(opts, "bindings")));
        populating = true;
        try {
            foreach (var pair in Map(Get(next, "config"))) if (fields.ContainsKey(pair.Key)) fields[pair.Key].Text = S(pair.Value);
            foreach (var key in new[] { "competence", "cnes", "unit", "matricula", "specialty" }) if (fields.ContainsKey(key)) fields[key].Text = S(Get(opts, key));
            strict.Checked = B(Get(opts, "strict_text")); coringa.Checked = B(Get(opts, "allow_coringa"));automaticLogin.Checked=Get(opts,"remember_login")==null||B(Get(opts,"remember_login"));
        } finally { populating = false; }
        FillAutomaticLogin();
        grid.Rows.Clear(); var rows = Rows(Get(next, "rows"));
        if (rows.Count == 0) {
            for (int n = 0; n < records.Count; n++) { var r = records[n]; int index = grid.Rows.Add(S(Get(r, "patientName")), S(Get(r, "attendanceDate")), S(Get(r, "professional")),S(Get(r,"procedure")),S(Get(r,"cid")), "A CONFERIR", "", "", "Editar"); grid.Rows[index].Tag = n; }
        } else {
            foreach (var r in rows) {
                int index = grid.Rows.Add(S(Get(r, "name")), S(Get(r, "date")), S(Get(r, "professional")),S(Get(r,"procedure")),S(Get(r,"cid")), S(Get(r, "status")), S(Get(r, "location")), S(Get(r, "detail")), "Editar");
                var matches = Enumerable.Range(0, records.Count).Where(n => S(Get(records[n], "patientName")) == S(Get(r, "name")) && S(Get(records[n], "attendanceDate")) == S(Get(r, "date")) && S(Get(records[n], "professional")) == S(Get(r, "professional"))&&S(Get(records[n],"procedure"))==S(Get(r,"procedure"))&&S(Get(records[n],"cid"))==S(Get(r,"cid"))).ToList();
                grid.Rows[index].Tag = matches.Count == 1 ? matches[0] : -1;
                if (S(Get(r, "status")) == "PENDENTE") grid.Rows[index].DefaultCellStyle.BackColor = Color.MistyRose;
                if (S(Get(r, "status")) == "EXISTENTE") grid.Rows[index].DefaultCellStyle.ForeColor = Color.DimGray;
            }
        }
        canSimulate = rows.Count > 0 && N(Get(next, "pending")) == 0 && N(Get(next, "new")) > 0; simulated = B(Get(next, "simulated")); UpdateButtons();
    }
    void StartWorker() {
        var start = new ProcessStartInfo { FileName = "python.exe", Arguments = "-u \"" + Path.Combine(root, "native_worker.py") + "\" --mode " + mode,
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = new UTF8Encoding(false), StandardErrorEncoding = new UTF8Encoding(false) };
        start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8"; start.EnvironmentVariables["PYTHONUTF8"] = "1";
        worker = Process.Start(start); if (worker == null) throw new Exception("Não foi possível iniciar o Python.");
        input = new StreamWriter(worker.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true };
    }
    async Task<object> RequestValue(string action, Dictionary<string, object> data) {
        if (busy) return null; busy = true; UpdateButtons();
        try {
            if (worker == null || worker.HasExited) throw new Exception("O processo de importação terminou. Confira o Python e as dependências e abra novamente.");
            int id = ++requestId;
            input.WriteLine(json.Serialize(Obj("id", id, "action", action, "data", data))); input.Flush();
            string line = await worker.StandardOutput.ReadLineAsync();
            if (line == null) throw new Exception("O processo de importação terminou sem responder. Confira o Python e as dependências.");
            var response = Map(json.DeserializeObject(line));
            if (N(Get(response, "id")) != id) throw new Exception("Resposta fora de sequência. Feche e abra o aplicativo.");
            if (!B(Get(response, "ok"))) throw new Exception(S(Get(response, "error")));
            if(automaticLogin.Checked&&(action=="links"||action=="preview")&&S(Get(data,"password")).Length>0){
                try{var cfg=Map(Get(data,"config"));WindowsCredentials.Save(mode,S(Get(cfg,"dsn")),S(Get(cfg,"user")),S(Get(data,"password")));}
                catch(Exception){status.Text="Conexão efetuada, mas o Windows não permitiu salvar o login automático nesta sessão.";}
            }
            return Get(response, "data");
        } catch (Exception e) {
#if QA
            if (qaMode) throw;
#endif
            simulated = false; status.Text = "Operação interrompida. Confira a mensagem antes de repetir.";
            MessageBox.Show(this, e.Message, "Conferência necessária", MessageBoxButtons.OK, MessageBoxIcon.Error); return null;
        } finally { data.Remove("password"); busy = false; UpdateButtons(); }
    }
    async Task<Dictionary<string, object>> Request(string action, Dictionary<string, object> data) { var value = await RequestValue(action, data); return value == null ? null : Map(value); }

    async Task<bool> ConfirmUnsaved() {
        if(!unsavedChanges)return true;
        var answer=MessageBox.Show(this,"Há alterações na revisão que ainda não foram salvas em um rascunho. Deseja salvá-las antes de continuar?","Salvar alterações",MessageBoxButtons.YesNoCancel,MessageBoxIcon.Question);
        if(answer==DialogResult.Cancel)return false;
        if(answer==DialogResult.No){unsavedChanges=false;return true;}
        using(var dialog=new SaveFileDialog{Filter="JSON (*.json)|*.json",FileName="revisao_pec_rascunho.json",OverwritePrompt=true}){
            if(dialog.ShowDialog(this)!=DialogResult.OK)return false;
            var result=await Request("saveDraft",Obj("path",dialog.FileName,"records",records.ToArray()));
            if(result==null)return false;unsavedChanges=false;return true;
        }
    }

    void EditRecord(int index) {
        if (index < 0) { MessageBox.Show(this, "Há registros idênticos. Corrija as duplicidades na extensão e exporte novamente."); return; }
        var keys = new List<string> { "patientName", "attendanceDate", "professional", "cpf", "cns", "birthDate", "sex", "procedure", "cid" };
        if (mode == "bpa") keys.AddRange(new[] { "postalCode", "residenceMunicipalityCode", "neighborhood", "streetType", "street", "number", "complement", "raceColorCode", "nationalityCode", "ethnicityCode", "streetSituation" });
        using (var dialog = new Form { Text = "Conferir identificação e atendimento", Size = new Size(1100, 650), StartPosition = FormStartPosition.CenterParent, Font = Font }) {
            var layout = MakeLayout(); var edits = new Dictionary<string, TextBox>();
            for (int i = 0; i < keys.Count; i++) edits[keys[i]] = AddField(layout, keys[i], S(Get(records[index], keys[i])), i);
            var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 50, Padding = new Padding(10) };
            var apply = new Button { Text = "Aplicar à revisão", Width = 160, DialogResult = DialogResult.OK }; var cancel = new Button { Text = "Cancelar", DialogResult = DialogResult.Cancel };
            bar.Controls.AddRange(new Control[] { apply, cancel }); dialog.Controls.Add(layout); dialog.Controls.Add(bar); dialog.CancelButton = cancel;
            if (dialog.ShowDialog(this) == DialogResult.OK) {
                foreach (var key in keys) records[index][key] = edits[key].Text.Trim();
                unsavedChanges=true;
                state["records"] = records.Cast<object>().ToArray(); state["rows"] = new object[0]; state["simulated"] = false;
                InvalidatePreview(); Populate(state);
                status.Text="Alterações aplicadas nesta revisão. Clique em Gerar prévia. Para guardar o arquivo editado, use Salvar rascunho.";
            }
        }
    }
    void FillAutomaticLogin() {
        bool loaded=false;string user,password;bool previous=populating;populating=true;
        try{if(automaticLogin.Checked&&WindowsCredentials.TryLoad(mode,fields["dsn"].Text,out user,out password)){fields["user"].Text=user;fields["password"].Text=password;loaded=true;}}
        finally{populating=previous;fields["user"].ReadOnly=fields["password"].ReadOnly=loaded;}
    }
    void ShowBindings(List<Dictionary<string, object>> links, Dictionary<string,object> suggestions) {
        using (var dialog = new Form { Text = "Vínculos profissionais do BPA", Size = new Size(1200, 550), StartPosition = FormStartPosition.CenterParent, Font = Font }) {
            var list = new DataGridView { Dock = DockStyle.Fill, AllowUserToAddRows = false, AllowUserToDeleteRows = false, AutoSizeColumnsMode = DataGridViewAutoSizeColumnsMode.Fill };
            list.Columns.Add("professional", "Profissional no PEC"); list.Columns["professional"].ReadOnly = true;
            var labels = new List<string> { "Selecione o vínculo" }; labels.AddRange(links.Select(v => S(Get(v,"NAME"))+" | "+S(Get(v,"CNS"))+" | "+S(Get(v,"CBO"))+" | "+S(Get(v,"CNES"))));
            var combo = new DataGridViewComboBoxColumn { Name = "link", HeaderText = "Nome | CNS | CBO | CNES", FillWeight = 220 };
            foreach (var label in labels) combo.Items.Add(label); list.Columns.Add(combo);
            list.Columns.Add("service", "Serviço"); list.Columns.Add("classification", "Classificação"); list.Columns.Add(new DataGridViewCheckBoxColumn { Name = "cid", HeaderText = "CID obrigatório" });
            list.Columns.Add("source","Origem do preenchimento");list.Columns["source"].ReadOnly=true;list.Columns["source"].FillWeight=220;
            foreach (var name in records.Select(r => S(Get(r, "professional"))).Distinct().OrderBy(s => s)) {
                var suggestion=Map(Get(suggestions,Key(name)));var current = Map(Get(bindings, Key(name)));if(current.Count==0)current=Map(Get(suggestion,"binding"));string chosen = labels[0];
                for (int j = 0; j < links.Count; j++) if (S(Get(links[j],"CNS")) == S(Get(current,"cns")) && S(Get(links[j],"CBO")) == S(Get(current,"cbo")) && S(Get(links[j],"CNES")) == S(Get(current,"cnes"))) chosen = labels[j+1];
                var candidates=Rows(Get(suggestion,"candidates"));var recommended=candidates.FirstOrDefault(c=>S(Get(c,"cns"))==S(Get(current,"cns"))&&S(Get(c,"cbo"))==S(Get(current,"cbo"))&&S(Get(c,"cnes"))==S(Get(current,"cnes")));
                if(recommended==null&&candidates.Count>0&&candidates.All(c=>S(Get(c,"service")).Length==3)&&candidates.Select(c=>S(Get(c,"service"))+S(Get(c,"classification"))).Distinct().Count()==1)recommended=candidates[0];
                if(recommended!=null){current=new Dictionary<string,object>(current);foreach(var k in new[]{"service","classification","cid_required","source"})current[k]=Get(recommended,k);}
                list.Rows.Add(name, chosen, S(Get(current,"service")), S(Get(current,"classification")), B(Get(current,"cid_required")),S(Get(current,"source")));
            }
            list.CurrentCellDirtyStateChanged+=delegate{if(list.IsCurrentCellDirty)list.CommitEdit(DataGridViewDataErrorContexts.Commit);};
            list.CellValueChanged+=delegate(object sender,DataGridViewCellEventArgs e){
                if(e.RowIndex<0||e.ColumnIndex!=list.Columns["link"].Index)return;
                var row=list.Rows[e.RowIndex];int idx=labels.IndexOf(S(row.Cells["link"].Value))-1;if(idx<0)return;var link=links[idx];var suggestion=Map(Get(suggestions,Key(S(row.Cells["professional"].Value))));
                var candidate=Rows(Get(suggestion,"candidates")).FirstOrDefault(c=>S(Get(c,"cns"))==S(Get(link,"CNS"))&&S(Get(c,"cbo"))==S(Get(link,"CBO"))&&S(Get(c,"cnes"))==S(Get(link,"CNES")));
                if(candidate==null)return;row.Cells["service"].Value=S(Get(candidate,"service"));row.Cells["classification"].Value=S(Get(candidate,"classification"));row.Cells["cid"].Value=B(Get(candidate,"cid_required"));row.Cells["source"].Value=S(Get(candidate,"source"));
            };
            var bar = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 60, Padding = new Padding(10) };
            var save = new Button { Text = "Aplicar vínculos", Width = 150, DialogResult = DialogResult.OK };
            bar.Controls.Add(save); bar.Controls.Add(new Label { Text = "Serviço e classificação são preenchidos pelas regras disponíveis. Confira o profissional e a origem indicada.", AutoSize = true });
            dialog.Controls.Add(list); dialog.Controls.Add(bar);
            if (dialog.ShowDialog(this) == DialogResult.OK) {
                list.EndEdit();
                foreach (DataGridViewRow row in list.Rows) {
                    string key = Key(S(row.Cells["professional"].Value)); int idx = labels.IndexOf(S(row.Cells["link"].Value)) - 1;
                    if (idx < 0) { bindings.Remove(key); continue; } var link = links[idx];
                    bindings[key] = Obj("cns",Get(link,"CNS"),"cbo",Get(link,"CBO"),"cnes",Get(link,"CNES"),"service",S(row.Cells["service"].Value).Trim(),"classification",S(row.Cells["classification"].Value).Trim(),"cid_required",B(row.Cells["cid"].Value));
                }
                InvalidatePreview();
            }
        }
    }

    [STAThread]
    public static void Main(string[] args) {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string mode = args.Length > 0 ? args[0].ToLowerInvariant() : "bpa";
        if (mode != "bpa" && mode != "gil") { MessageBox.Show("Use Importador_PEC.exe bpa ou gil."); return; }
        var form = new ImportadorForm(mode);
#if QA
        if (args.Length == 4 && args[1] == "--qa") {
            form.qaMode = true;
            var timer = new System.Windows.Forms.Timer { Interval = 50 };
            timer.Tick += async delegate {
                if (form.busy || form.state == null) return;
                timer.Stop();
                try {
                    var opened = await form.Request("open", Obj("path", args[2]));
                    if (opened == null) throw new Exception("Abertura sem resposta");
                    form.Populate(opened);
                    if (form.records.Count != 1 || form.grid.Rows.Count != 1) throw new Exception("Tabela não recebeu o registro fictício");
                    string editedName = "PACIENTE FICTÍCIO EDITADO";
                    form.records[0]["patientName"] = editedName;
                    string draft = Path.ChangeExtension(args[3], ".draft.json");
                    await form.Request("saveDraft", Obj("path", draft, "records", form.records.ToArray()));
                    var saved = Map(form.json.DeserializeObject(File.ReadAllText(draft, Encoding.UTF8)));
                    if (S(Get(Rows(Get(saved,"records"))[0],"patientName")) != editedName) throw new Exception("Acentos ou edição não foram preservados");
                    File.WriteAllText(args[3], form.json.Serialize(Obj("ok",true,"rows",form.grid.Rows.Count,"appPid",Process.GetCurrentProcess().Id,"workerPid",form.worker.Id,"transport","stdio")),Encoding.UTF8);
                } catch (Exception e) { File.WriteAllText(args[3],form.json.Serialize(Obj("ok",false,"error",e.ToString())),Encoding.UTF8);Environment.ExitCode=1; }
                form.Close();timer.Dispose();
            };
            form.Shown += delegate { timer.Start(); };
        }
#endif
        Application.Run(form);
    }
}
