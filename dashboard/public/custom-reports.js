(() => {
  const $ = (id) => document.getElementById(id);
  const state = { file: null, text: '', headers: [], sampleRows: [], mapping: {}, csrfToken: '', user: null, availablePeriod: null, previewStale: false, preview: null, reports: [] };
  const FIELD_DEFS = [
    { key: 'date', label: 'Date', required: true },
    { key: 'amount', label: 'Amount / line total', required: true },
    { key: 'product', label: 'Product', required: true },
    { key: 'orderId', label: 'Order ID', required: false },
    { key: 'customer', label: 'Customer', required: false },
    { key: 'category', label: 'Category', required: false },
    { key: 'lineItemId', label: 'Line item ID', required: false },
    { key: 'region', label: 'Region', required: false },
    { key: 'salesChannel', label: 'Sales channel', required: false },
    { key: 'quantity', label: 'Quantity / units', required: false },
    { key: 'cost', label: 'Cost', required: false },
    { key: 'grossProfit', label: 'Gross profit', required: false },
    { key: 'currency', label: 'Source currency', required: false },
  ];
  const currencyNames = { USD: '$', INR: '₹', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$', SGD: 'S$', JPY: '¥' };

  function status(id, message, kind = '') {
    const el = $(id);
    el.textContent = message;
    el.classList.toggle('error', kind === 'error');
    el.classList.toggle('success', kind === 'success');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function formatTimestamp(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }

  function formatMoney(value, currency = 'USD') {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value)); }
    catch { return `${currencyNames[currency] || `${currency} `}${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }
  }

  async function requestJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('X-CSRF-Token', state.csrfToken);
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      window.location.assign('/login?next=%2Fcustom-reports');
      throw new Error('Your sign-in has expired. Please sign in again.');
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  function encodeHeader(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function updateDateRangeInfo(data = state.preview) {
    const available = data?.availablePeriod || null;
    state.availablePeriod = available;
    for (const id of ['custom-start-date', 'custom-end-date']) {
      $(id).min = available?.startDate || '';
      $(id).max = available?.endDate || '';
    }
    document.querySelectorAll('.date-preset').forEach((button) => { button.disabled = !available; button.classList.remove('active'); });
    if (available) {
      $('date-availability-text').textContent = `${available.startDate} through ${available.endDate} · ${Number(data.validRowCount ?? data.rowCount).toLocaleString()} valid row(s) detected.`;
      const suggested = data.suggestedPeriod;
      $('date-range-warning').textContent = data.multipleCurrencies?.length
        ? `Multiple currencies found (${data.multipleCurrencies.join(', ')}). Split the CSV by currency before generating a report.`
        : (Number(data.validation?.invalidRows || 0) || Number(data.validation?.duplicateRows || 0)
          ? `${Number(data.validation?.invalidRows || 0)} invalid row(s) and ${Number(data.validation?.duplicateRows || 0)} duplicate line item(s) will be skipped.`
          : (suggested?.limited ? 'The full source covers more than 93 days. The default report uses the latest 93 days.' : 'The full available period fits within the 93-day report limit.'));
      if (suggested) {
        if (!$('custom-start-date').value || $('custom-start-date').value < available.startDate || $('custom-start-date').value > available.endDate) $('custom-start-date').value = suggested.startDate;
        if (!$('custom-end-date').value || $('custom-end-date').value < available.startDate || $('custom-end-date').value > available.endDate) $('custom-end-date').value = suggested.endDate;
      }
      if (data.detectedCurrency) {
        const currencySelect = $('report-currency');
        if ([...currencySelect.options].some((option) => option.value === data.detectedCurrency)) currencySelect.value = data.detectedCurrency;
      }
    } else {
      $('date-availability-text').textContent = data?.validationError || 'A valid date range could not be detected yet. Check the Date column mapping and recheck.';
      $('date-range-warning').textContent = data?.multipleCurrencies?.length ? `Multiple currencies found (${data.multipleCurrencies.join(', ')}). Split the CSV by currency.` : '';
      $('custom-start-date').value = ''; $('custom-end-date').value = '';
    }
  }

  function markPreviewStale() {
    state.previewStale = true;
    state.availablePeriod = null;
    for (const id of ['custom-start-date', 'custom-end-date']) { $(id).min = ''; $(id).max = ''; $(id).value = ''; }
    document.querySelectorAll('.date-preset').forEach((button) => { button.disabled = true; button.classList.remove('active'); });
    $('date-availability-text').textContent = 'Column mapping changed. Recheck the columns so the available dates match your selected date column.';
    $('date-range-warning').textContent = '';
    updateGenerateEnabled();
  }

  async function recheckMapping(showMessage = true) {
    if (!state.file || !state.text) { status('upload-status', 'Choose and preview a CSV first.', 'error'); return; }
    if (!state.mapping.date || !state.mapping.amount || !state.mapping.product) {
      status('upload-status', 'Choose columns for Date, Amount / line total, and Product.', 'error'); return;
    }
    const button = $('recheck-mapping'); button.disabled = true; button.textContent = 'Checking…';
    try {
      const data = await requestJson('/api/custom/csv/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': state.file.name, 'X-ExecuBrief-Preview-Mapping': encodeHeader(JSON.stringify(state.mapping)) },
        body: state.text,
      });
      state.preview = data; state.previewStale = false; state.mapping = { ...state.mapping, ...(data.selectedMapping || {}) };
      updateDateRangeInfo(data);
      updateGenerateEnabled();
      if (showMessage) status('upload-status', data.availablePeriod ? `Date coverage confirmed: ${data.availablePeriod.startDate} to ${data.availablePeriod.endDate}.` : (data.validationError || 'Date coverage could not be detected.'), data.availablePeriod ? 'success' : 'error');
    } catch (error) { state.availablePeriod = null; state.previewStale = true; updateDateRangeInfo({ validationError: error.message }); updateGenerateEnabled(); status('upload-status', error.message || 'Could not validate the selected columns.', 'error'); }
    finally { button.disabled = false; button.textContent = 'Recheck columns and date coverage'; }
  }

  function applyDatePreset(days) {
    const range = state.availablePeriod;
    if (!range) return;
    const endDate = range.endDate;
    const proposedStart = new Date(`${endDate}T00:00:00Z`);
    proposedStart.setUTCDate(proposedStart.getUTCDate() - (days - 1));
    let startDate = proposedStart.toISOString().slice(0, 10);
    if (startDate < range.startDate) startDate = range.startDate;
    $('custom-start-date').value = startDate; $('custom-end-date').value = endDate;
    document.querySelectorAll('.date-preset').forEach((button) => button.classList.toggle('active', Number(button.dataset.days) === Number(days)));
    updateGenerateEnabled();
  }

  function buildMappingUI() {
    const grid = $('mapping-grid');
    grid.replaceChildren();
    for (const field of FIELD_DEFS) {
      const wrapper = document.createElement('div');
      wrapper.className = 'mapping-field';
      const label = document.createElement('label');
      label.htmlFor = `map-${field.key}`;
      label.textContent = field.required ? `${field.label} *` : field.label;
      const select = document.createElement('select');
      select.id = `map-${field.key}`;
      select.className = 'workspace-select';
      select.required = field.required;
      const automatic = document.createElement('option');
      automatic.value = '';
      automatic.textContent = field.required ? 'Choose a column…' : 'Automatic default';
      select.append(automatic);
      for (const header of state.headers) {
        const option = document.createElement('option');
        option.value = header;
        option.textContent = header;
        select.append(option);
      }
      select.value = state.mapping[field.key] || '';
      select.addEventListener('change', () => {
        state.mapping[field.key] = select.value;
        markPreviewStale();
      });
      wrapper.append(label, select);
      grid.append(wrapper);
    }
  }

  function renderSample(data) {
    const head = $('sample-head');
    const body = $('sample-body');
    head.replaceChildren();
    body.replaceChildren();
    const headerRow = document.createElement('tr');
    for (const header of data.headers) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = header;
      headerRow.append(th);
    }
    head.append(headerRow);
    for (const cells of data.sampleRows || []) {
      const tr = document.createElement('tr');
      for (const cell of cells) {
        const td = document.createElement('td');
        td.textContent = cell;
        td.title = cell;
        tr.append(td);
      }
      body.append(tr);
    }
    $('csv-row-count').textContent = `${Number(data.rowCount).toLocaleString()} rows`;
    $('csv-preview-area').classList.remove('hidden');
  }

  function updateGenerateEnabled() {
    const ready = Boolean(state.file && state.text && state.mapping.date && state.mapping.amount && state.mapping.product && state.availablePeriod && !state.previewStale && !state.preview?.multipleCurrencies?.length);
    $('generate-custom-report').disabled = !ready;
    $('generate-custom-report').title = ready ? '' : (!state.file ? 'Choose and preview a CSV first.' : state.previewStale ? 'Recheck column mappings before generating.' : !state.availablePeriod ? 'A valid date range must be detected first.' : state.preview?.multipleCurrencies?.length ? 'Split the CSV by currency first.' : 'Choose required Date, Amount and Product columns.');
  }

  async function ensureSession() {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (!response.ok) {
      window.location.replace('/login?next=%2Fcustom-reports');
      return false;
    }
    const result = await response.json();
    state.user = result.user;
    state.csrfToken = result.csrfToken;
    $('account-name').textContent = result.user.name || result.user.email;
    const orgLabel = $('account-organisation');
    if (orgLabel) orgLabel.textContent = result.user.organization?.name || '';
    return true;
  }

  async function previewCsv() {
    const file = $('csv-file').files?.[0];
    if (!file) { status('upload-status', 'Choose a CSV file first.', 'error'); return; }
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      status('upload-status', 'Choose a .csv file.', 'error'); return;
    }
    if (file.size <= 0 || file.size > 5 * 1024 * 1024) {
      status('upload-status', 'The CSV must be between 1 byte and 5 MB.', 'error'); return;
    }
    const button = $('preview-csv');
    button.disabled = true;
    button.textContent = 'Reading CSV…';
    status('upload-status', 'Validating the file and detecting column names…');
    try {
      const text = await file.text();
      const data = await requestJson('/api/custom/csv/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': file.name },
        body: text,
      });
      state.file = file;
      state.text = text;
      state.headers = data.headers;
      state.sampleRows = data.sampleRows;
      state.mapping = data.suggestedMapping || {};
      state.preview = data;
      state.previewStale = false;
      buildMappingUI();
      renderSample(data);
      updateDateRangeInfo(data);
      if (!data.availablePeriod) {
        await recheckMapping(false);
        status('upload-status', data.validationError || 'Rows were found, but date coverage is not yet valid. Review the required mappings and recheck.', 'error');
      } else {
        status('upload-status', `${Number(data.validRowCount ?? data.rowCount).toLocaleString()} valid rows detected across ${data.availablePeriod.startDate} to ${data.availablePeriod.endDate}. ${Number(data.validation?.invalidRows || 0)} invalid row(s) and ${Number(data.validation?.duplicateRows || 0)} duplicate(s) will be skipped.`, 'success');
      }
      updateGenerateEnabled();
    } catch (error) {
      state.file = null; state.text = ''; state.headers = []; state.mapping = {}; state.preview = null; state.availablePeriod = null; state.previewStale = false;
      $('csv-preview-area').classList.add('hidden'); updateDateRangeInfo(null);
      updateGenerateEnabled();
      status('upload-status', error.message || 'Could not read this CSV.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Read CSV and preview';
    }
  }

  function showPdfPreview(report) {
    $('custom-pdf-preview').classList.remove('hidden');
    $('custom-preview-title').textContent = report.title || 'Custom executive report';
    $('custom-preview-subtitle').textContent = `${formatDate(report.startDate)} – ${formatDate(report.endDate)} · ${report.sourceFile || ''}`;
    $('custom-pdf-frame').src = report.file;
    $('custom-pdf-download').href = report.download;
    $('custom-pdf-download').download = `execubrief-${report.id}.pdf`;
    $('custom-pdf-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function appendCell(row, value, className = '') {
    const cell = document.createElement('td');
    cell.textContent = value ?? '—';
    if (className) cell.className = className;
    row.append(cell);
    return cell;
  }

  function renderHistory() {
    const tbody = $('custom-reports-list');
    const reports = state.reports || [];
    const query = ($('custom-history-search')?.value || '').trim().toLocaleLowerCase();
    const statusFilter = $('custom-history-status')?.value || '';
    const filtered = reports.filter((report) => {
      const searchText = [report.title, report.sourceFile, report.id, report.startDate, report.endDate].filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || searchText.includes(query)) && (!statusFilter || String(report.status || 'pending') === statusFilter);
    });
    tbody.replaceChildren();
    $('custom-history-count').textContent = reports.length
      ? `Showing ${filtered.length} of ${reports.length} reports`
      : 'No reports yet';
    $('custom-reports-empty').classList.toggle('hidden', reports.length > 0);
    document.querySelector('.workspace-reports-table').classList.toggle('hidden', reports.length === 0);
    if (!reports.length) return;
    if (!filtered.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = 7; cell.className = 'table-state'; cell.textContent = 'No reports match these filters.'; row.append(cell); tbody.append(row); return;
    }
    for (const report of filtered) {
      const row = document.createElement('tr');
      const titleCell = document.createElement('td');
      const title = document.createElement('strong'); title.className = 'report-id'; title.textContent = report.title || 'Custom report';
      const idHint = document.createElement('span'); idHint.className = 'report-created'; idHint.textContent = report.id;
      titleCell.append(title, idHint); row.append(titleCell);
      appendCell(row, report.sourceFile);
      appendCell(row, `${formatDate(report.startDate)} – ${formatDate(report.endDate)}`);
      appendCell(row, formatTimestamp(report.createdAt));
      const statusCell = document.createElement('td');
      const normalizedStatus = ['completed', 'pending', 'failed'].includes(report.status) ? report.status : 'failed';
      const badge = document.createElement('span'); badge.className = `status-badge status-${normalizedStatus}`; badge.textContent = report.status || 'unknown'; statusCell.append(badge); row.append(statusCell);
      appendCell(row, report.summary ? formatMoney(report.summary.totalRevenue, report.currency) : '—', 'numeric');
      const actionsCell = document.createElement('td'); actionsCell.className = 'table-actions';
      if (report.status === 'completed' && report.file) {
        const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'text-action'; preview.textContent = 'Preview'; preview.addEventListener('click', () => showPdfPreview(report));
        const download = document.createElement('a'); download.className = 'text-action'; download.textContent = 'Download'; download.href = report.download; download.download = `execubrief-${report.id}.pdf`;
        actionsCell.append(preview, download);
      } else if (report.status === 'failed') {
        const failed = document.createElement('span'); failed.className = 'report-created'; failed.textContent = 'Generation failed'; actionsCell.append(failed);
      } else {
        const pending = document.createElement('span'); pending.className = 'report-created'; pending.textContent = 'Preparing…'; actionsCell.append(pending);
      }
      row.append(actionsCell); tbody.append(row);
    }
  }

  async function loadHistory() {
    const tbody = $('custom-reports-list');
    try {
      const data = await requestJson('/api/custom/reports?limit=25');
      state.reports = data.reports || [];
      renderHistory();
    } catch (error) {
      state.reports = [];
      tbody.replaceChildren();
      const row = document.createElement('tr'); const cell = document.createElement('td');
      cell.colSpan = 7; cell.className = 'table-state'; cell.textContent = error.message || 'Could not load report history.'; row.append(cell); tbody.append(row);
      $('custom-history-count').textContent = 'History unavailable';
    }
  }

  async function generateReport() {
    if (!state.file || !state.text) { status('generation-status', 'Choose and preview a CSV file first.', 'error'); return; }
    const title = $('report-title').value.trim();
    const currency = $('report-currency').value;
    const startDate = $('custom-start-date').value;
    const endDate = $('custom-end-date').value;
    if (!title || title.length > 100) { status('generation-status', 'Enter a report title of 1–100 characters.', 'error'); return; }
    if (Boolean(startDate) !== Boolean(endDate)) { status('generation-status', 'Provide both start and end dates, or leave both blank.', 'error'); return; }
    if (startDate && endDate && startDate > endDate) { status('generation-status', 'Start date cannot be after end date.', 'error'); return; }
    if (state.previewStale || !state.availablePeriod) { status('generation-status', 'Recheck your column mapping and date coverage before generating.', 'error'); return; }
    if (startDate && (startDate < state.availablePeriod.startDate || endDate > state.availablePeriod.endDate)) { status('generation-status', `Choose dates within the uploaded data range (${state.availablePeriod.startDate} to ${state.availablePeriod.endDate}).`, 'error'); return; }
    if (startDate && endDate) {
      const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
      if (days > 93) { status('generation-status', 'Choose a reporting period of 93 days or fewer.', 'error'); return; }
    }
    if (!state.mapping.date || !state.mapping.amount || !state.mapping.product) { status('generation-status', 'Choose a date, amount, and product column.', 'error'); return; }

    const button = $('generate-custom-report');
    button.disabled = true;
    button.textContent = 'Generating PDF…';
    status('generation-status', 'Validating each data row and rendering your customized PDF. This may take a moment.');
    try {
      const options = { filename: state.file.name, title, currency, columns: state.mapping, startDate: startDate || null, endDate: endDate || null };
      const data = await requestJson('/api/custom/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv', 'X-ExecuBrief-Options': encodeHeader(JSON.stringify(options)) },
        body: state.text,
      });
      const skipped = Number(data.invalidRows || 0) + Number(data.duplicatesSkipped || 0);
      status('generation-status', `Your customized PDF was generated successfully from ${Number(data.rowCount || 0).toLocaleString()} valid rows.${skipped ? ` ${Number(data.duplicatesSkipped || 0)} duplicate(s) and ${Number(data.invalidRows || 0)} invalid row(s) were skipped.` : ''}`, 'success');
      await loadHistory();
      showPdfPreview(data);
    } catch (error) {
      status('generation-status', error.message || 'Report generation failed.', 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Generate customized PDF';
      updateGenerateEnabled();
    }
  }

  $('custom-history-search').addEventListener('input', renderHistory);
  $('custom-history-status').addEventListener('change', renderHistory);
  $('preview-csv').addEventListener('click', previewCsv);
  $('recheck-mapping').addEventListener('click', () => recheckMapping(true));
  document.querySelectorAll('.date-preset').forEach((button) => button.addEventListener('click', () => applyDatePreset(Number(button.dataset.days))));
  $('custom-start-date').addEventListener('change', () => updateGenerateEnabled());
  $('custom-end-date').addEventListener('change', () => updateGenerateEnabled());
  $('generate-custom-report').addEventListener('click', generateReport);
  $('refresh-history').addEventListener('click', loadHistory);
  $('close-custom-preview').addEventListener('click', () => {
    $('custom-pdf-frame').src = 'about:blank';
    $('custom-pdf-preview').classList.add('hidden');
  });
  $('sign-out').addEventListener('click', async () => {
    try { await requestJson('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); }
    finally { window.location.assign('/login'); }
  });
  $('csv-file').addEventListener('change', () => {
    state.file = null; state.text = ''; state.headers = []; state.mapping = {}; state.preview = null; state.availablePeriod = null; state.previewStale = false;
    $('csv-preview-area').classList.add('hidden'); updateDateRangeInfo(null);
    updateGenerateEnabled();
    status('upload-status', 'Read the selected CSV to preview its headers before generating a report.');
  });

  ensureSession().then((authenticated) => { if (authenticated) loadHistory(); }).catch(() => window.location.replace('/login'));
})();
