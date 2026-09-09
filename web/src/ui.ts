export interface BuildingInfo {
  id: string;
  name: string | null;
  addr: string | null;
  height: number;
  levels: number | null;
  type: string;
  landmark: string | null;
  wikidata: string | null;
  website: string | null;
  description?: string | null;
  summary?: string | null;
  thumbnail?: string | null;
  wikipediaUrl?: string | null;
}

export interface UICallbacks {
  onToggleNight(on: boolean): void;
  onTogglePause(on: boolean): void;
  onToggleMap(on: boolean): void;
  onTour(): void; // starts/advances a guided tour
  onCloseInfo(): void;
  onToggleHeights?(on: boolean): void;
}

export interface HeightsLegendSpec {
  minElev: number;
  maxElev: number;
  contour: number;
  stops: Array<{ t: number; color: string }>;
}

export interface UI {
  showInfo(info: BuildingInfo): void;
  hideInfo(): void;
  setLoading(loading: boolean, label?: string): void;
  setTourLabel(label: string): void; // e.g. "Tour: Capitol (2/9)"
  setNight(on: boolean): void; // sync button state + body.night
  setHeights(on: boolean): void; // sync button state + body.heights
  setHeightsLegend(spec: HeightsLegendSpec | null): void;
  setReadout(text: string | null): void;
}

/**
 * Builds a CSS linear-gradient() string for the heights legend bar from a
 * list of {t, color} stops. t is 0..1 from the bottom of the bar to the top;
 * CSS gradients are expressed top-to-bottom, so stops are flipped here.
 */
export function legendGradient(stops: Array<{ t: number; color: string }>): string {
  // CSS stop positions must be non-decreasing, so express the ramp bottom-up with t directly.
  const parts = stops.slice().sort((a, b) => a.t - b.t).map(({ t, color }) => `${color} ${Math.round(t * 1000) / 10}%`);
  return `linear-gradient(to top, ${parts.join(", ")})`;
}

/**
 * Formats the bottom-left readout pill text, e.g. "Elev 42 m · Bldg 18 m".
 * Elevation and building height are rounded to whole metres; when bldg is
 * null, only the elevation part is shown.
 */
export function readoutText(elev: number, bldg: number | null): string {
  const parts = [`Elev ${Math.round(elev)} m`];
  if (bldg !== null && bldg !== undefined) {
    parts.push(`Bldg ${Math.round(bldg)} m`);
  }
  return parts.join(" · ");
}

function capitalize(s: string): string {
  if (s.length === 0) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function fallbackName(type: string): string {
  const trimmed = type.trim();
  if (trimmed.length === 0) return "Building";
  return `${capitalize(trimmed)} building`;
}

function buildStatsLine(info: BuildingInfo): string {
  const parts: string[] = [];
  if (info.levels !== null && info.levels !== undefined) {
    parts.push(`${info.levels} level${info.levels === 1 ? "" : "s"}`);
  }
  if (typeof info.height === "number" && !Number.isNaN(info.height)) {
    parts.push(`${Math.round(info.height)} m`);
  }
  return parts.join(" · ");
}

export function createUI(root: HTMLElement, cb: UICallbacks): UI {
  root.textContent = "";

  let nightOn = false;
  let pauseOn = false;
  let mapOn = false;
  let heightsOn = false;

  // ---- Title badge ----
  const titleBadge = document.createElement("div");
  titleBadge.className = "panel title-badge";

  const title = document.createElement("h1");
  title.textContent = "Isometric Richmond";
  titleBadge.appendChild(title);

  const subtitle = document.createElement("p");
  subtitle.className = "subtitle";
  subtitle.textContent = "Downtown · Shockoe Bottom · Capitol Square";
  titleBadge.appendChild(subtitle);

  root.appendChild(titleBadge);

  // ---- Toolbar ----
  const toolbar = document.createElement("div");
  toolbar.className = "panel toolbar";

  function makeButton(icon: string, label: string): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";

    const iconSpan = document.createElement("span");
    iconSpan.className = "icon";
    iconSpan.textContent = icon;
    btn.appendChild(iconSpan);

    const labelSpan = document.createElement("span");
    labelSpan.className = "label";
    labelSpan.textContent = label;
    btn.appendChild(labelSpan);

    return btn;
  }

  const nightBtn = makeButton("\u{1F319}", "Night");
  const pauseBtn = makeButton("⏸", "Pause");
  const mapBtn = makeButton("\u{1F5FA}", "Map");
  const tourBtn = makeButton("\u{1F3DB}", "Tour");
  const heightsBtn = makeButton("\u{1F4D0}", "Heights");

  nightBtn.addEventListener("click", () => {
    nightOn = !nightOn;
    applyNightState(nightOn);
    cb.onToggleNight(nightOn);
  });

  pauseBtn.addEventListener("click", () => {
    pauseOn = !pauseOn;
    pauseBtn.classList.toggle("active", pauseOn);
    cb.onTogglePause(pauseOn);
  });

  mapBtn.addEventListener("click", () => {
    mapOn = !mapOn;
    mapBtn.classList.toggle("active", mapOn);
    cb.onToggleMap(mapOn);
  });

  tourBtn.addEventListener("click", () => {
    cb.onTour();
  });

  heightsBtn.addEventListener("click", () => {
    heightsOn = !heightsOn;
    applyHeightsState(heightsOn);
    cb.onToggleHeights?.(heightsOn);
  });

  toolbar.appendChild(nightBtn);
  toolbar.appendChild(pauseBtn);
  toolbar.appendChild(mapBtn);
  // toolbar.appendChild(tourBtn); // Tour hidden for now (button still wired; re-add to show it)
  toolbar.appendChild(heightsBtn);

  root.appendChild(toolbar);

  // ---- Info card ----
  const infoCard = document.createElement("div");
  infoCard.className = "panel info-card hidden";

  const infoClose = document.createElement("button");
  infoClose.type = "button";
  infoClose.className = "info-close";
  infoClose.setAttribute("aria-label", "Close");
  infoClose.textContent = "×";
  infoClose.addEventListener("click", () => {
    hideInfo();
    cb.onCloseInfo();
  });
  infoCard.appendChild(infoClose);

  const infoName = document.createElement("h2");
  infoCard.appendChild(infoName);

  const infoThumb = document.createElement("img");
  infoThumb.className = "info-thumb";
  infoThumb.alt = "";
  infoThumb.referrerPolicy = "no-referrer";
  infoThumb.hidden = true;
  infoCard.appendChild(infoThumb);

  const infoAddr = document.createElement("p");
  infoAddr.className = "info-addr";
  infoCard.appendChild(infoAddr);

  const infoStats = document.createElement("p");
  infoStats.className = "info-stats";
  infoCard.appendChild(infoStats);

  const infoDescription = document.createElement("p");
  infoDescription.className = "info-description";
  infoCard.appendChild(infoDescription);

  const infoSummary = document.createElement("p");
  infoSummary.className = "info-summary";
  infoCard.appendChild(infoSummary);

  const infoLinks = document.createElement("div");
  infoLinks.className = "info-links";
  infoCard.appendChild(infoLinks);

  const infoWikiAttr = document.createElement("p");
  infoWikiAttr.className = "info-wiki-attr";
  infoWikiAttr.textContent = "Text: Wikipedia, CC BY-SA 4.0";
  infoWikiAttr.hidden = true;
  infoCard.appendChild(infoWikiAttr);

  root.appendChild(infoCard);

  // ---- Loading pill ----
  const loadingPill = document.createElement("div");
  loadingPill.className = "panel loading-pill hidden";

  const spinner = document.createElement("span");
  spinner.className = "spinner";
  loadingPill.appendChild(spinner);

  const loadingLabel = document.createElement("span");
  loadingLabel.textContent = "Loading tiles…";
  loadingPill.appendChild(loadingLabel);

  root.appendChild(loadingPill);

  // ---- Readout pill (bottom-left, next to loading pill) ----
  const readoutPill = document.createElement("div");
  readoutPill.className = "panel readout-pill hidden";
  root.appendChild(readoutPill);

  // ---- Heights legend (bottom-left, above loading pill) ----
  const legendPanel = document.createElement("div");
  legendPanel.className = "panel heights-legend hidden";

  const legendMax = document.createElement("div");
  legendMax.className = "heights-legend-label heights-legend-max";
  legendPanel.appendChild(legendMax);

  const legendBarWrap = document.createElement("div");
  legendBarWrap.className = "heights-legend-bar-wrap";

  const legendBar = document.createElement("div");
  legendBar.className = "heights-legend-bar";
  legendBarWrap.appendChild(legendBar);

  legendPanel.appendChild(legendBarWrap);

  const legendMin = document.createElement("div");
  legendMin.className = "heights-legend-label heights-legend-min";
  legendPanel.appendChild(legendMin);

  const legendCaption = document.createElement("div");
  legendCaption.className = "heights-legend-caption";
  legendPanel.appendChild(legendCaption);

  root.appendChild(legendPanel);

  // ---- Tour label ----
  const tourLabel = document.createElement("div");
  tourLabel.className = "panel tour-label hidden";
  root.appendChild(tourLabel);

  // ---- Attribution ----
  const attribution = document.createElement("div");
  attribution.className = "attribution";

  const attrPrefix = document.createTextNode("© ");
  attribution.appendChild(attrPrefix);

  const osmLink = document.createElement("a");
  osmLink.href = "https://www.openstreetmap.org/copyright";
  osmLink.target = "_blank";
  osmLink.rel = "noopener noreferrer";
  osmLink.textContent = "OpenStreetMap contributors";
  attribution.appendChild(osmLink);

  attribution.appendChild(document.createTextNode(" · "));

  const overtureLink = document.createElement("a");
  overtureLink.href = "https://overturemaps.org/";
  overtureLink.target = "_blank";
  overtureLink.rel = "noopener noreferrer";
  overtureLink.textContent = "Overture Maps";
  attribution.appendChild(overtureLink);

  attribution.appendChild(document.createTextNode(" · "));

  const usgsLink = document.createElement("a");
  usgsLink.href = "https://www.usgs.gov/3d-elevation-program";
  usgsLink.target = "_blank";
  usgsLink.rel = "noopener noreferrer";
  usgsLink.textContent = "USGS 3DEP";
  attribution.appendChild(usgsLink);

  root.appendChild(attribution);

  function applyNightState(on: boolean): void {
    document.body.classList.toggle("night", on);
    nightBtn.classList.toggle("active", on);
  }

  function hideInfo(): void {
    infoCard.classList.add("hidden");
  }

  function showInfo(info: BuildingInfo): void {
    infoName.textContent = info.name && info.name.length > 0 ? info.name : fallbackName(info.type);

    if (info.thumbnail) {
      infoThumb.src = info.thumbnail;
      infoThumb.hidden = false;
    } else {
      infoThumb.removeAttribute("src");
      infoThumb.hidden = true;
    }

    if (info.addr) {
      infoAddr.textContent = info.addr;
      infoAddr.hidden = false;
    } else {
      infoAddr.textContent = "";
      infoAddr.hidden = true;
    }

    const stats = buildStatsLine(info);
    infoStats.textContent = stats;
    infoStats.hidden = stats.length === 0;

    if (info.description) {
      infoDescription.textContent = info.description;
      infoDescription.hidden = false;
    } else {
      infoDescription.textContent = "";
      infoDescription.hidden = true;
    }

    if (info.summary) {
      infoSummary.textContent = info.summary;
      infoSummary.hidden = false;
    } else {
      infoSummary.textContent = "";
      infoSummary.hidden = true;
    }

    infoLinks.textContent = "";

    if (info.wikipediaUrl) {
      const link = document.createElement("a");
      link.href = info.wikipediaUrl;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Wikipedia";
      infoLinks.appendChild(link);
    }

    if (info.wikidata) {
      const link = document.createElement("a");
      link.href = `https://www.wikidata.org/wiki/${encodeURIComponent(info.wikidata)}`;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Wikidata";
      infoLinks.appendChild(link);
    }

    if (info.website) {
      const link = document.createElement("a");
      link.href = info.website;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Website";
      infoLinks.appendChild(link);
    }

    infoWikiAttr.hidden = !info.summary;

    infoCard.classList.remove("hidden");
  }

  function setLoading(loading: boolean, label?: string): void {
    loadingLabel.textContent = label ?? "Loading tiles…";
    loadingPill.classList.toggle("hidden", !loading);
  }

  function setTourLabel(label: string): void {
    if (label.length === 0) {
      tourLabel.classList.add("hidden");
      tourLabel.textContent = "";
      return;
    }
    tourLabel.textContent = label;
    tourLabel.classList.remove("hidden");
  }

  function setNight(on: boolean): void {
    nightOn = on;
    applyNightState(on);
  }

  function applyHeightsState(on: boolean): void {
    document.body.classList.toggle("heights", on);
    heightsBtn.classList.toggle("active", on);
    legendPanel.classList.toggle("hidden", !on || !legendPanel.dataset.hasSpec);
  }

  function setHeights(on: boolean): void {
    heightsOn = on;
    applyHeightsState(on);
  }

  function setHeightsLegend(spec: HeightsLegendSpec | null): void {
    if (spec === null) {
      delete legendPanel.dataset.hasSpec;
      legendPanel.classList.add("hidden");
      return;
    }
    legendPanel.dataset.hasSpec = "1";
    legendBar.style.background = legendGradient(spec.stops);
    legendMax.textContent = `${Math.round(spec.maxElev)} m`;
    legendMin.textContent = `${Math.round(spec.minElev)} m`;
    legendCaption.textContent = `Elevation + building height (m), contours every ${spec.contour} m`;
    legendPanel.classList.toggle("hidden", !heightsOn);
  }

  function setReadout(text: string | null): void {
    if (text === null) {
      readoutPill.classList.add("hidden");
      readoutPill.textContent = "";
      return;
    }
    readoutPill.textContent = text;
    readoutPill.classList.remove("hidden");
  }

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      target.isContentEditable
    );
  }

  document.addEventListener("keydown", (event: KeyboardEvent) => {
    if (isTypingTarget(event.target)) return;

    switch (event.key) {
      case "Escape":
        hideInfo();
        cb.onCloseInfo();
        break;
      case "n":
      case "N":
        nightOn = !nightOn;
        applyNightState(nightOn);
        cb.onToggleNight(nightOn);
        break;
      case " ":
        event.preventDefault();
        pauseOn = !pauseOn;
        pauseBtn.classList.toggle("active", pauseOn);
        cb.onTogglePause(pauseOn);
        break;
      case "m":
      case "M":
        mapOn = !mapOn;
        mapBtn.classList.toggle("active", mapOn);
        cb.onToggleMap(mapOn);
        break;
      case "t":
      case "T":
        cb.onTour();
        break;
      case "h":
      case "H":
        heightsOn = !heightsOn;
        applyHeightsState(heightsOn);
        cb.onToggleHeights?.(heightsOn);
        break;
      default:
        break;
    }
  });

  return {
    showInfo,
    hideInfo,
    setLoading,
    setTourLabel,
    setNight,
    setHeights,
    setHeightsLegend,
    setReadout,
  };
}
