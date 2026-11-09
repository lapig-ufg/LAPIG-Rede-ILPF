# =========================================================================================
# 1. CONFIGURAÇÕES E VARIÁVEIS DE TEMPO / FILTROS
# =========================================================================================
# NOTA: Bandas de latitude e longitude foram removidas da exportação.
# O cubo raster exportado contém 230 bandas (232 originais - 2 coordenadas).
#
# CONVERSÃO FLOAT → INT16 (multiplicação por 100):
# As bandas são tratadas em dois grupos para a conversão:
#
# BANDAS MULTIPLICADAS POR 100 (índices espectrais, derivadas e embeddings - 139 bandas):
#   - ndvi_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - ndwi_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - cai_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - cri1_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - ari1_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - rgr_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - psri_wet_*    (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - satvi_wet_*   (min, max, median, stdDev, amp, p10, p25, p75, p90)  = 9 bandas
#   - ndvi_wet_stdDev_3x3, ndvi_wet_median_3x3                          = 2 bandas
#   - slope                                                              = 1 banda
#   - embedding_* (64 bandas do Satellite Embedding V1 Annual)           = 64 bandas
#   Subtotal: 72 + 2 + 1 + 64 = 139 bandas
#
# BANDAS NÃO MULTIPLICADAS (reflectância S2 já em escala inteira + elevação - 91 bandas):
#   - blue_wet_*      (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - green_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - red_wet_*       (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - rededge1_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - rededge2_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - rededge3_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - nir_wet_*       (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - rededge4_wet_*  (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - swir1_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - swir2_wet_*     (min, max, median, stdDev, amp, p10, p25, p75, p90) = 9 bandas
#   - elevation                                                           = 1 banda
#   Subtotal: 90 + 1 = 91 bandas
#
# TOTAL EXPORTADO: 139 + 91 = 230 bandas (Int16)
# =========================================================================================

import ee
import math

# Autenticação e inicialização do GEE
# Na primeira execução, será necessário autenticar via navegador.
# Após autenticar, o token fica salvo localmente.
ee.Authenticate()
ee.Initialize(project='guilhermevaz')

# -----------------------------------------------------------------------------------------
# Configurações
# -----------------------------------------------------------------------------------------
CONFIG = {
    'ano_base': 2025,

    # Configuração de lote de grids para exportação.
    # Ajuste grid_inicio e grid_fim para controlar o lote a ser exportado.
    # Para teste inicial, use grid_inicio: 1, grid_fim: 1 (apenas 1 grid).
    # Para produção, aumente o range (ex: grid_inicio: 1, grid_fim: 500).
    # O asset grid_br possui grids de 1 a 18340.
    'grid_inicio': 1,
    'grid_fim': 1,

    # Fator de multiplicação float → int (100 = 2 casas decimais)
    'fator_escala': 100,

    # Pasta de destino no Google Drive
    'pasta_drive': 'metricas_ilpf',

    # Filtros de Nuvem
    'max_nuvens_imagem': 80,
    'limiar_cloud_score': 0.50,
}

# Janela temporal derivada do ano base (~1 ano antes a ~1 ano depois)
CONFIG['data_inicio'] = ee.Date(f"{CONFIG['ano_base'] - 1}-07-01")
CONFIG['data_fim'] = ee.Date(f"{CONFIG['ano_base'] + 1}-06-30")

# =========================================================================================
# 2. FONTES DE DADOS E DEFINIÇÃO DA ÁREA DE INTERESSE (ROI)
# =========================================================================================
col_S2 = ee.ImageCollection('COPERNICUS/S2_HARMONIZED')
col_CS_PLUS = ee.ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED')
terrain = ee.Algorithms.Terrain(ee.Image('NASA/NASADEM_HGT/001'))

# Coleção Anual de Embeddings
col_embeddings = ee.ImageCollection('GOOGLE/SATELLITE_EMBEDDING/V1/ANNUAL')

# Geometria do Brasil para filtragem das coleções
AMOSTRAS = ee.FeatureCollection('projects/ee-vieiramesquita/assets/BR_UF_2022')
ROI = AMOSTRAS.geometry().bounds()

# Grade de exportação (18.340 grids de 0.2° x 0.2° cobrindo o Brasil)
GRADE_BR = ee.FeatureCollection('projects/guilhermevaz/assets/utils/grid_br')

# =========================================================================================
# 3. DEFINIÇÃO DE MÉTRICAS E ÍNDICES ESPECTRAIS
# =========================================================================================
INDEXES = {
    'CAI': "(b('B12') / b('B11'))",
    'NDVI': "(b('B8') - b('B4')) / (b('B8') + b('B4'))",
    'NDWI': "(b('B8') - b('B11')) / (b('B8') + b('B11'))",
    'CRI1': "1/(b('B2')) - 1/(b('B3'))",
    'ARI_1': "(1/b('B3') - 1/b('B5'))*1000",
    'RGR': "b('B4')/b('B3')",
    'PSRI': "(b('B4') - b('B2') )/(b('B6'))",
    'SATVI': "((b('B11') - b('B4'))/(b('B11') + b('B4') + 0.5))*(1*0.5)-(b('B12')/2)*0.0001",
}

BANDS_WET = [
    'blue_wet', 'green_wet', 'red_wet', 'rededge1_wet', 'rededge2_wet', 'rededge3_wet',
    'nir_wet', 'rededge4_wet', 'swir1_wet', 'swir2_wet', 'ndvi_wet', 'ndwi_wet', 'cai_wet',
    'cri1_wet', 'ari1_wet', 'rgr_wet', 'psri_wet', 'satvi_wet',
]

BANDS_WET_AMP = [
    'blue_wet_amp', 'green_wet_amp', 'red_wet_amp', 'rededge1_wet_amp',
    'rededge2_wet_amp', 'rededge3_wet_amp', 'nir_wet_amp', 'rededge4_wet_amp',
    'swir1_wet_amp', 'swir2_wet_amp', 'ndvi_wet_amp', 'ndwi_wet_amp', 'cai_wet_amp',
    'cri1_wet_amp', 'ari1_wet_amp', 'rgr_wet_amp', 'psri_wet_amp', 'satvi_wet_amp',
]

# Prefixos de bandas de reflectância S2 (já em escala inteira, NÃO multiplicar por fator_escala)
PREFIXOS_REFLECTANCIA = [
    'blue_wet', 'green_wet', 'red_wet', 'rededge1_wet',
    'rededge2_wet', 'rededge3_wet', 'nir_wet', 'rededge4_wet', 'swir1_wet', 'swir2_wet',
]

# Sufixos das reduções temporais
SUFIXOS_TEMPORAIS = ['_min', '_max', '_median', '_stdDev', '_amp', '_p10', '_p25', '_p75', '_p90']

# =========================================================================================
# 4. FUNÇÕES DE PROCESSAMENTO
# =========================================================================================


def spectral_features(image):
    """Calcula índices espectrais e adiciona como bandas à imagem."""
    ndvi = image.expression(INDEXES['NDVI']).select([0], ['NDVI'])
    ndwi = image.expression(INDEXES['NDWI']).select([0], ['NDWI'])
    cai = image.expression(INDEXES['CAI']).select([0], ['CAI'])
    cri1 = image.expression(INDEXES['CRI1']).select([0], ['CRI1'])
    ari1 = image.expression(INDEXES['ARI_1']).select([0], ['ARI_1'])
    rgr = image.expression(INDEXES['RGR']).select([0], ['RGR'])
    psri = image.expression(INDEXES['PSRI']).select([0], ['PSRI'])
    satvi = image.expression(INDEXES['SATVI']).select([0], ['SATVI'])
    return image.addBands([ndvi, ndwi, cai, cri1, ari1, rgr, psri, satvi])


def temporal_features(col):
    """Reduz a coleção temporal em min, max, median, stdDev e amplitude."""
    img_min = col.reduce(ee.Reducer.min())
    img_max = col.reduce(ee.Reducer.max())
    img_median = col.reduce(ee.Reducer.median())
    img_stddev = col.reduce(ee.Reducer.stdDev())
    img_amp = img_max.subtract(img_min).rename(BANDS_WET_AMP)

    return ee.Image().select().addBands([img_min, img_max, img_median, img_amp, img_stddev])


def temporal_percs(col):
    """Calcula percentis temporais (10, 25, 75, 90)."""
    percs = col.reduce(ee.Reducer.percentile([10, 25, 75, 90]))
    return ee.Image().select().addBands([percs])


def mask_clouds(img):
    """Mascara pixels com Cloud Score Plus abaixo do limiar."""
    mask = img.select('cs').gte(CONFIG['limiar_cloud_score'])
    return img.updateMask(mask)


def res_bilinear(img):
    """Reamostra bandas de 20m para 10m usando interpolação bilinear."""
    bands = img.select('B5', 'B6', 'B7', 'B8A', 'B11', 'B12')
    return img.resample('bilinear').reproject(
        crs=bands.projection().crs(),
        scale=img.select('B8').projection().nominalScale()
    )


def mask_edges(s2_img):
    """Remove pixels de borda do Sentinel-2."""
    return s2_img.updateMask(
        s2_img.select('B8A').mask().updateMask(s2_img.select('B9').mask())
    )


def radians(img):
    """Converte graus para radianos."""
    return img.toFloat().multiply(math.pi).divide(180)


elevation = terrain.select('elevation')
slope = radians(terrain.select('slope')).expression('b("slope")*100')

# =========================================================================================
# 5. CONSTRUÇÃO DA LISTA DE BANDAS POR TIPO DE ESCALA
# =========================================================================================


def construir_lista_bandas_sem_multiplicar():
    """Monta a lista de bandas de reflectância (NÃO multiplicar) + elevation."""
    lista = []
    for prefixo in PREFIXOS_REFLECTANCIA:
        for sufixo in SUFIXOS_TEMPORAIS:
            lista.append(prefixo + sufixo)
    lista.append('elevation')
    return lista


# =========================================================================================
# 6. PROCESSAMENTO E CONSTRUÇÃO DO RASTER MULTIBANDA (CUBO DE DADOS)
# =========================================================================================


def gerar_cubo_raster(roi, config):
    """Gera o cubo raster com 230 bandas (feature space) para classificação."""

    # 6.1 Filtragem e mascaramento da coleção Sentinel-2
    s2 = col_S2.filterBounds(roi).filterDate(config['data_inicio'], config['data_fim'])
    cs_plus = col_CS_PLUS.filterBounds(roi).filterDate(config['data_inicio'], config['data_fim'])
    cs_plus_bands = cs_plus.first().bandNames()

    s2_cloud_masked = (
        s2.linkCollection(cs_plus, cs_plus_bands)
        .filter(ee.Filter.lte('CLOUDY_PIXEL_PERCENTAGE', config['max_nuvens_imagem']))
        .map(mask_edges)
        .map(mask_clouds)
        .map(res_bilinear)
    )

    # 6.2 Índices Espectrais e Seleção da Época Húmida
    spectral_data = s2_cloud_masked.map(spectral_features).select(
        ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B8A',
         'B11', 'B12', 'NDVI', 'NDWI', 'CAI', 'CRI1', 'ARI_1', 'RGR',
         'PSRI', 'SATVI']
    )

    wet_threshold = spectral_data.select('NDVI').reduce(ee.Reducer.percentile([25]))

    def only_wet_season(image):
        season_mask = image.select('NDVI').gte(wet_threshold)
        return image.updateMask(season_mask)

    wet_spectral_data = (
        spectral_data
        .map(only_wet_season)
        .select(spectral_data.first().bandNames(), BANDS_WET)
    )

    # 6.3 Reduções Temporais e Relevo (latitude e longitude removidos)
    temporal_data = temporal_percs(wet_spectral_data).addBands(
        [temporal_features(wet_spectral_data), elevation, slope]
    )

    # Filtro Focal Median 3x3
    ndvi_stddev_band = temporal_data.select('.*ndvi_wet_stdDev.*')
    ndvi_median_band = temporal_data.select('.*ndvi_wet_median.*')

    ndvi_3x3 = (
        ee.Image.cat([ndvi_stddev_band, ndvi_median_band])
        .focalMedian(radius=3, kernelType='square', units='pixels')
        .rename(['ndvi_wet_stdDev_3x3', 'ndvi_wet_median_3x3'])
    )

    # Embeddings do ano base
    ano = config['ano_base']
    embedding_ano = (
        col_embeddings
        .filterDate(f'{ano}-01-01', f'{ano + 1}-01-01')
        .mosaic()
    )

    # 6.4 Feature Space Final empilhado em uma única Imagem
    feature_space_image = ee.Image(temporal_data).addBands([ndvi_3x3, embedding_ano])

    # NOTA: Não usar bandNames().getInfo() aqui — avalia a imagem inteira e estoura a memória.
    # A contagem de bandas será verificada no momento da exportação.

    return feature_space_image


# =========================================================================================
# 7. EXPORTAÇÃO POR GRADE (TILEADA) COM CONVERSÃO FLOAT → INT16
# =========================================================================================


def exportar_por_grade(feature_space_image, config):
    """Exporta o cubo raster por tiles da grade para o Google Drive."""

    # Filtra os grids do lote atual
    grids = (
        GRADE_BR
        .filter(ee.Filter.gte('grid_num', config['grid_inicio']))
        .filter(ee.Filter.lte('grid_num', config['grid_fim']))
    )

    grid_list = grids.toList(grids.size())
    n_grids = grids.size().getInfo()

    # Construir listas de bandas por tipo de escala (tudo server-side, sem getInfo)
    bandas_sem_multiplicar = construir_lista_bandas_sem_multiplicar()
    bandas_sem_multiplicar_ee = ee.List(bandas_sem_multiplicar)
    bandas_para_multiplicar_ee = feature_space_image.bandNames().removeAll(bandas_sem_multiplicar_ee)

    print('---------------------------------------------------------------')
    print('CONFIGURAÇÃO DE EXPORTAÇÃO POR GRADE')
    print('---------------------------------------------------------------')
    print(f"Grids no lote: {n_grids} (de {config['grid_inicio']} a {config['grid_fim']})")
    print(f"Bandas SEM multiplicar (91): reflectância S2 + elevação")
    print(f"Bandas COM multiplicar x{config['fator_escala']} (139): índices + slope + embeddings + focal")
    print(f"Pasta Drive: {config['pasta_drive']}")
    print('---------------------------------------------------------------')

    tasks = []

    for i in range(n_grids):
        feature = ee.Feature(grid_list.get(i))
        grid_num = feature.get('grid_num').getInfo()
        grid_geom = feature.geometry()

        # Zero-padding para 5 dígitos: 1 → "00001"
        grid_str = str(grid_num).zfill(5)

        # Bandas de reflectância + elevação → apenas converter para Int16 (sem multiplicar)
        img_sem_mult = (
            feature_space_image
            .select(bandas_sem_multiplicar_ee)
            .toInt16()
        )

        # Bandas de índices + slope + embeddings + focal → multiplicar por fator_escala e converter
        img_com_mult = (
            feature_space_image
            .select(bandas_para_multiplicar_ee)
            .multiply(config['fator_escala'])
            .round()
            .toInt16()
        )

        # Combinar todas as bandas e clipar pelo grid
        imagem_final = img_sem_mult.addBands(img_com_mult).clip(grid_geom)

        # Nome do arquivo: metricas_ilpf_YYYY_gridNNNNN
        nome_arquivo = f"metricas_ilpf_{config['ano_base']}_grid{grid_str}"

        task = ee.batch.Export.image.toDrive(
            image=imagem_final,
            description=nome_arquivo,
            fileNamePrefix=nome_arquivo,
            folder=config['pasta_drive'],
            region=grid_geom,
            scale=10,
            maxPixels=int(1e12),
            fileFormat='GeoTIFF',
        )
        task.start()
        tasks.append(task)

        print(f'Task submetida: {nome_arquivo} (status: {task.status()["state"]})')

    return tasks


# =========================================================================================
# EXECUÇÃO DO SCRIPT
# =========================================================================================

if __name__ == '__main__':
    # Gera o cubo raster (computação lazy — só é processada no momento da exportação)
    feature_space_image = gerar_cubo_raster(ROI, CONFIG)

    # Exporta por grade para o Google Drive
    tasks = exportar_por_grade(feature_space_image, CONFIG)

    print(f'\n{len(tasks)} task(s) submetida(s) ao Earth Engine.')
    print('Acompanhe o progresso em: https://code.earthengine.google.com/tasks')
