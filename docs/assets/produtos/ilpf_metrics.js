// =========================================================================================
// 1. CONFIGURAÇÕES E VARIÁVEIS DE TEMPO / FILTROS
// =========================================================================================
// NOTA: Bandas de latitude e longitude foram removidas da exportação.
// O cubo raster exportado contém 230 bandas (232 originais - 2 coordenadas).
//
// CONVERSÃO FLOAT → INT16 (multiplicação por 100):
// As bandas são tratadas em dois grupos para a conversão:
//
// BANDAS MULTIPLICADAS POR 100 (índices espectrais, derivadas e embeddings - 139 bandas):
//   - ndvi_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - ndwi_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - cai_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - cri1_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - ari1_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - rgr_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - psri_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - satvi_wet_*   (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
//   - ndvi_wet_stdDev_3x3, ndvi_wet_median_3x3                          = 2 bandas
//   - slope                                                              = 1 banda
//   - embedding_* (64 bandas do Satellite Embedding V1 Annual)           = 64 bandas
//   Subtotal: 72 + 2 + 1 + 64 = 139 bandas
//
// BANDAS NÃO MULTIPLICADAS (reflectância S2 já em escala inteira + elevação - 91 bandas):
//   - blue_wet_*      (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - green_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - red_wet_*       (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - rededge1_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - rededge2_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - rededge3_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - nir_wet_*       (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - rededge4_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - swir1_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - swir2_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
//   - elevation                                                           = 1 banda
//   Subtotal: 90 + 1 = 91 bandas
//
// TOTAL EXPORTADO: 139 + 91 = 230 bandas (Int16)
// =========================================================================================

var CONFIG = {
    ano_base: 2025,

    // Configuração de lote de grids para exportação.
    // Ajuste grid_inicio e grid_fim para controlar o lote a ser exportado.
    // Para teste inicial, use grid_inicio: 1, grid_fim: 1 (apenas 1 grid).
    // Para produção, aumente o range (ex: grid_inicio: 1, grid_fim: 500).
    // O asset grade_br possui grids de 1 a 18340.
    grid_inicio: 1,
    grid_fim: 1,

    // Fator de multiplicação float → int (100 = 2 casas decimais)
    fator_escala: 100,

    // Pasta de destino no Google Drive
    pasta_drive: 'metricas_ilpf',

    // Filtros de Nuvem
    max_nuvens_imagem: 80,
    limiar_cloud_score: 0.50
};

// Janela temporal derivada do ano base (~1 ano antes a ~1 ano depois)
CONFIG.data_inicio = ee.Date((CONFIG.ano_base - 1) + '-07-01');
CONFIG.data_fim = ee.Date((CONFIG.ano_base + 1) + '-06-30');

// =========================================================================================
// 2. FONTES DE DADOS E DEFINIÇÃO DA ÁREA DE INTERESSE (ROI)
// =========================================================================================
var col_S2 = ee.ImageCollection("COPERNICUS/S2_HARMONIZED");
var col_CS_PLUS = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED');
var terrain = ee.Algorithms.Terrain(ee.Image("NASA/NASADEM_HGT/001"));

// Coleção Anual de Embeddings
var col_embeddings = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL');

// Geometria do Brasil para filtragem das coleções
var AMOSTRAS = ee.FeatureCollection('projects/ee-vieiramesquita/assets/BR_UF_2022');
var ROI = AMOSTRAS.geometry().bounds();

// Grade de exportação (18.340 grids de 0.2° x 0.2° cobrindo o Brasil)
var GRADE_BR = ee.FeatureCollection('projects/guilhermevaz/assets/utils/grid_br');

// =========================================================================================
// 3. DEFINIÇÃO DE MÉTRICAS E ÍNDICES ESPECTRAIS
// =========================================================================================
var indexes = {
    'CAI': "(b('B12') / b('B11'))",
    'NDVI': "(b('B8') - b('B4')) / (b('B8') + b('B4'))",
    'NDWI': "(b('B8') - b('B11')) / (b('B8') + b('B11'))",
    'CRI1': "1/(b('B2')) - 1/(b('B3'))",
    'ARI_1': "(1/b('B3') - 1/b('B5'))*1000",
    'RGR': "b('B4')/b('B3')",
    'PSRI': "(b('B4') - b('B2') )/(b('B6'))",
    'SATVI': "((b('B11') - b('B4'))/(b('B11') + b('B4') + 0.5))*(1*0.5)-(b('B12')/2)*0.0001"
};

var BandsWet = ['blue_wet', 'green_wet', 'red_wet', 'rededge1_wet', 'rededge2_wet', 'rededge3_wet',
    'nir_wet', 'rededge4_wet', 'swir1_wet', 'swir2_wet', 'ndvi_wet', 'ndwi_wet', 'cai_wet',
    'cri1_wet', 'ari1_wet', 'rgr_wet', 'psri_wet', 'satvi_wet'];

var BandsWetAmp = ['blue_wet_amp', 'green_wet_amp', 'red_wet_amp', 'rededge1_wet_amp',
    'rededge2_wet_amp', 'rededge3_wet_amp', 'nir_wet_amp', 'rededge4_wet_amp', 'swir1_wet_amp', 'swir2_wet_amp',
    'ndvi_wet_amp', 'ndwi_wet_amp', 'cai_wet_amp', 'cri1_wet_amp', 'ari1_wet_amp', 'rgr_wet_amp',
    'psri_wet_amp', 'satvi_wet_amp'];

// Prefixos de bandas de reflectância S2 (já em escala inteira, NÃO multiplicar por fator_escala)
var PREFIXOS_REFLECTANCIA = ['blue_wet', 'green_wet', 'red_wet', 'rededge1_wet',
    'rededge2_wet', 'rededge3_wet', 'nir_wet', 'rededge4_wet', 'swir1_wet', 'swir2_wet'];

// Sufixos das reduções temporais
var SUFIXOS_TEMPORAIS = ['_min', '_max', '_median', '_stdDev', '_amp', '_p10', '_p25', '_p75', '_p90'];

// =========================================================================================
// 4. FUNÇÕES DE PROCESSAMENTO
// =========================================================================================

function spectralFeatures(image) {
    var ndvi = image.expression(indexes["NDVI"]).select([0], ['NDVI']);
    var ndwi = image.expression(indexes["NDWI"]).select([0], ['NDWI']);
    var cai = image.expression(indexes["CAI"]).select([0], ['CAI']);
    var cri1 = image.expression(indexes["CRI1"]).select([0], ['CRI1']);
    var ari1 = image.expression(indexes["ARI_1"]).select([0], ['ARI_1']);
    var rgr = image.expression(indexes["RGR"]).select([0], ['RGR']);
    var psri = image.expression(indexes["PSRI"]).select([0], ['PSRI']);
    var satvi = image.expression(indexes["SATVI"]).select([0], ['SATVI']);
    return image.addBands([ndvi, ndwi, cai, cri1, ari1, rgr, psri, satvi]);
}

function temporalFeatures(image) {
    var min = image.reduce(ee.Reducer.min());
    var max = image.reduce(ee.Reducer.max());
    var median = image.reduce(ee.Reducer.median());
    var stdv = image.reduce(ee.Reducer.stdDev());
    var amp = max.subtract(min).rename(BandsWetAmp);

    return ee.Image().select().addBands([min, max, median, amp, stdv]);
}

function temporalPercs(image) {
    var percs = image.reduce(ee.Reducer.percentile([10, 25, 75, 90]));
    return ee.Image().select().addBands([percs]);
}

function maskClouds(img) {
    var mask = img.select('cs').gte(CONFIG.limiar_cloud_score);
    return img.updateMask(mask);
}

function res_bilinear(img) {
    var bands = img.select('B5', 'B6', 'B7', 'B8A', 'B11', 'B12');
    return img.resample('bilinear').reproject({
        'crs': bands.projection().crs(),
        'scale': img.select('B8').projection().nominalScale()
    });
}

function maskEdges(s2_img) {
    return s2_img.updateMask(s2_img.select('B8A').mask().updateMask(s2_img.select('B9').mask()));
}

function radians(img) {
    return img.toFloat().multiply(Math.PI).divide(180);
}

var elevation = terrain.select('elevation');
var slope = (radians(terrain.select('slope'))).expression('b("slope")*100');

// =========================================================================================
// 5. CONSTRUÇÃO DA LISTA DE BANDAS POR TIPO DE ESCALA
// =========================================================================================

// Monta a lista de bandas de reflectância (NÃO multiplicar) + elevation
function construirListaBandasSemMultiplicar() {
    var lista = [];
    for (var p = 0; p < PREFIXOS_REFLECTANCIA.length; p++) {
        for (var s = 0; s < SUFIXOS_TEMPORAIS.length; s++) {
            lista.push(PREFIXOS_REFLECTANCIA[p] + SUFIXOS_TEMPORAIS[s]);
        }
    }
    lista.push('elevation');
    return lista;
}

// =========================================================================================
// 6. PROCESSAMENTO E CONSTRUÇÃO DO RASTER MULTIBANDA (CUBO DE DADOS)
// =========================================================================================

function gerar_cubo_raster(roi, config) {

    // 6.1 Filtragem e mascaramento da coleção Sentinel-2
    var s2 = col_S2.filterBounds(roi).filterDate(config.data_inicio, config.data_fim);
    var csPlus = col_CS_PLUS.filterBounds(roi).filterDate(config.data_inicio, config.data_fim);
    var csPlusBands = csPlus.first().bandNames();

    var s2CloudMasked = s2.linkCollection(csPlus, csPlusBands)
        .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', config.max_nuvens_imagem))
        .map(maskEdges)
        .map(maskClouds)
        .map(res_bilinear);

    // 6.2 Índices Espectrais e Seleção da Época Húmida
    var spectralDataNei = s2CloudMasked.map(spectralFeatures)
        .select(['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A',
            'B11', 'B12', 'NDVI', 'NDWI', 'CAI', 'CRI1', 'ARI_1', 'RGR',
            'PSRI', 'SATVI']);

    var wetThresholdNei = spectralDataNei.select("NDVI").reduce(ee.Reducer.percentile([25]));

    function onlyWetSeasonNei(image) {
        var seasonMask = image.select("NDVI").gte(wetThresholdNei);
        return image.updateMask(seasonMask);
    }

    var wetSpectralDataNei = spectralDataNei
        .map(onlyWetSeasonNei)
        .select(spectralDataNei.first().bandNames(), BandsWet);

    // 6.3 Reduções Temporais e Relevo (latitude e longitude removidos)
    var temporalData = temporalPercs(wetSpectralDataNei)
        .addBands([temporalFeatures(wetSpectralDataNei), elevation, slope]);

    // Filtro Focal Median 3x3
    var ndviStdDevBand = temporalData.select('.*ndvi_wet_stdDev.*');
    var ndviMedianBand = temporalData.select('.*ndvi_wet_median.*');

    var ndvi_3x3 = ee.Image.cat([ndviStdDevBand, ndviMedianBand])
        .focalMedian({ radius: 3, kernelType: "square", units: "pixels" })
        .rename(['ndvi_wet_stdDev_3x3', 'ndvi_wet_median_3x3']);

    // Embeddings do ano base
    var embedding_ano = col_embeddings
        .filterDate(config.ano_base + '-01-01', (config.ano_base + 1) + '-01-01')
        .mosaic();

    // 6.4 Feature Space Final empilhado em uma única Imagem
    var featureSpaceImage = ee.Image(temporalData)
        .addBands([ndvi_3x3, embedding_ano]);

    // NOTA: Não usar print(bandNames()) aqui — avalia a imagem inteira e estoura a memória.
    // A contagem de bandas será verificada no momento da exportação.

    return featureSpaceImage;
}

// =========================================================================================
// 7. EXPORTAÇÃO POR GRADE (TILEADA) COM CONVERSÃO FLOAT → INT16
// =========================================================================================

function exportar_por_grade(featureSpaceImage, config) {

    // Filtra os grids do lote atual
    var grids = GRADE_BR
        .filter(ee.Filter.gte('grid_num', config.grid_inicio))
        .filter(ee.Filter.lte('grid_num', config.grid_fim));

    var gridList = grids.toList(grids.size());
    var nGrids = grids.size().getInfo();

    // Construir listas de bandas por tipo de escala (tudo server-side, sem getInfo)
    var bandasSemMultiplicar = construirListaBandasSemMultiplicar();
    var bandasSemMultiplicarEE = ee.List(bandasSemMultiplicar);
    var bandasParaMultiplicarEE = featureSpaceImage.bandNames().removeAll(bandasSemMultiplicarEE);

    print('---------------------------------------------------------------');
    print('CONFIGURAÇÃO DE EXPORTAÇÃO POR GRADE');
    print('---------------------------------------------------------------');
    print('Grids no lote: ' + nGrids + ' (de ' + config.grid_inicio + ' a ' + config.grid_fim + ')');
    print('Bandas SEM multiplicar (91): reflectância S2 + elevação');
    print('Bandas COM multiplicar x' + config.fator_escala + ' (139): índices + slope + embeddings + focal');
    print('Pasta Drive: ' + config.pasta_drive);
    print('---------------------------------------------------------------');

    for (var i = 0; i < nGrids; i++) {
        var feature = ee.Feature(gridList.get(i));
        var gridNum = feature.get('grid_num').getInfo();
        var gridGeom = feature.geometry();

        // Zero-padding para 5 dígitos: 1 → "00001"
        var gridStr = ('00000' + gridNum).slice(-5);

        // Bandas de reflectância + elevação → apenas converter para Int16 (sem multiplicar)
        var imgSemMult = featureSpaceImage
            .select(bandasSemMultiplicarEE)
            .toInt16();

        // Bandas de índices + slope + embeddings + focal → multiplicar por fator_escala e converter
        var imgComMult = featureSpaceImage
            .select(bandasParaMultiplicarEE)
            .multiply(config.fator_escala)
            .round()
            .toInt16();

        // Combinar todas as bandas e clipar pelo grid
        var imagemFinal = imgSemMult.addBands(imgComMult).clip(gridGeom);

        // Nome do arquivo: metricas_ilpf_YYYY_gridNNNNN
        var nomeArquivo = 'metricas_ilpf_' + config.ano_base + '_grid' + gridStr;

        Export.image.toDrive({
            image: imagemFinal,
            description: nomeArquivo,
            fileNamePrefix: nomeArquivo,
            folder: config.pasta_drive,
            region: gridGeom,
            scale: 10,
            maxPixels: 1e12,
            fileFormat: 'GeoTIFF'
        });

        print('Task submetida: ' + nomeArquivo);
    }
}

// =========================================================================================
// EXECUÇÃO DO SCRIPT
// =========================================================================================

// Gera o cubo raster (computação lazy — só é processada no momento da exportação)
var featureSpaceImage = gerar_cubo_raster(ROI, CONFIG);

// Exporta por grade para o Google Drive
exportar_por_grade(featureSpaceImage, CONFIG);

// Visualização no Mapa (opcional, para inspeção visual rápida)
var gridsLote = GRADE_BR
    .filter(ee.Filter.gte('grid_num', CONFIG.grid_inicio))
    .filter(ee.Filter.lte('grid_num', CONFIG.grid_fim));

Map.centerObject(gridsLote, 8);
Map.addLayer(featureSpaceImage.select(['ndvi_wet_median', 'nir_wet_median', 'red_wet_median']),
    { min: 0, max: 0.4 }, 'Composição Falsa Cor NDVI/NIR/Red', true);
Map.addLayer(gridsLote, { color: 'red' }, 'Grids do Lote Atual', true);
Map.setOptions('SATELLITE');
