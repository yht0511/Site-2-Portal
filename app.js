"use strict";

const CONFIG_URL = "./services.yaml";
const ROUTE_QUERY_KEYS = ["id", "name", "url", "link", "target", "to"];
const DEFAULT_SITE = {
  title: "Site-2中央路由系统",
  mark: "TECLAB",
  loading: {
    minDuration: 2000,
    status: "正在检测网络环境",
  },
};

const state = {
  config: null,
  adapterValues: {},
  adapterResults: {},
  bootStartedAt: performance.now(),
  isBooting: true,
  site: DEFAULT_SITE,
  services: [],
  query: "",
  expandedServices: new Set(),
};

const elements = {
  adapterList: document.querySelector("#adapterList"),
  bootScreen: document.querySelector("#bootScreen"),
  bootStatus: document.querySelector("#bootStatus"),
  bootTitle: document.querySelector("#bootTitle"),
  brandMark: document.querySelector("#brandMark"),
  brandTitle: document.querySelector("#brandTitle"),
  refreshButton: document.querySelector("#refreshButton"),
  routeNotice: document.querySelector("#routeNotice"),
  searchInput: document.querySelector("#searchInput"),
  serviceCount: document.querySelector("#serviceCount"),
  serviceGrid: document.querySelector("#serviceGrid"),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  renderSiteMeta();
  setBootStatus(DEFAULT_SITE.loading.status);

  try {
    const response = await fetch(CONFIG_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`配置加载失败：HTTP ${response.status}`);
    }

    const source = await response.text();
    state.config = parseYaml(source);
    state.site = normalizeSiteConfig(state.config.site);
    state.services = normalizeServices(state.config.services);
    renderSiteMeta();
    setBootStatus(state.site.loading.status);
    render();
    await runAdapters();
    await finishBoot();
    await handleInitialRoute();
  } catch (error) {
    await finishBoot();
    renderFatalError(error);
  }
}

function bindEvents() {
  elements.searchInput.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLowerCase();
    renderServices();
  });

  elements.refreshButton.addEventListener("click", async () => {
    await runAdapters();
  });
}

async function runAdapters() {
  const adapters = Array.isArray(state.config?.adapters) ? state.config.adapters : [];

  setBootStatus("正在初始化环境适配器");
  state.adapterResults = Object.fromEntries(
    adapters.map((adapter) => [
      adapter.id,
      {
        id: adapter.id,
        name: adapter.name || adapter.id,
        mode: adapter.mode,
        status: "pending",
        text: "检测中",
        variable: adapter.variable || adapter.id,
      },
    ]),
  );
  renderAdapters();
  renderServices();

  await Promise.all(
    adapters.map(async (adapter) => {
      const variable = adapter.variable || adapter.id;
      setBootStatus(`正在检测 ${adapter.name || adapter.id}`);
      try {
        const result = await executeAdapter(adapter);
        state.adapterValues[variable] = result.value;
        state.adapterResults[adapter.id] = {
          id: adapter.id,
          name: adapter.name || adapter.id,
          mode: adapter.mode,
          status: "ready",
          text: result.text || stringifyValue(result.value),
          value: result.value,
          variable,
        };
      } catch (error) {
        state.adapterValues[variable] = false;
        state.adapterResults[adapter.id] = {
          id: adapter.id,
          name: adapter.name || adapter.id,
          mode: adapter.mode,
          status: "error",
          text: error.message,
          value: false,
          variable,
        };
      }

      renderAdapters();
      renderServices();
    }),
  );

  setBootStatus("入口选择已准备完成");
}

async function executeAdapter(adapter) {
  const mode = adapter.mode || "constant";

  if (mode === "constant") {
    const value = adapter.config?.value ?? true;
    return {
      value,
      text: adapter.config?.text || stringifyValue(value),
    };
  }

  if (mode === "https-probe") {
    return probeHttps(adapter.config || {});
  }

  throw new Error(`未知适配器模式：${mode}`);
}

function probeHttps(config) {
  return new Promise((resolve) => {
    const timeout = Number(config.timeout ?? 2500);
    const targetUrl = appendCacheBuster(config.url);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      controller.abort();
      resolve({
        value: config.failureValue ?? false,
        text: config.timeoutText || config.failureText || "探测超时",
      });
    }, timeout);

    fetch(targetUrl, {
      method: config.method || "HEAD",
      mode: "no-cors",
      signal: controller.signal,
    })
      .then(() => {
        window.clearTimeout(timer);
        resolve({
          value: config.successValue ?? true,
          text: config.successText || "连通成功",
        });
      })
      .catch((error) => {
        window.clearTimeout(timer);
        const isAbort = error.name === "AbortError";
        resolve({
          value: config.failureValue ?? false,
          text: isAbort
            ? config.timeoutText || config.failureText || "探测超时"
            : config.failureText || "连接失败",
        });
      });
  });
}

async function handleInitialRoute() {
  const routeValue = getRouteParam();
  if (!routeValue) {
    return;
  }

  const match = findServiceByRouteParam(routeValue);
  if (!match) {
    setRouteNotice(`未找到匹配目标：${routeValue}`, true);
    return;
  }

  const selectedLink = selectBestLink(match.service, match.matchedUrl);
  if (!selectedLink) {
    setRouteNotice(`${match.service.name} 当前没有满足条件的入口`, true);
    return;
  }

  setRouteNotice(`已匹配 ${match.service.name}，正在进入 ${selectedLink.label || selectedLink.url}`);
  navigateTo(selectedLink.url);
}

function findServiceByRouteParam(rawValue) {
  const value = safeDecodeURIComponent(rawValue).trim();
  const normalizedValue = normalizeComparable(value);

  const byId = state.services.find((service) => normalizeComparable(service.id) === normalizedValue);
  if (byId) {
    return { service: byId, reason: "id" };
  }

  const byName = state.services.find((service) => normalizeComparable(service.name) === normalizedValue);
  if (byName) {
    return { service: byName, reason: "name" };
  }

  const byAlias = state.services.find((service) =>
    service.aliases.some((alias) => normalizeComparable(alias) === normalizedValue),
  );
  if (byAlias) {
    return { service: byAlias, reason: "alias" };
  }

  const urlMatch = findServiceByUrl(value);
  if (urlMatch) {
    return urlMatch;
  }

  return null;
}

function findServiceByUrl(rawValue) {
  const candidates = state.services.flatMap((service) =>
    service.links.map((link) => ({ service, link, score: scoreUrlMatch(rawValue, link.url) })),
  );

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score <= 0) {
    return null;
  }

  return {
    service: best.service,
    matchedUrl: best.link.url,
    reason: "url",
  };
}

function scoreUrlMatch(input, configuredUrl) {
  const normalizedInput = normalizeUrlLike(input);
  const normalizedConfigured = normalizeUrlLike(configuredUrl);

  if (!normalizedInput || !normalizedConfigured) {
    return 0;
  }

  if (normalizedInput.full === normalizedConfigured.full) {
    return 100;
  }

  if (normalizedInput.withoutTrailingSlash === normalizedConfigured.withoutTrailingSlash) {
    return 95;
  }

  if (
    normalizedInput.host === normalizedConfigured.host &&
    normalizedInput.path !== "/" &&
    (normalizedConfigured.path.startsWith(normalizedInput.path) ||
      normalizedInput.path.startsWith(normalizedConfigured.path))
  ) {
    return 80;
  }

  if (normalizedInput.host === normalizedConfigured.host) {
    return 70;
  }

  if (normalizedConfigured.full.includes(normalizedInput.raw) || normalizedInput.full.includes(normalizedConfigured.raw)) {
    return 40;
  }

  if (normalizedConfigured.raw.includes(normalizedInput.raw) || normalizedInput.raw.includes(normalizedConfigured.raw)) {
    return 30;
  }

  return 0;
}

function normalizeUrlLike(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) {
    return null;
  }

  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const url = new URL(withProtocol);
    const host = url.host.replace(/^www\./, "");
    const path = url.pathname || "/";
    const full = `${url.protocol}//${host}${path}${url.search}`.replace(/\/+$/, "");
    return {
      full,
      host,
      path: path.replace(/\/+$/, "") || "/",
      raw,
      withoutTrailingSlash: full.replace(/\/+$/, ""),
    };
  } catch {
    return {
      full: raw.replace(/\/+$/, ""),
      host: "",
      path: "",
      raw,
      withoutTrailingSlash: raw.replace(/\/+$/, ""),
    };
  }
}

function selectBestLink(service, preferredUrl) {
  if (preferredUrl) {
    const requested = service.links.find((link) => link.url === preferredUrl);
    if (requested && canOpenLink(requested)) {
      return requested;
    }
  }

  return service.links.find((link) => isLinkEnabled(link)) || null;
}

function isLinkEnabled(link) {
  if (!link.when) {
    return true;
  }

  try {
    return evaluateCondition(link.when, state.adapterValues);
  } catch {
    return false;
  }
}

function canOpenLink(link) {
  if (link.when === "!isSchoolNetwork") {
    return true;
  }
  if (link.when === "isSchoolNetwork") {
    const result = state.adapterResults.schoolNetwork;
    return result?.status !== "ready" || state.adapterValues.isSchoolNetwork === true;
  }
  return isLinkEnabled(link);
}

function evaluateCondition(condition, values) {
  if (typeof condition === "boolean") {
    return condition;
  }

  const source = String(condition).trim();
  if (!source) {
    return true;
  }

  const tokens = tokenizeCondition(source);
  let index = 0;

  function parseExpression() {
    return parseOr();
  }

  function parseOr() {
    let value = parseAnd();
    while (tokens[index] === "||") {
      index += 1;
      value = parseAnd() || value;
    }
    return value;
  }

  function parseAnd() {
    let value = parseNot();
    while (tokens[index] === "&&") {
      index += 1;
      value = parseNot() && value;
    }
    return value;
  }

  function parseNot() {
    if (tokens[index] === "!") {
      index += 1;
      return !parseNot();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const token = tokens[index];
    if (token === "(") {
      index += 1;
      const value = parseExpression();
      if (tokens[index] !== ")") {
        throw new Error("条件表达式缺少右括号");
      }
      index += 1;
      return value;
    }

    index += 1;

    if (token === "true") {
      return true;
    }
    if (token === "false") {
      return false;
    }
    if (!token) {
      return false;
    }

    return Boolean(values[token]);
  }

  const result = parseExpression();
  if (index < tokens.length) {
    throw new Error("条件表达式无法完整解析");
  }

  return result;
}

function tokenizeCondition(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (source.startsWith("&&", index) || source.startsWith("||", index)) {
      tokens.push(source.slice(index, index + 2));
      index += 2;
      continue;
    }

    if (char === "!" || char === "(" || char === ")") {
      tokens.push(char);
      index += 1;
      continue;
    }

    const match = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_.-]*/);
    if (!match) {
      throw new Error(`无法解析条件：${source}`);
    }

    tokens.push(match[0]);
    index += match[0].length;
  }

  return tokens;
}

function render() {
  renderSiteMeta();
  renderAdapters();
  renderServices();
}

function renderSiteMeta() {
  const site = state.site || DEFAULT_SITE;
  document.title = site.title;
  elements.brandTitle.textContent = site.title;
  elements.brandMark.textContent = site.mark;
  elements.bootTitle.textContent = site.title;
}

function setBootStatus(message) {
  elements.bootStatus.textContent = message;
}

async function finishBoot() {
  if (!state.isBooting) {
    return;
  }

  const minDuration = Number(state.site?.loading?.minDuration ?? DEFAULT_SITE.loading.minDuration);
  const elapsed = performance.now() - state.bootStartedAt;
  const remaining = Math.max(0, minDuration - elapsed);

  if (remaining > 0) {
    await delay(remaining);
  }

  state.isBooting = false;
  document.body.classList.remove("is-booting");
  document.body.classList.add("is-ready");
  elements.bootScreen.setAttribute("aria-hidden", "true");
}

function renderAdapters() {
  const results = Object.values(state.adapterResults);
  if (!results.length) {
    elements.adapterList.innerHTML = `<div class="empty-state">没有配置适配器</div>`;
    return;
  }

  elements.adapterList.innerHTML = results
    .map((result) => {
      const statusLabel = result.status === "pending" ? "检测中" : result.status === "error" ? "失败" : "完成";
      return `
        <article class="adapter-item">
          <div class="adapter-main">
            <span>${escapeHtml(result.name)}</span>
            <span class="status-pill ${escapeHtml(result.status)}">${statusLabel}</span>
          </div>
          <div class="adapter-value">
            ${escapeHtml(result.text)}
          </div>
        </article>
      `;
    })
    .join("");
}

function renderServices() {
  const visibleServices = state.services.filter((service) => serviceMatchesQuery(service, state.query));
  const availableCount = visibleServices.filter((service) => service.links.some(canOpenLink)).length;
  elements.serviceCount.textContent = `${availableCount}/${visibleServices.length} 个服务可进入`;

  if (!visibleServices.length) {
    elements.serviceGrid.innerHTML = `<div class="empty-state">没有匹配的服务</div>`;
    return;
  }

  elements.serviceGrid.innerHTML = visibleServices.map(renderServiceCard).join("");

  elements.serviceGrid.querySelectorAll("[data-action='toggle-service']").forEach((button) => {
    button.addEventListener("click", () => {
      const serviceId = button.dataset.serviceId;
      if (state.expandedServices.has(serviceId)) {
        state.expandedServices.delete(serviceId);
      } else {
        state.expandedServices.add(serviceId);
      }
      renderServices();
    });
  });

  elements.serviceGrid.querySelectorAll("[data-action='open-service']").forEach((button) => {
    button.addEventListener("click", () => {
      const service = state.services.find((item) => item.id === button.dataset.serviceId);
      const link = service ? selectBestLink(service) : null;
      if (service && link) {
        navigateTo(link.url);
      }
    });
  });

  elements.serviceGrid.querySelectorAll("[data-action='open-link']").forEach((button) => {
    button.addEventListener("click", () => {
      const service = state.services.find((item) => item.id === button.dataset.serviceId);
      const link = service?.links.find((item) => item.url === button.dataset.url);
      if (service && link && canOpenLink(link)) {
        navigateTo(link.url);
      }
    });
  });
}

function renderServiceCard(service) {
  const bestLink = selectBestLink(service);
  const isExpanded = state.expandedServices.has(service.id);
  const selectedLabel = bestLink ? bestLink.label || bestLink.url : "当前没有可用入口";
  const selectedUrl = bestLink ? bestLink.url : "请刷新检测或检查配置条件";

  return `
    <article class="service-row">
      <div class="service-main">
        <div class="service-title">
          <h3>${escapeHtml(service.name)}</h3>
          <div class="service-id">${escapeHtml(service.id)}</div>
        </div>
        <div class="selected-link">
          <div class="selected-label">
            <span class="selected-dot ${bestLink ? "" : "unavailable"}"></span>
            <span>${escapeHtml(selectedLabel)}</span>
          </div>
          <div class="selected-url">${escapeHtml(selectedUrl)}</div>
        </div>
        <div class="service-actions">
          <button
            class="secondary-action"
            type="button"
            data-action="toggle-service"
            data-service-id="${escapeHtml(service.id)}"
            aria-expanded="${isExpanded ? "true" : "false"}"
          >
            ${isExpanded ? "收起" : "展开"}
          </button>
          <button
            class="primary-action"
            type="button"
            data-action="open-service"
            data-service-id="${escapeHtml(service.id)}"
            ${bestLink ? "" : "disabled"}
          >
            进入
          </button>
        </div>
      </div>
      ${isExpanded ? renderServiceLinks(service) : ""}
    </article>
  `;
}

function renderServiceLinks(service) {
  const links = service.links.map((link) => {
    const available = canOpenLink(link);
    const note = available
      ? isLinkEnabled(link) ? "当前推荐" : "可手动进入"
      : link.when === "isSchoolNetwork" ? "校外网络不可用" : "当前条件不可用";
    return `
      <div class="link-row ${available ? "" : "disabled"}">
        <div class="link-info">
          <div class="link-label">${escapeHtml(link.label || link.url)}</div>
          <div class="link-url">${escapeHtml(link.url)}</div>
          <div class="link-condition">${note}</div>
        </div>
        <button
          type="button"
          data-action="open-link"
          data-service-id="${escapeHtml(service.id)}"
          data-url="${escapeHtml(link.url)}"
          ${available ? "" : "disabled"}
        >
          ${available ? "进入" : "不可用"}
        </button>
      </div>
    `;
  });

  return `<div class="link-list">${links.join("")}</div>`;
}

function serviceMatchesQuery(service, query) {
  if (!query) {
    return true;
  }

  const haystack = [
    service.id,
    service.name,
    ...service.aliases,
    ...service.links.flatMap((link) => [link.label, link.url, link.when]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(query);
}

function navigateTo(url) {
  window.location.assign(url);
}

function setRouteNotice(message, isError = false) {
  elements.routeNotice.textContent = message;
  elements.routeNotice.classList.toggle("error", isError);
}

function renderFatalError(error) {
  elements.serviceCount.textContent = "加载失败";
  elements.serviceGrid.innerHTML = `<div class="error-state">${escapeHtml(error.message)}</div>`;
  elements.adapterList.innerHTML = `<div class="error-state">无法读取 services.yaml</div>`;
}

function getRouteParam() {
  const params = new URLSearchParams(window.location.search);
  for (const key of ROUTE_QUERY_KEYS) {
    const value = params.get(key);
    if (value) {
      return value;
    }
  }

  const raw = window.location.search.replace(/^\?/, "");
  if (raw && !raw.includes("=")) {
    return raw;
  }

  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash) {
    return hash;
  }

  return "";
}

function normalizeServices(services) {
  if (!Array.isArray(services)) {
    return [];
  }

  return services.map((service) => ({
    id: String(service.id || "").trim(),
    name: String(service.name || service.id || "").trim(),
    aliases: Array.isArray(service.aliases) ? service.aliases.map(String) : [],
    links: normalizeLinks(service.links),
  }));
}

function normalizeSiteConfig(site) {
  const loading = site?.loading || {};
  return {
    title: String(site?.title || DEFAULT_SITE.title),
    mark: String(site?.mark || DEFAULT_SITE.mark),
    loading: {
      minDuration: Number(loading.minDuration ?? DEFAULT_SITE.loading.minDuration),
      status: String(loading.status || DEFAULT_SITE.loading.status),
    },
  };
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) {
    return [];
  }

  return links
    .map((link) => {
      if (typeof link === "string") {
        return { label: link, url: link };
      }

      return {
        label: link.label || link.name || link.url,
        url: String(link.url || "").trim(),
        when: link.when ? String(link.when).trim() : "",
      };
    })
    .filter((link) => link.url);
}

function appendCacheBuster(url) {
  const target = new URL(url, window.location.href);
  target.searchParams.set("t", Date.now().toString());
  return target.toString();
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function stringifyValue(value) {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  return String(value);
}

function delay(duration) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, duration);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseYaml(source) {
  const lines = source.replace(/\t/g, "  ").split(/\r?\n/);
  const root = {};
  const stack = [{ indent: -1, value: root }];

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const withoutComment = stripYamlComment(rawLine);
    if (!withoutComment.trim()) {
      continue;
    }

    const indent = withoutComment.match(/^ */)[0].length;
    const text = withoutComment.trim();

    while (stack.length > 1 && indent <= stack.at(-1).indent) {
      stack.pop();
    }

    const parent = stack.at(-1).value;

    if (text.startsWith("- ")) {
      if (!Array.isArray(parent)) {
        throw new Error(`YAML 结构错误：列表项缺少列表父级：${text}`);
      }

      const itemText = text.slice(2).trim();
      if (!itemText) {
        const item = createYamlContainer(lines, index, indent);
        parent.push(item);
        stack.push({ indent, value: item });
        continue;
      }

      if (isInlineYamlMapping(itemText)) {
        const item = {};
        parent.push(item);
        stack.push({ indent, value: item });
        parseKeyValueInto(item, itemText, indent, stack, lines, index);
      } else {
        parent.push(parseYamlScalar(itemText));
      }
      continue;
    }

    parseKeyValueInto(parent, text, indent, stack, lines, index);
  }

  return root;
}

function parseKeyValueInto(target, text, indent, stack, lines, index) {
  const separator = text.indexOf(":");
  if (separator === -1) {
    throw new Error(`YAML 行缺少冒号：${text}`);
  }

  const key = text.slice(0, separator).trim();
  const rawValue = text.slice(separator + 1).trim();

  if (!rawValue) {
    const container = createYamlContainer(lines, index, indent);
    target[key] = container;
    stack.push({ indent, value: container });
    return;
  }

  target[key] = parseYamlScalar(rawValue);
}

function createYamlContainer(lines, index, indent) {
  const nextLine = findNextMeaningfulLine(lines, index + 1);
  if (!nextLine) {
    return {};
  }
  return nextLine.indent > indent && nextLine.text.startsWith("- ") ? [] : {};
}

function findNextMeaningfulLine(lines, startIndex) {
  for (let index = startIndex; index < lines.length; index += 1) {
    const withoutComment = stripYamlComment(lines[index]);
    if (!withoutComment.trim()) {
      continue;
    }
    return {
      indent: withoutComment.match(/^ */)[0].length,
      text: withoutComment.trim(),
    };
  }
  return null;
}

function stripYamlComment(line) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (char === "#" && !quote) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseYamlScalar(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  if (value === "null") {
    return null;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return Number(value);
  }
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((item) => parseYamlScalar(item.trim()))
      .filter((item) => item !== "");
  }

  return value;
}

function isInlineYamlMapping(text) {
  return /^[A-Za-z0-9_.-]+\s*:(?:\s+|$)/.test(text);
}
