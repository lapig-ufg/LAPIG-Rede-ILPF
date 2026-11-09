import sys

# O console do Windows (cmd/PowerShell) costuma usar a codificação cp1252 por
# padrão, que não sabe representar os emojis usados nos prints abaixo (✅, 📂,
# 📖, 🧠, ⚠️) - sem isso, o script quebra com UnicodeEncodeError bem no final,
# mesmo depois do treino e do salvamento do modelo terem funcionado.
sys.stdout.reconfigure(encoding="utf-8")

from pathlib import Path

import numpy as np
import pandas as pd
import tensorflow as tf
import yaml
from tensorflow.keras import layers, Model, regularizers
from tensorflow.keras.callbacks import EarlyStopping

_CONFIG_PATH = Path(__file__).resolve().parent / "config" / "settings.yaml"
with open(_CONFIG_PATH, "r", encoding="utf-8") as _f:
    conf = yaml.safe_load(_f)

# Mesma seed usada em scripts/py/utils/_ssl_tempcnn_grid_search.py - sem ela o
# treino não é reprodutível e o resultado pode variar bastante de execução
# pra execução (ver ressalva no relatório da busca de hiperparâmetros).
RANDOM_STATE = 42
np.random.seed(RANDOM_STATE)
tf.random.set_seed(RANDOM_STATE)

# Hiperparâmetros vencedores da busca em grade sobre os 60% de SSL (ver
# scripts/py/utils/_ssl_tempcnn_grid_search.py): menor val_loss (0.000488)
# entre as 21 combinações testadas. 04_finetunning_model.py importa estas
# constantes para reconstruir o encoder com a MESMA arquitetura antes de
# carregar os pesos salvos por este script - precisam ficar em sincronia.
SSL_NUM_HEADS = 3
SSL_FILTERS = 16
SSL_KERNEL_SIZES = (3, 5, 7)
SSL_N_BLOCOS = 2


# NOVO: regularização do bloco básico da TempCNN (Pelletier et al., 2019).
# O artigo usa dropout 0.5 e L2 1e-6 na classificação; no autoencoder o dropout
# alto pode atrapalhar a reconstrução, então começamos com um valor menor.
SSL_DROPOUT = 0.2
SSL_L2 = 1e-6

# NOVO: bloco básico da TempCNN -> Conv1D + BatchNorm + ReLU + Dropout
def bloco_tempcnn(x, filtros, kernel, dropout=0.5, l2=1e-6, nome=None):
    """Conv1D -> BatchNorm -> ReLU -> Dropout (bloco da TempCNN)."""
    x = layers.Conv1D(filtros, kernel_size=kernel, padding="same",
                      kernel_regularizer=regularizers.l2(l2), name=nome)(x)
    x = layers.BatchNormalization()(x)
    x = layers.Activation("relu")(x)
    if dropout > 0:
        x = layers.Dropout(dropout)(x)
    return x

def build_autoencoder_1d(
    input_shape: tuple, num_heads: int = 2, filters: int = 32, kernel_sizes=(3, 5),n_blocos: int = 1,
    dropout: float = 0.5, l2: float = 1e-6,
):
    """
    Encoder TempCNN multi-cabeça: cada cabeça aplica 2 blocos TempCNN
    (Conv1D + BatchNorm + ReLU + Dropout) com um kernel_size próprio (captura
    padrões sazonais de escala diferente - kernel pequeno = transições curtas,
    kernel grande = ciclos longos) e as cabeças são concatenadas no espaço
    latente. num_heads deve bater com len(kernel_sizes).
    """
    if len(kernel_sizes) != num_heads:
        raise ValueError(f"num_heads={num_heads} não bate com len(kernel_sizes)={len(kernel_sizes)}")

    inputs = layers.Input(shape=input_shape, name="EVI_Input")

    # ====================================================
    # ENCODER (TempCNN Multi-Head)
    # ====================================================
    cabecas = []
    for i, k in enumerate(kernel_sizes, start=1):
        h = inputs
        for j in range(1, n_blocos + 1):
            h = bloco_tempcnn(h, filters, k, dropout, l2, nome=f"cabeca{i}_conv{j}")
        cabecas.append(h)

    # Espaço Latente / Fusão das representações (concatena só se houver mais de 1 cabeça)
    latent_space = cabecas[0] if len(cabecas) == 1 else layers.Concatenate(name="Espaco_Latente")(cabecas)

    # ====================================================
    # DECODER (Reconstrução da série temporal)
    # ====================================================
    dec = layers.Conv1D(filters, kernel_size=3, padding="same", activation="relu")(latent_space)
    dec = layers.BatchNormalization()(dec)
    

    # Saída reconstruída com 1 canal (EVI) e ativação linear
    reconstructed_output = layers.Conv1D(1, kernel_size=3, padding='same', activation='linear', name="Reconstrucao_EVI")(dec)
                           
    # Modelo completo (Autoencoder)
    autoencoder = Model(inputs=inputs, outputs=reconstructed_output, name="Autoencoder_SSL")
                  

    # Modelo isolado do Encoder (para usar no Fine-Tuning, em outro script)
    encoder = Model(inputs=inputs, outputs=latent_space, name="Encoder_TempCNN")

    return autoencoder, encoder


if __name__ == '__main__':
    # ==========================================
    # 1. CARREGAMENTO DOS DADOS (só os 60% reservados para SSL)
    # ==========================================
    dados_ssl = conf["dados"]["samples_ssl"]
    prefixo = conf["dados"]["indice_prefixo"]
    df = pd.read_csv(dados_ssl)
    X_unlabeled = df.loc[:, df.columns.str.startswith(prefixo)]
    X_unlabeled = X_unlabeled.interpolate(method="linear", limit_direction="both", axis=1)
    
    # Conv1D espera (N, timesteps, canais) - um DataFrame 2D (N, timesteps) não
    # é aceito direto pelo Input(shape=(timesteps, 1)).
    X_unlabeled = X_unlabeled.to_numpy()[..., np.newaxis]
    print(f"Dados de SSL: {dados_ssl} -> {X_unlabeled.shape[0]} amostras, {X_unlabeled.shape[1]} meses")

    # ==========================================
    # 2. PRÉ-TREINAMENTO AUTO-SUPERVISIONADO (Autoencoder)
    # ==========================================
    colsNum = X_unlabeled.shape[1]
    print("--- Iniciando Pré-Treinamento Auto-Supervisionado ---")
    autoencoder, encoder = build_autoencoder_1d(
                            input_shape=(colsNum, 1), num_heads=SSL_NUM_HEADS, filters=SSL_FILTERS,
                            kernel_sizes=SSL_KERNEL_SIZES, n_blocos=SSL_N_BLOCOS,
                            dropout=SSL_DROPOUT, l2=SSL_L2,
    )

    
    autoencoder.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=0.001),
        loss="mse"  # Erro Quadrático Médio para reconstruir o valor do EVI
    )

    # Treina para reconstruir a própria entrada (X_unlabeled -> X_unlabeled)
    autoencoder.fit(
        X_unlabeled, X_unlabeled,
        epochs=conf["modelo"]["epochs"],
        batch_size=conf["modelo"]["batch_size"],
        validation_split=conf["modelo"]["validation_split"],
        callbacks=[EarlyStopping(monitor='val_loss', patience=8, restore_best_weights=True)],
        verbose=1
    )

    # ==========================================
    # 3. SALVA MODELO (autoencoder completo) E PESOS (só o encoder)
    # ==========================================
    caminho_pesos = Path(conf["modelo"]["pesos_saida"])
    caminho_autoencoder = Path(conf["modelo"]["autoencoder_ssl_saida"])
    caminho_pesos.parent.mkdir(parents=True, exist_ok=True)
    caminho_autoencoder.parent.mkdir(parents=True, exist_ok=True)

    autoencoder.save(caminho_autoencoder)
    encoder.save_weights(caminho_pesos)

    print(f"✅ Autoencoder SSL salvo em: {caminho_autoencoder}")
    print(f"✅ Pesos do Encoder salvos em: {caminho_pesos}")
