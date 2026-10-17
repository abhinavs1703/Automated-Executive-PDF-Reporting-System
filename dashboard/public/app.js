(() => {
  'use strict';

  const state = {
    currency: 'USD',
    revenueChart: null,
    ordersChart: null,
    reportData: null,
    products: [],
    reports: [],
    csrfToken: '',
    isGenerating: false,
  };

  const $ = (id) => document.getElementById(id);
  const dom = {
    periodForm: $('period-form'), startDate: $('start-date'), endDate: $('end-date'),
    applyPeriod: $('apply-period'), generateButton: $('generate-report'), periodLabel: $('period-label'),
    revenue: $('kpi-revenue'), orders: $('kpi-orders'), aov: $('kpi-aov'), previousRevenue: $('kpi-previous-revenue'),
    revenueChange: $('revenue-change'), ordersChange: $('orders-change'), aovNote: $('aov-note'),
    previousLabel: $('previous-period-label'), previousDates: $('previous-dates'), trendSubtitle: $('trend-subtitle'),
    products: $('products-list'), daily: $('daily-list'), dailyCount: $('daily-count'),
    reports: $('reports-list'), reportCount: $('report-count'), reportsEmpty: $('reports-empty'),
    pdfPanel: $('pdf-preview'), pdfFrame: $('pdf-iframe'), pdfDownload: $('pdf-download'),
    previewSubtitle: $('preview-subtitle'), closePreview: $('close-preview'), toast: $('toast'),
    revenueFallback: $('revenue-chart-fallback'), ordersFallback: $('orders-chart-fallback'),
    productSearch: $('product-search'), productCategory: $('product-category-filter'), productSort: $('product-sort'),
    reportsSearch: $('reports-search'), reportsStatus: $('reports-status-filter'), reportsFilterCount: $('reports-filter-count'),
    topbarAccount: $('topbar-account'),
  };

  function formatDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function previousCompleteWeek() {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const daysSinceMonday = (today.getUTCDay() + 6) % 7;
    const thisMonday = new Date(today.getTime() - daysSinceMonday * 86400000);
    const previousMonday = new Date(thisMonday.getTime() - 7 * 86400000);
    const previousSunday = new Date(thisMonday.getTime() - 86400000);
    return { startDate: formatDate(previousMonday), endDate: formatDate(previousSunday) };
  }

  function money(value) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: state.currency, maximumFractionDigits: 2 }).format(Number(value || 0));
    } catch {
      return `${state.currency} ${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    }
  }

  function number(value) {
    return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Number(value || 0));
  }

  function shortDate(isoDate) {
    if (!isoDate) return '—';
    const date = new Date(`${isoDate}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? isoDate : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(date);
  }

  function timestamp(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
  }

  function safePercent(value) {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'No prior-period baseline';
    const numeric = Number(value);
    return `${numeric > 0 ? '+' : ''}${numeric.toFixed(1)}% vs prior period`;
  }

  function setChange(element, value) {
    element.textContent = safePercent(value);
    element.classList.toggle('negative', Number(value) < 0);
    element.classList.toggle('neutral-change', value === null || value === undefined || !Number.isFinite(Number(value)));
  }

  function showToast(message, isError = false) {
    dom.toast.textContent = message;
    dom.toast.classList.toggle('error', isError);
    dom.toast.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), 5000);
  }

  async function requestJson(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options, headers: { ...(options.headers || {}) } });
    let body;
    try { body = await response.json(); } catch { body = {}; }
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  function queryUrl(path) {
    const query = new URLSearchParams({ startDate: dom.startDate.value, endDate: dom.endDate.value });
    return `${path}?${query.toString()}`;
  }

  function validatePeriod() {
    const start = dom.startDate.value;
    const end = dom.endDate.value;
    const validIso = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
    if (!validIso(start) || !validIso(end)) throw new Error('Choose valid start and end dates.');
    if (start > end) throw new Error('The start date must be on or before the end date.');
    const dayCount = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 1;
    if (dayCount > 93) throw new Error('Choose a reporting period of 93 days or fewer.');
    return { startDate: start, endDate: end };
  }

  async function loadConfig() {
    try {
      const data = await requestJson('/api/config');
      if (data.reportCurrency) state.currency = data.reportCurrency;
    } catch (error) {
      console.warn('Dashboard configuration is unavailable.');
    }
  }

  async function loadAnalytics() {
    let data;
    try {
      validatePeriod();
      data = await requestJson(queryUrl('/api/analytics'));
    } catch (error) {
      showToast(error.message || 'Could not load analytics.', true);
      throw error;
    }
    state.reportData = data;
    renderAnalytics(data);
  }

  function renderAnalytics(data) {
    const summary = data.summary || {};
    const previous = data.previousSummary || {};
    const metadata = data.metadata || {};
    const days = data.dailyTrend || [];
    dom.periodLabel.textContent = `${shortDate(metadata.reportStart)} – ${shortDate(metadata.reportEnd)}`;
    dom.revenue.textContent = money(summary.totalRevenue);
    dom.orders.textContent = number(summary.totalOrders);
    dom.aov.textContent = money(summary.averageOrderValue);
    dom.previousRevenue.textContent = money(previous.totalRevenue);
    setChange(dom.revenueChange, summary.revenueChangePercent);
    setChange(dom.ordersChange, summary.ordersChangePercent);
    dom.aovNote.textContent = `${number(summary.totalOrders)} distinct order${Number(summary.totalOrders) === 1 ? '' : 's'} in period`;
    dom.previousDates.textContent = previous.startDate && previous.endDate ? `${shortDate(previous.startDate)} – ${shortDate(previous.endDate)}` : 'Previous period';
    dom.previousLabel.textContent = previous.startDate && previous.endDate ? 'Equal-length comparison' : 'No comparison period';
    dom.trendSubtitle.textContent = `${days.length} daily point${days.length === 1 ? '' : 's'}`;
    dom.dailyCount.textContent = `${days.length} day${days.length === 1 ? '' : 's'}`;
    renderCharts(days);
    renderProducts(data.topProducts || []);
    renderDaily(days);
  }

  function renderCharts(days) {
    if (typeof Chart === 'undefined') {
      dom.revenueFallback.classList.remove('hidden');
      dom.ordersFallback.classList.remove('hidden');
      return;
    }
    dom.revenueFallback.classList.add('hidden');
    dom.ordersFallback.classList.add('hidden');
    const labels = days.map((item) => shortDate(item.date));
    if (state.revenueChart) state.revenueChart.destroy();
    if (state.ordersChart) state.ordersChart.destroy();
    const commonOptions = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      plugins: { legend: { display: false }, tooltip: { padding: 10, displayColors: false } },
      interaction: { intersect: false, mode: 'index' },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: '#8190a0', maxTicksLimit: 7, font: { size: 10 } } },
        y: { beginAtZero: true, grid: { color: '#edf1f5', drawTicks: false }, border: { display: false }, ticks: { color: '#8190a0', padding: 9, maxTicksLimit: 5, font: { size: 10 } } },
      },
    };
    state.revenueChart = new Chart($('revenue-chart'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Revenue', data: days.map((item) => Number(item.revenue || 0)), borderColor: '#159d93', backgroundColor: 'rgba(21,157,147,.10)', borderWidth: 2.5, fill: true, tension: .28, pointRadius: days.length > 21 ? 0 : 3, pointHoverRadius: 5, pointBackgroundColor: '#fff', pointBorderWidth: 2 }] },
      options: { ...commonOptions, plugins: { ...commonOptions.plugins, tooltip: { ...commonOptions.plugins.tooltip, callbacks: { label: (context) => ` ${money(context.parsed.y)}` } } }, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, ticks: { ...commonOptions.scales.y.ticks, callback: (value) => Number(value) >= 1000 ? `${state.currency} ${(Number(value) / 1000).toFixed(0)}k` : value } } } },
    });
    state.ordersChart = new Chart($('orders-chart'), {
      type: 'bar',
      data: { labels, datasets: [{ label: 'Orders', data: days.map((item) => Number(item.totalOrders || 0)), backgroundColor: '#c0d9e8', hoverBackgroundColor: '#159d93', borderRadius: 4, maxBarThickness: 22 }] },
      options: { ...commonOptions, plugins: { ...commonOptions.plugins, tooltip: { ...commonOptions.plugins.tooltip, callbacks: { label: (context) => ` ${number(context.parsed.y)} orders` } } }, scales: { ...commonOptions.scales, y: { ...commonOptions.scales.y, ticks: { ...commonOptions.scales.y.ticks, precision: 0 } } } },
    });
  }

  function makeCell(text, className = '') {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (className) cell.className = className;
    return cell;
  }

  function renderProducts(products) {
    state.products = Array.isArray(products) ? products : [];
    const select = dom.productCategory;
    if (select) {
      const previous = select.value;
      const categories = [...new Set(state.products.map((item) => String(item.category || 'Other')).filter(Boolean))].sort((a, b) => a.localeCompare(b));
      select.replaceChildren(new Option('All categories', ''));
      for (const category of categories) select.add(new Option(category, category));
      if (categories.includes(previous)) select.value = previous;
    }
    applyProductFilters();
  }

  function applyProductFilters() {
    if (!dom.products) return;
    const query = (dom.productSearch?.value || '').trim().toLocaleLowerCase();
    const category = dom.productCategory?.value || '';
    const sort = dom.productSort?.value || 'revenue';
    const items = state.products.filter((item) => {
      const productName = String(item.product || 'Unspecified product').toLocaleLowerCase();
      const categoryName = String(item.category || 'Other');
      return (!query || productName.includes(query) || categoryName.toLocaleLowerCase().includes(query)) && (!category || categoryName === category);
    });
    items.sort((a, b) => {
      if (sort === 'name') return String(a.product || '').localeCompare(String(b.product || ''));
      const key = sort === 'orders' ? 'totalOrders' : 'revenue';
      return Number(b[key] || 0) - Number(a[key] || 0);
    });
    dom.products.replaceChildren();
    if (!items.length) {
      const row = document.createElement('tr');
      const cell = makeCell('No products match these filters in the current period.', 'table-state'); cell.colSpan = 4;
      row.append(cell); dom.products.append(row); return;
    }
    for (const item of items) {
      const row = document.createElement('tr');
      const product = makeCell(item.product || 'Unspecified product', 'product-name');
      const categoryCell = document.createElement('td');
      const pill = document.createElement('span'); pill.className = 'category-pill'; pill.textContent = item.category || 'Other'; categoryCell.append(pill);
      row.append(product, categoryCell, makeCell(number(item.totalOrders)), makeCell(money(item.revenue), 'numeric'));
      dom.products.append(row);
    }
  }

  function renderDaily(days) {
    dom.daily.replaceChildren();
    if (!days.length) {
      const row = document.createElement('tr');
      const cell = makeCell('No daily results in this period.', 'table-state');
      cell.colSpan = 3;
      row.append(cell);
      dom.daily.append(row);
      return;
    }
    for (const item of [...days].reverse()) {
      const row = document.createElement('tr');
      row.append(makeCell(shortDate(item.date)), makeCell(number(item.totalOrders), 'numeric'), makeCell(money(item.revenue), 'numeric'));
      dom.daily.append(row);
    }
  }

  function renderReports() {
    const allReports = state.reports || [];
    const query = (dom.reportsSearch?.value || '').trim().toLocaleLowerCase();
    const statusFilter = dom.reportsStatus?.value || '';
    const filtered = allReports.filter((report) => {
      const searchable = [report.id, report.title, report.startDate, report.endDate].filter(Boolean).join(' ').toLocaleLowerCase();
      return (!query || searchable.includes(query)) && (!statusFilter || String(report.status || 'pending') === statusFilter);
    });
    dom.reports.replaceChildren();
    dom.reportCount.textContent = filtered.length === allReports.length
      ? `${allReports.length} report${allReports.length === 1 ? '' : 's'}`
      : `${filtered.length} of ${allReports.length} reports`;
    if (dom.reportsFilterCount) dom.reportsFilterCount.textContent = allReports.length ? `Showing ${filtered.length} of latest ${allReports.length}` : 'No reports loaded';
    dom.reportsEmpty.classList.toggle('hidden', allReports.length !== 0);
    document.querySelector('.reports-table').classList.toggle('hidden', allReports.length === 0);
    if (!allReports.length) return;
    if (!filtered.length) {
      const row = document.createElement('tr'); const cell = makeCell('No reports match these filters.', 'table-state'); cell.colSpan = 6; row.append(cell); dom.reports.append(row); return;
    }
    for (const report of filtered) {
      const row = document.createElement('tr');
      const idCell = document.createElement('td');
      const id = document.createElement('span'); id.className = 'report-id'; id.textContent = String(report.title || report.id || 'Report');
      const idHint = document.createElement('span'); idHint.className = 'report-created'; idHint.textContent = report.id || '';
      idCell.append(id, idHint);
      const period = document.createElement('td');
      period.className = 'report-period'; period.textContent = report.startDate && report.endDate ? `${report.startDate} – ${report.endDate}` : 'Period unavailable';
      const created = document.createElement('td'); const createdText = document.createElement('span'); createdText.className = 'report-created'; createdText.textContent = timestamp(report.createdAt); created.append(createdText);
      const statusCell = document.createElement('td'); const status = document.createElement('span');
      status.className = `status-badge status-${['completed', 'pending', 'failed'].includes(report.status) ? report.status : 'pending'}`; status.textContent = report.status || 'unknown'; statusCell.append(status);
      const revenueCell = makeCell(report.summary ? money(report.summary.totalRevenue) : '—', 'numeric');
      const actions = document.createElement('td'); const actionWrap = document.createElement('div'); actionWrap.className = 'table-actions';
      if (report.status === 'completed' && report.file) {
        const preview = document.createElement('button'); preview.type = 'button'; preview.className = 'text-action'; preview.textContent = 'Preview'; preview.addEventListener('click', () => showPreview(report));
        const download = document.createElement('a'); download.className = 'text-action'; download.href = report.download || `/api/reports/${encodeURIComponent(report.id)}/download`; download.download = `executive-report-${report.id}.pdf`; download.textContent = 'Download'; actionWrap.append(preview, download);
      } else {
        const unavailable = document.createElement('span'); unavailable.className = 'report-created'; unavailable.textContent = 'Unavailable'; actionWrap.append(unavailable);
      }
      actions.append(actionWrap); row.append(idCell, period, created, statusCell, revenueCell, actions); dom.reports.append(row);
    }
  }

  async function loadReports() {
    try {
      const data = await requestJson('/api/reports?limit=20');
      state.reports = data.reports || [];
      renderReports();
    } catch (error) {
      state.reports = [];
      renderReports();
      showToast(error.message || 'Report history is unavailable.', true);
    }
  }

  function showPreview(report) {
    dom.pdfPanel.classList.remove('hidden');
    dom.pdfFrame.src = report.file;
    dom.pdfDownload.href = report.download || `/api/reports/${report.id}/download`;
    dom.pdfDownload.download = `executive-report-${report.id}.pdf`;
    dom.previewSubtitle.textContent = `${report.startDate || 'Report'} – ${report.endDate || ''}`;
    dom.pdfPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function generateReport() {
    if (state.isGenerating) return;
    let period;
    try { period = validatePeriod(); } catch (error) { showToast(error.message, true); return; }
    state.isGenerating = true;
    dom.generateButton.disabled = true;
    dom.applyPeriod.disabled = true;
    dom.generateButton.textContent = 'Generating PDF…';
    try {
      let idempotencyKey;
      try { idempotencyKey = crypto.randomUUID(); } catch { idempotencyKey = `demo-${Date.now()}`; }
      const report = await requestJson('/api/reports/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
        body: JSON.stringify(period),
      });
      await Promise.all([loadAnalytics(), loadReports()]);
      showToast('Report generated. Preview or download the real PDF from Recent reports.');
      if (report.status === 'completed') showPreview({ ...report, ...period, file: report.file });
    } catch (error) {
      showToast(error.message || 'Report generation failed.', true);
    } finally {
      state.isGenerating = false;
      dom.generateButton.disabled = false;
      dom.applyPeriod.disabled = false;
      dom.generateButton.innerHTML = '<span aria-hidden="true">＋</span> Generate PDF report';
    }
  }

  function initials(name) {
    return String(name || 'Account').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join('') || 'AC';
  }

  async function loadAccountMenu() {
    const host = dom.topbarAccount;
    if (!host) return;
    try {
      const response = await fetch('/api/auth/me', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) return;
      if (!response.ok) return;
      const result = await response.json();
      const user = result.user;
      if (!user) return;
      state.csrfToken = result.csrfToken || '';
      host.replaceChildren();
      const details = document.createElement('details'); details.className = 'account-menu';
      const summary = document.createElement('summary');
      const avatar = document.createElement('span'); avatar.className = 'account-avatar'; avatar.setAttribute('aria-hidden', 'true'); avatar.textContent = initials(user.name || user.email);
      const copy = document.createElement('span'); copy.className = 'account-menu-copy';
      const name = document.createElement('strong'); name.textContent = user.name || user.email;
      const organization = document.createElement('small'); organization.textContent = user.organization?.name || 'Personal workspace';
      copy.append(name, organization);
      const caret = document.createElement('span'); caret.className = 'account-caret'; caret.setAttribute('aria-hidden', 'true'); caret.textContent = '▾';
      summary.append(avatar, copy, caret); details.append(summary);
      const popover = document.createElement('div'); popover.className = 'account-menu-popover';
      const email = document.createElement('p'); email.className = 'account-menu-email'; email.textContent = user.email || '';
      const workspace = document.createElement('a'); workspace.href = '/workspace'; workspace.textContent = 'Open organisation workspace';
      const custom = document.createElement('a'); custom.href = '/custom-reports'; custom.textContent = 'Custom PDF reports';
      const signOut = document.createElement('button'); signOut.type = 'button'; signOut.textContent = 'Sign out';
      signOut.addEventListener('click', async () => {
        signOut.disabled = true; signOut.textContent = 'Signing out…';
        try {
          const logout = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': state.csrfToken }, body: '{}' });
          if (!logout.ok) throw new Error('Sign-out could not be completed. Reload the page and try again.');
          window.location.assign('/');
        } catch (error) {
          signOut.disabled = false; signOut.textContent = 'Sign out'; showToast(error.message || 'Sign-out failed.', true);
        }
      });
      popover.append(email, workspace, custom, signOut); details.append(popover); host.append(details);
      document.addEventListener('click', (event) => { if (!details.contains(event.target)) details.open = false; });
      document.addEventListener('keydown', (event) => { if (event.key === 'Escape') details.open = false; });
    } catch { /* Account navigation remains available as Sign in if session lookup fails. */ }
  }

  function chooseQuickPeriod(days) {
    const end = dom.endDate.value || previousCompleteWeek().endDate;
    const start = new Date(`${end}T00:00:00Z`);
    start.setUTCDate(start.getUTCDate() - (days - 1));
    dom.startDate.value = formatDate(start);
    dom.endDate.value = end;
    document.querySelectorAll('.period-preset').forEach((button) => {
      const active = Number(button.dataset.periodDays) === Number(days);
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    dom.periodForm.requestSubmit();
  }

  async function init() {
    const defaults = previousCompleteWeek();
    dom.startDate.value = defaults.startDate;
    dom.endDate.value = defaults.endDate;
    const today = formatDate(new Date());
    dom.startDate.max = today;
    dom.endDate.max = today;
    dom.periodForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      try { await loadAnalytics(); showToast('Dashboard updated for the selected period.'); }
      catch { /* error already presented */ }
    });
    document.querySelectorAll('.period-preset').forEach((button) => button.addEventListener('click', () => chooseQuickPeriod(Number(button.dataset.periodDays))));
    [dom.startDate, dom.endDate].forEach((input) => input.addEventListener('change', () => {
      document.querySelectorAll('.period-preset').forEach((button) => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); });
    }));
    dom.generateButton.addEventListener('click', generateReport);
    dom.productSearch?.addEventListener('input', applyProductFilters);
    dom.productCategory?.addEventListener('change', applyProductFilters);
    dom.productSort?.addEventListener('change', applyProductFilters);
    dom.reportsSearch?.addEventListener('input', renderReports);
    dom.reportsStatus?.addEventListener('change', renderReports);
    dom.closePreview.addEventListener('click', () => {
      dom.pdfFrame.src = 'about:blank';
      dom.pdfPanel.classList.add('hidden');
    });
    document.querySelectorAll('.nav-link').forEach((link) => link.addEventListener('click', () => {
      document.querySelectorAll('.nav-link').forEach((item) => item.classList.toggle('active', item === link));
    }));
    await Promise.all([loadConfig(), loadAccountMenu()]);
    try { await loadAnalytics(); } catch { /* error already presented */ }
    try { await loadReports(); } catch (error) { showToast(error.message || 'Report history is unavailable.', true); }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
