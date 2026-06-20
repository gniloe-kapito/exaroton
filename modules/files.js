/* =============================================================================
 *  modules/files.js — файловый браузер с полным набором операций
 *
 *  Возможности:
 *    - Просмотр содержимого папок (GET /files/info/{path}/)
 *    - Предпросмотр текстовых/изображений файлов (GET /files/data/{path}/)
 *    - Создание папки (PUT /files/data/{path}/ с Content-Type: inode/directory)
 *    - Загрузка файла (PUT /files/data/{path}/ с бинарным телом)
 *    - Сохранение отредактированного текстового файла (PUT /files/data/{path}/)
 *    - Удаление файла/папки (DELETE /files/data/{path}/)
 *    - Скачивание файла/папки
 *    - Редактор .properties конфигов (GET/POST /files/config/{path}/) —
 *      работает с ЛЮБЫМ .properties файлом, не только server.properties
 * ========================================================================== */

(function (global) {
  'use strict';

  let currentPath = '/';
  let currentEntry = null;     // Текущий выбранный файл (для preview/удаляемый)
  let configOptions = [];      // Опции конфига (если открыт .properties)
  let configPath = null;       // Путь к редактируемому конфигу
  let selectedPaths = new Set(); // Множество выбранных путей (для multi-select)

  function onOpenServer() {
    currentPath = '/';
    currentEntry = null;
    configOptions = [];
    configPath = null;
    selectedPaths.clear();
    // Сбрасываем превью-панель, чтобы редактор файла не оставался висеть
    // от предыдущего сервера.
    setFilePreview();
    loadFiles('/');
  }

  function getCurrentPath() { return currentPath; }

  // ── Мульти-выбор файлов ─────────────────────────────────────────
  // Логика:
  //   - Обычный клик: открыть файл/папку (как раньше), сбросить выбор
  //   - Ctrl/Cmd+клик: добавить/убрать файл из выбора (toggle)
  //   - Shift+клик: выбрать диапазон (от последнего выбранного до текущего)
  function toggleFileSelect(encodedPath, event) {
    const path = decodeURIComponent(encodedPath);
    if (event && (event.ctrlKey || event.metaKey)) {
      // toggle
      if (selectedPaths.has(path)) selectedPaths.delete(path);
      else selectedPaths.add(path);
      updateFileSelectionUI();
      updateMultiSelectBar();
      return;
    }
    if (event && event.shiftKey && selectedPaths.size > 0) {
      // диапазон: найти в списке последний выбранный и текущий
      const rows = Array.from(document.querySelectorAll('#files-list .file-row'));
      const paths = rows.map(r => r.dataset.path);
      const lastIdx = paths.findIndex(p => selectedPaths.has(p));
      const curIdx = paths.indexOf(path);
      if (lastIdx !== -1 && curIdx !== -1) {
        const [from, to] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        for (let i = from; i <= to; i++) selectedPaths.add(paths[i]);
        updateFileSelectionUI();
        updateMultiSelectBar();
        return;
      }
    }
    // Обычный клик: сбросить выбор + открыть файл
    selectedPaths.clear();
    updateFileSelectionUI();
    updateMultiSelectBar();
    openEntry(encodedPath);
  }

  function selectAllFiles() {
    document.querySelectorAll('#files-list .file-row').forEach(r => {
      if (r.dataset.path) selectedPaths.add(r.dataset.path);
    });
    updateFileSelectionUI();
    updateMultiSelectBar();
  }

  function clearSelection() {
    selectedPaths.clear();
    updateFileSelectionUI();
    updateMultiSelectBar();
  }

  function updateFileSelectionUI(activePath = '') {
    // Если передан activePath — это обычный single-select, мульти-выбор игнорируем
    if (activePath) {
      document.querySelectorAll('#files-list .file-row').forEach(row => {
        row.classList.toggle('active', row.dataset.path === activePath);
      });
      return;
    }
    // Multi-select: показываем все выбранные
    document.querySelectorAll('#files-list .file-row').forEach(row => {
      row.classList.toggle('active', selectedPaths.has(row.dataset.path));
      row.classList.toggle('selected', selectedPaths.has(row.dataset.path));
    });
  }

  function updateMultiSelectBar() {
    const bar = document.getElementById('files-multi-bar');
    if (!bar) return;
    const count = selectedPaths.size;
    if (count === 0) {
      bar.style.display = 'none';
      return;
    }
    bar.style.display = 'flex';
    bar.querySelector('#files-multi-count').textContent = count;
  }

  async function deleteSelected() {
    if (!selectedPaths.size) return;
    const paths = Array.from(selectedPaths);
    const confirmed = await UI.confirmModal({
      title: `Удалить ${paths.length} файлов?`,
      message: 'Это действие необратимо. Удалить все выбранные файлы и папки?',
      okLabel: 'Удалить все',
      danger: true,
    });
    if (!confirmed) return;
    const srv = Servers.getCurrent();
    if (!srv) return;
    let okCount = 0, errCount = 0;
    for (let i = 0; i < paths.length; i++) {
      UI.activity(`Удаление ${i + 1}/${paths.length}...`);
      const resp = await API.apiRaw(API.PATHS.fileData(srv.id, paths[i]), { method: 'DELETE' });
      if (resp.ok) okCount += 1;
      else errCount += 1;
    }
    UI.toast(`Удалено: ${okCount}${errCount ? `, ошибок: ${errCount}` : ''}`, 'ok');
    if (global.Audit) Audit.log('file.deleteMulti', { count: okCount });
    selectedPaths.clear();
    updateMultiSelectBar();
    await loadFiles(currentPath);
  }

  async function downloadSelectedAsZip() {
    if (!selectedPaths.size) return;
    const srv = Servers.getCurrent();
    if (!srv) return;
    if (typeof JSZip === 'undefined') {
      UI.toast('JSZip не загружен', 'err');
      return;
    }
    const directMode = API.isDirectMode();
    UI.activity(`Сбор ${selectedPaths.size} элементов ${directMode ? '(прямой режим)' : ''}...`);
    const zip = new JSZip();
    let fileCount = 0, folderCount = 0, errorCount = 0, totalBytes = 0;

    const fetchInfo = (path) => directMode
      ? API.directApi(API.DIRECT_PATHS.fileInfo(srv.id, path))
      : API.api(API.PATHS.fileInfo(srv.id, path));
    const fetchData = (path) => directMode
      ? API.directApiRaw(API.DIRECT_PATHS.fileData(srv.id, path))
      : API.apiRaw(API.PATHS.fileData(srv.id, path));

    async function addEntryToZip(path, zipFolder) {
      const infoResp = await fetchInfo(path);
      if (!infoResp.success || !infoResp.data) { errorCount += 1; return; }
      const entry = infoResp.data;
      const name = entry.name || path.split('/').pop() || 'item';
      if (!entry.isDirectory) {
        try {
          const resp = await fetchData(path);
          if (!resp.ok) { errorCount += 1; return; }
          const blob = await resp.blob();
          totalBytes += blob.size;
          zipFolder.file(name, blob);
          fileCount += 1;
          UI.activity(`Скачано: ${fileCount} файлов, ${folderCount} папок, ${UI.formatBytes(totalBytes)}...`);
        } catch { errorCount += 1; }
      } else {
        const subZip = zipFolder.folder(name);
        folderCount += 1;
        const children = entry.children || entry.files || [];
        for (const child of children) {
          const childPath = API.joinPath(path, child.name);
          await addEntryToZip(childPath, subZip);
        }
      }
    }

    for (const path of selectedPaths) {
      await addEntryToZip(path, zip);
    }

    if (fileCount === 0 && folderCount === 0) {
      UI.toast('Ничего не удалось скачать', 'err');
      return;
    }
    UI.activity(`Упаковка ZIP (${fileCount} файлов, ${UI.formatBytes(totalBytes)})...`);
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'STORE',
    });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `selected-${fileCount}-files.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    UI.toast(`ZIP готов: ${fileCount} файлов, ${folderCount} папок, ${UI.formatBytes(totalBytes)}${errorCount ? `, ошибок: ${errorCount}` : ''}`, 'ok', 7000);
  }

  // ── Навигация ───────────────────────────────────────────────────
  async function loadFiles(path = '/') {
    const srv = Servers.getCurrent();
    if (!srv) return;
    currentPath = API.normalizePath(path);
    renderPath();

    const el = document.getElementById('files-list');
    if (el) el.innerHTML = '<div class="skeleton" style="height:80px;border-radius:8px;"></div>';

    const r = await API.api(API.PATHS.fileInfo(srv.id, currentPath));
    if (!r.success || !r.data) {
      if (el) el.innerHTML = '<div class="empty-state" style="padding:1.25rem;"><p>Файлы недоступны</p></div>';
      setFilePreview();
      return;
    }
    const base = r.data;
    const files = (base.children || base.files || []).slice().sort((a, b) => {
      const aDir = !!a.isDirectory;
      const bDir = !!b.isDirectory;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '', 'ru', { sensitivity: 'base' });
    });

    if (!files.length) {
      if (el) el.innerHTML = '<div class="empty-state" style="padding:1.25rem;"><p>В этой папке нет файлов</p></div>';
      setFilePreview(base, '', 'directory');
      return;
    }

    if (el) {
      const fileIcon = '<svg class="file-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z"/></svg>';
      const folderIcon = '<svg class="file-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
      const downloadIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zm7-18v10.17l3.59-3.58L17 10l-5 5-5-5 1.41-1.41L11 12.17V2h2z"/></svg>';
      const deleteIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
      const editIcon = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';

      el.innerHTML = '<div class="file-list">' + files.map(f => {
        const isDir = !!f.isDirectory;
        const isConfig = API.isConfigFile(f);
        const isPlayerDat = !isDir && /\.dat$/i.test(f.name || '') && /playerdata/i.test(f.path || '');
        const isAdv = !isDir && /\.json$/i.test(f.name || '') && /advancements/i.test(f.path || '');
        const isStat = !isDir && /\.json$/i.test(f.name || '') && /stats/i.test(f.path || '');
        const isMca = !isDir && /\.mca$/i.test(f.name || '') && /region/i.test(f.path || '');
        const meta = isDir ? 'folder' : (API.isPreviewableFile(f) ? 'text' : (API.isImageFile(f) ? 'image' : 'file'));
        let badge = '';
        if (isPlayerDat) badge = '<span class="file-meta player-dat">player</span>';
        else if (isAdv) badge = '<span class="file-meta player-dat" style="background:var(--blue-light);color:var(--blue-text);">adv</span>';
        else if (isStat) badge = '<span class="file-meta player-dat" style="background:var(--amber-light);color:var(--amber-text);">stats</span>';
        else if (isMca) badge = '<span class="file-meta player-dat" style="background:var(--purple-light);color:var(--purple-text);">map</span>';
        else badge = `<span class="file-meta">${meta}${isConfig ? ' • cfg' : ''}</span>`;
        const openBtn = isPlayerDat
          ? `<button class="icon-btn" title="Профиль игрока" onclick="event.stopPropagation(); Files.openEntry('${encodeURIComponent(f.path || '')}'); setTimeout(()=>Files.openPlayerProfile(),100)">${editIcon}</button>`
          : isAdv
          ? `<button class="icon-btn" title="Достижения" onclick="event.stopPropagation(); Files.openEntry('${encodeURIComponent(f.path || '')}'); setTimeout(()=>Files.openAdvancements(),100)">${editIcon}</button>`
          : isStat
          ? `<button class="icon-btn" title="Статистика" onclick="event.stopPropagation(); Files.openEntry('${encodeURIComponent(f.path || '')}'); setTimeout(()=>Files.openPlayerStats(),100)">${editIcon}</button>`
          : isMca
          ? `<button class="icon-btn" title="Карта региона" onclick="event.stopPropagation(); Files.openEntry('${encodeURIComponent(f.path || '')}'); setTimeout(()=>Files.openRegionMap(),100)">${editIcon}</button>`
          : isConfig
          ? `<button class="icon-btn" title="Редактировать как конфиг" onclick="event.stopPropagation(); Files.openConfig('${encodeURIComponent(f.path || '')}')">${editIcon}</button>`
          : '';
        return `<div class="file-row${currentEntry?.path === f.path ? ' active' : ''}" data-path="${UI.escapeHtml(f.path || '')}" onclick="Files.toggleFileSelect('${encodeURIComponent(f.path || '')}', event)">
          ${isDir ? folderIcon : fileIcon}
          <span class="file-name">${UI.escapeHtml(f.name || f.path || '—')}</span>
          ${badge}
          <div class="file-actions">
            <span class="file-size">${UI.formatBytes(f.size)}</span>
            ${openBtn}
            <button class="icon-btn" title="Скачать" onclick="event.stopPropagation(); Files.downloadSpecific('${encodeURIComponent(f.path || '')}')">${downloadIcon}</button>
            <button class="icon-btn danger" title="Удалить" onclick="event.stopPropagation(); Files.deleteEntry('${encodeURIComponent(f.path || '')}')">${deleteIcon}</button>
          </div>
        </div>`;
      }).join('') + '</div>';
    }

    setFilePreview(base, '', 'directory');
  }

  function renderPath() {
    const el = document.getElementById('files-path');
    if (!el) return;
    const parts = API.normalizePath(currentPath).split('/').filter(Boolean);
    let walk = '';
    const crumbs = ['<button class="path-chip" onclick="Files.load(\'/\')">root</button>'];
    for (const part of parts) {
      walk += '/' + part;
      crumbs.push(`<button class="path-chip" onclick="Files.load('${walk.replace(/'/g, "\\'")}')">${UI.escapeHtml(part)}</button>`);
    }
    el.innerHTML = crumbs.join('<span style="color:var(--text3)">/</span>');
  }

  // ── Открытие файла/папки ────────────────────────────────────────
  async function openEntry(encodedPath) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const path = decodeURIComponent(encodedPath);
    const infoResp = await API.api(API.PATHS.fileInfo(srv.id, path));
    if (!infoResp.success || !infoResp.data) {
      UI.toast(infoResp.error || 'Не удалось открыть файл', 'err');
      return;
    }
    const entry = infoResp.data;
    if (entry.isDirectory) {
      await loadFiles(entry.path || path);
      return;
    }
    currentEntry = entry;
    if (API.isPreviewableFile(entry)) {
      const resp = await API.apiRaw(API.PATHS.fileData(srv.id, entry.path));
      if (!resp.ok) {
        UI.toast('Не удалось загрузить содержимое', 'err');
        setFilePreview(entry, '', 'binary');
        return;
      }
      const text = await resp.text();
      setFilePreview(entry, text, 'text');
      return;
    }
    if (API.isImageFile(entry)) {
      const resp = await API.apiRaw(API.PATHS.fileData(srv.id, entry.path));
      if (!resp.ok) {
        UI.toast('Не удалось загрузить изображение', 'err');
        setFilePreview(entry, '', 'binary');
        return;
      }
      const blob = await resp.blob();
      setFilePreview(entry, URL.createObjectURL(blob), 'image');
      return;
    }
    setFilePreview(entry, '', 'binary');
  }

  // ── Предпросмотр ────────────────────────────────────────────────
  // originalContent — для кнопки "Отменить" в текстовом редакторе
  let originalContent = '';

  function setFilePreview(entry = null, content = '', kind = 'empty') {
    currentEntry = entry;
    originalContent = (kind === 'text') ? content : '';
    // При preview одного файла — не трогаем multi-select UI.
    // Multi-select показывается только когда currentEntry == null.
    if (entry) {
      document.querySelectorAll('#files-list .file-row').forEach(row => {
        row.classList.toggle('active', row.dataset.path === entry.path);
      });
    } else {
      updateFileSelectionUI();
    }
    const titleEl = document.getElementById('file-preview-title');
    const subEl = document.getElementById('file-preview-sub');
    const bodyEl = document.getElementById('file-preview-body');
    const actionsEl = document.getElementById('file-preview-actions');
    if (!titleEl || !subEl || !bodyEl) return;

    if (!entry) {
      titleEl.textContent = 'Выбери файл';
      subEl.textContent = 'Текстовые файлы открываются для просмотра/редактирования';
      bodyEl.innerHTML = '<div class="preview-empty">Открой папку или выбери файл слева. Текстовые файлы можно редактировать и сохранять, конфиги (.properties/.yml) — редактировать через спец. кнопку.</div>';
      if (actionsEl) actionsEl.innerHTML = '';
      return;
    }

    titleEl.textContent = entry.path || entry.name || 'Файл';
    subEl.textContent = `${entry.isDirectory ? 'Папка' : 'Файл'}${entry.size ? ' • ' + UI.formatBytes(entry.size) : ''}`;

    if (kind === 'text') {
      const isMarkdown = /\.md$/i.test(entry.name || '');
      const ext = (entry.name || '').split('.').pop()?.toLowerCase();
      const hlLang = detectHlLang(ext);

      if (isMarkdown) {
        // Для markdown — переключатель Edit / Preview
        bodyEl.innerHTML = `
          <div style="display:flex;gap:6px;margin-bottom:8px;">
            <button class="btn btn-sm btn-green" id="md-tab-edit" onclick="Files.switchMdTab('edit')">Редактор</button>
            <button class="btn btn-sm" id="md-tab-preview" onclick="Files.switchMdTab('preview')">Превью</button>
          </div>
          <div id="md-pane-edit">
            <textarea id="file-editor" style="width:100%;height:100%;min-height:340px;padding:10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px;line-height:1.5;resize:vertical;outline:none;">${UI.escapeHtml(content)}</textarea>
          </div>
          <div id="md-pane-preview" style="display:none;">
            <div class="md-preview" id="md-rendered"></div>
          </div>`;
        if (actionsEl) {
          actionsEl.innerHTML = `
            <button class="btn btn-green btn-sm" onclick="Files.saveEdited()" title="Ctrl+S">Сохранить</button>
            <button class="btn btn-sm" onclick="Files.resetEdited()" title="Вернуть исходное">Отменить</button>
            <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
        }
        // Первичный рендер
        renderMarkdownPreview(content);
      } else {
        // Обычный редактор + опциональная подсветка
        bodyEl.innerHTML = `
          <div style="display:flex;gap:6px;margin-bottom:8px;align-items:center;">
            <button class="btn btn-sm btn-green" id="hl-tab-edit" onclick="Files.switchHlTab('edit')">Редактор</button>
            <button class="btn btn-sm" id="hl-tab-preview" onclick="Files.switchHlTab('preview')">Подсветка${hlLang ? ' (' + hlLang + ')' : ''}</button>
          </div>
          <div id="hl-pane-edit">
            <textarea id="file-editor" style="width:100%;height:100%;min-height:340px;padding:10px;border:1px solid var(--border2);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px;line-height:1.5;resize:vertical;outline:none;">${UI.escapeHtml(content)}</textarea>
          </div>
          <div id="hl-pane-preview" style="display:none;">
            <pre class="hljs-preview"><code id="hl-rendered" class="hljs${hlLang ? ' language-' + hlLang : ''}"></code></pre>
          </div>`;
        if (actionsEl) {
          actionsEl.innerHTML = `
            <button class="btn btn-green btn-sm" onclick="Files.saveEdited()" title="Ctrl+S">Сохранить</button>
            <button class="btn btn-sm" onclick="Files.resetEdited()" title="Вернуть исходное">Отменить</button>
            <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
        }
        // Первичная подсветка
        renderHlPreview(content, hlLang);
      }
      // Ctrl+S / Cmd+S для сохранения
      const editor = document.getElementById('file-editor');
      if (editor) {
        editor.addEventListener('keydown', (e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault();
            saveEdited();
          }
        });
        // Live preview при вводе
        editor.addEventListener('input', () => {
          if (isMarkdown) renderMarkdownPreview(editor.value);
          else renderHlPreview(editor.value, hlLang);
        });
      }
      return;
    }
    if (kind === 'image') {
      bodyEl.innerHTML = `<img class="preview-image" src="${content}" alt="${UI.escapeHtml(entry.name || 'image')}" />`;
      if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
      return;
    }
    if (kind === 'directory') {
      bodyEl.innerHTML = '<div class="preview-empty">Это папка. Содержимое отображается слева.<br />Кнопка «Скачать папку» упакует её в ZIP (с подкаталогами).</div>';
      if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-sm" onclick="Files.downloadCurrent()">${entry.isDirectory ? 'Скачать как ZIP' : 'Скачать'}</button>`;
      return;
    }
    // .mca файл в region/ — карта мира
    const isRegionMca = /\.mca$/i.test(entry.name || '') && /region/i.test(entry.path || '');
    if (isRegionMca) {
      bodyEl.innerHTML = '<div class="preview-empty">Файл региона Minecraft (Anvil .mca, 32×32 чанка). Можно открыть как карту (top-down, 1px = 1 блок).</div>';
      if (actionsEl) actionsEl.innerHTML = `
        <button class="btn btn-green btn-sm" onclick="Files.openRegionMap()">Открыть карту</button>
        <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
      return;
    }
    // .dat файл в playerdata — предложим открыть как профиль
    const isPlayerDat = /\.dat$/i.test(entry.name || '') && /playerdata/i.test(entry.path || '');
    if (isPlayerDat) {
      bodyEl.innerHTML = '<div class="preview-empty">Это NBT-файл данных игрока (gzip-compressed). Можно скачать, либо открыть как профиль игрока (здоровье, инвентарь, опыт, позиция).</div>';
      if (actionsEl) actionsEl.innerHTML = `
        <button class="btn btn-green btn-sm" onclick="Files.openPlayerProfile()">Профиль игрока</button>
        <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
      return;
    }
    // advancements/{uuid}.json — достижения игрока
    const isAdvancements = /\.json$/i.test(entry.name || '') && /advancements/i.test(entry.path || '');
    if (isAdvancements) {
      bodyEl.innerHTML = '<div class="preview-empty">Файл достижлений игрока (JSON). Можно открыть в человеко-читаемом виде.</div>';
      if (actionsEl) actionsEl.innerHTML = `
        <button class="btn btn-green btn-sm" onclick="Files.openAdvancements()">Достижения</button>
        <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
      return;
    }
    // stats/{uuid}.json — статистика игрока
    const isStats = /\.json$/i.test(entry.name || '') && /stats/i.test(entry.path || '');
    if (isStats) {
      bodyEl.innerHTML = '<div class="preview-empty">Файл статистики игрока (JSON). Можно открыть в человеко-читаемом виде.</div>';
      if (actionsEl) actionsEl.innerHTML = `
        <button class="btn btn-green btn-sm" onclick="Files.openPlayerStats()">Статистика</button>
        <button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
      return;
    }
    bodyEl.innerHTML = '<div class="preview-empty">Предпросмотр недоступен. Файл можно скачать.</div>';
    if (actionsEl) actionsEl.innerHTML = `<button class="btn btn-sm" onclick="Files.downloadCurrent()">Скачать</button>`;
  }

  // ── Отменить изменения в редакторе ──────────────────────────────
  function resetEdited() {
    const editor = document.getElementById('file-editor');
    if (!editor) return;
    editor.value = originalContent;
    // Обновим preview
    const isMarkdown = document.getElementById('md-rendered');
    const hlRendered = document.getElementById('hl-rendered');
    if (isMarkdown) renderMarkdownPreview(originalContent);
    if (hlRendered) {
      const cls = hlRendered.className.match(/language-(\w+)/);
      renderHlPreview(originalContent, cls ? cls[1] : '');
    }
    UI.toast('Изменения отменены');
  }

  // ── Определить язык для highlight.js по расширению ──────────────
  function detectHlLang(ext) {
    const map = {
      'json': 'json',
      'yml': 'yaml', 'yaml': 'yaml',
      'xml': 'xml',
      'html': 'xml', 'htm': 'xml',
      'css': 'css',
      'js': 'javascript', 'mjs': 'javascript',
      'ts': 'typescript',
      'java': 'java',
      'py': 'python',
      'sh': 'bash', 'bash': 'bash',
      'bat': 'dos',
      'properties': 'properties',
      'ini': 'ini', 'conf': 'ini', 'cfg': 'ini',
      'toml': 'ini',
      'sql': 'sql',
      'md': 'markdown',
      'gradle': 'groovy',
      'kts': 'kotlin',
      'kt': 'kotlin',
      'go': 'go',
      'rs': 'rust',
      'c': 'c', 'h': 'c',
      'cpp': 'cpp', 'cc': 'cpp', 'hpp': 'cpp',
      'php': 'php',
      'rb': 'ruby',
      'lua': 'lua',
      'mcmeta': 'json',
    };
    return map[ext] || '';
  }

  // ── Рендер Markdown preview ─────────────────────────────────────
  function renderMarkdownPreview(text) {
    const el = document.getElementById('md-rendered');
    if (!el) return;
    if (typeof marked === 'undefined') {
      el.innerHTML = '<div style="color:var(--text3);font-size:12px;">marked.js не загружен — превью недоступно</div>';
      return;
    }
    try {
      // Санитизируем минимально (marked v12 по умолчанию не включает HTML из md)
      const html = marked.parse(text || '', { breaks: true, gfm: true });
      el.innerHTML = html;
    } catch (e) {
      el.innerHTML = '<div style="color:var(--red-text);">Ошибка рендера: ' + UI.escapeHtml(e.message) + '</div>';
    }
  }

  // ── Рендер с подсветкой синтаксиса ──────────────────────────────
  function renderHlPreview(text, lang) {
    const el = document.getElementById('hl-rendered');
    if (!el) return;
    if (typeof hljs === 'undefined') {
      el.textContent = text || '';
      return;
    }
    try {
      if (lang && hljs.getLanguage(lang)) {
        el.innerHTML = hljs.highlight(text || '', { language: lang }).value;
      } else {
        el.innerHTML = hljs.highlightAuto(text || '').value;
      }
    } catch (e) {
      el.textContent = text || '';
    }
  }

  // ── Переключатели Edit / Preview ────────────────────────────────
  function switchMdTab(tab) {
    const editPane = document.getElementById('md-pane-edit');
    const previewPane = document.getElementById('md-pane-preview');
    const editBtn = document.getElementById('md-tab-edit');
    const previewBtn = document.getElementById('md-tab-preview');
    if (!editPane || !previewPane) return;
    if (tab === 'edit') {
      editPane.style.display = '';
      previewPane.style.display = 'none';
      editBtn.classList.add('btn-green');
      previewBtn.classList.remove('btn-green');
    } else {
      editPane.style.display = 'none';
      previewPane.style.display = '';
      previewBtn.classList.add('btn-green');
      editBtn.classList.remove('btn-green');
      const editor = document.getElementById('file-editor');
      if (editor) renderMarkdownPreview(editor.value);
    }
  }

  function switchHlTab(tab) {
    const editPane = document.getElementById('hl-pane-edit');
    const previewPane = document.getElementById('hl-pane-preview');
    const editBtn = document.getElementById('hl-tab-edit');
    const previewBtn = document.getElementById('hl-tab-preview');
    if (!editPane || !previewPane) return;
    if (tab === 'edit') {
      editPane.style.display = '';
      previewPane.style.display = 'none';
      editBtn.classList.add('btn-green');
      previewBtn.classList.remove('btn-green');
    } else {
      editPane.style.display = 'none';
      previewPane.style.display = '';
      previewBtn.classList.add('btn-green');
      editBtn.classList.remove('btn-green');
      const editor = document.getElementById('file-editor');
      if (editor) {
        const cls = document.getElementById('hl-rendered')?.className.match(/language-(\w+)/);
        renderHlPreview(editor.value, cls ? cls[1] : '');
      }
    }
  }

  // ── Сохранение отредактированного файла ─────────────────────────
  async function saveEdited() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) return;
    const editor = document.getElementById('file-editor');
    if (!editor) return;
    const content = editor.value;
    UI.activity('Сохранение файла...');
    // PUT /files/data/{path}/ с бинарным телом
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: content,
    });
    if (resp.ok) {
      UI.toast('Файл сохранён', 'ok');
      if (global.Audit) Audit.log('file.save', { path: currentEntry.path });
      await loadFiles(currentPath);
    } else {
      let err = 'Ошибка сохранения';
      try { const j = await resp.json(); err = j.error || err; } catch {}
      UI.toast(err, 'err');
    }
  }

  // ── Скачивание ──────────────────────────────────────────────────
  // Для файла — просто качает. Для папки — рекурсивно обходит и пакует в ZIP.
  async function downloadCurrent() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) { UI.toast('Сначала выбери файл', 'err'); return; }
    if (currentEntry.isDirectory) {
      await downloadFolderAsZip(currentEntry);
      return;
    }
    // Прямой режим если есть directToken, иначе через Worker
    const resp = API.isDirectMode()
      ? await API.directApiRaw(API.DIRECT_PATHS.fileData(srv.id, currentEntry.path))
      : await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path));
    if (!resp.ok) {
      let err = 'Скачать не удалось';
      try { const j = await resp.json(); err = j.error || err; } catch {}
      UI.toast(err, 'err');
      return;
    }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = currentEntry.name || 'download';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
    UI.toast('Скачано');
  }

  async function downloadSpecific(encodedPath) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const path = decodeURIComponent(encodedPath);
    const infoResp = await API.api(API.PATHS.fileInfo(srv.id, path));
    if (!infoResp.success || !infoResp.data) {
      UI.toast('Файл недоступен', 'err');
      return;
    }
    currentEntry = infoResp.data;
    await downloadCurrent();
  }

  async function downloadCurrentFolder() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const infoResp = await API.api(API.PATHS.fileInfo(srv.id, API.normalizePath(currentPath)));
    if (!infoResp.success || !infoResp.data) {
      UI.toast('Папка недоступна', 'err');
      return;
    }
    currentEntry = infoResp.data;
    await downloadCurrent();
  }

  // ── Скачивание папки в ZIP (через JSZip) ────────────────────────
  // Требует JSZip (подключён через CDN в index.html).
  // Алгоритм:
  //   1. Рекурсивно обходим дерево через GET /files/info/{path}/
  //   2. Для каждого файла — GET /files/data/{path}/ → Blob
  //   3. Добавляем в ZIP с относительным путём
  //   4. Генерируем ZIP blob → триггерим скачивание
  //   ВАЖНО: exaroton может возвращать child.path как относительный (только имя)
  //   или как абсолютный (родительский путь + имя). Поэтому всегда строим
  //   полный путь сами: parentPath + '/' + child.name. Это надёжнее.
  //
  //   РЕЖИМЫ ЗАГРУЗКИ:
  //   - Через Cloudflare Worker (по умолчанию) — лимит ~100 MB на ответ
  //   - Прямой режим (если в Account установлен Direct exaroton token) —
  //     фронт качает напрямую с api.exaroton.com, минуя Worker. Без лимита.
  //     НЕБЕЗОПАСНО: токен виден в DevTools.
  async function downloadFolderAsZip(folderEntry) {
    const srv = Servers.getCurrent();
    if (!srv || !folderEntry) return;
    if (typeof JSZip === 'undefined') {
      UI.toast('JSZip не загружен. Проверьте подключение CDN.', 'err');
      return;
    }
    const directMode = API.isDirectMode();
    UI.activity(`Сбор содержимого папки ${directMode ? '(прямой режим)' : ''}...`);
    const zip = new JSZip();
    const rootName = folderEntry.name || 'folder';
    let fileCount = 0;
    let folderCount = 0;
    let errorCount = 0;
    let totalBytes = 0;

    // Хелперы для запросов — выбирают прямой режим или через Worker
    const fetchInfo = (path) => directMode
      ? API.directApi(API.DIRECT_PATHS.fileInfo(srv.id, path))
      : API.api(API.PATHS.fileInfo(srv.id, path));
    const fetchData = (path) => directMode
      ? API.directApiRaw(API.DIRECT_PATHS.fileData(srv.id, path))
      : API.apiRaw(API.PATHS.fileData(srv.id, path));

    // Рекурсивный обход
    // entryPath — абсолютный путь в файловой системе сервера (например "/world/plugins")
    // zipFolder — соответствующая папка в ZIP
    async function walk(entryPath, zipFolder) {
      const infoResp = await fetchInfo(entryPath);
      if (!infoResp.success || !infoResp.data) {
        console.warn('[zip] fileInfo failed for', entryPath, infoResp);
        errorCount += 1;
        return;
      }
      const children = infoResp.data.children || infoResp.data.files || [];
      for (const child of children) {
        const childPath = API.joinPath(entryPath, child.name);
        if (child.isDirectory) {
          const subZip = zipFolder.folder(child.name);
          folderCount += 1;
          await walk(childPath, subZip);
        } else {
          try {
            const resp = await fetchData(childPath);
            if (!resp.ok) {
              console.warn('[zip] fileData failed for', childPath, resp.status);
              errorCount += 1;
              continue;
            }
            const blob = await resp.blob();
            totalBytes += blob.size;
            zipFolder.file(child.name, blob);
            fileCount += 1;
            UI.activity(`Скачано: ${fileCount} файлов, ${folderCount} папок, ${UI.formatBytes(totalBytes)}...`);
          } catch (e) {
            console.warn('[zip] fileData exception for', childPath, e);
            errorCount += 1;
          }
        }
      }
    }

    try {
      const rootPath = API.normalizePath(folderEntry.path || '/');
      await walk(rootPath, zip);
      if (fileCount === 0 && folderCount === 0) {
        UI.toast('Папка пуста или все файлы недоступны', 'warn');
        return;
      }
      UI.activity(`Упаковка ZIP (${fileCount} файлов, ${UI.formatBytes(totalBytes)})...`);
      // БЕЗ compression — это критично для больших миров.
      // DEFLATE в JSZip жрал память и валил вкладку на 200+ МБ.
      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'STORE',  // без сжатия, просто упаковка
      });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${rootName}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      UI.toast(`ZIP готов: ${fileCount} файлов, ${folderCount} папок, ${UI.formatBytes(totalBytes)}${errorCount ? `, ошибок: ${errorCount}` : ''}`, 'ok', 7000);
    } catch (e) {
      UI.toast('Ошибка упаковки ZIP: ' + (e.message || e), 'err');
    }
  }

  // ── Создание папки ──────────────────────────────────────────────
  // PUT /files/data/{path}/ с Content-Type: inode/directory и пустым телом
  async function createDirectory() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const name = await UI.promptModal({
      title: 'Новая папка',
      label: 'Имя папки в текущей директории',
      placeholder: 'my-folder',
      okLabel: 'Создать',
    });
    if (!name) return;
    if (!isValidFileName(name)) {
      UI.toast('Имя не должно содержать / \\ или быть пустым', 'err');
      return;
    }
    const newPath = API.joinPath(currentPath, name);
    UI.activity('Создание папки...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, newPath), {
      method: 'PUT',
      headers: { 'Content-Type': 'inode/directory' },
      body: '',
    });
    if (resp.ok) {
      UI.toast(`Папка «${name}» создана`, 'ok');
      if (global.Audit) Audit.log('file.createDir', { path: newPath });
      await loadFiles(currentPath);
    } else {
      let err = 'Не удалось создать папку';
      try { const j = await resp.json(); err = j.error || err; } catch {}
      UI.toast(err, 'err');
    }
  }

  // ── Загрузка файла (через диалог) ───────────────────────────────
  async function uploadFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      if (files.length) await uploadFilesArray(files);
    };
    input.click();
  }

  // ── Загрузка массива файлов (используется и dialog, и drag-and-drop) ──
  async function uploadFilesArray(files) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    let okCount = 0, errCount = 0;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const newPath = API.joinPath(currentPath, file.name);
      UI.activity(`Загрузка ${i + 1}/${files.length}: ${file.name}`);
      const resp = await API.apiRaw(API.PATHS.fileData(srv.id, newPath), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });
      if (resp.ok) {
        okCount += 1;
        if (global.Audit) Audit.log('file.upload', { name: file.name, size: UI.formatBytes(file.size) });
      }
      else errCount += 1;
    }
    if (files.length > 1 && global.Audit) Audit.log('file.uploadMulti', { count: okCount });
    if (okCount) UI.toast(`Загружено: ${okCount}${errCount ? `, ошибок: ${errCount}` : ''}`, 'ok');
    else if (errCount) UI.toast(`Не удалось загрузить ${errCount} файл(ов)`, 'err');
    await loadFiles(currentPath);
  }

  // ── Drag-and-drop инициализация ─────────────────────────────────
  // Вешаем обработчики на files-layout + section-card.
  // Вызывается один раз из app.js при init.
  let dndInitialized = false;
  function initDragAndDrop() {
    if (dndInitialized) return;
    dndInitialized = true;
    const dropZone = document.getElementById('dtab-files');
    if (!dropZone) return;

    let dragCounter = 0;

    dropZone.addEventListener('dragenter', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      dragCounter += 1;
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragover', (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    dropZone.addEventListener('dragleave', (e) => {
      dragCounter -= 1;
      if (dragCounter <= 0) {
        dragCounter = 0;
        dropZone.classList.remove('dragover');
      }
    });

    dropZone.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      dragCounter = 0;
      dropZone.classList.remove('dragover');
      const files = Array.from(e.dataTransfer.files);
      await uploadFilesArray(files);
    });
  }

  // ── Создание текстового файла ───────────────────────────────────
  async function createFile() {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const name = await UI.promptModal({
      title: 'Новый файл',
      label: 'Имя файла',
      placeholder: 'new-file.txt',
      okLabel: 'Создать',
    });
    if (!name) return;
    if (!isValidFileName(name)) {
      UI.toast('Имя не должно содержать / \\ или быть пустым', 'err');
      return;
    }
    const newPath = API.joinPath(currentPath, name);
    UI.activity('Создание файла...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, newPath), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: '',
    });
    if (resp.ok) {
      UI.toast(`Файл «${name}» создан`, 'ok');
      if (global.Audit) Audit.log('file.createFile', { path: newPath });
      await loadFiles(currentPath);
      // Откроем его для редактирования
      const info = await API.api(API.PATHS.fileInfo(srv.id, newPath));
      if (info.success && info.data) {
        currentEntry = info.data;
        setFilePreview(info.data, '', 'text');
      }
    } else {
      let err = 'Не удалось создать файл';
      try { const j = await resp.json(); err = j.error || err; } catch {}
      UI.toast(err, 'err');
    }
  }

  // ── Валидация имени файла/папки ─────────────────────────────────
  // Запрещаем / и \\ (они разбирают путь), а также пустые имена.
  function isValidFileName(name) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (!trimmed || trimmed === '.' || trimmed === '..') return false;
    if (/[\/\\]/.test(trimmed)) return false;
    return true;
  }

  // ── Удаление файла/папки ────────────────────────────────────────
  // DELETE /files/data/{path}/
  async function deleteEntry(encodedPath) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const path = decodeURIComponent(encodedPath);
    const infoResp = await API.api(API.PATHS.fileInfo(srv.id, path));
    if (!infoResp.success || !infoResp.data) {
      UI.toast('Файл недоступен', 'err');
      return;
    }
    const entry = infoResp.data;
    const confirmed = await UI.confirmModal({
      title: entry.isDirectory ? 'Удалить папку?' : 'Удалить файл?',
      message: `${entry.isDirectory ? 'Папка' : 'Файл'} «${entry.name || path}» будет удалён безвозвратно. Продолжить?`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) return;
    UI.activity('Удаление...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, path), { method: 'DELETE' });
    if (resp.ok) {
      UI.toast('Удалено', 'ok');
      if (global.Audit) Audit.log('file.delete', { path });
      if (currentEntry?.path === path) {
        currentEntry = null;
        setFilePreview();
      }
      await loadFiles(currentPath);
    } else {
      let err = 'Не удалось удалить';
      try { const j = await resp.json(); err = j.error || err; } catch {}
      UI.toast(err, 'err');
    }
  }

  // ── Редактор конфиг-файла (.properties / .yml / .toml) ──────────
  // GET /files/config/{path}/ → массив опций {key, label, type, value, options}
  // POST /files/config/{path}/ с {[key]: value, ...} → обновление
  async function openConfig(encodedPath) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const path = decodeURIComponent(encodedPath);
    configPath = path;
    // Перейдём на вкладку настроек и подгрузим туда конфиг
    // (но если мы уже на files — откроем модалку)
    showConfigModal(path);
  }

  async function loadConfigOptions(path) {
    const srv = Servers.getCurrent();
    if (!srv) return null;
    const r = await API.api(API.PATHS.fileConfig(srv.id, path));
    if (!r.success) return null;
    return Array.isArray(r.data) ? r.data : [];
  }

  async function showConfigModal(path) {
    UI.activity('Загрузка конфига...');
    const options = await loadConfigOptions(path);
    if (!options) {
      UI.toast('Не удалось загрузить конфиг', 'err');
      return;
    }
    configOptions = options;
    const fileName = path.split('/').pop() || path;

    const bodyHtml = `
      <div style="max-height:60vh;overflow-y:auto;padding-right:6px;">
        ${options.length ? `<div class="config-grid">${options.map((opt, i) => {
          const id = `cfg-${i}`;
          let control = '';
          if (opt.type === 'boolean') {
            control = `<input id="${id}" class="config-item-toggle" type="checkbox" ${opt.value ? 'checked' : ''} />`;
          } else if (opt.type === 'select' && Array.isArray(opt.options)) {
            control = `<select id="${id}">${opt.options.map(v => `<option value="${UI.escapeHtml(v)}" ${v === opt.value ? 'selected' : ''}>${UI.escapeHtml(v)}</option>`).join('')}</select>`;
          } else if (opt.type === 'integer') {
            control = `<input id="${id}" type="number" value="${UI.escapeHtml(opt.value ?? 0)}" />`;
          } else {
            control = `<input id="${id}" type="text" value="${UI.escapeHtml(opt.value ?? '')}" />`;
          }
          return `<div class="config-item">
            <div class="config-item-head">
              <div>
                <div class="config-item-label">${UI.escapeHtml(opt.label || opt.key)}</div>
                <div class="config-item-key">${UI.escapeHtml(opt.key)}</div>
              </div>
            </div>
            <div class="config-item-control">${control}</div>
          </div>`;
        }).join('')}</div>` : '<div class="empty-state"><p>В файле нет опций или это не конфиг-формат</p></div>'}
      </div>`;

    const result = await UI.showModal({
      title: `Конфиг: ${fileName}`,
      sub: `${options.length} параметров • ${path}`,
      bodyHtml,
      actions: [
        { label: 'Отмена', value: 'cancel' },
        { label: 'Сохранить всё', value: 'save', primary: true },
      ],
    });

    if (result === 'save') {
      await saveAllConfigOptions(path, options);
    }
  }

  async function saveAllConfigOptions(path, options) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const payload = {};
    options.forEach((opt, i) => {
      const el = document.getElementById(`cfg-${i}`);
      if (!el) return;
      let value;
      if (opt.type === 'boolean') value = !!el.checked;
      else if (opt.type === 'integer') value = Number(el.value || 0);
      else value = el.value;
      payload[opt.key] = value;
    });
    UI.activity('Сохранение конфига...');
    const r = await API.api(API.PATHS.fileConfig(srv.id, path), 'POST', payload);
    if (r.success) {
      UI.toast('Конфиг сохранён', 'ok');
    } else {
      UI.toast(r.error || 'Не удалось сохранить конфиг', 'err');
    }
  }

  // ── server.properties helpers (для settings tab) ────────────────
  async function loadServerProperties(showToast = false) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const el = document.getElementById('server-config-list');
    if (el) el.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Загрузка server.properties...</p></div>';
    const r = await API.api(API.PATHS.fileConfig(srv.id, 'server.properties'));
    if (!r.success) {
      if (el) el.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Не удалось загрузить server.properties</p></div>';
      if (showToast) UI.toast(r.error || 'Ошибка', 'err');
      return;
    }
    configOptions = Array.isArray(r.data) ? r.data : [];
    configPath = 'server.properties';
    renderServerProperties();
    if (showToast) UI.toast('server.properties обновлён');
  }

  function renderServerProperties() {
    const el = document.getElementById('server-config-list');
    if (!el) return;
    if (!configOptions.length) {
      el.innerHTML = '<div class="empty-state" style="padding:1.5rem;"><p>Параметры недоступны</p></div>';
      return;
    }
    const preferredOrder = [
      'max-players', 'gamemode', 'difficulty', 'white-list', 'online-mode', 'allow-flight',
      'force-gamemode', 'spawn-protection', 'view-distance', 'simulation-distance',
      'level-name', 'level-seed', 'level-type', 'generate-structures', 'hardcore',
      'resource-pack', 'resource-pack-prompt', 'pause-when-empty-seconds',
    ];
    const ordered = configOptions.slice().sort((a, b) => {
      const ai = preferredOrder.indexOf(a.key);
      const bi = preferredOrder.indexOf(b.key);
      if (ai === -1 && bi === -1) return (a.label || '').localeCompare(b.label || '', 'ru');
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    const featured = ordered.filter(opt => preferredOrder.includes(opt.key));
    el.innerHTML = featured.map((option, i) => {
      const id = `spcfg-${i}`;
      let control = '';
      if (option.type === 'boolean') {
        control = `<input id="${id}" class="config-item-toggle" type="checkbox" ${option.value ? 'checked' : ''} />`;
      } else if (option.type === 'select' && Array.isArray(option.options)) {
        control = `<select id="${id}">${option.options.map(v => `<option value="${UI.escapeHtml(v)}" ${v === option.value ? 'selected' : ''}>${UI.escapeHtml(v)}</option>`).join('')}</select>`;
      } else if (option.type === 'integer') {
        control = `<input id="${id}" type="number" value="${UI.escapeHtml(option.value ?? 0)}" />`;
      } else {
        control = `<input id="${id}" type="text" value="${UI.escapeHtml(option.value ?? '')}" />`;
      }
      return `<div class="config-item">
        <div class="config-item-head">
          <div>
            <div class="config-item-label">${UI.escapeHtml(option.label || option.key)}</div>
            <div class="config-item-key">${UI.escapeHtml(option.key)}</div>
          </div>
          <button class="btn btn-green btn-sm" onclick="Files.saveServerProperty(${i})">Сохранить</button>
        </div>
        <div class="config-item-control">${control}</div>
      </div>`;
    }).join('');
  }

  async function saveServerProperty(index) {
    const srv = Servers.getCurrent();
    if (!srv) return;
    const option = configOptions[index];
    if (!option) return;
    const el = document.getElementById(`spcfg-${index}`);
    if (!el) return;
    let value;
    if (option.type === 'boolean') value = !!el.checked;
    else if (option.type === 'integer') value = Number(el.value || 0);
    else value = el.value;
    const r = await API.api(API.PATHS.fileConfig(srv.id, 'server.properties'), 'POST', { [option.key]: value });
    if (r.success) {
      option.value = value;
      UI.toast(`${option.label || option.key} сохранён`, 'ok');
      if (global.Audit) Audit.log('config.save', { key: option.key, value: String(value) });
      await Servers.loadServer(srv.id);
    } else {
      UI.toast(r.error || 'Ошибка сохранения', 'err');
    }
  }

  // ───────────────────────────────────────────────────────────────
  //  NBT-парсер + профиль игрока
  //  .dat-файлы в world/playerdata/ — это gzip-compressed NBT.
  //  Формат NBT: https://minecraft.wiki/w/NBT_format
  //  Мы пишем минимальный парсер, без зависимостей.
  // ───────────────────────────────────────────────────────────────

  // Big-endian read helpers
  function nbtReadByte(view, pos) { return [view.getInt8(pos), pos + 1]; }
  function nbtReadShort(view, pos) { return [view.getInt16(pos), pos + 2]; }
  function nbtReadInt(view, pos) { return [view.getInt32(pos), pos + 4]; }
  function nbtReadLong(view, pos) {
    // BigInt для long, чтобы не потерять точность
    const hi = view.getUint32(pos);
    const lo = view.getUint32(pos + 4);
    return [BigInt(hi) << 32n | BigInt(lo), pos + 8];
  }
  function nbtReadFloat(view, pos) { return [view.getFloat32(pos), pos + 4]; }
  function nbtReadDouble(view, pos) { return [view.getFloat64(pos), pos + 8]; }
  function nbtReadString(view, pos) {
    const [len, p2] = nbtReadShort(view, pos);
    const bytes = new Uint8Array(view.buffer, view.byteOffset + p2, len);
    const str = new TextDecoder('utf-8').decode(bytes);
    return [str, p2 + len];
  }

  // Главный рекурсивный парсер payload по типу
  function nbtReadPayload(type, view, pos) {
    switch (type) {
      case 1: { const [v, p] = nbtReadByte(view, pos); return [{ value: v }, p]; }       // BYTE
      case 2: { const [v, p] = nbtReadShort(view, pos); return [{ value: v }, p]; }       // SHORT
      case 3: { const [v, p] = nbtReadInt(view, pos); return [{ value: v }, p]; }         // INT
      case 4: { const [v, p] = nbtReadLong(view, pos); return [{ value: v }, p]; }        // LONG
      case 5: { const [v, p] = nbtReadFloat(view, pos); return [{ value: v }, p]; }       // FLOAT
      case 6: { const [v, p] = nbtReadDouble(view, pos); return [{ value: v }, p]; }      // DOUBLE
      case 7: { // BYTE_ARRAY
        const [len, p] = nbtReadInt(view, pos);
        const arr = [];
        for (let i = 0; i < len; i++) { const [v, np] = nbtReadByte(view, p + i); arr.push(v); }
        return [{ value: arr, type: 'byte_array' }, p + len];
      }
      case 8: { // STRING
        const [v, p] = nbtReadString(view, pos);
        return [{ value: v, type: 'string' }, p];
      }
      case 9: { // LIST
        const [elemType, p1] = nbtReadByte(view, pos);
        const [len, p2] = nbtReadInt(view, p1);
        const items = [];
        let p = p2;
        for (let i = 0; i < len; i++) {
          const [item, np] = nbtReadPayload(elemType, view, p);
          items.push(item);
          p = np;
        }
        return [{ value: items, type: 'list', elementType: elemType }, p];
      }
      case 10: { // COMPOUND
        const entries = {};
        let p = pos;
        while (true) {
          const [t, p1] = nbtReadByte(view, p);
          p = p1;
          if (t === 0) break; // END
          const [name, p2] = nbtReadString(view, p);
          p = p2;
          const [val, p3] = nbtReadPayload(t, view, p);
          p = p3;
          entries[name] = val;
        }
        return [{ value: entries, type: 'compound' }, p];
      }
      case 11: { // INT_ARRAY
        const [len, p] = nbtReadInt(view, pos);
        const arr = [];
        let pp = p;
        for (let i = 0; i < len; i++) { const [v, np] = nbtReadInt(view, pp); arr.push(v); pp = np; }
        return [{ value: arr, type: 'int_array' }, pp];
      }
      case 12: { // LONG_ARRAY
        const [len, p] = nbtReadInt(view, pos);
        const arr = [];
        let pp = p;
        for (let i = 0; i < len; i++) { const [v, np] = nbtReadLong(view, pp); arr.push(v); pp = np; }
        return [{ value: arr, type: 'long_array' }, pp];
      }
      default:
        throw new Error('Unknown NBT tag type: ' + type);
    }
  }

  // Распаковка gzip через нативный DecompressionStream
  async function gunzip(buffer) {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([buffer]).stream().pipeThrough(ds);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  // Парсинг NBT из ArrayBuffer (gzip или plain)
  async function parseNbtFile(arrayBuffer) {
    let bytes = new Uint8Array(arrayBuffer);
    // Проверим gzip magic: 0x1f 0x8b
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      bytes = await gunzip(bytes);
    }
    // DataView на распакованных байтах (big-endian по умолчанию)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const [type, p1] = nbtReadByte(view, 0);
    if (type === 0) return null; // пустой файл
    const [name, p2] = nbtReadString(view, p1);
    const [payload] = nbtReadPayload(type, view, p2);
    return { name, payload };
  }

  // Извлечь значения игрока из распарсенного NBT
  function extractPlayerData(parsed) {
    if (!parsed?.payload?.value) return null;
    const root = parsed.payload.value;
    // Структура: { Data: { Health: ..., foodLevel: ..., Inventory: [...], ... } }
    // (иногда Data уже корень, зависит от версии)
    const data = root.Data?.value || root;
    const result = {
      raw: data,
      health: data.Health?.value,
      foodLevel: data.foodLevel?.value,
      foodSaturationLevel: data.foodSaturationLevel?.value,
      xpLevel: data.XpLevel?.value,
      xpP: data.XpP?.value,
      xpTotal: data.XpTotal?.value,
      score: data.Score?.value,
      playerGameType: data.playerGameType?.value,
      dimension: data.Dimension?.value,
      pos: data.Pos?.value,
      rotation: data.Rotation?.value,
      inventory: extractInventory(data.Inventory?.value),
      enderItems: extractInventory(data.EnderItems?.value),
      abilities: data.abilities?.value,
      seenCredits: data.seenCredits?.value,
      fire: data.Fire?.value,
      air: data.Air?.value,
      fallDistance: data.fallDistance?.value,
    };
    return result;
  }

  function extractInventory(list) {
    if (!Array.isArray(list)) return [];
    return list.map(item => {
      const v = item.value;
      if (!v) return null;
      return {
        id: v.id?.value,
        count: v.Count?.value,
        slot: v.Slot?.value,
        tag: v.tag?.value,
      };
    }).filter(Boolean);
  }

  // Отрисовать инвентарь в HTML (3 строки по 9 = 27 слотов main + 9 hotbar)
  function renderInventoryHtml(inventory) {
    if (!inventory || !inventory.length) return '<div style="color:var(--text3);font-size:12px;">Инвентарь пуст</div>';
    // Слоты 0-8 — hotbar, 9-35 — main inventory, 100-103 — armor, -106 — offhand
    const slots = new Map();
    inventory.forEach(it => {
      slots.set(it.slot, it);
    });
    const mcItemStyle = 'display:inline-flex;align-items:center;justify-content:center;width:38px;height:38px;border:1px solid var(--border2);border-radius:4px;background:var(--surface2);position:relative;font-size:11px;color:var(--text);font-family:var(--mono);';
    const cell = (slot) => {
      const it = slots.get(slot);
      if (!it) return `<div style="${mcItemStyle}opacity:0.5;"></div>`;
      const itemId = String(it.id || '').replace('minecraft:', '');
      const count = Number(it.count) || 1;
      return `<div style="${mcItemStyle}" title="${UI.escapeHtml(it.id)} (слот ${slot})">
        <span style="font-size:9px;line-height:1;text-align:center;word-break:break-all;overflow:hidden;">${UI.escapeHtml(itemId.slice(0, 8))}</span>
        ${count > 1 ? `<span style="position:absolute;bottom:1px;right:3px;font-size:10px;font-weight:600;color:var(--text);">${count}</span>` : ''}
      </div>`;
    };
    const row = (slotsArr) => `<div style="display:flex;gap:3px;margin-bottom:3px;">${slotsArr.map(cell).join('')}</div>`;

    let html = '<div style="margin-top:6px;">';
    html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px;">Main inventory (9-35)</div>';
    for (let r = 0; r < 3; r++) {
      html += row([9 + r * 9, 10 + r * 9, 11 + r * 9, 12 + r * 9, 13 + r * 9, 14 + r * 9, 15 + r * 9, 16 + r * 9, 17 + r * 9]);
    }
    html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:6px 0 4px;">Hotbar (0-8)</div>';
    html += row([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    html += '<div style="font-size:10px;color:var(--text3);text-transform:uppercase;letter-spacing:.05em;margin:6px 0 4px;">Armor (100-103) + Offhand (-106)</div>';
    html += row([103, 102, 101, 100, -106]);
    html += '</div>';
    return html;
  }

  // ── Открыть профиль игрока (вызывается по кнопке из preview .dat) ──
  async function openPlayerProfile() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) return;
    UI.activity('Загрузка и парсинг NBT...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path));
    if (!resp.ok) { UI.toast('Не удалось скачать файл', 'err'); return; }
    const buf = await resp.arrayBuffer();
    let parsed;
    try {
      parsed = await parseNbtFile(buf);
    } catch (e) {
      UI.toast('Не удалось распарсить NBT: ' + (e.message || e), 'err');
      return;
    }
    if (!parsed) { UI.toast('Файл пустой', 'err'); return; }
    const player = extractPlayerData(parsed);
    if (!player) { UI.toast('Структура NBT не похожа на игрока', 'err'); return; }

    const uuid = (currentEntry.name || '').replace(/\.dat$/i, '');
    const posStr = Array.isArray(player.pos) && player.pos.length === 3
      ? `${Number(player.pos[0]).toFixed(1)}, ${Number(player.pos[1]).toFixed(1)}, ${Number(player.pos[2]).toFixed(1)}`
      : '—';
    const rotStr = Array.isArray(player.rotation) && player.rotation.length === 2
      ? `yaw ${Number(player.rotation[0]).toFixed(1)}, pitch ${Number(player.rotation[1]).toFixed(1)}`
      : '—';

    const bodyHtml = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
        <div class="bento-card" style="padding:.8rem;">
          <div class="bento-card-title">UUID</div>
          <div style="font-family:var(--mono);font-size:12px;color:var(--text);word-break:break-all;">${UI.escapeHtml(uuid)}</div>
        </div>
        <div class="bento-card" style="padding:.8rem;">
          <div class="bento-card-title">Габариты</div>
          <div style="font-size:14px;color:var(--text);font-family:var(--mono);">${UI.formatBytes(buf.byteLength)}</div>
        </div>
      </div>
      <div class="bento" style="margin-bottom:14px;">
        <div class="bento-card"><div class="bento-card-title">Здоровье</div><div class="big-num">${player.health != null ? Number(player.health).toFixed(1) : '—'}<span style="font-size:14px;color:var(--text3)"> / 20</span></div></div>
        <div class="bento-card"><div class="bento-card-title">Голод</div><div class="big-num">${player.foodLevel != null ? player.foodLevel : '—'}<span style="font-size:14px;color:var(--text3)"> / 20</span></div></div>
        <div class="bento-card"><div class="bento-card-title">Уровень XP</div><div class="big-num">${player.xpLevel != null ? player.xpLevel : '—'}</div></div>
        <div class="bento-card"><div class="bento-card-title">Всего XP</div><div class="big-num">${player.xpTotal != null ? player.xpTotal : '—'}</div></div>
        <div class="bento-card"><div class="bento-card-title">Счёт</div><div class="big-num">${player.score != null ? player.score : '—'}</div></div>
        <div class="bento-card"><div class="bento-card-title">Режим игры</div><div class="big-num" style="font-size:18px;">${gameModeName(player.playerGameType)}</div></div>
      </div>
      <div class="section-card" style="padding:1rem;margin-bottom:12px;">
        <div class="section-card-title">Локация</div>
        <div class="account-grid">
          <div class="account-row"><span class="account-row-label">Измерение</span><span class="account-row-val">${UI.escapeHtml(String(player.dimension || '—'))}</span></div>
          <div class="account-row"><span class="account-row-label">Позиция (X, Y, Z)</span><span class="account-row-val">${UI.escapeHtml(posStr)}</span></div>
          <div class="account-row"><span class="account-row-label">Поворот</span><span class="account-row-val">${UI.escapeHtml(rotStr)}</span></div>
          <div class="account-row"><span class="account-row-label">Падение</span><span class="account-row-val">${player.fallDistance != null ? Number(player.fallDistance).toFixed(2) : '—'}</span></div>
          <div class="account-row"><span class="account-row-label">Огонь</span><span class="account-row-val">${player.fire != null ? player.fire + ' тиков' : '—'}</span></div>
          <div class="account-row"><span class="account-row-label">Воздух</span><span class="account-row-val">${player.air != null ? player.air : '—'}</span></div>
        </div>
      </div>
      <div class="section-card" style="padding:1rem;margin-bottom:12px;">
        <div class="section-card-title">Инвентарь (${player.inventory?.length || 0} предметов)</div>
        ${renderInventoryHtml(player.inventory)}
      </div>
      <div class="section-card" style="padding:1rem;margin-bottom:12px;">
        <div class="section-card-title">Эндер-сундук (${player.enderItems?.length || 0} предметов)</div>
        ${renderInventoryHtml(player.enderItems)}
      </div>
      <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-size:12px;color:var(--text3);">Сырой NBT (для разработчиков)</summary>
        <pre style="margin-top:8px;font-size:10px;background:#0f0f12;padding:10px;border-radius:6px;overflow:auto;max-height:300px;color:var(--text2);">${UI.escapeHtml(JSON.stringify(parsed, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2))}</pre>
      </details>`;

    await UI.showModal({
      title: `Профиль игрока`,
      sub: currentEntry.path,
      bodyHtml,
      actions: [{ label: 'Закрыть', value: true, primary: true }],
    });
  }

  function gameModeName(mode) {
    const m = Number(mode);
    if (m === 0) return 'Survival';
    if (m === 1) return 'Creative';
    if (m === 2) return 'Adventure';
    if (m === 3) return 'Spectator';
    return mode != null ? String(mode) : '—';
  }

  // ───────────────────────────────────────────────────────────────
  //  Просмотр достижлений игрока (advancements/{uuid}.json)
  // ───────────────────────────────────────────────────────────────
  async function openAdvancements() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) return;
    UI.activity('Загрузка достижлений...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path));
    if (!resp.ok) { UI.toast('Не удалось скачать файл', 'err'); return; }
    let data;
    try { data = await resp.json(); }
    catch (e) { UI.toast('Не удалось распарсить JSON: ' + (e.message || e), 'err'); return; }

    // Структура: { "minecraft:story/mine_diamond": { criteria: {...}, done: true }, ... }
    const entries = Object.entries(data || {});
    const doneCount = entries.filter(([_, v]) => v && v.done).length;
    const totalCount = entries.length;
    const categories = groupAdvancementsByCategory(entries);

    const bodyHtml = `
      <div class="bento" style="margin-bottom:14px;">
        <div class="bento-card"><div class="bento-card-title">Всего</div><div class="big-num">${totalCount}</div></div>
        <div class="bento-card"><div class="bento-card-title">Выполнено</div><div class="big-num" style="color:var(--green-text)">${doneCount}</div></div>
        <div class="bento-card"><div class="bento-card-title">Прогресс</div><div class="big-num">${totalCount ? Math.round(doneCount / totalCount * 100) : 0}<span style="font-size:14px;color:var(--text3)">%</span></div></div>
      </div>
      ${Object.entries(categories).map(([cat, items]) => `
        <div class="section-card" style="padding:1rem;margin-bottom:10px;">
          <div class="section-card-title">${UI.escapeHtml(cat)} (${items.filter(i => i.done).length}/${items.length})</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:6px;">
            ${items.map(([key, v]) => {
              const name = key.split('/').pop().replace(/_/g, ' ');
              return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;background:${v.done ? 'var(--green-light)' : 'var(--surface2)'};font-size:12px;">
                <span style="font-size:14px;">${v.done ? '✓' : '○'}</span>
                <span style="color:${v.done ? 'var(--green-text)' : 'var(--text2)'};">${UI.escapeHtml(name)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>
      `).join('')}
      <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-size:12px;color:var(--text3);">Сырой JSON</summary>
        <pre style="margin-top:8px;font-size:10px;background:#0f0f12;padding:10px;border-radius:6px;overflow:auto;max-height:300px;color:var(--text2);">${UI.escapeHtml(JSON.stringify(data, null, 2))}</pre>
      </details>`;

    await UI.showModal({
      title: 'Достижения игрока',
      sub: currentEntry.path,
      bodyHtml,
      actions: [{ label: 'Закрыть', value: true, primary: true }],
    });
  }

  function groupAdvancementsByCategory(entries) {
    const cats = {};
    for (const [key, v] of entries) {
      const cat = key.includes(':') ? key.split(':')[0] : 'other';
      const sub = key.includes('/') ? key.split('/')[0].split(':').pop() : 'root';
      const groupName = `${cat}/${sub}`;
      if (!cats[groupName]) cats[groupName] = [];
      cats[groupName].push([key, v]);
    }
    return cats;
  }

  // ───────────────────────────────────────────────────────────────
  //  Просмотр статистики игрока (stats/{uuid}.json)
  //  Формат: { stats: { "minecraft:mined": { "minecraft:stone": 42, ... }, ... } }
  // ───────────────────────────────────────────────────────────────
  async function openPlayerStats() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) return;
    UI.activity('Загрузка статистики...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path));
    if (!resp.ok) { UI.toast('Не удалось скачать файл', 'err'); return; }
    let data;
    try { data = await resp.json(); }
    catch (e) { UI.toast('Не удалось распарсить JSON: ' + (e.message || e), 'err'); return; }

    const stats = data?.stats || data?.data?.stats || data;
    const categoryLabels = {
      'minecraft:mined': 'Добыто блоков',
      'minecraft:picked_up': 'Подобрано',
      'minecraft:dropped': 'Выброшено',
      'minecraft:used': 'Использовано предметов',
      'minecraft:broken': 'Сломано инструментов',
      'minecraft:crafted': 'Скрафчено',
      'minecraft:killed': 'Убито мобов',
      'minecraft:killed_by': 'Убито игроком',
      'minecraft:custom': 'Прочее (пройдено, прыжки и т.д.)',
    };

    const topByCategory = {};
    let totalActions = 0;
    for (const [cat, items] of Object.entries(stats)) {
      const arr = Object.entries(items || {}).sort((a, b) => b[1] - a[1]);
      topByCategory[cat] = arr;
      totalActions += arr.reduce((s, [_, n]) => s + n, 0);
    }

    const bodyHtml = `
      <div class="bento" style="margin-bottom:14px;">
        <div class="bento-card"><div class="bento-card-title">Категорий</div><div class="big-num">${Object.keys(stats).length}</div></div>
        <div class="bento-card"><div class="bento-card-title">Всего действий</div><div class="big-num">${totalActions.toLocaleString('ru-RU')}</div></div>
      </div>
      ${Object.entries(topByCategory).map(([cat, arr]) => {
        if (!arr.length) return '';
        const label = categoryLabels[cat] || cat;
        const top = arr.slice(0, 20);
        const max = top[0]?.[1] || 1;
        return `<div class="section-card" style="padding:1rem;margin-bottom:10px;">
          <div class="section-card-title">${UI.escapeHtml(label)} (${arr.length})</div>
          <div style="display:flex;flex-direction:column;gap:3px;">
            ${top.map(([key, n]) => {
              const itemName = key.replace('minecraft:', '').replace(/_/g, ' ');
              const pct = (n / max * 100).toFixed(0);
              return `<div style="display:grid;grid-template-columns:1fr 60px 80px;gap:8px;align-items:center;font-size:12px;padding:3px 0;">
                <span style="color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${UI.escapeHtml(itemName)}</span>
                <span style="color:var(--text3);font-family:var(--mono);text-align:right;">${n.toLocaleString('ru-RU')}</span>
                <div style="height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:var(--green);"></div></div>
              </div>`;
            }).join('')}
            ${arr.length > 20 ? `<div style="font-size:11px;color:var(--text3);text-align:center;padding:6px;">…и ещё ${arr.length - 20}</div>` : ''}
          </div>
        </div>`;
      }).join('')}
      <details style="margin-top:14px;">
        <summary style="cursor:pointer;font-size:12px;color:var(--text3);">Сырой JSON</summary>
        <pre style="margin-top:8px;font-size:10px;background:#0f0f12;padding:10px;border-radius:6px;overflow:auto;max-height:300px;color:var(--text2);">${UI.escapeHtml(JSON.stringify(data, null, 2))}</pre>
      </details>`;

    await UI.showModal({
      title: 'Статистика игрока',
      sub: currentEntry.path,
      bodyHtml,
      actions: [{ label: 'Закрыть', value: true, primary: true }],
    });
  }

  // ───────────────────────────────────────────────────────────────
  //  Карта мира из .mca региона
  //  Поддерживает 2 режима:
  //   - surface: верхний блок (поверхность)
  //   - slice:   срез на конкретной высоте Y (для пещер/руды)
  //  В модалке есть контролы для переключения и изменения параметров.
  // ───────────────────────────────────────────────────────────────
  async function openRegionMap() {
    const srv = Servers.getCurrent();
    if (!srv || !currentEntry) return;
    if (typeof MCA === 'undefined') {
      UI.toast('Модуль MCA не загружен', 'err');
      return;
    }
    UI.activity('Загрузка региона (это может занять 5-20 сек)...');
    const resp = await API.apiRaw(API.PATHS.fileData(srv.id, currentEntry.path));
    if (!resp.ok) { UI.toast('Не удалось скачать регион', 'err'); return; }
    const buf = await resp.arrayBuffer();
    UI.activity(`Парсинг ${UI.formatBytes(buf.byteLength)}...`);

    let chunks;
    try {
      chunks = await MCA.parseMcaFile(buf, (done, total) => {
        UI.activity(`Парсинг чанков: ${done}/${total}...`);
      });
    } catch (e) {
      UI.toast('Не удалось распарсить регион: ' + (e.message || e), 'err');
      return;
    }

    const validChunks = chunks.filter(c => c).length;
    if (validChunks === 0) {
      UI.toast('В регионе нет валидных чанков', 'err');
      return;
    }

    // Извлечь координаты региона из имени файла (r.X.Z.mca)
    const nameMatch = (currentEntry.name || '').match(/r\.(-?\d+)\.(-?\d+)\.mca/i);
    const regionX = nameMatch ? parseInt(nameMatch[1]) : 0;
    const regionZ = nameMatch ? parseInt(nameMatch[2]) : 0;
    const worldX = regionX * 512;
    const worldZ = regionZ * 512;

    // Определим диапазон Y, который реально есть в чанках (для слайдера)
    let minY = 319, maxY = -64;
    for (const chunk of chunks) {
      if (!chunk || !chunk.sections) continue;
      for (const sec of chunk.sections) {
        if (sec.y * 16 < minY) minY = sec.y * 16;
        if (sec.y * 16 + 15 > maxY) maxY = sec.y * 16 + 15;
      }
    }
    // Если не удалось определить — дефолт
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || minY > maxY) {
      minY = -64; maxY = 319;
    }

    // Состояние режима (хранится в замыкании, доступно из controls)
    let renderState = {
      mode: 'surface',  // 'surface' | 'slice'
      maxY: 319,        // для surface — до какой высоты искать верхний блок
      sliceY: 64,       // для slice — на какой высоте брать срез
      showGrid: true,
    };

    const bodyHtml = `
      <div style="display:flex;flex-direction:column;gap:10px;">
        <div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text3);">
          <span>Регион: <strong style="color:var(--text);">${regionX}, ${regionZ}</strong></span>
          <span>Мировые X: <strong style="color:var(--text);">${worldX}..${worldX + 511}</strong></span>
          <span>Мировые Z: <strong style="color:var(--text);">${worldZ}..${worldZ + 511}</strong></span>
          <span>Чанков: <strong style="color:var(--text);">${validChunks}/1024</strong></span>
          <span>Y в мире: <strong style="color:var(--text);">${minY}..${maxY}</strong></span>
          <span>Размер: <strong style="color:var(--text);">${UI.formatBytes(buf.byteLength)}</strong></span>
        </div>

        <div style="background:var(--surface2);border-radius:8px;padding:10px;display:flex;flex-wrap:wrap;gap:10px;align-items:center;">
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);cursor:pointer;">
            <input type="radio" name="map-mode" value="surface" checked onchange="Files._mapState.mode='surface'; Files._updateMapControls();" /> Поверхность
          </label>
          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);cursor:pointer;">
            <input type="radio" name="map-mode" value="slice" onchange="Files._mapState.mode='slice'; Files._updateMapControls();" /> Срез на высоте Y
          </label>

          <div id="map-ctrl-surface" style="display:flex;align-items:center;gap:8px;">
            <span style="font-size:11px;color:var(--text3);">до Y:</span>
            <input type="number" id="map-maxy" value="319" min="-64" max="319" style="width:70px;padding:4px 7px;border:1px solid var(--border2);border-radius:4px;background:var(--bg);color:var(--text);font-family:var(--mono);font-size:12px;" />
          </div>

          <div id="map-ctrl-slice" style="display:none;align-items:center;gap:8px;">
            <span style="font-size:11px;color:var(--text3);">Y среза:</span>
            <input type="range" id="map-slice-slider" min="${minY}" max="${maxY}" value="64" style="width:180px;" oninput="document.getElementById('map-slice-val').textContent=this.value;" />
            <span id="map-slice-val" style="font-family:var(--mono);font-size:12px;color:var(--text);min-width:36px;">64</span>
          </div>

          <label style="display:flex;align-items:center;gap:5px;font-size:12px;color:var(--text2);cursor:pointer;margin-left:auto;">
            <input type="checkbox" id="map-grid" checked /> Сетка
          </label>

          <button class="btn btn-green btn-sm" onclick="Files._rerenderMap()">Перерисовать</button>
        </div>

        <div style="position:relative;background:#000;border-radius:8px;overflow:hidden;display:inline-block;">
          <canvas id="region-map-canvas" width="512" height="512" style="display:block;max-width:100%;height:auto;image-rendering:pixelated;cursor:crosshair;"></canvas>
          <div id="region-map-tooltip" style="position:absolute;display:none;background:rgba(0,0,0,0.85);color:var(--text);padding:6px 9px;border-radius:6px;font-size:11px;pointer-events:none;font-family:var(--mono);white-space:nowrap;border:1px solid var(--border2);z-index:10;"></div>
        </div>
        <div style="font-size:11px;color:var(--text3);">Кликни на любой пиксель — покажется блок и его мировые координаты. 1 пиксель = 1 блок. Сетка — границы чанков (16×16 блоков).</div>
        <div id="region-map-info" style="font-size:12px;color:var(--text2);min-height:20px;padding:6px 10px;background:var(--surface2);border-radius:6px;">Готово к работе.</div>
        <details style="margin-top:6px;">
          <summary style="cursor:pointer;font-size:12px;color:var(--text3);">Подсказки по режимам</summary>
          <div style="margin-top:6px;font-size:11px;color:var(--text3);line-height:1.6;">
            <strong>Поверхность</strong> — для каждого столбца (X,Z) ищется самый верхний непустой блок (до Y=319).
            Подходит для общей карты мира: видно горы, леса, воду, пустыни.
            <br />
            <strong>Срез на высоте Y</strong> — показывает блоки ровно на высоте Y.
            Полезно для:
            <ul style="margin-left:18px;margin-top:4px;">
              <li>Y=11 — уровень алмазов в 1.17- (видно руды в пещерах)</li>
              <li>Y=-58 — уровень алмазов в 1.18+</li>
              <li>Y=64 — морской уровень (видно океаны)</li>
              <li>Y=0 — граница бедрока</li>
              <li>Y=any — поиск пещер, шахт, построек</li>
            </ul>
            <br />
            Если карта поверхности белая/серая — попробуй режим «Срез» на Y=64 или Y=100.
            Это покажет, есть ли вообще блоки в чанках или проблема в парсере.
          </div>
        </details>
      </div>`;

    // Сохраняем chunks + renderState в Files для доступа из controls
    Files._mapChunks = chunks;
    Files._mapState = renderState;
    Files._mapWorldX = worldX;
    Files._mapWorldZ = worldZ;
    Files._mapRegionX = regionX;
    Files._mapRegionZ = regionZ;

    await UI.showModal({
      title: `Карта региона ${regionX}, ${regionZ}`,
      sub: currentEntry.path,
      bodyHtml,
      actions: [
        { label: 'Скачать PNG', value: 'download', primary: false },
        { label: 'Закрыть', value: true, primary: true },
      ],
    }).then(async (result) => {
      if (result === 'download') {
        const canvas = document.getElementById('region-map-canvas');
        if (canvas) {
          const a = document.createElement('a');
          a.href = canvas.toDataURL('image/png');
          a.download = `region-${regionX}-${regionZ}-${renderState.mode}${renderState.mode === 'slice' ? '-y' + renderState.sliceY : ''}.png`;
          a.click();
          UI.toast('PNG сохранён', 'ok');
        }
      }
      // Очистка
      delete Files._mapChunks;
      delete Files._mapState;
      delete Files._mapWorldX;
      delete Files._mapWorldZ;
    });

    // После показа модалки: первая отрисовка + подключение tooltip
    setTimeout(() => {
      const canvas = document.getElementById('region-map-canvas');
      const tooltip = document.getElementById('region-map-tooltip');
      const info = document.getElementById('region-map-info');
      if (!canvas) return;

      // Первая отрисовка (поверхность по умолчанию)
      Files._rerenderMap();

      // Tooltip + click
      const handleMove = (e) => {
        if (!Files._mapState) return; // модалка закрыта
        const rect = canvas.getBoundingClientRect();
        const scaleX = 512 / rect.width;
        const scaleY = 512 / rect.height;
        const px = Math.floor((e.clientX - rect.left) * scaleX);
        const py = Math.floor((e.clientY - rect.top) * scaleY);
        if (px < 0 || px >= 512 || py < 0 || py >= 512) return;
        const d = MCA.getBlockAtPixel(canvas, px, py, Files._mapChunks, renderState.mode, renderState.sliceY, renderState.maxY);
        if (!d) return;
        const worldBX = worldX + px;
        const worldBZ = worldZ + py;
        const block = d.top?.block || 'minecraft:air';
        const y = d.top?.y ?? '—';
        tooltip.style.display = 'block';
        tooltip.innerHTML = `${UI.escapeHtml(block)}<br/>X=${worldBX} Z=${worldBZ}<br/>Y=${y}`;
        // Ограничиваем позицию tooltip внутри canvas-обёртки, чтобы не убегал
        const tw = tooltip.offsetWidth;
        const th = tooltip.offsetHeight;
        let left = e.clientX - rect.left + 10;
        let top = e.clientY - rect.top + 10;
        const maxLeft = rect.width - tw - 4;
        const maxTop = rect.height - th - 4;
        if (left > maxLeft) left = Math.max(0, maxLeft);
        if (top > maxTop) top = Math.max(0, maxTop);
        tooltip.style.left = left + 'px';
        tooltip.style.top = top + 'px';
      };

      const handleClick = (e) => {
        if (!Files._mapState) return; // модалка закрыта
        const rect = canvas.getBoundingClientRect();
        const scaleX = 512 / rect.width;
        const scaleY = 512 / rect.height;
        const px = Math.floor((e.clientX - rect.left) * scaleX);
        const py = Math.floor((e.clientY - rect.top) * scaleY);
        if (px < 0 || px >= 512 || py < 0 || py >= 512) return;
        const d = MCA.getBlockAtPixel(canvas, px, py, Files._mapChunks, renderState.mode, renderState.sliceY, renderState.maxY);
        if (!d) return;
        const worldBX = worldX + px;
        const worldBZ = worldZ + py;
        const block = d.top?.block || 'minecraft:air';
        const y = d.top?.y ?? '—';
        if (info) info.innerHTML = `Клик: <strong style="color:var(--text);">${UI.escapeHtml(block)}</strong> на координатах <strong style="color:var(--text);">X=${worldBX} Y=${y} Z=${worldBZ}</strong> (чанк ${d.cx},${d.cz} блок ${d.bx},${d.bz})`;
      };

      canvas.addEventListener('mousemove', handleMove);
      canvas.addEventListener('click', handleClick);
      canvas.addEventListener('mouseleave', () => { if (tooltip) tooltip.style.display = 'none'; });
    }, 100);
  }

  // ── Перерисовать карту с текущими параметрами из controls ───────
  async function _rerenderMap() {
    const canvas = document.getElementById('region-map-canvas');
    if (!canvas) return;
    const state = global.Files._mapState;
    const chunks = global.Files._mapChunks;
    if (!chunks || !state) return;

    // Считаем значения из контролов
    const maxyEl = document.getElementById('map-maxy');
    const sliceSlider = document.getElementById('map-slice-slider');
    const gridEl = document.getElementById('map-grid');
    if (maxyEl) state.maxY = parseInt(maxyEl.value) || 319;
    if (sliceSlider) state.sliceY = parseInt(sliceSlider.value) || 0;
    if (gridEl) state.showGrid = gridEl.checked;

    const info = document.getElementById('region-map-info');
    if (info) info.innerHTML = `<span style="color:var(--text3);">Отрисовка: режим=${state.mode}${state.mode === 'slice' ? ', Y=' + state.sliceY : ', до Y=' + state.maxY}...</span>`;

    // Токен отмены: если модалку закрыли во время рендера — рендер прерывается.
    const isCancelled = () => !global.Files._mapState;

    try {
      if (state.mode === 'slice') {
        await MCA.renderSlice(canvas, chunks, state.sliceY, {
          showGrid: state.showGrid,
          isCancelled,
          onProgress: (done, total) => {
            if (isCancelled()) return;
            UI.activity(`Срез Y=${state.sliceY}: ${done}/${total} чанков...`);
          },
        });
      } else {
        // Считаем статистику во время рендера
        let foundTopBlocks = 0;
        let totalColumns = 0;
        const blockCounter = new Map();
        await MCA.renderMap(canvas, chunks, {
          showGrid: state.showGrid,
          maxY: state.maxY,
          isCancelled,
          onProgress: (done, total) => {
            if (isCancelled()) return;
            UI.activity(`Поверхность: ${done}/${total} чанков...`);
          },
          onChunk: (chunk) => {
            if (isCancelled()) return;
            if (!chunk || !chunk.sections) return;
            for (let bz = 0; bz < 16; bz++) {
              for (let bx = 0; bx < 16; bx++) {
                totalColumns += 1;
                const top = MCA.getTopBlock(chunk, bx, bz, state.maxY);
                if (top) {
                  foundTopBlocks += 1;
                  blockCounter.set(top.block, (blockCounter.get(top.block) || 0) + 1);
                }
              }
            }
          },
        });

        if (isCancelled()) return; // модалку закрыли — не трогаем info

        // Покажем статистику
        const topBlocks = Array.from(blockCounter.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([block, count]) => `${UI.escapeHtml(block.replace('minecraft:', ''))} (${count})`)
          .join(', ') || '—';
        if (info) info.innerHTML = `Поверхность (до Y=${state.maxY}): найдено <strong style="color:var(--text);">${foundTopBlocks}</strong> блоков из ${totalColumns}. Топ: ${topBlocks}`;
      }
      if (!isCancelled()) UI.activity('Карта готова');
    } catch (e) {
      if (isCancelled()) return; // не логируем ошибки отменённого рендера
      UI.toast('Ошибка отрисовки: ' + (e.message || e), 'err');
      if (info) info.innerHTML = `<span style="color:var(--red-text);">Ошибка: ${UI.escapeHtml(e.message || String(e))}</span>`;
    }
  }

  // ── Показать/скрыть контролы в зависимости от режима ────────────
  function _updateMapControls() {
    const state = global.Files._mapState;
    if (!state) return;
    const surface = document.getElementById('map-ctrl-surface');
    const slice = document.getElementById('map-ctrl-slice');
    if (surface) surface.style.display = state.mode === 'surface' ? 'flex' : 'none';
    if (slice) slice.style.display = state.mode === 'slice' ? 'flex' : 'none';
  }

  // ── Export ──────────────────────────────────────────────────────
  global.Files = {
    onOpenServer,
    load: loadFiles,
    getCurrentPath,
    openEntry, setFilePreview,
    saveEdited, resetEdited, downloadCurrent, downloadSpecific, downloadCurrentFolder,
    createDirectory, createFile, uploadFile, uploadFilesArray, initDragAndDrop,
    deleteEntry,
    openConfig, loadServerProperties, saveServerProperty,
    openPlayerProfile, openAdvancements, openPlayerStats, openRegionMap,
    toggleFileSelect, selectAllFiles, clearSelection, deleteSelected, downloadSelectedAsZip,
    switchMdTab, switchHlTab,
    _rerenderMap, _updateMapControls,
  };
})(window);
