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
}

export interface UICallbacks {
  onToggleNight(on: boolean): void;
  onTogglePause(on: boolean): void;
  onToggleMap(on: boolean): void;
  onTour(): void; // starts/advances a guided tour
  onCloseInfo(): void;
}

export interface UI {
  showInfo(info: BuildingInfo): void;
  hideInfo(): void;
  setLoading(loading: boolean, label?: string): void;
  setTourLabel(label: string): void; // e.g. "Tour: Capitol (2/9)"
  setNight(on: boolean): void; // sync button state + body.night
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

  toolbar.appendChild(nightBtn);
  toolbar.appendChild(pauseBtn);
  toolbar.appendChild(mapBtn);
  toolbar.appendChild(tourBtn);

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

  const infoAddr = document.createElement("p");
  infoAddr.className = "info-addr";
  infoCard.appendChild(infoAddr);

  const infoStats = document.createElement("p");
  infoStats.className = "info-stats";
  infoCard.appendChild(infoStats);

  const infoDescription = document.createElement("p");
  infoDescription.className = "info-description";
  infoCard.appendChild(infoDescription);

  const infoLinks = document.createElement("div");
  infoLinks.className = "info-links";
  infoCard.appendChild(infoLinks);

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

    infoLinks.textContent = "";

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
  };
}
