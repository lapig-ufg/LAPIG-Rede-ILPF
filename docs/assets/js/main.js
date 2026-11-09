/**
 * Rede ILPF & LAPIG/UFG — Script Principal da Plataforma (Versão Pública — Camadas & Temp_CNN)
 * Focado exclusivamente nas camadas raster (Classificação Temp_CNN 30m + MapBiomas 75m),
 * filtragem temática e espacial em cima da Classificação Temp_CNN, curvas típicas de EVI2 por classe e exportação CSV.
 * Sem pontos amostrais ou informações de localização de propriedades.
 */

(function () {
  'use strict';

  const siteBase = window.siteBaseUrl || '';

  // ──────────────────────────────────────────────────────────
  //  CONFIGURAÇÃO DAS 9 CLASSES DA CLASSIFICAÇÃO TEMP_CNN
  // ──────────────────────────────────────────────────────────
  const CNN_CLASSES = [
    { code: 1, key: 'Pastagem',     label: '1 - Pastagem',     color: '#eddc4b', rgb: [237, 220, 75],  group: 'Campestre / Pecuária', integrated: false },
    { code: 2, key: 'Agricultura',  label: '2 - Agricultura',  color: '#2fc912', rgb: [47, 201, 18],   group: 'Lavoura Anual',        integrated: false },
    { code: 3, key: 'ILPF',         label: '3 - ILPF',         color: '#3c4d0a', rgb: [60, 77, 10],    group: 'Integração Arbórea',   integrated: true  },
    { code: 4, key: 'ILP',          label: '4 - ILP',          color: '#b2f323', rgb: [178, 243, 35],  group: 'Integração Lavoura-Pec.', integrated: true },
    { code: 5, key: 'IPF',          label: '5 - IPF',          color: '#f02907', rgb: [240, 41, 7],    group: 'Integração Arbórea',   integrated: true  },
    { code: 6, key: 'Agrofloresta', label: '6 - Agrofloresta', color: '#d67910', rgb: [214, 121, 16],  group: 'Integração Arbórea',   integrated: true  },
    { code: 7, key: 'ILF',          label: '7 - ILF',          color: '#bcb915', rgb: [188, 185, 21],  group: 'Integração Arbórea',   integrated: true  },
    { code: 8, key: 'Outros',       label: '8 - Outros',       color: '#718096', rgb: [113, 128, 150], group: 'Outros Usos',          integrated: false },
    { code: 9, key: 'Silvicultura', label: '9 - Silvicultura', color: '#1b4332', rgb: [27, 67, 50],    group: 'Florestal Plantado',   integrated: false }
  ];

  const CLASS_BY_CODE = {};
  const CLASS_BY_KEY = {};
  CNN_CLASSES.forEach(c => {
    CLASS_BY_CODE[c.code] = c;
    CLASS_BY_KEY[c.key] = c;
  });

  const MACRO_GROUPS = {
    'all': [1, 2, 3, 4, 5, 6, 7, 8, 9],
    'integrated': [3, 4, 5, 6, 7],
    'agropastoral': [1, 2, 4],
    'arboreal': [3, 5, 6, 7, 9]
  };

  const MONTHS_LABELS = ['Out', 'Nov', 'Dez', 'Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out+1'];

  // ──────────────────────────────────────────────────────────
  //  ESTADO GLOBAL
  // ──────────────────────────────────────────────────────────
  let cnnStats = null; // carregado de /assets/cnn_spatial_stats.json
  let activeCodes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  let activeTileId = 'all';
  let activeMbYear = '2025';
  let selectionBounds = null;
  let isDrawingRect = false;
  let selectionRectLayer = null;
  let cnnOpacity = 0.92;

  let map = null;
  let basemaps = {};
  let rasterOverlayLayer = null;
  let isRasterVisible = true;
  let cnnOverlayLayer = null;
  let isCnnVisible = true;
  let isMgrsVisible = false;
  let mgrsLayerGroup = null;
  let mbHighResGroup = null;
  let cnnHighResGroup = null;
  let mbManifestTiles = [];
  let cnnManifestTiles = [];
  let activeMbTileLayers = new Map();
  let activeCnnTileLayers = new Map();

  // Cache de imagens originais para filtragem dinâmica de classes por pixel (Canvas)
  const imageCache = new Map();
  let filterDebounceTimer = null;

  const CNN_BOUNDS = [[-18.562380, -52.338274], [-12.663281, -46.978250]];
  const BRAZIL_CENTER = [-15.5, -50.0];
  const BRAZIL_ZOOM = 5;

  let classesChart = null;
  let evi2Chart = null;

  // ──────────────────────────────────────────────────────────
  //  INICIALIZAÇÃO DO MAPA
  // ──────────────────────────────────────────────────────────
  function initMap() {
    const mapEl = document.getElementById('map-amostras');
    if (!mapEl) return;

    map = L.map('map-amostras', {
      center: [-15.6, -49.6],
      zoom: 7,
      zoomControl: true,
      preferCanvas: true
    });

    basemaps['satellite'] = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: '&copy; Esri, Maxar, Earthstar Geographics',
      maxZoom: 19
    }).addTo(map);

    basemaps['osm'] = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    });

    const RASTER_BOUNDS = [[-35.207379, -75.626648], [6.787221, -31.801924]];
    const rasterUrl = siteBase + '/assets/mapbiomas_coverage_overlay_2025.png';
    rasterOverlayLayer = L.imageOverlay(rasterUrl, RASTER_BOUNDS, {
      opacity: 0.85,
      interactive: false
    }).addTo(map);

    const cnnUrl = siteBase + '/assets/classificacao_cnn_overlay.png';
    cnnOverlayLayer = L.imageOverlay(cnnUrl, CNN_BOUNDS, {
      opacity: cnnOpacity,
      interactive: false
    }).addTo(map);
    cnnOverlayLayer._origSrc = cnnUrl;

    mbHighResGroup = L.layerGroup().addTo(map);
    cnnHighResGroup = L.layerGroup().addTo(map);
    mgrsLayerGroup = L.featureGroup();

    // Carregar manifestos de blocos de alta resolução (MapBiomas 75m e CNN 30m)
    fetch(siteBase + '/assets/mb_75m/manifest.json')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.tiles)) {
          mbManifestTiles = data.tiles;
          updateHighResOverlays();
        }
      })
      .catch(() => {});

    fetch(siteBase + '/assets/cnn_30m/manifest.json')
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data && Array.isArray(data.tiles)) {
          cnnManifestTiles = data.tiles;
          updateHighResOverlays();
        }
      })
      .catch(() => {});

    map.on('moveend zoomend', updateHighResOverlays);

    setupMapControls();
    setupFilterEvents();
    setupSelectionTool();
    loadCnnStats();
  }

  // ──────────────────────────────────────────────────────────
  //  FILTRAGEM VISUAL POR PIXEL DOS BLOCOS CNN (CANVAS)
  // ──────────────────────────────────────────────────────────
  function getFilteredImageUrl(origUrl, callback) {
    if (activeCodes.size === 9) {
      callback(origUrl);
      return;
    }

    function applyMask(img) {
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth || img.width;
      canvas.height = img.naturalHeight || img.height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imgData.data;

      // Verifica quais das 9 classes estão desmarcadas
      const inactiveRgbs = [];
      CNN_CLASSES.forEach(c => {
        if (!activeCodes.has(c.code)) {
          inactiveRgbs.push(c.rgb);
        }
      });

      const nInactive = inactiveRgbs.length;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i + 3] === 0) continue;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        for (let j = 0; j < nInactive; j++) {
          const ir = inactiveRgbs[j];
          if (Math.abs(r - ir[0]) <= 6 && Math.abs(g - ir[1]) <= 6 && Math.abs(b - ir[2]) <= 6) {
            d[i + 3] = 0;
            break;
          }
        }
      }
      ctx.putImageData(imgData, 0, 0);
      callback(canvas.toDataURL('image/png'));
    }

    if (imageCache.has(origUrl)) {
      applyMask(imageCache.get(origUrl));
    } else {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        imageCache.set(origUrl, img);
        applyMask(img);
      };
      img.onerror = function () {
        callback(origUrl);
      };
      img.src = origUrl;
    }
  }

  function refreshCnnLayerPixelFilter() {
    if (!map || !isCnnVisible) return;
    if (cnnOverlayLayer && cnnOverlayLayer._origSrc) {
      getFilteredImageUrl(cnnOverlayLayer._origSrc, (url) => {
        cnnOverlayLayer.setUrl(url);
      });
    }
    for (const [key, ov] of activeCnnTileLayers.entries()) {
      const origUrl = ov._origSrc || (siteBase + key);
      getFilteredImageUrl(origUrl, (url) => {
        ov.setUrl(url);
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  //  GERENCIADOR DINÂMICO DE BLOCOS DE ALTA RESOLUÇÃO
  // ──────────────────────────────────────────────────────────
  function updateHighResOverlays() {
    if (!map) return;
    const zoom = map.getZoom();
    const viewBounds = map.getBounds().pad(0.12);
    const yr = activeMbYear || '2025';

    // 1. MAPBIOMAS (75m em zoom >= 7 para 2025)
    const useMb75m = isRasterVisible && (yr === '2025') && (mbManifestTiles.length > 0) && (zoom >= 7);
    if (!isRasterVisible) {
      if (rasterOverlayLayer && map.hasLayer(rasterOverlayLayer)) map.removeLayer(rasterOverlayLayer);
      if (activeMbTileLayers.size > 0) {
        mbHighResGroup.clearLayers();
        activeMbTileLayers.clear();
      }
    } else if (useMb75m) {
      if (rasterOverlayLayer && map.hasLayer(rasterOverlayLayer)) map.removeLayer(rasterOverlayLayer);
      const neededKeys = new Set();
      mbManifestTiles.forEach(t => {
        const tb = L.latLngBounds(t.bounds);
        if (viewBounds.intersects(tb)) {
          const key = t.file;
          neededKeys.add(key);
          if (!activeMbTileLayers.has(key)) {
            const ov = L.imageOverlay(siteBase + t.file, t.bounds, { opacity: 0.85, interactive: false });
            mbHighResGroup.addLayer(ov);
            activeMbTileLayers.set(key, ov);
          }
        }
      });
      for (const [k, layer] of activeMbTileLayers.entries()) {
        if (!neededKeys.has(k)) {
          mbHighResGroup.removeLayer(layer);
          activeMbTileLayers.delete(k);
        }
      }
    } else {
      if (activeMbTileLayers.size > 0) {
        mbHighResGroup.clearLayers();
        activeMbTileLayers.clear();
      }
      if (rasterOverlayLayer && !map.hasLayer(rasterOverlayLayer)) map.addLayer(rasterOverlayLayer);
    }

    const mrlTitle = document.getElementById('mrl-title');
    if (mrlTitle) {
      mrlTitle.textContent = useMb75m ? `MapBiomas (${yr} · 75m Alta Res.)` : `MapBiomas 75m (${yr})`;
    }

    // 2. CLASSIFICAÇÃO TEMP_CNN (30m em zoom >= 7)
    const useCnn30m = isCnnVisible && (cnnManifestTiles.length > 0) && (zoom >= 7);
    if (!isCnnVisible) {
      if (cnnOverlayLayer && map.hasLayer(cnnOverlayLayer)) map.removeLayer(cnnOverlayLayer);
      if (activeCnnTileLayers.size > 0) {
        cnnHighResGroup.clearLayers();
        activeCnnTileLayers.clear();
      }
    } else if (useCnn30m) {
      if (cnnOverlayLayer && map.hasLayer(cnnOverlayLayer)) map.removeLayer(cnnOverlayLayer);
      const neededCnn = new Set();
      cnnManifestTiles.forEach(t => {
        const tb = L.latLngBounds(t.bounds);
        if (viewBounds.intersects(tb)) {
          const key = t.file;
          neededCnn.add(key);
          if (!activeCnnTileLayers.has(key)) {
            const origUrl = siteBase + t.file;
            const ov = L.imageOverlay(origUrl, t.bounds, { opacity: cnnOpacity, interactive: false });
            ov._origSrc = origUrl;
            cnnHighResGroup.addLayer(ov);
            activeCnnTileLayers.set(key, ov);
            if (activeCodes.size < 9) {
              getFilteredImageUrl(origUrl, (filteredUrl) => ov.setUrl(filteredUrl));
            }
          }
        }
      });
      for (const [k, layer] of activeCnnTileLayers.entries()) {
        if (!neededCnn.has(k)) {
          cnnHighResGroup.removeLayer(layer);
          activeCnnTileLayers.delete(k);
        }
      }
    } else {
      if (activeCnnTileLayers.size > 0) {
        cnnHighResGroup.clearLayers();
        activeCnnTileLayers.clear();
      }
      if (cnnOverlayLayer && !map.hasLayer(cnnOverlayLayer)) {
        map.addLayer(cnnOverlayLayer);
        if (activeCodes.size < 9 && cnnOverlayLayer._origSrc) {
          getFilteredImageUrl(cnnOverlayLayer._origSrc, (url) => cnnOverlayLayer.setUrl(url));
        }
      }
    }

    if (mgrsLayerGroup && isMgrsVisible) mgrsLayerGroup.bringToFront();
  }

  // ──────────────────────────────────────────────────────────
  //  CARREGAMENTO DAS ESTATÍSTICAS DA CLASSIFICAÇÃO TEMP_CNN
  // ──────────────────────────────────────────────────────────
  function loadCnnStats() {
    fetch(siteBase + '/assets/cnn_spatial_stats.json')
      .then(r => r.json())
      .then(data => {
        cnnStats = data;
        populateTileSelect();
        buildMgrsFootprints();
        buildFilterCheckboxes();
        initCharts();
        applyFiltersAndRender();
        updateEvi2ClassCard('ILP');
      })
      .catch(err => console.error('Erro ao carregar estatísticas da Classificação Temp_CNN:', err));
  }

  function populateTileSelect() {
    const sel = document.getElementById('tile-select');
    if (!sel || !cnnStats || !Array.isArray(cnnStats.tiles)) return;
    cnnStats.tiles.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.tile;
      opt.textContent = `Cena ${t.tile} (${Math.round(t.total_ha).toLocaleString('pt-BR')} ha)`;
      sel.appendChild(opt);
    });
  }

  function buildMgrsFootprints() {
    if (!mgrsLayerGroup || !cnnStats || !Array.isArray(cnnStats.tiles)) return;
    mgrsLayerGroup.clearLayers();
    cnnStats.tiles.forEach(t => {
      const rect = L.rectangle(t.bounds, {
        color: '#facc15',
        weight: 1.5,
        fillColor: '#facc15',
        fillOpacity: 0.04,
        dashArray: '4, 4'
      });
      rect.bindTooltip(`<strong>Cena S2: ${t.tile}</strong><br>Área Classificada: ${Math.round(t.total_ha).toLocaleString('pt-BR')} ha`, { sticky: true });
      rect.on('click', () => {
        const sel = document.getElementById('tile-select');
        if (sel) {
          sel.value = t.tile;
          activeTileId = t.tile;
          map.fitBounds(t.bounds, { padding: [20, 20] });
          applyFiltersAndRender();
        }
      });
      mgrsLayerGroup.addLayer(rect);
    });
  }

  // ──────────────────────────────────────────────────────────
  //  CONTROLES DO MAPA E EVENTOS DE FILTRO
  // ──────────────────────────────────────────────────────────
  function setupMapControls() {
    const focusCnnBtn = document.getElementById('map-focus-cnn');
    if (focusCnnBtn) {
      focusCnnBtn.addEventListener('click', () => {
        map.fitBounds(CNN_BOUNDS, { padding: [20, 20] });
      });
    }

    const resetBtn = document.getElementById('map-reset');
    if (resetBtn) {
      resetBtn.addEventListener('click', () => {
        map.setView(BRAZIL_CENTER, BRAZIL_ZOOM);
      });
    }

    const basemapSelect = document.getElementById('map-basemap-select');
    if (basemapSelect) {
      basemapSelect.addEventListener('change', (e) => {
        const selected = e.target.value;
        Object.keys(basemaps).forEach(k => map.removeLayer(basemaps[k]));
        if (basemaps[selected]) basemaps[selected].addTo(map);
        updateHighResOverlays();
      });
    }

    const btnToggleRaster = document.getElementById('btn-toggle-raster');
    if (btnToggleRaster) {
      btnToggleRaster.addEventListener('click', () => {
        isRasterVisible = !isRasterVisible;
        const mrl = document.getElementById('map-raster-legend');
        if (isRasterVisible) {
          btnToggleRaster.classList.add('active');
          btnToggleRaster.style.background = 'rgba(45, 106, 63, 0.9)';
          btnToggleRaster.style.color = '#fff';
          if (mrl) mrl.style.display = 'block';
        } else {
          btnToggleRaster.classList.remove('active');
          btnToggleRaster.style.background = 'rgba(255, 255, 255, 0.9)';
          btnToggleRaster.style.color = 'var(--color-fg)';
          if (mrl) mrl.style.display = 'none';
        }
        updateHighResOverlays();
      });
    }

    const btnToggleCnn = document.getElementById('btn-toggle-cnn');
    const cnnLegend = document.getElementById('map-cnn-legend');
    if (btnToggleCnn) {
      btnToggleCnn.addEventListener('click', () => {
        isCnnVisible = !isCnnVisible;
        if (isCnnVisible) {
          btnToggleCnn.classList.add('active');
          btnToggleCnn.style.background = 'rgba(60, 77, 10, 0.95)';
          btnToggleCnn.style.color = '#fff';
          if (cnnLegend) cnnLegend.style.display = 'block';
        } else {
          btnToggleCnn.classList.remove('active');
          btnToggleCnn.style.background = 'rgba(255, 255, 255, 0.9)';
          btnToggleCnn.style.color = 'var(--color-fg)';
          if (cnnLegend) cnnLegend.style.display = 'none';
        }
        updateHighResOverlays();
      });
    }

    const btnToggleMgrs = document.getElementById('btn-toggle-mgrs');
    if (btnToggleMgrs) {
      btnToggleMgrs.addEventListener('click', () => {
        isMgrsVisible = !isMgrsVisible;
        if (isMgrsVisible) {
          btnToggleMgrs.classList.add('active');
          btnToggleMgrs.style.background = '#1e293b';
          btnToggleMgrs.style.color = '#fff';
          if (mgrsLayerGroup) mgrsLayerGroup.addTo(map);
        } else {
          btnToggleMgrs.classList.remove('active');
          btnToggleMgrs.style.background = 'rgba(255, 255, 255, 0.9)';
          btnToggleMgrs.style.color = 'var(--color-fg)';
          if (mgrsLayerGroup && map.hasLayer(mgrsLayerGroup)) map.removeLayer(mgrsLayerGroup);
        }
      });
    }

    const btnDownload = document.getElementById('btn-download-filtered-csv');
    if (btnDownload) {
      btnDownload.addEventListener('click', exportCnnStatsCSV);
    }
  }

  function buildFilterCheckboxes() {
    const list = document.getElementById('filter-list');
    if (!list) return;
    list.innerHTML = '';

    CNN_CLASSES.forEach(cls => {
      const li = document.createElement('li');
      li.className = 'filter-list__item';
      li.innerHTML = `
        <label class="filter-checkbox-label">
          <input type="checkbox" class="class-checkbox" value="${cls.code}" checked>
          <span class="filter-swatch" style="background-color: ${cls.color};"></span>
          <span class="filter-name">${cls.label}</span>
          <span class="filter-count" id="count-cls-${cls.code}">0 ha</span>
        </label>
      `;
      list.appendChild(li);
    });

    list.querySelectorAll('.class-checkbox').forEach(cb => {
      cb.addEventListener('change', () => {
        const code = parseInt(cb.value, 10);
        if (cb.checked) activeCodes.add(code);
        else activeCodes.delete(code);
        syncToggleAllBtn();
        applyFiltersAndRender();
      });
    });
  }

  function syncToggleAllBtn() {
    const btn = document.getElementById('btn-toggle-all');
    if (!btn) return;
    btn.textContent = (activeCodes.size === CNN_CLASSES.length) ? 'Desmarcar Todos' : 'Marcar Todos';
  }

  function setupFilterEvents() {
    // Accordions do painel de filtro
    document.querySelectorAll('.filter-item__header').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const parent = hdr.closest('.filter-item');
        if (parent) parent.classList.toggle('open');
      });
    });

    // Botões de Macrogrupo
    document.querySelectorAll('[data-macro]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-macro]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const macro = btn.getAttribute('data-macro');
        const codes = MACRO_GROUPS[macro] || MACRO_GROUPS['all'];
        activeCodes = new Set(codes);
        document.querySelectorAll('.class-checkbox').forEach(cb => {
          cb.checked = activeCodes.has(parseInt(cb.value, 10));
        });
        syncToggleAllBtn();
        applyFiltersAndRender();
      });
    });

    // Seletor de Cena MGRS
    const tileSelect = document.getElementById('tile-select');
    if (tileSelect) {
      tileSelect.addEventListener('change', () => {
        activeTileId = tileSelect.value;
        if (activeTileId !== 'all' && cnnStats && Array.isArray(cnnStats.tiles)) {
          const tObj = cnnStats.tiles.find(t => t.tile === activeTileId);
          if (tObj && map) map.fitBounds(tObj.bounds, { padding: [20, 20] });
        } else if (map) {
          map.fitBounds(CNN_BOUNDS, { padding: [20, 20] });
        }
        applyFiltersAndRender();
      });
    }

    // Controle de Opacidade da Classificação Temp_CNN
    const opRange = document.getElementById('cnn-opacity-range');
    const opVal = document.getElementById('cnn-opacity-val');
    if (opRange) {
      opRange.addEventListener('input', () => {
        cnnOpacity = parseInt(opRange.value, 10) / 100.0;
        if (opVal) opVal.textContent = `${opRange.value}%`;
        if (cnnOverlayLayer) cnnOverlayLayer.setOpacity(cnnOpacity);
        for (const [, ov] of activeCnnTileLayers.entries()) {
          ov.setOpacity(cnnOpacity);
        }
      });
    }

    // Marcar / Desmarcar todas as classes
    const btnToggleAll = document.getElementById('btn-toggle-all');
    if (btnToggleAll) {
      btnToggleAll.addEventListener('click', () => {
        const markAll = activeCodes.size < CNN_CLASSES.length;
        activeCodes = markAll ? new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]) : new Set();
        document.querySelectorAll('.class-checkbox').forEach(cb => { cb.checked = markAll; });
        syncToggleAllBtn();
        applyFiltersAndRender();
      });
    }

    // Chips do Ano MapBiomas de Fundo
    document.querySelectorAll('.mb-year-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.mb-year-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        activeMbYear = chip.getAttribute('data-mbyear') || '2025';
        const newUrl = siteBase + '/assets/mapbiomas_coverage_overlay_' + activeMbYear + '.png';
        if (rasterOverlayLayer) rasterOverlayLayer.setUrl(newUrl);
        const btn = document.getElementById('btn-toggle-raster');
        if (btn) btn.textContent = `Raster MapBiomas 75m (${activeMbYear})`;
        updateHighResOverlays();
      });
    });

    // Seletor de Classe para a Curva Fenológica de EVI2
    const evi2Select = document.getElementById('evi2-class-select');
    if (evi2Select) {
      evi2Select.addEventListener('change', () => {
        updateEvi2ClassCard(evi2Select.value);
      });
    }

    // Botão Limpar Filtros
    const btnClear = document.getElementById('btn-clear-filters');
    if (btnClear) {
      btnClear.addEventListener('click', () => {
        activeCodes = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]);
        activeTileId = 'all';
        selectionBounds = null;
        if (selectionRectLayer && map) {
          map.removeLayer(selectionRectLayer);
          selectionRectLayer = null;
        }
        const btnClearRect = document.getElementById('btn-clear-rect');
        if (btnClearRect) btnClearRect.style.display = 'none';
        if (tileSelect) tileSelect.value = 'all';
        document.querySelectorAll('[data-macro]').forEach(b => b.classList.toggle('active', b.getAttribute('data-macro') === 'all'));
        document.querySelectorAll('.class-checkbox').forEach(cb => { cb.checked = true; });
        syncToggleAllBtn();
        applyFiltersAndRender();
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SELEÇÃO ESPACIAL EM CAIXA SOBRE A CLASSIFICAÇÃO TEMP_CNN
  // ──────────────────────────────────────────────────────────
  function setupSelectionTool() {
    const btnDraw = document.getElementById('btn-draw-rect');
    const btnClear = document.getElementById('btn-clear-rect');
    const hint = document.getElementById('map-selection-hint');
    if (!btnDraw || !map) return;

    let startLatLng = null;
    let tempRect = null;

    function cancelDrawing() {
      isDrawingRect = false;
      btnDraw.classList.remove('active');
      btnDraw.style.background = '';
      btnDraw.style.color = '';
      if (hint) hint.style.display = 'none';
      map.getContainer().style.cursor = '';
      map.dragging.enable();
      startLatLng = null;
      if (tempRect) {
        map.removeLayer(tempRect);
        tempRect = null;
      }
    }

    btnDraw.addEventListener('click', () => {
      isDrawingRect = !isDrawingRect;
      if (isDrawingRect) {
        btnDraw.classList.add('active');
        btnDraw.style.background = 'var(--color-accent)';
        btnDraw.style.color = '#fff';
        if (hint) hint.style.display = 'block';
        map.getContainer().style.cursor = 'crosshair';
        map.dragging.disable();
      } else {
        cancelDrawing();
      }
    });

    map.on('mousedown', (e) => {
      if (!isDrawingRect) return;
      startLatLng = e.latlng;
      if (tempRect) map.removeLayer(tempRect);
      tempRect = L.rectangle([startLatLng, startLatLng], {
        color: '#2d6a3f',
        weight: 2,
        dashArray: '4, 4',
        fillColor: '#2d6a3f',
        fillOpacity: 0.15
      }).addTo(map);
    });

    map.on('mousemove', (e) => {
      if (!isDrawingRect || !startLatLng || !tempRect) return;
      tempRect.setBounds(L.latLngBounds(startLatLng, e.latlng));
    });

    map.on('mouseup', (e) => {
      if (!isDrawingRect || !startLatLng) return;
      const bounds = L.latLngBounds(startLatLng, e.latlng);
      if (Math.abs(startLatLng.lat - e.latlng.lat) > 0.01 && Math.abs(startLatLng.lng - e.latlng.lng) > 0.01) {
        if (selectionRectLayer) map.removeLayer(selectionRectLayer);
        selectionRectLayer = L.rectangle(bounds, {
          color: '#18362d',
          weight: 2.5,
          fillColor: '#22c55e',
          fillOpacity: 0.12
        }).addTo(map);
        selectionBounds = bounds;
        if (btnClear) btnClear.style.display = 'inline-block';
        applyFiltersAndRender();
      }
      cancelDrawing();
    });

    if (btnClear) {
      btnClear.addEventListener('click', () => {
        if (selectionRectLayer) {
          map.removeLayer(selectionRectLayer);
          selectionRectLayer = null;
        }
        selectionBounds = null;
        btnClear.style.display = 'none';
        applyFiltersAndRender();
      });
    }
  }

  // ──────────────────────────────────────────────────────────
  //  CÁLCULO DINÂMICO DE ÁREAS E ATUALIZAÇÃO DE GRÁFICOS/TABELAS
  // ──────────────────────────────────────────────────────────
  function computeFilteredStats() {
    const classPixels = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
    const classHa = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
    const activeTilesMap = new Map();

    if (!cnnStats) return { classPixels, classHa, activeTiles: [] };

    cnnStats.grid_cells.forEach(cell => {
      if (activeTileId !== 'all' && cell.tile !== activeTileId) return;
      if (selectionBounds) {
        const cb = L.latLngBounds(cell.bounds);
        if (!selectionBounds.intersects(cb)) return;
      }

      let tileEntry = activeTilesMap.get(cell.tile);
      if (!tileEntry) {
        tileEntry = { tile: cell.tile, countsHa: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 }, totalHa: 0 };
        activeTilesMap.set(cell.tile, tileEntry);
      }

      const pxHa = cell.px_ha || 0.0095;
      for (const [kStr, pxCount] of Object.entries(cell.counts)) {
        const code = parseInt(kStr, 10);
        const ha = pxCount * pxHa;
        // Guardamos nas estatísticas por classe do recorte espacial (mesmo para classes desmarcadas mostrarem no contador lateral, mas somamos só as ativas no total visível)
        classPixels[code] += pxCount;
        classHa[code] += ha;
        if (activeCodes.has(code)) {
          tileEntry.countsHa[code] += ha;
          tileEntry.totalHa += ha;
        }
      }
    });

    const activeTiles = Array.from(activeTilesMap.values()).filter(t => t.totalHa > 0);
    activeTiles.sort((a, b) => b.totalHa - a.totalHa);
    return { classPixels, classHa, activeTiles };
  }

  function applyFiltersAndRender() {
    if (!cnnStats) return;
    const { classPixels, classHa, activeTiles } = computeFilteredStats();

    let visibleHa = 0;
    let visiblePx = 0;
    let integratedHa = 0;

    CNN_CLASSES.forEach(cls => {
      const ha = classHa[cls.code] || 0;
      const countEl = document.getElementById(`count-cls-${cls.code}`);
      if (countEl) {
        countEl.textContent = `${Math.round(ha).toLocaleString('pt-BR')} ha`;
      }
      if (activeCodes.has(cls.code)) {
        visibleHa += ha;
        visiblePx += (classPixels[cls.code] || 0);
        if (cls.integrated) integratedHa += ha;
      }
    });

    const intPct = visibleHa > 0 ? ((integratedHa / visibleHa) * 100).toFixed(2) : '0.00';

    // Atualizar Card Principal
    const counterNum = document.getElementById('counter-number');
    const counterSub = document.getElementById('counter-sub');
    if (counterNum) counterNum.textContent = `${Math.round(visibleHa).toLocaleString('pt-BR')} ha`;
    if (counterSub) {
      counterSub.textContent = `${Math.round(integratedHa).toLocaleString('pt-BR')} ha em Sistemas Integrados (${intPct.replace('.', ',')}%) · ${activeTiles.length} cenas S2`;
    }

    // Atualizar Badge de Filtros Ativos
    const badge = document.getElementById('active-filters-count');
    if (badge) {
      const parts = [`${activeCodes.size}/9 classes`];
      if (activeTileId !== 'all') parts.push(activeTileId);
      if (selectionBounds) parts.push('Caixa');
      badge.textContent = parts.join(' · ');
    }

    const totalFilteredEl = document.getElementById('total-filtered-count');
    if (totalFilteredEl) {
      totalFilteredEl.textContent = `${activeTiles.length} cenas · ${activeCodes.size} classes (${Math.round(visibleHa).toLocaleString('pt-BR')} ha)`;
    }

    updateClassesChart(classHa, visibleHa);
    updateClassSummaryTable(classPixels, classHa, visibleHa, visiblePx);
    updateTilesTable(activeTiles);

    // Atualiza o filtro visual nos pixels da camada Temp_CNN no mapa (com debounce leve)
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(refreshCnnLayerPixelFilter, 60);
  }

  // ──────────────────────────────────────────────────────────
  //  GRÁFICOS CHART.JS (DISTRIBUIÇÃO DE ÁREA & CURVA EVI2)
  // ──────────────────────────────────────────────────────────
  function initCharts() {
    const ctxClasses = document.getElementById('chart-classes');
    if (ctxClasses && window.Chart) {
      classesChart = new Chart(ctxClasses, {
        type: 'bar',
        data: { labels: [], datasets: [{ data: [], backgroundColor: [], borderRadius: 4 }] },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx) => `${Math.round(ctx.raw).toLocaleString('pt-BR')} ha`
              }
            }
          },
          scales: {
            x: {
              ticks: {
                font: { size: 10 },
                callback: (v) => v >= 1000 ? `${(v / 1000).toFixed(0)}k ha` : `${v} ha`
              }
            },
            y: { ticks: { font: { size: 11, weight: '600' } } }
          },
          onClick: (evt, elements) => {
            if (elements && elements.length > 0) {
              const idx = elements[0].index;
              const activeList = CNN_CLASSES.filter(c => activeCodes.has(c.code));
              if (activeList[idx]) {
                const sel = document.getElementById('evi2-class-select');
                if (sel) sel.value = activeList[idx].key;
                updateEvi2ClassCard(activeList[idx].key);
              }
            }
          }
        }
      });
    }

    const ctxEvi2 = document.getElementById('chart-evi2');
    if (ctxEvi2 && window.Chart) {
      evi2Chart = new Chart(ctxEvi2, {
        type: 'line',
        data: {
          labels: MONTHS_LABELS,
          datasets: [
            {
              label: 'Mediana Mensal EVI2',
              data: [],
              borderColor: '#18362d',
              backgroundColor: 'rgba(24, 54, 45, 0.14)',
              borderWidth: 2.5,
              pointRadius: 3,
              fill: true,
              tension: 0.3
            },
            {
              label: 'Média da Mediana (x̄)',
              data: [],
              borderColor: '#f59e0b',
              borderDash: [5, 4],
              borderWidth: 1.8,
              pointRadius: 0,
              fill: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: true, labels: { boxWidth: 12, font: { size: 10 } } }
          },
          scales: {
            y: { min: 0.05, max: 0.68, ticks: { font: { size: 10 } } },
            x: { ticks: { font: { size: 10 } } }
          }
        }
      });
    }
  }

  function updateClassesChart(classHa, visibleHa) {
    if (!classesChart) return;
    const activeList = CNN_CLASSES.filter(c => activeCodes.has(c.code));
    classesChart.data.labels = activeList.map(c => c.label);
    classesChart.data.datasets[0].data = activeList.map(c => Math.round(classHa[c.code] || 0));
    classesChart.data.datasets[0].backgroundColor = activeList.map(c => c.color);
    classesChart.update();
  }

  function updateEvi2ClassCard(classKey) {
    if (!cnnStats || !cnnStats.evi2_class_curves) return;
    const curveObj = cnnStats.evi2_class_curves[classKey];
    const clsMeta = CLASS_BY_KEY[classKey] || CNN_CLASSES[0];
    if (!curveObj) return;

    const vals = curveObj.median || [];
    const maxVal = Math.max(...vals);
    const minVal = Math.min(...vals);
    const maxIdx = vals.indexOf(maxVal);
    const minIdx = vals.indexOf(minVal);

    const elMean = document.getElementById('evi2-stat-mean');
    const elAmp = document.getElementById('evi2-stat-amp');
    const elMax = document.getElementById('evi2-stat-max');
    const elMaxM = document.getElementById('evi2-stat-max-month');
    const elMin = document.getElementById('evi2-stat-min');
    const elMinM = document.getElementById('evi2-stat-min-month');

    if (elMean) elMean.textContent = curveObj.mean.toFixed(3).replace('.', ',');
    if (elAmp) elAmp.textContent = curveObj.amp.toFixed(3).replace('.', ',');
    if (elMax) elMax.textContent = maxVal.toFixed(3).replace('.', ',');
    if (elMaxM) elMaxM.textContent = MONTHS_LABELS[maxIdx] || 'Ápice';
    if (elMin) elMin.textContent = minVal.toFixed(3).replace('.', ',');
    if (elMinM) elMinM.textContent = MONTHS_LABELS[minIdx] || 'Seca';

    if (evi2Chart) {
      evi2Chart.data.datasets[0].label = `Mediana EVI2 (${clsMeta.label})`;
      evi2Chart.data.datasets[0].data = vals;
      evi2Chart.data.datasets[0].borderColor = clsMeta.color === '#eddc4b' ? '#ca8a04' : clsMeta.color;
      evi2Chart.data.datasets[0].backgroundColor = 'rgba(45, 106, 63, 0.12)';
      evi2Chart.data.datasets[1].data = vals.map(() => curveObj.mean);
      evi2Chart.update();
    }
  }

  // ──────────────────────────────────────────────────────────
  //  TABELAS SÍNTESE (POR CLASSE E POR CENA MGRS) + EXPORTAÇÃO CSV
  // ──────────────────────────────────────────────────────────
  function updateClassSummaryTable(classPixels, classHa, visibleHa, visiblePx) {
    const tbody = document.getElementById('class-summary-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    CNN_CLASSES.forEach(cls => {
      if (!activeCodes.has(cls.code)) return;
      const px = classPixels[cls.code] || 0;
      const ha = classHa[cls.code] || 0;
      const pct = visibleHa > 0 ? ((ha / visibleHa) * 100).toFixed(2).replace('.', ',') : '0,00';
      const evi = (cnnStats && cnnStats.evi2_class_curves && cnnStats.evi2_class_curves[cls.key]) || { mean: 0, amp: 0 };

      const tr = document.createElement('tr');
      tr.style.cursor = 'pointer';
      tr.title = 'Clique para visualizar a curva de Mediana Mensal do EVI2 desta classe';
      tr.innerHTML = `
        <td><strong>${cls.code}</strong></td>
        <td>
          <span style="display:inline-block;width:11px;height:11px;border-radius:3px;background:${cls.color};margin-right:6px;vertical-align:middle;border:1px solid rgba(0,0,0,0.15);"></span>
          <strong>${cls.key}</strong>
        </td>
        <td>${cls.group}</td>
        <td style="text-align:right;">${px.toLocaleString('pt-BR')}</td>
        <td style="text-align:right;"><strong>${Math.round(ha).toLocaleString('pt-BR')} ha</strong></td>
        <td style="text-align:right;">${pct}%</td>
        <td style="text-align:right;">${evi.mean.toFixed(3).replace('.', ',')}</td>
        <td style="text-align:right;">${evi.amp.toFixed(3).replace('.', ',')}</td>
      `;
      tr.addEventListener('click', () => {
        const sel = document.getElementById('evi2-class-select');
        if (sel) sel.value = cls.key;
        updateEvi2ClassCard(cls.key);
      });
      tbody.appendChild(tr);
    });

    const totalTr = document.createElement('tr');
    totalTr.style.background = '#f0fdf4';
    totalTr.style.fontWeight = '700';
    totalTr.innerHTML = `
      <td>—</td>
      <td><strong>Total Visível (Temp_CNN)</strong></td>
      <td>${activeCodes.size} classes ativas</td>
      <td style="text-align:right;"><strong>${visiblePx.toLocaleString('pt-BR')}</strong></td>
      <td style="text-align:right;"><strong>${Math.round(visibleHa).toLocaleString('pt-BR')} ha</strong></td>
      <td style="text-align:right;"><strong>100,00%</strong></td>
      <td style="text-align:right;">—</td>
      <td style="text-align:right;">—</td>
    `;
    tbody.appendChild(totalTr);
  }

  function updateTilesTable(activeTiles) {
    const tbody = document.getElementById('overlap-tbody');
    const countEl = document.getElementById('table-count');
    if (countEl) countEl.textContent = String(activeTiles.length);
    if (!tbody) return;
    tbody.innerHTML = '';

    activeTiles.forEach(t => {
      const c = t.countsHa;
      const intHa = (c[3] || 0) + (c[4] || 0) + (c[5] || 0) + (c[6] || 0) + (c[7] || 0);
      const otherArb = (c[6] || 0) + (c[7] || 0) + (c[9] || 0);
      const intPct = t.totalHa > 0 ? ((intHa / t.totalHa) * 100).toFixed(1).replace('.', ',') : '0,0';

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${t.tile}</strong></td>
        <td style="text-align:right;"><strong>${Math.round(t.totalHa).toLocaleString('pt-BR')}</strong></td>
        <td style="text-align:right;">${Math.round(c[1] || 0).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;">${Math.round(c[4] || 0).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;">${Math.round(c[2] || 0).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;">${Math.round(c[5] || 0).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;">${Math.round(c[3] || 0).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;">${Math.round(otherArb).toLocaleString('pt-BR')}</td>
        <td style="text-align:right;"><strong>${intPct}%</strong></td>
        <td><button type="button" class="btn-zoom-feature" data-tile="${t.tile}" style="padding:3px 8px;font-size:0.72rem;border-radius:4px;border:1px solid #cbd5e1;background:#f8fafc;cursor:pointer;font-weight:600;">Focar Cena</button></td>
      `;
      const btn = tr.querySelector('[data-tile]');
      if (btn) {
        btn.addEventListener('click', () => {
          const tileObj = cnnStats.tiles.find(x => x.tile === t.tile);
          if (tileObj && map) {
            map.fitBounds(tileObj.bounds, { padding: [20, 20] });
          }
        });
      }
      tbody.appendChild(tr);
    });
  }

  function exportCnnStatsCSV() {
    if (!cnnStats) return;
    const { classPixels, classHa } = computeFilteredStats();
    let visibleHa = 0;
    CNN_CLASSES.forEach(c => {
      if (activeCodes.has(c.code)) visibleHa += (classHa[c.code] || 0);
    });

    const rows = [
      ['Codigo_Classe', 'Classe_Temp_CNN', 'Grupo_Fenologico', 'Pixels_Classificados', 'Area_Mapeada_ha', 'Participacao_Pct', 'Media_Mediana_EVI2', 'Amplitude_EVI2'].join(',')
    ];

    CNN_CLASSES.forEach(cls => {
      if (!activeCodes.has(cls.code)) return;
      const px = classPixels[cls.code] || 0;
      const ha = classHa[cls.code] || 0;
      const pct = visibleHa > 0 ? ((ha / visibleHa) * 100).toFixed(2) : '0.00';
      const evi = (cnnStats.evi2_class_curves && cnnStats.evi2_class_curves[cls.key]) || { mean: 0, amp: 0 };
      rows.push([
        cls.code,
        `"${cls.key}"`,
        `"${cls.group}"`,
        px,
        ha.toFixed(1),
        pct,
        evi.mean.toFixed(4),
        evi.amp.toFixed(4)
      ].join(','));
    });

    const csvContent = '\uFEFF' + rows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `estatisticas_classificacao_temp_cnn_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ──────────────────────────────────────────────────────────
  //  METODOLOGIA — ACCORDION TOGGLES (PADRÃO WRI/LAPIG)
  // ──────────────────────────────────────────────────────────
  function initMethodFlow() {
    const root = document.getElementById('method-flow');
    if (!root) return;

    const nodes = Array.from(root.querySelectorAll('.fnode'));

    function setOpen(node, open) {
      node.classList.toggle('is-open', open);
      const btn = node.querySelector('.fnode__toggle');
      const panel = node.querySelector('.fnode__panel');
      if (btn) btn.setAttribute('aria-expanded', String(open));
      if (panel) panel.setAttribute('aria-hidden', String(!open));
    }

    nodes.forEach(node => {
      setOpen(node, node.classList.contains('is-open'));
      const btn = node.querySelector('.fnode__toggle');
      if (btn) {
        btn.addEventListener('click', () => setOpen(node, !node.classList.contains('is-open')));
      }
    });

    const expandAll = document.getElementById('flow-expand-all') || document.getElementById('method-expand-all');
    const collapseAll = document.getElementById('flow-collapse-all') || document.getElementById('method-collapse-all');
    if (expandAll) expandAll.addEventListener('click', () => nodes.forEach(n => setOpen(n, true)));
    if (collapseAll) collapseAll.addEventListener('click', () => nodes.forEach(n => setOpen(n, false)));

    const hash = window.location.hash.slice(1);
    if (hash) {
      const target = nodes.find(n => n.id === hash);
      if (target) {
        setOpen(target, true);
        setTimeout(() => target.scrollIntoView({ behavior: 'smooth', block: 'center' }), 300);
      }
    }
  }

  // ──────────────────────────────────────────────────────────
  //  SCROLL REVEAL
  // ──────────────────────────────────────────────────────────
  function initScrollEffects() {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

    document.querySelectorAll('.reveal').forEach(el => observer.observe(el));
  }

  document.addEventListener('DOMContentLoaded', () => {
    initMap();
    initMethodFlow();
    initScrollEffects();
  });

})();
