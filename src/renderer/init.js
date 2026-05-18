'use strict';

async function init() {
  document.body.classList.add('platform-' + (backend.platform || 'other'));

  // title bar window controls
  $('win-min').addEventListener('click', () => backend.windowControl('minimize'));
  $('win-max').addEventListener('click', () => backend.windowControl('maximize'));
  $('win-close').addEventListener('click', () => backend.windowControl('close'));
  $('win-info').addEventListener('click', openAbout);
  $('about-close').addEventListener('click', () =>
    $('about-overlay').classList.add('hidden')
  );
  $('about-overlay').addEventListener('click', (e) => {
    const link = e.target.closest('.ext-link');
    if (link) backend.openExternal(link.dataset.url);
  });

  // options dialog
  $('win-options').addEventListener('click', openOptions);
  $('options-close').addEventListener('click', () =>
    $('options-overlay').classList.add('hidden')
  );
  $('options-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'options-overlay')
      $('options-overlay').classList.add('hidden');
  });
  $('opt-autostart').addEventListener('change', (e) => {
    backend.setAutostart(e.target.checked).then((on) => {
      e.target.checked = !!on;
    });
  });
  $('opt-updatecheck').addEventListener('change', (e) => {
    backend.saveSettings({ updateCheckOnStartup: e.target.checked });
  });
  $('opt-check').addEventListener('click', runUpdateCheck);
  $('opt-get').addEventListener('click', () => {
    if (state.updateInfo && state.updateInfo.url)
      backend.openExternal(state.updateInfo.url);
  });

  // look for a newer version at launch if the user wants it
  backend.getSettings().then((s) => {
    if (s && s.updateCheckOnStartup !== false) {
      backend.checkForUpdate().then((r) => {
        state.updateInfo = r;
        if (r && r.updateAvailable)
          $('win-options').classList.add('has-update');
      });
    }
  });
  $('titlebar').addEventListener('dblclick', (e) => {
    if (!e.target.closest('.tb-controls')) backend.windowControl('maximize');
  });
  backend.onWindowState((isMax) =>
    document.body.classList.toggle('win-maximized', isMax)
  );

  wireSeg('cx', applyCxAuth);
  wireSeg('dc', applyDcAuth);
  wireSeg('mode', applyMode);

  // environment tabs
  $('tab-new').addEventListener('click', () => openEditor(''));
  $('tab-list').addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    const id = tab.dataset.id;
    if (e.target.closest('.tab-edit')) openEditor(id);
    else clickTab(id);
  });
  wireTabDragging();

  // editor
  $('cx-colors').addEventListener('click', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw) return;
    state.formColor = sw.dataset.color;
    renderColorRow();
  });
  $('cx-keybtn').addEventListener('click', () => pickKeyInto('cx'));
  $('cx-connect').addEventListener('click', doConnect);
  $('cx-diagnose').addEventListener('click', () => doDiagnose());
  $('cx-delete').addEventListener('click', deleteEnv);
  ['cx-name', 'cx-host', 'cx-port', 'cx-user', 'cx-pass', 'cx-passphrase'].forEach(
    (id) => {
      $(id).addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doConnect();
      });
    }
  );

  // workspace
  $('dc-keybtn').addEventListener('click', () => pickKeyInto('dc'));
  $('btn-refresh').addEventListener('click', refreshHosts);
  $('btn-disconnect').addEventListener('click', disconnect);
  $('key-input').addEventListener('input', onKeyInput);
  $('key-loadfile').addEventListener('click', loadPublicKeyFile);
  $('dc-same').addEventListener('change', (e) => {
    $('dc-fields').classList.toggle('hidden', e.target.checked);
  });

  document.querySelectorAll('#host-filters .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document
        .querySelectorAll('#host-filters .seg-btn')
        .forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.filter = btn.dataset.filter;
      renderHosts();
    });
  });
  $('host-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    renderHosts();
  });
  $('host-running').addEventListener('change', (e) => {
    state.runningOnly = e.target.checked;
    renderHosts();
  });
  $('host-selectall').addEventListener('click', () => {
    const hosts = visibleHosts();
    const allSelected = hosts.every((h) => state.selected.has(h.id));
    hosts.forEach((h) => {
      if (allSelected) state.selected.delete(h.id);
      else state.selected.add(h.id);
    });
    renderHosts();
    updateDeployBar();
  });

  $('btn-deploy').addEventListener('click', doDeploy);
  $('btn-verify').addEventListener('click', () => verifyHosts(selectedHosts()));
  $('btn-audit').addEventListener('click', () => {
    const sel = selectedHosts();
    auditHostList(sel.length ? sel : state.hosts);
  });
  $('audit-close').addEventListener('click', () =>
    $('audit-overlay').classList.add('hidden')
  );
  $('audit-body').addEventListener('click', (e) => {
    const rm = e.target.closest('.audit-remove');
    if (rm) return removeAuditKey(rm.dataset.b64);
    const use = e.target.closest('.audit-use');
    if (use) useAuditKey(use.dataset.b64);
  });
  $('verify-key-pick').addEventListener('click', async () => {
    const r = await backend.pickKey();
    if (r) setVerifyKey(r.path);
  });
  $('host-list').addEventListener('click', (e) => {
    const v = e.target.closest('.host-verify');
    if (!v) return;
    const row = v.closest('.host-row');
    if (!row) return;
    const host = state.hosts.find((h) => h.id === row.dataset.id);
    if (host) verifyHosts([host]);
  });
  $('deploy-summary').addEventListener('click', (e) => {
    if (e.target.closest('.reveal-hidden')) revealSelected();
  });
  $('btn-ov-close').addEventListener('click', () => {
    $('overlay').classList.add('hidden');
  });

  $('btn-history').addEventListener('click', openHistory);
  $('history-close').addEventListener('click', () =>
    $('history-overlay').classList.add('hidden')
  );
  $('history-search').addEventListener('input', (e) =>
    renderHistory(e.target.value)
  );
  $('history-clear').addEventListener('click', async () => {
    if (!state.history.length) return;
    if (confirm('Clear all deployment history?')) {
      await backend.clearHistory();
      state.history = [];
      renderHistory('');
    }
  });

  // load environments — auto-connect to the last one, else open the editor
  const data = await backend.listEnvironments();
  state.environments = data.environments || [];
  renderTabs();
  if (state.environments.length) {
    const last =
      state.environments.find((e) => e.id === data.lastEnvId) ||
      state.environments[0];
    connectEnv(last.id);
  } else {
    openEditor('');
  }
}

init();
