(() => {
  const $ = (id) => document.getElementById(id);
  const state = { user: null, csrfToken: '', headers: [], csvText: '', file: null, mapping: {}, preview: null, analytics: null, charts: {}, currency: 'USD', availablePeriod: null, currencyMismatch: false, imports: [] };
  const FIELDS = [
    ['date', 'Date', true], ['amount', 'Amount / revenue', true], ['product', 'Product', true],
    ['orderId', 'Order ID', false], ['lineItemId', 'Line item ID', false], ['customer', 'Customer / account', false],
    ['category', 'Category', false], ['region', 'Region', false], ['country', 'Country', false],
    ['businessUnit', 'Business unit', false], ['salesChannel', 'Sales channel', false], ['customerSegment', 'Customer segment', false],
    ['quantity', 'Units / quantity', false], ['unitPrice', 'Unit price', false], ['cost', 'Cost', false], ['grossProfit', 'Gross profit', false],
    ['grossMarginPercent', 'Gross margin %', false], ['currency', 'Source currency', false], ['salesRep', 'Sales representative', false],
    ['paymentStatus', 'Payment status', false], ['fulfillmentStatus', 'Fulfilment status', false], ['sourceSystem', 'Source system', false],
  ];
  const CURRENCY_NAMES = { USD: '$', INR: '₹', GBP: '£', EUR: '€', CAD: 'CA$', AUD: 'A$', SGD: 'S$', JPY: '¥' };
  const CHART_COLORS = { teal: '#159d93', tealLight: 'rgba(21,157,147,.12)', navy: '#173a53', blue: '#5f93b7', mint: '#82c9bf', slate: '#9aabba', coral: '#d8877d', gold: '#d8af60' };

  function setStatus(id, message, kind = '') {
    const node = $(id);
    if (!node) return;
    node.textContent = message || '';
    node.classList.toggle('error', kind === 'error');
    node.classList.toggle('success', kind === 'success');
    node.classList.toggle('warning', kind === 'warning');
  }
  function encodeHeader(value) {
    const bytes = new TextEncoder().encode(value); let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  async function requestJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.method && !['GET', 'HEAD'].includes(options.method.toUpperCase())) headers.set('X-CSRF-Token', state.csrfToken);
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { window.location.replace('/login?next=%2Fworkspace'); throw new Error('Your sign-in expired. Please sign in again.'); }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }
  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(date);
  }
  function formatTimestamp(value) {
    if (!value) return '—'; const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
  }
  function formatNumber(value, max = 0) {
    return value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toLocaleString(undefined, { maximumFractionDigits: max });
  }
  function formatMoney(value, currency = state.currency) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value)); }
    catch { return `${CURRENCY_NAMES[currency] || `${currency} `}${Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 })}`; }
  }
  function isoDay(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function shiftDay(day, amount) { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); }
  function setPresetActive(days) {
    document.querySelectorAll('.org-preset').forEach((button) => button.classList.toggle('active', Number(button.dataset.days) === Number(days)));
  }
  function updatePeriodBounds(range) {
    state.availablePeriod = range || null;
    const ids = ['org-start-date', 'org-end-date', 'org-report-start', 'org-report-end'];
    for (const id of ids) {
      $(id).min = range?.startDate || '';
      $(id).max = range?.endDate || '';
      $(id).disabled = !range;
    }
    $('org-generate-report').disabled = !range;
    if (range) {
      $('org-date-coverage').textContent = `${formatDate(range.startDate)} – ${formatDate(range.endDate)}`;
      $('org-period-help').textContent = `Imported data covers ${formatDate(range.startDate)} to ${formatDate(range.endDate)}. Reporting windows are limited to 93 days.`;
      if (!$('org-start-date').value || $('org-start-date').value < range.startDate || $('org-start-date').value > range.endDate) fillQuickRange(30, false);
      else if (!$('org-end-date').value || $('org-end-date').value > range.endDate) $('org-end-date').value = range.endDate;
      if (!$('org-report-start').value || $('org-report-start').value < range.startDate || $('org-report-start').value > range.endDate) {
        $('org-report-end').value = $('org-end-date').value;
        $('org-report-start').value = $('org-start-date').value;
      }
    } else {
      $('org-date-coverage').textContent = 'No imported date range yet';
      $('org-period-help').textContent = 'Import a valid CSV to discover available dates. Reports support up to 93 days at a time.';
      for (const id of ids) $(id).value = '';
    }
  }
  function fillQuickRange(days, load = true) {
    const range = state.availablePeriod;
    if (!range) return;
    const candidateStart = shiftDay(range.endDate, -(days - 1));
    const start = candidateStart < range.startDate ? range.startDate : candidateStart;
    $('org-start-date').value = start; $('org-end-date').value = range.endDate;
    $('org-report-start').value = start; $('org-report-end').value = range.endDate;
    $('org-period-label').textContent = `${formatDate(start)} – ${formatDate(range.endDate)}`;
    setPresetActive(days);
    if (load) loadAnalytics(start, range.endDate);
  }
  function safeTextCell(row, value, className = '') {
    const td = document.createElement('td'); td.textContent = value === null || value === undefined || value === '' ? '—' : String(value); if (className) td.className = className; row.append(td); return td;
  }
  function renderLoadingRow(tbody, cols, message) {
    tbody.replaceChildren(); const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = cols; cell.className = 'table-state'; cell.textContent = message; row.append(cell); tbody.append(row);
  }
  function createChart(id, kind, labels, datasets, options = {}) {
    const canvas = $(id); const fallback = $(`${id}-fallback`);
    if (!canvas || !window.Chart) { if (canvas) canvas.classList.add('hidden'); if (fallback) fallback.classList.remove('hidden'); return; }
    if (fallback) fallback.classList.add('hidden'); canvas.classList.remove('hidden');
    if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }
    const noMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    state.charts[id] = new Chart(canvas, {
      type: kind,
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        animation: { duration: noMotion ? 0 : 650, easing: 'easeOutQuart' },
        interaction: { intersect: false, mode: 'index' },
        plugins: { legend: { display: kind === 'doughnut', position: 'bottom', labels: { color: '#687b8b', usePointStyle: true, boxWidth: 8, padding: 14, font: { size: 10 } } }, tooltip: { backgroundColor: '#10243a', padding: 11, displayColors: kind !== 'line', callbacks: options.tooltipCallbacks || {} } },
        scales: kind === 'doughnut' ? {} : (() => {
          const horizontal = kind === 'bar' && (options.indexAxis || 'x') === 'y';
          const numericTick = options.valueTick || options.yTick || ((value) => Number(value) >= 1000000 ? `${(Number(value) / 1000000).toFixed(1)}M` : Number(value) >= 1000 ? `${(Number(value) / 1000).toFixed(0)}k` : value);
          return {
            x: { beginAtZero: horizontal, grid: { display: horizontal, color: 'rgba(131,151,167,.13)' }, ticks: { color: '#8291a0', maxTicksLimit: 7, font: { size: 9 }, ...(horizontal ? { callback: numericTick } : {}) }, border: { display: false } },
            y: { beginAtZero: !horizontal, grid: { display: !horizontal, color: 'rgba(131,151,167,.13)' }, ticks: { color: '#8291a0', maxTicksLimit: horizontal ? 8 : 5, font: { size: 9 }, ...(!horizontal ? { callback: numericTick } : {}) }, border: { display: false } },
          };
        })(),
        ...(kind === 'bar' ? { indexAxis: options.indexAxis || 'y', datasets: { bar: { borderRadius: 4, borderSkipped: false, maxBarThickness: 21 } } } : {}),
        ...(options.extra || {}),
      },
    });
  }
  function renderCharts(data) {
    const trend = data.dailyTrend || [];
    createChart('org-revenue-chart', 'line', trend.map((row) => row.date.slice(5)), [{ label: 'Revenue', data: trend.map((row) => row.revenue), borderColor: CHART_COLORS.teal, backgroundColor: CHART_COLORS.tealLight, borderWidth: 2.5, fill: true, tension: .34, pointRadius: trend.length > 45 ? 0 : 2.5, pointHoverRadius: 5 }], { yTick: (value) => value >= 1000000 ? `${(value / 1000000).toFixed(1)}M` : value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value });
    const categories = (data.categoryRevenue || []).slice(0, 7);
    createChart('org-category-chart', 'bar', categories.map((row) => row.category), [{ label: 'Revenue', data: categories.map((row) => row.revenue), backgroundColor: [CHART_COLORS.teal, CHART_COLORS.blue, CHART_COLORS.navy, CHART_COLORS.mint, CHART_COLORS.gold, CHART_COLORS.slate, CHART_COLORS.coral], borderRadius: 4, maxBarThickness: 20 }], { indexAxis: 'y', yTick: (value) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value });
    const regions = (data.regions || []).slice(0, 7);
    createChart('org-region-chart', 'bar', regions.map((row) => row.label), [{ label: 'Revenue', data: regions.map((row) => row.revenue), backgroundColor: CHART_COLORS.navy, borderRadius: 4, maxBarThickness: 20 }], { indexAxis: 'y', yTick: (value) => value >= 1000 ? `${(value / 1000).toFixed(0)}k` : value });
    $('org-trend-count').textContent = `${trend.length} daily points`;
    $('org-category-note').textContent = categories.length ? `Showing ${categories.length} categories by revenue.` : 'No category breakdown found in this period.';
    $('org-region-note').textContent = regions.length ? `Showing ${regions.length} regions by revenue.` : 'Region analytics appear when the CSV includes a region column.';
  }
  function renderSignals(signals) {
    const root = $('org-business-signals'); root.replaceChildren();
    if (!signals?.length) { const p = document.createElement('p'); p.className = 'org-empty-copy'; p.textContent = 'More data is needed to produce reliable business signals.'; root.append(p); return; }
    for (const signal of signals) {
      const item = document.createElement('article'); item.className = `org-signal ${['positive','negative','neutral','insight'].includes(signal.kind) ? signal.kind : 'neutral'}`;
      const accent = document.createElement('span'); accent.className = 'org-signal-accent'; accent.setAttribute('aria-hidden', 'true');
      const main = document.createElement('div'); const title = document.createElement('strong'); title.className = 'org-signal-title'; title.textContent = signal.title;
      const detail = document.createElement('span'); detail.className = 'org-signal-detail'; detail.textContent = signal.detail || '';
      main.append(title, detail); const metric = document.createElement('span'); metric.className = 'org-signal-metric'; metric.textContent = signal.metric || '';
      item.append(accent, main, metric); root.append(item);
    }
  }
  function renderAnalytics(data) {
    state.analytics = data; state.currency = data.currency || 'USD';
    if (!state.preview && !$('org-import-currency').disabled) $('org-import-currency').value = state.currency;
    updatePeriodBounds(data.availablePeriod);
    updateAnalyticsFilterControls(data);
    if (!data.hasData) {
      $('org-data-status').textContent = 'No data imported yet'; $('org-period-label').textContent = 'Waiting for data';
      for (const id of ['org-kpi-revenue','org-kpi-orders','org-kpi-aov','org-kpi-customers','org-kpi-profit']) $(id).textContent = '—';
      $('org-kpi-revenue-change').textContent = 'Import a CSV to begin'; $('org-kpi-orders-change').textContent = 'No imported records'; $('org-kpi-customers-note').textContent = 'Customer fields are optional'; $('org-kpi-margin').textContent = 'Profit data is optional';
      renderSignals([]); renderCharts({ dailyTrend: [], categoryRevenue: [], regions: [] }); renderImportHealth(data.importHealth); $('org-generate-report').disabled = true; return;
    }
    const summary = data.summary || {};
    $('org-data-status').textContent = `${formatNumber(data.importHealth?.rowsImported || 0)} imported rows · analytics refreshed`;
    $('org-period-label').textContent = `${formatDate(data.selectedPeriod.startDate)} – ${formatDate(data.selectedPeriod.endDate)}`;
    $('org-kpi-revenue').textContent = formatMoney(summary.totalRevenue);
    const revenueChange = summary.revenueChangePercent;
    $('org-kpi-revenue-change').textContent = revenueChange === null || revenueChange === undefined ? 'No comparable baseline' : `${revenueChange > 0 ? '↑' : revenueChange < 0 ? '↓' : '→'} ${Math.abs(revenueChange)}% vs previous period`;
    $('org-kpi-revenue-change').classList.toggle('org-change-negative', Number(revenueChange) < 0);
    $('org-kpi-orders').textContent = formatNumber(summary.totalOrders);
    $('org-kpi-orders-change').textContent = summary.ordersChangePercent === null || summary.ordersChangePercent === undefined ? 'No comparable baseline' : `${summary.ordersChangePercent > 0 ? '↑' : summary.ordersChangePercent < 0 ? '↓' : '→'} ${Math.abs(summary.ordersChangePercent)}% vs previous period`;
    $('org-kpi-aov').textContent = formatMoney(summary.averageOrderValue);
    $('org-kpi-customers').textContent = summary.customerCount === null ? 'Not mapped' : formatNumber(summary.customerCount);
    $('org-kpi-customers-note').textContent = summary.customerCount === null ? 'Add a customer or account column to enable this KPI' : 'Distinct customer/account IDs';
    $('org-kpi-profit').textContent = summary.grossProfit === null ? 'Not mapped' : formatMoney(summary.grossProfit);
    $('org-kpi-margin').textContent = summary.grossMarginPercent === null ? 'Gross profit/margin fields unavailable' : `${formatNumber(summary.grossMarginPercent, 1)}% gross margin`;
    $('org-profit-track-fill').style.width = `${Math.max(0, Math.min(100, Number(summary.grossMarginPercent) || 0))}%`;
    $('org-report-start').value = data.selectedPeriod.startDate; $('org-report-end').value = data.selectedPeriod.endDate;
    renderCharts(data); renderSignals(data.businessSignals); renderImportHealth(data.importHealth);
  }
  function renderImportHealth(health = {}) {
    $('org-health-files').textContent = formatNumber(health.successfulFiles || 0);
    $('org-health-rows').textContent = formatNumber(health.rowsImported || 0);
    $('org-health-duplicates').textContent = formatNumber(health.duplicatesSkipped || 0);
    $('org-health-invalid').textContent = formatNumber(health.invalidRows || 0);
    $('org-health-latest').textContent = health.latestImportAt ? `Latest import: ${formatTimestamp(health.latestImportAt)}` : 'No data imported yet.';
    const badge = $('org-health-indicator'); badge.textContent = health.successfulFiles ? 'Tracking imports' : 'Awaiting data'; badge.classList.toggle('healthy', Number(health.successfulFiles) > 0);
  }
  function updateAnalyticsFilterControls(data) {
    const options = data.filterOptions || { categories: [], regions: [] };
    const selected = data.filters || {};
    const fillSelect = (id, values, allLabel, chosen) => {
      const select = $(id);
      const previous = select.value;
      select.replaceChildren(new Option(allLabel, ''));
      for (const value of values) select.add(new Option(String(value), String(value)));
      const desired = chosen || previous || '';
      select.value = values.includes(desired) ? desired : '';
      select.disabled = !data.hasData || values.length === 0;
    };
    fillSelect('org-category-filter', options.categories || [], 'All categories', selected.category || '');
    fillSelect('org-region-filter', options.regions || [], 'All regions', selected.region || '');
    const category = $('org-category-filter').value;
    const region = $('org-region-filter').value;
    const active = [category ? `Category: ${category}` : '', region ? `Region: ${region}` : ''].filter(Boolean);
    $('org-clear-filters').disabled = !data.hasData || active.length === 0;
    $('org-filter-summary').textContent = data.hasData
      ? (active.length ? `${active.join(' · ')}. KPIs, charts, comparison signals and generated PDFs use these filters.` : 'All categories and regions are included. KPIs, charts and generated PDFs update together when filters are applied.')
      : 'Dimension filters become available after data is imported.';
  }

  async function loadAnalytics(startDate = null, endDate = null) {
    const url = new URL('/api/organization/analytics', window.location.origin);
    if (startDate && endDate) { url.searchParams.set('startDate', startDate); url.searchParams.set('endDate', endDate); }
    const category = $('org-category-filter')?.value || '';
    const region = $('org-region-filter')?.value || '';
    if (category) url.searchParams.set('category', category);
    if (region) url.searchParams.set('region', region);
    try {
      const data = await requestJson(url.pathname + url.search);
      renderAnalytics(data);
      if (data.hasData) setStatus('org-global-status', '', '');
    } catch (error) { setStatus('org-global-status', error.message || 'Analytics could not be loaded.', 'error'); }
  }
  function renderImports() {
    const tbody = $('org-import-list');
    const imports = state.imports || [];
    const query = ($('org-import-search')?.value || '').trim().toLocaleLowerCase();
    const statusFilter = $('org-import-status-filter')?.value || '';
    const filtered = imports.filter((entry) => {
      const searchable = [entry.sourceFile, entry.status, entry.minDate, entry.maxDate].filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || searchable.includes(query)) && (!statusFilter || String(entry.status || '') === statusFilter);
    });
    tbody.replaceChildren();
    $('org-import-filter-count').textContent = imports.length ? `Showing ${filtered.length} of ${imports.length} imports` : 'No imports yet';
    $('org-import-empty').classList.toggle('hidden', imports.length > 0);
    document.querySelector('.org-import-history-panel .table-scroll').classList.toggle('hidden', imports.length === 0);
    if (!imports.length) return;
    if (!filtered.length) {
      const row = document.createElement('tr'); const cell = document.createElement('td'); cell.colSpan = 7; cell.className = 'table-state'; cell.textContent = 'No imports match these filters.'; row.append(cell); tbody.append(row); return;
    }
    for (const entry of filtered) {
      const row = document.createElement('tr'); safeTextCell(row, entry.sourceFile); safeTextCell(row, formatTimestamp(entry.importedAt));
      const statusCell = document.createElement('td');
      const kind = entry.status === 'completed' ? 'completed' : ['partial', 'duplicate'].includes(entry.status) ? 'pending' : 'failed';
      const badge = document.createElement('span'); badge.className = `status-badge status-${kind}`; badge.textContent = entry.status || 'unknown'; if (entry.error) badge.title = entry.error; statusCell.append(badge); row.append(statusCell);
      safeTextCell(row, formatNumber(entry.rowsImported), 'numeric'); safeTextCell(row, formatNumber(entry.duplicatesSkipped), 'numeric'); safeTextCell(row, formatNumber(entry.invalidRows), 'numeric'); safeTextCell(row, entry.minDate && entry.maxDate ? `${entry.minDate} – ${entry.maxDate}` : '—'); tbody.append(row);
    }
  }

  async function loadImports() {
    const tbody = $('org-import-list'); renderLoadingRow(tbody, 7, 'Loading import history…');
    try {
      const data = await requestJson('/api/organization/imports?limit=50');
      state.imports = data.imports || [];
      renderImports();
    } catch (error) {
      state.imports = [];
      renderLoadingRow(tbody, 7, error.message || 'Import history could not be loaded.');
      $('org-import-filter-count').textContent = 'History unavailable';
    }
  }

  function renderMapping() {
    const grid = $('org-mapping-grid'); grid.replaceChildren();
    for (const [key, label, required] of FIELDS) {
      const wrapper = document.createElement('div'); wrapper.className = 'mapping-field';
      const fieldLabel = document.createElement('label'); fieldLabel.htmlFor = `org-map-${key}`; fieldLabel.textContent = required ? `${label} *` : label;
      const select = document.createElement('select'); select.className = 'workspace-select'; select.id = `org-map-${key}`; select.required = required;
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = required ? 'Choose a column…' : 'Not mapped'; select.append(empty);
      for (const header of state.headers) { const option = document.createElement('option'); option.value = header; option.textContent = header; select.append(option); }
      select.value = state.mapping[key] || '';
      select.addEventListener('change', () => { state.mapping[key] = select.value; updateImportEnabled(); markPreviewDateStale(); });
      wrapper.append(fieldLabel, select); grid.append(wrapper);
    }
  }
  function renderSample(data) {
    const head = $('org-sample-head'); const body = $('org-sample-body'); head.replaceChildren(); body.replaceChildren();
    const header = document.createElement('tr');
    for (const name of data.headers || []) { const th = document.createElement('th'); th.scope = 'col'; th.textContent = name; header.append(th); }
    head.append(header);
    for (const cells of data.sampleRows || []) { const tr = document.createElement('tr'); for (const value of cells) { const td = document.createElement('td'); td.textContent = value; td.title = value; tr.append(td); } body.append(tr); }
    $('org-preview-filename').textContent = state.file?.name || 'Selected CSV'; $('org-preview-row-count').textContent = `${formatNumber(data.rowCount)} source rows · ${formatNumber(data.validRowCount ?? data.rowCount)} valid`;
  }
  function updateImportEnabled() {
    const hasRequired = ['date','amount','product'].every((key) => state.mapping[key]);
    const selectedCurrency = state.preview?.detectedCurrency || $('org-import-currency').value || state.currency || 'USD';
    const currencyMismatch = Boolean(state.analytics?.hasData && selectedCurrency !== state.currency);
    state.currencyMismatch = currencyMismatch;
    $('org-import-csv').disabled = !state.file || !state.csvText || !hasRequired || !state.preview || !state.preview.availablePeriod || Boolean(state.preview.multipleCurrencies?.length) || currencyMismatch;
    if (!hasRequired) $('org-import-csv').title = 'Map date, amount, and product columns first.';
    else if (!state.preview?.availablePeriod) $('org-import-csv').title = 'Recheck the column mapping to detect a valid date range.';
    else if (state.preview.multipleCurrencies?.length) $('org-import-csv').title = 'Split this file by currency before import.';
    else if (currencyMismatch) $('org-import-csv').title = `This workspace already uses ${state.currency}. Currency conversion is not supported.`;
    else $('org-import-csv').title = '';
  }
  function markPreviewDateStale() {
    if (!state.preview) return;
    state.preview.availablePeriod = null;
    $('org-preview-date-range').textContent = 'Column mapping changed. Recheck the columns to detect the correct available dates.';
    $('org-preview-warnings').textContent = '';
    updateImportEnabled();
  }
  async function previewCsv() {
    const file = $('org-csv-file').files?.[0];
    if (!file) { setStatus('org-import-status', 'Choose a CSV file first.', 'error'); return; }
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') { setStatus('org-import-status', 'Choose a .csv file.', 'error'); return; }
    if (!file.size || file.size > 5 * 1024 * 1024) { setStatus('org-import-status', 'The CSV must be between 1 byte and 5 MB.', 'error'); return; }
    const button = $('org-preview-csv'); button.disabled = true; button.textContent = 'Previewing…';
    try {
      state.file = file; state.csvText = await file.text();
      const data = await requestJson('/api/custom/csv/preview', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': file.name }, body: state.csvText });
      state.preview = data; state.headers = data.headers || []; state.mapping = { ...(data.suggestedMapping || {}) };
      renderMapping(); renderSample(data); $('org-csv-preview').classList.remove('hidden');
      await recalculatePreview(false);
      $('org-csv-preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) { state.preview = null; updateImportEnabled(); setStatus('org-import-status', error.message || 'The CSV could not be previewed.', 'error'); }
    finally { button.disabled = false; button.textContent = 'Preview file'; }
  }
  async function recalculatePreview(showStatus = true) {
    if (!state.file || !state.csvText) return;
    try {
      const data = await requestJson('/api/custom/csv/preview', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-ExecuBrief-Preview-Mapping': encodeHeader(JSON.stringify(state.mapping)), 'X-Upload-Filename': state.file.name }, body: state.csvText });
      state.preview = { ...state.preview, ...data, suggestedMapping: state.mapping };
      const range = data.availablePeriod;
      if (range) {
        $('org-preview-date-range').textContent = `Available data dates: ${range.startDate} to ${range.endDate}. ${formatNumber(data.validRowCount)} valid rows will be eligible for import.`;
        const warningItems = [];
        const duplicateCount = Number(data.validation?.duplicateRows || 0);
        const invalidCount = Number(data.validation?.invalidRows || 0);
        if (duplicateCount || invalidCount) warningItems.push(`${formatNumber(duplicateCount)} duplicate row(s) and ${formatNumber(invalidCount)} invalid row(s) are expected to be skipped.`);
        if (data.multipleCurrencies?.length) warningItems.push(`Multiple currencies detected (${data.multipleCurrencies.join(', ')}). Split the file by currency before importing.`);
        if (data.detectedCurrency) {
          $('org-import-currency').value = data.detectedCurrency; $('org-import-currency').disabled = true;
          if (state.analytics?.hasData && data.detectedCurrency !== state.currency) warningItems.push(`Currency mismatch: this file uses ${data.detectedCurrency}, but this workspace uses ${state.currency}. Convert the source before importing; ExecuBrief does not apply FX rates.`);
          $('org-import-currency-help').textContent = state.analytics?.hasData && data.detectedCurrency !== state.currency ? `Workspace currency: ${state.currency}. This CSV uses ${data.detectedCurrency}; import is blocked to prevent mixed-currency totals.` : `Currency detected from the CSV: ${data.detectedCurrency}. No conversion is performed.`;
        } else {
          $('org-import-currency').disabled = false;
          $('org-import-currency-help').textContent = state.analytics?.hasData ? `This organisation reports in ${state.currency}. Keep the same currency; conversion is not performed.` : 'No currency column detected. Choose the actual currency used in this CSV; values will not be converted.';
        }
        $('org-preview-warnings').textContent = warningItems.join(' ');
        $('org-preview-warnings').classList.toggle('warning', warningItems.length > 0);
      } else {
        $('org-preview-date-range').textContent = data.validationError || 'Unable to detect available dates. Verify the date, amount, and product mappings.';
        $('org-preview-warnings').textContent = data.validationError || 'Select valid required columns and recheck.';
        $('org-preview-warnings').classList.add('warning');
      }
      updateImportEnabled();
      const currencyBlocked = state.currencyMismatch || Boolean(data.multipleCurrencies?.length);
      if (showStatus) {
        if (!range) setStatus('org-import-status', 'Date coverage could not be detected. Adjust required columns and recheck.', 'error');
        else if (currencyBlocked) setStatus('org-import-status', data.multipleCurrencies?.length ? 'This file contains multiple currencies. Split it by currency before importing.' : `This CSV uses a different currency from the workspace (${state.currency}). Convert the file before importing; no currency conversion is performed.`, 'error');
        else setStatus('org-import-status', 'Column mapping rechecked. The file is ready to import.', 'success');
      }
    } catch (error) { setStatus('org-import-status', error.message || 'Could not validate the selected column mapping.', 'error'); }
  }
  async function importCsv() {
    const btn = $('org-import-csv');
    if (btn.disabled || !state.file || !state.csvText) return;
    btn.disabled = true; btn.textContent = 'Importing rows…';
    try {
      const options = { filename: state.file.name, currency: state.preview.detectedCurrency || $('org-import-currency').value || state.currency || 'USD', columns: state.mapping };
      const result = await requestJson('/api/organization/imports', { method: 'POST', headers: { 'Content-Type': 'text/csv', 'X-Upload-Filename': state.file.name, 'X-ExecuBrief-Import-Options': encodeHeader(JSON.stringify(options)) }, body: state.csvText });
      const importResult = result.import || result;
      setStatus('org-import-status', result.message || `Imported ${formatNumber(importResult.rowsImported)} row(s); ${formatNumber(importResult.duplicatesSkipped)} duplicate(s) and ${formatNumber(importResult.invalidRows)} invalid row(s) skipped.`, result.duplicateFile || importResult.status === 'duplicate' ? 'warning' : 'success');
      state.file = null; state.csvText = ''; state.preview = null; state.headers = []; state.mapping = {}; $('org-csv-file').value = ''; $('org-csv-preview').classList.add('hidden'); $('org-import-currency').disabled = false; $('org-import-currency').value = state.currency || 'USD'; $('org-import-currency-help').textContent = 'If the CSV contains a currency column, its value is detected automatically.'; updateImportEnabled();
      await loadImports(); await loadAnalytics();
    } catch (error) { setStatus('org-import-status', error.message || 'Import failed; no success was assumed.', 'error'); }
    finally { btn.textContent = 'Import into workspace'; updateImportEnabled(); }
  }
  async function loadIdentity() {
    const result = await requestJson('/api/auth/me'); state.user = result.user; state.csrfToken = result.csrfToken;
    $('org-user-name').textContent = result.user.name || result.user.email;
    $('org-import-currency').value = state.currency || 'USD';
    $('org-user-organisation').textContent = result.user.organization?.name || 'Organisation';
    $('org-page-title').firstChild.textContent = 'Executive Pulse';
    $('org-report-name').value = `${result.user.organization?.name || 'Organisation'} Executive Brief`;
    $('org-import-currency').addEventListener('change', () => { if (!state.preview?.detectedCurrency) updateImportEnabled(); });
  }
  async function generateWorkspaceReport(event) {
    event.preventDefault();
    const startDate = $('org-report-start').value; const endDate = $('org-report-end').value; const title = $('org-report-name').value.trim();
    if (!state.availablePeriod) { setStatus('org-report-status', 'Import a valid CSV before generating an organisation report.', 'error'); return; }
    if (!title || title.length > 100) { setStatus('org-report-status', 'Enter a report title between 1 and 100 characters.', 'error'); return; }
    if (!startDate || !endDate || startDate > endDate) { setStatus('org-report-status', 'Choose a valid start and end date.', 'error'); return; }
    const days = Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000) + 1;
    if (days > 93) { setStatus('org-report-status', 'Choose a date range of 93 days or fewer.', 'error'); return; }
    const btn = $('org-generate-report'); btn.disabled = true; btn.textContent = 'Rendering PDF…';
    try {
      const report = await requestJson('/api/organization/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        title, startDate, endDate, currency: state.currency,
        category: $('org-category-filter').value || '', region: $('org-region-filter').value || '',
      }) });
      const preview = $('org-report-preview'); preview.classList.remove('hidden'); $('org-report-preview-title').textContent = report.title || 'Executive report ready'; $('org-report-preview-subtitle').textContent = `${formatDate(report.startDate)} – ${formatDate(report.endDate)} · ${report.sourceFile || 'Organisation workspace data'}`; $('org-report-frame').src = report.file; $('org-report-download').href = report.download; $('org-report-download').download = `execubrief-${report.id}.pdf`;
      setStatus('org-report-status', 'Your organisation PDF was generated successfully.', 'success'); preview.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) { setStatus('org-report-status', error.message || 'The report could not be generated.', 'error'); }
    finally { btn.disabled = !state.availablePeriod; btn.textContent = 'Generate organisation PDF'; }
  }
  async function applyPeriod(event) {
    event.preventDefault(); const start = $('org-start-date').value; const end = $('org-end-date').value;
    if (!state.availablePeriod) { setStatus('org-global-status', 'Import data before selecting a period.', 'error'); return; }
    if (!start || !end || start > end) { setStatus('org-global-status', 'Choose a valid start and end date.', 'error'); return; }
    const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1;
    if (days > 93) { setStatus('org-global-status', 'The maximum reporting period is 93 days.', 'error'); return; }
    if (start < state.availablePeriod.startDate || end > state.availablePeriod.endDate) { setStatus('org-global-status', `Choose dates within ${state.availablePeriod.startDate} to ${state.availablePeriod.endDate}.`, 'error'); return; }
    $('org-report-start').value = start; $('org-report-end').value = end; $('org-period-label').textContent = `${formatDate(start)} – ${formatDate(end)}`; setPresetActive(0); await loadAnalytics(start, end);
  }
  $('org-preview-csv').addEventListener('click', previewCsv);
  $('org-import-csv').addEventListener('click', importCsv);
  $('org-csv-file').addEventListener('change', () => { state.file = null; state.csvText = ''; state.preview = null; state.headers = []; state.mapping = {}; $('org-csv-preview').classList.add('hidden'); updateImportEnabled(); setStatus('org-import-status', 'Preview the selected CSV before importing.'); });
  $('org-refresh-imports').addEventListener('click', loadImports);
  $('org-import-search').addEventListener('input', renderImports);
  $('org-import-status-filter').addEventListener('change', renderImports);
  $('org-period-form').addEventListener('submit', applyPeriod);
  $('org-category-filter').addEventListener('change', () => loadAnalytics($('org-start-date').value, $('org-end-date').value));
  $('org-region-filter').addEventListener('change', () => loadAnalytics($('org-start-date').value, $('org-end-date').value));
  $('org-clear-filters').addEventListener('click', () => {
    $('org-category-filter').value = ''; $('org-region-filter').value = '';
    loadAnalytics($('org-start-date').value, $('org-end-date').value);
  });
  document.querySelectorAll('.org-preset').forEach((button) => button.addEventListener('click', () => fillQuickRange(Number(button.dataset.days))));
  $('org-report-form').addEventListener('submit', generateWorkspaceReport);
  $('org-report-close').addEventListener('click', () => { $('org-report-frame').src = 'about:blank'; $('org-report-preview').classList.add('hidden'); });
  $('org-sign-out').addEventListener('click', async () => { try { await requestJson('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } finally { window.location.assign('/login'); } });
  loadIdentity().then(async () => { await loadAnalytics(); await loadImports(); }).catch((error) => { setStatus('org-global-status', error.message || 'Your session could not be loaded.', 'error'); });
})();
