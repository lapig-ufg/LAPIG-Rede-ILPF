import sys

# O console do Windows (cmd/PowerShell) costuma usar a codificação cp1252 por
# padrão, que não sabe representar os emojis usados nos prints abaixo (✅, 📂,
# 📖, 🧠, ⚠️) - sem isso, o script quebra com UnicodeEncodeError bem no final,
# mesmo depois do treino e do salvamento do modelo terem funcionado.
sys.stdout.reconfigure(encoding="utf-8")

import importlib.util
from pathlib import Path

import numpy as np
import pandas as pd
import tensorflow as tf
import yaml
from tensorflow.keras import layers, Model
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.preprocessing import LabelEncoder
from sklearn.utils.class_weight import compute_class_weight
from tensorflow.keras.callbacks import EarlyStopping, ModelCheckpoint

_CONFIG_PATH = Path(__file__).resolve().parent / "config" / "settings.yaml"
with open(_CONFIG_PATH, "r", encoding="utf-8") as _f:
    conf = yaml.safe_load(_f)

# Legenda de tipo_integ, de "Parceria Lapig-Rede ILPF.pptx" (slide
# "Codificação do tipo de integração"). tipo_integ==0 não tem entrada na
# legenda (classe espúria, 1 única amostra - já excluída do split 60/40).
NOMES_TIPO_INTEG = {
    1: "Pastagem", 2: "Agricultura", 3: "ILPF", 4: "ILP", 5: "IPF",
    6: "Agrofloresta", 7: "ILF", 8: "Outros", 9: "Silvicultura",
}

# Reaproveita build_autoencoder_1d + os hiperparâmetros vencedores do SSL de
# 03_model_tempcnn_ssl.py (nome do arquivo começa com dígito, por isso o
# import via importlib em vez de "import ..."). É essencial usar a MESMA
# arquitetura usada no pré-treino - senão encoder.load_weights() falha ou
# carrega pesos nas camadas erradas.
_spec = importlib.util.spec_from_file_location(
    "tempcnn_ssl", Path(__file__).resolve().parent / "03_model_tempcnn_ssl.py"
)
_tempcnn_ssl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_tempcnn_ssl)
build_autoencoder_1d = _tempcnn_ssl.build_autoencoder_1d
SSL_NUM_HEADS = _tempcnn_ssl.SSL_NUM_HEADS
SSL_FILTERS = _tempcnn_ssl.SSL_FILTERS
SSL_KERNEL_SIZES = _tempcnn_ssl.SSL_KERNEL_SIZES
SSL_N_BLOCOS = _tempcnn_ssl.SSL_N_BLOCOS
SSL_DROPOUT = _tempcnn_ssl.SSL_DROPOUT
SSL_L2 = _tempcnn_ssl.SSL_L2


def build_ssl_classifier(encoder_model, input_shape: tuple, num_classes: int, freeze_encoder=False):
    """
    Acopla a cabeça de classificação multiclasse (tipo_integ) ao Encoder pré-treinado.
    """
    # Congela os pesos do Encoder inicialmente se tiver pouquíssimas amostras (< 30)
    encoder_model.trainable = not freeze_encoder

    inputs = layers.Input(shape=input_shape, name="Classifier_Input")

    # Extrai as características aprendidas no pré-treinamento
    features = encoder_model(inputs)

    # Cabeça de decisão
    x = layers.Flatten(name="Flatten_Features")(features)
    x = layers.Dense(32, activation='relu')(x)
    x = layers.Dropout(0.3)(x)

    # Saída multiclasse: 1 probabilidade por tipo_integ (softmax, soma 1)
    outputs = layers.Dense(num_classes, activation='softmax', name="Output_TipoInteg")(x)

    model = Model(inputs=inputs, outputs=outputs, name="TempCNN_TipoInteg_FineTuned")
    return model


def augment_evi_series(X, y, multiplier=4):
    """
    Multiplica as poucas amostras de treino adicionando ruído gaussiano leve
    e mascaramento temporal pontual.
    """
    X_aug, y_aug = list(X), list(y)

    for _ in range(multiplier):
        for series, label in zip(X, y):

            # 1. Ruído leve
            noise = np.random.normal(0, 0.015, series.shape)
            s_noisy = np.clip(series + noise, -1.0, 1.0)
            X_aug.append(s_noisy)
            y_aug.append(label)

            # 2. Mascaramento aleatório de 1 mês
            s_masked = series.copy()
            idx = np.random.randint(0, len(series))
            s_masked[idx] = np.mean(series)
            X_aug.append(s_masked)
            y_aug.append(label)

    return np.array(X_aug), np.array(y_aug)


if __name__ == '__main__':
    # ------------------------------------------------------------------
    # FINE-TUNING COM OS 40% DE AMOSTRAS RESERVADOS (samples_iCLS_finetune_40pct.csv)
    # ------------------------------------------------------------------
    print("\n--- Iniciando Fine-Tuning ---")

    prefixo = conf["dados"]["indice_prefixo"]
    dados_finetune = conf["dados"]["samples_finetune"]
    df_labeled = pd.read_csv(dados_finetune)
    # Exclui a classe espúria 0, se houver (não deveria sobrar nenhuma aqui,
    # já tirada no split 60/40, mas fica como salvaguarda caso o CSV de
    # fine-tuning seja regenerado diferente). Precisa vir ANTES de montar
    # X_labeled, pra X e y continuarem alinhados linha a linha.
    df_labeled = df_labeled[df_labeled["tipo_integ"] != 0].reset_index(drop=True)
    print(f"Dados de fine-tuning: {dados_finetune} -> {len(df_labeled)} amostras")

    X_labeled = df_labeled.loc[:, df_labeled.columns.str.startswith(prefixo)]
    # Preenchimento de lacunas de nuvem, por segurança (samples_iCLS.csv não
    # tem NaN hoje, mas um lote futuro reexportado do GEE pode ter).
    X_labeled = X_labeled.interpolate(method="linear", limit_direction="both", axis=1)
    colsNum = X_labeled.shape[1]
    X_labeled = X_labeled.to_numpy().reshape(-1, colsNum, 1)

    # RÓTULO: tipo_integ (multiclasse)
    label_encoder = LabelEncoder()
    y_labeled = label_encoder.fit_transform(df_labeled["tipo_integ"])
    num_classes = len(label_encoder.classes_)
    nomes_classes = [NOMES_TIPO_INTEG.get(t, str(t)) for t in label_encoder.classes_]

    print(f"\nClasses ({num_classes}): {nomes_classes}")
    print("Distribuição por classe:")
    print(df_labeled["tipo_integ"].map(NOMES_TIPO_INTEG).value_counts().to_string())

    # Divisão Treino e Teste
    X_train, X_test, y_train, y_test = train_test_split(
        X_labeled, y_labeled, test_size=0.25, random_state=42, stratify=y_labeled
    )

    # Aplica Augmentação nos dados de treino
    X_train_aug, y_train_aug = augment_evi_series(X_train, y_train, multiplier=3)

    # ------------------------------------------------------------------
    # Reconstrói o encoder com a MESMA arquitetura do pré-treino SSL e
    # carrega os pesos salvos por 03_model_tempcnn_ssl.py.
    # ------------------------------------------------------------------
    _, encoder = build_autoencoder_1d(
        input_shape=(colsNum, 1), num_heads=SSL_NUM_HEADS, filters=SSL_FILTERS, kernel_sizes=SSL_KERNEL_SIZES,
        n_blocos=SSL_N_BLOCOS, dropout=SSL_DROPOUT, l2=SSL_L2,
    )
    encoder.load_weights(conf["modelo"]["pesos_saida"])
    print(f"Pesos do encoder SSL carregados de: {conf['modelo']['pesos_saida']}")

    # Cria o classificador usando o encoder pré-treinado
    classifier = build_ssl_classifier(encoder, input_shape=(colsNum, 1), num_classes=num_classes, freeze_encoder=False)

    # Compila com Learning Rate MENOR (1e-4) para preservação das características aprendidas
    classifier.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=1e-4),
        loss="sparse_categorical_crossentropy",
        metrics=["accuracy"]
    )

    # Pesos para equilibrar as classes (muito desbalanceadas - ver análise descritiva)
    class_weights = compute_class_weight("balanced", classes=np.unique(y_train_aug), y=y_train_aug)
    weights_dict = dict(enumerate(class_weights))

    caminho_model_saida = Path(conf["modelo"]["model_saida"])
    caminho_model_saida.parent.mkdir(parents=True, exist_ok=True)

    # Treinamento Supervisionado
    history = classifier.fit(
        X_train_aug, y_train_aug,
        validation_data=(X_test, y_test),
        epochs=100,
        batch_size=16,
        class_weight=weights_dict,
        callbacks=[
            EarlyStopping(monitor='val_accuracy', mode='max', patience=20, restore_best_weights=True),
            ModelCheckpoint(caminho_model_saida, monitor='val_accuracy', mode='max', save_best_only=True)
        ],
        verbose=1
    )

    print(f"✅ Modelo fine-tuned salvo em: {caminho_model_saida}")

    # ------------------------------------------------------------------
    # AVALIAÇÃO NO CONJUNTO DE TESTE
    # ------------------------------------------------------------------
    # `restore_best_weights=True` já deixa o `classifier` na época de melhor
    # val_accuracy, então avaliamos ele diretamente (mesmo modelo salvo pelo
    # ModelCheckpoint).
    y_proba_test = classifier.predict(X_test, verbose=0)
    y_pred_test = np.argmax(y_proba_test, axis=1)

    print("\n--- [Avaliação] Conjunto de teste ---")
    print(f"Treino: {len(X_train)} (ampliado p/ {len(X_train_aug)} com augmentação) | Teste: {len(X_test)}")
    print("\nMatriz de confusão (linhas=real, colunas=previsto):")
    print(pd.DataFrame(
        confusion_matrix(y_test, y_pred_test, labels=range(num_classes)),
        index=nomes_classes, columns=nomes_classes,
    ).to_string())
    print()
    print(classification_report(
        y_test, y_pred_test, labels=range(num_classes), target_names=nomes_classes, digits=3, zero_division=0,
    ))
