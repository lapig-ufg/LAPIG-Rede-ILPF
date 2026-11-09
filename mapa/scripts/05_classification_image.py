import sys

# O console do Windows (cmd/PowerShell) costuma usar a codificação cp1252 por
# padrão, que não sabe representar os emojis usados nos prints abaixo (✅, 📂,
# 📖, 🧠, ⚠️) - sem isso, o script quebra com UnicodeEncodeError bem no final,
# mesmo depois da predição e do salvamento do mapa terem funcionado.
sys.stdout.reconfigure(encoding="utf-8")

import argparse
from pathlib import Path

import numpy as np
import rasterio
import tensorflow as tf
import yaml
from skimage.segmentation import slic
from sklearn.cluster import MiniBatchKMeans
from sklearn.preprocessing import StandardScaler

_CONFIG_PATH = Path(__file__).resolve().parent / "config" / "settings.yaml"
with open(_CONFIG_PATH, "r", encoding="utf-8") as _f:
    conf = yaml.safe_load(_f)

# Ordem das classes do LabelEncoder em 04_finetunning_model.py: valores
# únicos de tipo_integ ordenados (0 excluído), ou seja [1..9] - o índice i da
# saída softmax do modelo corresponde a tipo_integ = i + 1. Se o modelo for
# re-treinado com outro conjunto de classes, esta lista PRECISA acompanhar.
TIPO_INTEG_CLASSES = [1, 2, 3, 4, 5, 6, 7, 8, 9]
NOMES_TIPO_INTEG = {
    1: "Pastagem", 2: "Agricultura", 3: "ILPF", 4: "ILP", 5: "IPF",
    6: "Agrofloresta", 7: "ILF", 8: "Outros", 9: "Silvicultura",
}
NODATA_CLASSE = 0  # fora da legenda de tipo_integ - usado pra pixel sem dado/nuvem


def parse_args():
    parser = argparse.ArgumentParser(
        description="Classifica um GeoTIFF de EVI2 mensal (13 bandas) em tipo_integ, usando o modelo TempCNN fine-tuned."
    )
    parser.add_argument(
        "-i", "--imagem", dest="imagem", default=None,
        help=f"GeoTIFF de entrada (13 bandas mensais de EVI2). Se omitido, usa settings.yaml (classificacao.imagem_entrada): '{conf['classificacao']['imagem_entrada']}'.",
    )
    parser.add_argument(
        "-o", "--saida", dest="pasta_saida", default=None,
        help=f"Pasta onde salvar os mapas de saída. Se omitido, usa settings.yaml (classificacao.pasta_saida): '{conf['classificacao']['pasta_saida']}'.",
    )
    parser.add_argument(
        "-m", "--modo", choices=["pixel", "segmento", "cluster_temporal"], default="pixel",
        help="'pixel' classifica cada pixel individualmente (default). 'segmento' primeiro segmenta a "
             "imagem (SLIC, agrupando pixels espacialmente próximos E com EVI2 parecido) e classifica cada "
             "segmento de uma vez - reduz ruído 'sal e pimenta' e aproxima de um mapa de talhões. "
             "'cluster_temporal' agrupa pixels SÓ pela forma da série de EVI2 (K-Means, sem nenhuma restrição "
             "espacial - pixels em pontos opostos da imagem podem cair no mesmo grupo se a fenologia for parecida).",
    )
    parser.add_argument(
        "--pixels-por-segmento", dest="pixels_por_segmento", type=int, default=2500,
        help="Tamanho médio alvo de cada segmento, em pixels (só no modo 'segmento'). "
             "Default 2500 px ~ 25 ha a 10m de resolução do Sentinel-2 (perto da mediana de área dos "
             "talhões usados no treino). ATENÇÃO: o custo do SLIC escala muito mais com a QUANTIDADE de "
             "segmentos do que com o tamanho da imagem - testado empiricamente: baixar esse valor pra perto "
             "de 100 px deixa a segmentação ~20x mais lenta (na imagem inteira, passa de minutos pra horas).",
    )
    parser.add_argument(
        "--compactness", dest="compactness", type=float, default=0.1,
        help="Peso da compacidade espacial do SLIC (só no modo 'segmento'): maior = segmentos mais "
             "regulares/quadrados, menor = segue mais a textura do EVI2. Default 0.1 (dados não são RGB).",
    )
    parser.add_argument(
        "--interpolar", dest="interpolar", action="store_true",
        help="Preenche meses com nuvem/sem dado por interpolação linear no tempo, pixel a pixel (mesma "
             "lógica usada em 02_build_datasets.py pras amostras de treino), ANTES de classificar. Só fica "
             "sem dado o pixel que não tem NENHUM mês válido no ano inteiro - reduz bastante a área 'sem "
             "informação' no mapa final, ao custo de meses preenchidos por interpolação (menos confiáveis "
             "que um valor observado de verdade, principalmente se sobrar só 1-2 meses válidos no pixel).",
    )
    parser.add_argument(
        "--n-clusters", dest="n_clusters", type=int, default=200,
        help="Número de grupos temporais (só no modo 'cluster_temporal'). Default 200.",
    )
    return parser.parse_args()


def interpolar_temporal(arr):
    """
    Interpolação linear ao longo do eixo do tempo (bandas), pixel a pixel,
    preenchendo meses com NaN (nuvem) a partir dos meses válidos mais
    próximos - mesma lógica de pandas.interpolate(method="linear",
    limit_direction="both") usada em 02_build_datasets.py, só que vetorizada
    em numpy puro (sem laço por pixel) pra escalar a milhões de pixels.
    Bordas sem vizinho válido de um lado usam o valor válido mais próximo do
    outro lado (preenchimento "chato", sem extrapolar inclinação). Pixel sem
    NENHUM mês válido continua NaN - não tem o que interpolar.
    """
    T, H, W = arr.shape
    data = arr.reshape(T, H * W).astype("float32")
    valido = ~np.isnan(data)
    tem_algum_valido = valido.any(axis=0)

    indices = np.arange(T, dtype="float32")[:, None]
    idx_se_valido = np.where(valido, np.arange(T)[:, None], -1)
    idx_anterior = np.maximum.accumulate(idx_se_valido, axis=0)

    idx_se_valido_rev = np.where(valido, np.arange(T)[:, None], T)
    idx_seguinte = np.minimum.accumulate(idx_se_valido_rev[::-1], axis=0)[::-1]

    idx_anterior_clip = np.clip(idx_anterior, 0, T - 1)
    idx_seguinte_clip = np.clip(idx_seguinte, 0, T - 1)
    valor_anterior = np.take_along_axis(data, idx_anterior_clip, axis=0)
    valor_seguinte = np.take_along_axis(data, idx_seguinte_clip, axis=0)

    intervalo = (idx_seguinte - idx_anterior).astype("float32")
    intervalo[intervalo == 0] = 1.0  # evita divisão por zero (não é usado onde intervalo real é 0)
    fracao = (indices - idx_anterior) / intervalo
    interpolado = valor_anterior + fracao * (valor_seguinte - valor_anterior)

    sem_anterior = idx_anterior < 0
    interpolado = np.where(sem_anterior, valor_seguinte, interpolado)
    sem_seguinte = idx_seguinte >= T
    interpolado = np.where(sem_seguinte, valor_anterior, interpolado)

    resultado = np.where(valido, data, interpolado)
    resultado = np.where(tem_algum_valido[None, :], resultado, np.nan)

    n_pixels_recuperados = int(tem_algum_valido.sum() - valido.all(axis=0).sum())
    print(
        f"Interpolação temporal: {int(tem_algum_valido.sum()):,} de {H * W:,} pixels tinham pelo menos 1 "
        f"mês válido -> esses viram completos (eram {int(valido.all(axis=0).sum()):,} já completos antes)."
    )

    return resultado.reshape(T, H, W)


def _carregar_modelo_e_imagem(model_path, cube_path, interpolar=False):
    print("📂 Carregando o modelo treinado...")
    model = tf.keras.models.load_model(model_path)
    n_classes_modelo = model.output_shape[-1]
    if n_classes_modelo != len(TIPO_INTEG_CLASSES):
        raise ValueError(
            f"O modelo tem {n_classes_modelo} classes de saída, mas TIPO_INTEG_CLASSES tem "
            f"{len(TIPO_INTEG_CLASSES)} - atualize o mapeamento antes de classificar a imagem."
        )

    print(f"📖 Lendo o GeoTIFF: {cube_path}")
    with rasterio.open(cube_path) as src:
        arr = src.read()  # Forma: (bandas, H, W)
        profile = src.profile.copy()

    n_bands, H, W = arr.shape
    colsNum = model.input_shape[1]
    if n_bands != colsNum:
        raise ValueError(f"A imagem tem {n_bands} banda(s), mas o modelo espera {colsNum} meses.")

    if interpolar:
        arr = interpolar_temporal(arr)

    return model, arr, profile, n_bands, H, W


def classificar_imagem_tipo_integ(model_path, cube_path, out_dir, interpolar=False, batch_size=65536):
    """
    Carrega o classificador TempCNN (SSL + fine-tuning) e gera, a partir de um
    GeoTIFF com bandas mensais de EVI2:
      - um mapa de classes (tipo_integ previsto por pixel, 1-9; 0 = sem dado)
      - um mapa de confiança (probabilidade softmax da classe vencedora)
    """
    model, arr, profile, n_bands, H, W = _carregar_modelo_e_imagem(model_path, cube_path, interpolar=interpolar)

    # Matriz da imagem (bandas, H, W) -> formato esperado pelo Keras (H*W, bandas, 1)
    arr_reshaped = arr.transpose(1, 2, 0).reshape(H * W, n_bands, 1)

    # Trata valores nulos (NaN / NoData de borda ou nuvem): guarda a máscara
    # pra marcar esses pixels como "sem dado" na saída, e zera a entrada só
    # pra não quebrar a rede (a predição desses pixels é descartada depois).
    mask_nan = np.isnan(arr).any(axis=0).reshape(H * W)
    arr_reshaped = np.nan_to_num(arr_reshaped, nan=0.0)
    print(f"Pixels: {H * W:,} total, {mask_nan.sum():,} sem dado ({mask_nan.mean():.1%}), {(~mask_nan).sum():,} a classificar")

    print("🧠 Executando a inferência na rede neural...")
    probs = model.predict(arr_reshaped, batch_size=batch_size, verbose=1)  # (H*W, n_classes)

    pred_idx = np.argmax(probs, axis=1)
    confianca = np.max(probs, axis=1).astype("float32")
    mapa_classes = np.array(TIPO_INTEG_CLASSES, dtype="uint8")[pred_idx]

    mapa_classes[mask_nan] = NODATA_CLASSE
    confianca[mask_nan] = np.nan

    mapa_classes = mapa_classes.reshape(H, W)
    confianca = confianca.reshape(H, W)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(cube_path).stem

    caminho_classes = out_dir / f"classificacao_tipo_integ_{stem}.tif"
    perfil_classes = profile.copy()
    perfil_classes.update(count=1, dtype="uint8", nodata=NODATA_CLASSE)
    with rasterio.open(caminho_classes, "w", **perfil_classes) as dst:
        dst.write(mapa_classes, 1)
        dst.write_colormap(1, {0: (0, 0, 0, 0)})
        dst.update_tags(1, **{f"classe_{c}": NOMES_TIPO_INTEG[c] for c in TIPO_INTEG_CLASSES})

    caminho_confianca = out_dir / f"confianca_tipo_integ_{stem}.tif"
    perfil_confianca = profile.copy()
    perfil_confianca.update(count=1, dtype="float32", nodata=np.nan)
    with rasterio.open(caminho_confianca, "w", **perfil_confianca) as dst:
        dst.write(confianca, 1)

    print(f"✅ Mapa de classes salvo em: {caminho_classes}")
    print(f"✅ Mapa de confiança salvo em: {caminho_confianca}")

    # Resumo: quantos pixels caíram em cada classe
    valores, contagens = np.unique(mapa_classes[mapa_classes != NODATA_CLASSE], return_counts=True)
    print("\nDistribuição de pixels classificados:")
    for v, c in sorted(zip(valores, contagens), key=lambda x: -x[1]):
        print(f"  {NOMES_TIPO_INTEG.get(int(v), v):15s} {c:>12,} pixels ({c / contagens.sum():.1%})")

    return caminho_classes, caminho_confianca


def segmentar_e_classificar_imagem(
    model_path, cube_path, out_dir, pixels_por_segmento=2500, compactness=0.1,
    interpolar=False, batch_size=65536,
):
    """
    Segmenta a imagem (SLIC, sobre as 13 bandas de EVI2) em regiões
    espacialmente contíguas e espectralmente homogêneas, e classifica cada
    segmento de uma vez (1 predição por segmento, propagada pra todos os
    pixels dele) - em vez de pixel a pixel. Isso reduz o ruído "sal e pimenta"
    típico da classificação pixel a pixel e aproxima mais de um mapa de
    talhões/parcelas.
    """
    model, arr, profile, n_bands, H, W = _carregar_modelo_e_imagem(model_path, cube_path, interpolar=interpolar)

    mask_valido = ~np.isnan(arr).any(axis=0)  # (H, W) - True = tem as 13 bandas
    n_validos = int(mask_valido.sum())
    n_segmentos_alvo = max(1, n_validos // pixels_por_segmento)
    print(
        f"Pixels válidos: {n_validos:,} de {H * W:,} ({n_validos / (H * W):.1%}) -> "
        f"alvo de {n_segmentos_alvo:,} segmentos (~{pixels_por_segmento} px cada)"
    )

    img_hwc = np.nan_to_num(arr.transpose(1, 2, 0), nan=0.0).astype("float32")

    print("✂️ Segmentando a imagem (SLIC)...")
    # mask=mask_valido já deixa o segmento 0 reservado pros pixels fora da
    # máscara (= nosso NODATA_CLASSE), confirmado empiricamente antes de
    # rodar isso na imagem inteira.
    segmentos = slic(
        img_hwc, n_segments=n_segmentos_alvo, compactness=compactness, channel_axis=-1,
        mask=mask_valido, convert2lab=False, enforce_connectivity=True, start_label=1,
    )
    n_segmentos = int(segmentos.max())
    print(f"{n_segmentos:,} segmentos gerados.")

    # Feature de cada segmento: média mensal de EVI2 dos pixels válidos dele
    # (usa os valores ORIGINAIS com NaN, não os zeros de preenchimento, pra
    # não distorcer a média). Vetorizado com bincount em vez de laço Python
    # por segmento, essencial pra escalar a dezenas de milhares de segmentos.
    print("📊 Calculando a série temporal média de cada segmento...")
    bandas_flat = arr.reshape(n_bands, H * W)
    segmentos_flat = segmentos.reshape(H * W).astype(np.int64)

    medias_por_segmento = np.full((n_segmentos, n_bands), np.nan, dtype="float32")
    for b in range(n_bands):
        banda = bandas_flat[b]
        validos_banda = ~np.isnan(banda)
        soma = np.bincount(segmentos_flat, weights=np.where(validos_banda, banda, 0.0), minlength=n_segmentos + 1)
        contagem = np.bincount(segmentos_flat, weights=validos_banda.astype("float64"), minlength=n_segmentos + 1)
        with np.errstate(invalid="ignore", divide="ignore"):
            media_banda = soma / contagem
        medias_por_segmento[:, b] = media_banda[1:n_segmentos + 1]

    # Segmento só é classificado se tiver os 13 meses completos (não deveria
    # faltar nenhum já que slic só rotula dentro da máscara, mas fica como
    # salvaguarda).
    segmentos_completos = ~np.isnan(medias_por_segmento).any(axis=1)
    print(f"{segmentos_completos.sum():,} de {n_segmentos:,} segmentos com os {n_bands} meses completos.")

    X_segmentos = np.nan_to_num(medias_por_segmento, nan=0.0).reshape(n_segmentos, n_bands, 1)

    print("🧠 Classificando os segmentos...")
    probs = model.predict(X_segmentos, batch_size=batch_size, verbose=1)  # (n_segmentos, n_classes)
    pred_idx = np.argmax(probs, axis=1)
    confianca_segmento = np.max(probs, axis=1).astype("float32")
    classe_segmento = np.array(TIPO_INTEG_CLASSES, dtype="uint8")[pred_idx]

    classe_segmento[~segmentos_completos] = NODATA_CLASSE
    confianca_segmento[~segmentos_completos] = np.nan

    # Propaga classe/confiança de cada segmento pra todos os pixels dele via
    # tabela de consulta (índice 0 = fora da máscara = nodata).
    lut_classe = np.zeros(n_segmentos + 1, dtype="uint8")
    lut_classe[1:] = classe_segmento
    lut_confianca = np.full(n_segmentos + 1, np.nan, dtype="float32")
    lut_confianca[1:] = confianca_segmento

    mapa_classes = lut_classe[segmentos]
    mapa_confianca = lut_confianca[segmentos]

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(cube_path).stem

    caminho_classes = out_dir / f"classificacao_tipo_integ_segmentada_{stem}.tif"
    perfil_classes = profile.copy()
    perfil_classes.update(count=1, dtype="uint8", nodata=NODATA_CLASSE)
    with rasterio.open(caminho_classes, "w", **perfil_classes) as dst:
        dst.write(mapa_classes, 1)
        dst.write_colormap(1, {0: (0, 0, 0, 0)})
        dst.update_tags(1, **{f"classe_{c}": NOMES_TIPO_INTEG[c] for c in TIPO_INTEG_CLASSES})

    caminho_confianca = out_dir / f"confianca_tipo_integ_segmentada_{stem}.tif"
    perfil_confianca = profile.copy()
    perfil_confianca.update(count=1, dtype="float32", nodata=np.nan)
    with rasterio.open(caminho_confianca, "w", **perfil_confianca) as dst:
        dst.write(mapa_confianca, 1)

    caminho_segmentos = out_dir / f"segmentos_{stem}.tif"
    perfil_segmentos = profile.copy()
    perfil_segmentos.update(count=1, dtype="int32", nodata=0)
    with rasterio.open(caminho_segmentos, "w", **perfil_segmentos) as dst:
        dst.write(segmentos.astype("int32"), 1)

    print(f"✅ Mapa de segmentos salvo em: {caminho_segmentos}")
    print(f"✅ Mapa de classes (segmentado) salvo em: {caminho_classes}")
    print(f"✅ Mapa de confiança (segmentado) salvo em: {caminho_confianca}")

    valores, contagens = np.unique(mapa_classes[mapa_classes != NODATA_CLASSE], return_counts=True)
    print("\nDistribuição de pixels classificados (via segmentos):")
    for v, c in sorted(zip(valores, contagens), key=lambda x: -x[1]):
        print(f"  {NOMES_TIPO_INTEG.get(int(v), v):15s} {c:>12,} pixels ({c / contagens.sum():.1%})")

    return caminho_classes, caminho_confianca, caminho_segmentos


def agrupar_temporal_e_classificar_imagem(
    model_path, cube_path, out_dir, n_clusters=200, interpolar=False, batch_size=65536, random_state=42,
):
    """
    Agrupa os pixels SÓ pela forma da série de EVI2 (13 meses), via K-Means,
    SEM nenhuma restrição espacial - dois pixels em pontos opostos da imagem
    caem no mesmo grupo se tiverem fenologia parecida (ao contrário de
    segmentar_e_classificar_imagem, que exige vizinhança espacial). Depois
    classifica cada grupo (centróide do K-Means) de uma vez.
    """
    model, arr, profile, n_bands, H, W = _carregar_modelo_e_imagem(model_path, cube_path, interpolar=interpolar)

    mask_valido = ~np.isnan(arr).any(axis=0).reshape(H * W)
    n_validos = int(mask_valido.sum())
    print(f"Pixels válidos: {n_validos:,} de {H * W:,} ({n_validos / (H * W):.1%})")

    dados_flat = arr.reshape(n_bands, H * W).T  # (H*W, n_bands)
    X_validos = dados_flat[mask_valido].astype("float32")

    print(f"🔗 Agrupando {n_validos:,} pixels em {n_clusters} clusters temporais (K-Means)...")
    # Padroniza cada mês antes de agrupar, senão meses com maior variância
    # dominam a distância euclidiana do K-Means.
    scaler = StandardScaler()
    X_norm = scaler.fit_transform(X_validos)

    kmeans = MiniBatchKMeans(
        n_clusters=n_clusters, random_state=random_state, batch_size=10_000, n_init=10,
    )
    labels_validos = kmeans.fit_predict(X_norm)  # 0..n_clusters-1

    # Centróide de cada cluster, desfeita a padronização, pra alimentar o
    # classificador com valores de EVI2 na escala original (0-1).
    centroides = scaler.inverse_transform(kmeans.cluster_centers_)

    print("🧠 Classificando os clusters...")
    X_clusters = centroides.reshape(n_clusters, n_bands, 1).astype("float32")
    probs = model.predict(X_clusters, batch_size=batch_size, verbose=1)  # (n_clusters, n_classes)
    pred_idx = np.argmax(probs, axis=1)
    confianca_cluster = np.max(probs, axis=1).astype("float32")
    classe_cluster = np.array(TIPO_INTEG_CLASSES, dtype="uint8")[pred_idx]

    # Propaga cluster/classe/confiança pra todos os pixels via tabela de
    # consulta (índice 0 = fora da máscara = nodata).
    labels_completo = np.zeros(H * W, dtype="int32")
    labels_completo[mask_valido] = labels_validos + 1

    lut_classe = np.zeros(n_clusters + 1, dtype="uint8")
    lut_classe[1:] = classe_cluster
    lut_confianca = np.full(n_clusters + 1, np.nan, dtype="float32")
    lut_confianca[1:] = confianca_cluster

    mapa_classes = lut_classe[labels_completo].reshape(H, W)
    mapa_confianca = lut_confianca[labels_completo].reshape(H, W)
    mapa_clusters = labels_completo.reshape(H, W)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(cube_path).stem

    caminho_clusters = out_dir / f"cluster_temporal_{stem}.tif"
    perfil_clusters = profile.copy()
    perfil_clusters.update(count=1, dtype="int32", nodata=0)
    with rasterio.open(caminho_clusters, "w", **perfil_clusters) as dst:
        dst.write(mapa_clusters, 1)

    caminho_classes = out_dir / f"classificacao_tipo_integ_cluster_temporal_{stem}.tif"
    perfil_classes = profile.copy()
    perfil_classes.update(count=1, dtype="uint8", nodata=NODATA_CLASSE)
    with rasterio.open(caminho_classes, "w", **perfil_classes) as dst:
        dst.write(mapa_classes, 1)
        dst.write_colormap(1, {0: (0, 0, 0, 0)})
        dst.update_tags(1, **{f"classe_{c}": NOMES_TIPO_INTEG[c] for c in TIPO_INTEG_CLASSES})

    caminho_confianca = out_dir / f"confianca_tipo_integ_cluster_temporal_{stem}.tif"
    perfil_confianca = profile.copy()
    perfil_confianca.update(count=1, dtype="float32", nodata=np.nan)
    with rasterio.open(caminho_confianca, "w", **perfil_confianca) as dst:
        dst.write(mapa_confianca, 1)

    print(f"✅ Mapa de clusters salvo em: {caminho_clusters}")
    print(f"✅ Mapa de classes (cluster temporal) salvo em: {caminho_classes}")
    print(f"✅ Mapa de confiança (cluster temporal) salvo em: {caminho_confianca}")

    valores, contagens = np.unique(mapa_classes[mapa_classes != NODATA_CLASSE], return_counts=True)
    print("\nDistribuição de pixels classificados (via clusters temporais):")
    for v, c in sorted(zip(valores, contagens), key=lambda x: -x[1]):
        print(f"  {NOMES_TIPO_INTEG.get(int(v), v):15s} {c:>12,} pixels ({c / contagens.sum():.1%})")

    return caminho_classes, caminho_confianca, caminho_clusters


if __name__ == '__main__':
    args = parse_args()
    imagem_entrada = args.imagem or conf["classificacao"]["imagem_entrada"]
    pasta_saida = args.pasta_saida or conf["classificacao"]["pasta_saida"]

    if not Path(imagem_entrada).exists():
        raise FileNotFoundError(f"Imagem não encontrada: '{imagem_entrada}'.")

    if args.modo == "segmento":
        segmentar_e_classificar_imagem(
            model_path=conf["modelo"]["model_saida"],
            cube_path=imagem_entrada,
            out_dir=pasta_saida,
            pixels_por_segmento=args.pixels_por_segmento,
            compactness=args.compactness,
            interpolar=args.interpolar,
        )
    elif args.modo == "cluster_temporal":
        agrupar_temporal_e_classificar_imagem(
            model_path=conf["modelo"]["model_saida"],
            cube_path=imagem_entrada,
            out_dir=pasta_saida,
            n_clusters=args.n_clusters,
            interpolar=args.interpolar,
        )
    else:
        classificar_imagem_tipo_integ(
            model_path=conf["modelo"]["model_saida"],
            cube_path=imagem_entrada,
            out_dir=pasta_saida,
            interpolar=args.interpolar,
        )
