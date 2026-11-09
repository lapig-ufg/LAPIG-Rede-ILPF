# Mapeamento Nacional de Pastagens com Camada de Integração (ILPF)

Repositório institucional contendo dados abertos, bases cartográficas de calibração, rotinas de processamento e a plataforma web interativa desenvolvida na cooperação técnico-científica entre a **Associação Rede ILPF** e o **Laboratório de Processamento de Imagens e Geoprocessamento (LAPIG)** da **Universidade Federal de Goiás (UFG)**.

---

## 📊 Resumo das Bases Amostrais

A plataforma integra **2.115 amostras georreferenciadas** inspecionadas e auditadas por especialistas agrícolas, distribuídas em duas camadas complementares com séries temporais de 13 meses de **EVI2** (Enhanced Vegetation Index 2):

| Conjunto Amostral | Feições | Geometria | Proveniência & Atributos |
| :--- | :--- | :--- | :--- |
| **Talhões Amostrais (Polígonos)** | **1.267** | MultiPolygon | Delineamento cartográfico de propriedades e talhões (área em ha, tipologia, safras 2010 a 2026, série EVI2) |
| **Pontos de Referência de Campo** | **848** | Point | Coordenadas pontuais auditadas em campo (município, UF, histórico de uso do solo 2023–2026, série EVI2) |
| **Total Integrado** | **2.115** | Vetorial | Base harmonizada de treino, teste e validação da camada nacional ILPF |

### Classes Mapeadas do Sistema de Integração:
1. **ILP — Lavoura-Pecuária** (`#b2f323`): 391 amostras (384 polígonos · 7 pontos)
2. **Pastagem Convencional** (`#eddc4b`): 497 amostras (364 polígonos · 133 pontos)
3. **Agricultura Monocultura** (`#2fc912`): 598 amostras (212 polígonos · 386 pontos)
4. **IPF — Pecuária-Floresta (Silvipastoril)** (`#f02907`): 400 amostras (225 polígonos · 175 pontos)
5. **ILPF — Lavoura-Pecuária-Floresta** (`#3c4d0a`): 37 amostras (24 polígonos · 13 pontos)
6. **ILF — Lavoura-Floresta (Silviagrícola)** (`#bcb915`): 11 amostras (11 polígonos)
7. **Agrofloresta (SAF)** (`#d67910`): 61 amostras (1 polígono · 60 pontos)
8. **Silvicultura Pura** (`#1b4332`): 25 amostras (9 polígonos · 16 pontos)
9. **Outros Usos** (`#718096`): 95 amostras (37 polígonos · 58 pontos)

---

## 🌐 Plataforma Web Interativa (`docs/`)

Estruturada em arquitetura estática modular compatível com GitHub Pages (Fonte: pasta `/docs` na branch `main`), utilizando aceleração gráfica via **Leaflet Canvas Markers**, **Chart.js 4** e design responsivo:

* **Página Inicial (`/`)**: Visão geral institucional, números do projeto, lacunas territoriais, pipeline metodológico, síntese das classes, entregas e cronograma.
* **Mapa Interativo & Amostras (`/analise-top3/` e `/mapa/`)**:
  * **Seletor de Camadas**: Alternância instantânea entre Polígonos (1.267), Pontos (848) ou visualização conjunta.
  * **Seleção em Caixa (Bounding Box)**: Desenhe áreas de interesse retangulares diretamente sobre o mapa para recalcular dinamicamente os contadores e gráficos de classes.
  * **Perfil Sazonal de EVI2**: Clique em qualquer talhão ou ponto para visualizar a curva temporal de 13 meses de vigor vegetativo.
  * **Filtros por Safra & Classe**: Filtragem simultânea por ano agrícola (2020 a 2026) e classes com contadores em tempo real.
  * **Tabela de Detalhes & Exportação CSV**: Tabela pesquisável com centralização automática e botão para download do subconjunto filtrado.
* **Downloads & Dados Abertos (`/produtos/`)**: Acesso direto aos arquivos `amostras_poligonos.geojson`, `amostras_pontos.geojson`, planilhas CSV e relatórios técnicos.
* **Cronograma & Fases (`/cronograma/`)**: Acompanhamento detalhado das 6 etapas contratuais e marcos temporais (Maio 2026 a Abril 2027).

---

## 📁 Estrutura de Diretórios do Repositório

```
Rede_ILPF_LAPIG/
│
├── 🌐 docs/                          # Plataforma Web (Jekyll / GitHub Pages: /docs)
│   ├── _config.yml                  # Configuração Jekyll do site
│   ├── _layouts/                    # Layouts base (default.html, page.html)
│   ├── _includes/                   # Módulos reutilizáveis (nav, hero, map_viz, methodology, etc.)
│   ├── assets/
│   │   ├── css/style.css            # Folha de estilos unificada
│   │   ├── js/main.js               # Motor interativo (Leaflet, filtros, Chart.js, CSV)
│   │   ├── figures/                 # Capa Time2Graze (ilpf_cover_bg.jpg) e logos
│   │   ├── mapbiomas_coverage_overlay_2025.png # Camada raster MapBiomas 10m em PNG leve
│   │   ├── produtos/                # Pacotes de dados analíticos para download
│   │   │   ├── pontos_integrado_ilpf_evi2_mapbiomas.gpkg # GPKG completo de pontos
│   │   │   ├── amostras_poligonos_ilpf_evi2_mapbiomas.gpkg # GPKG completo de polígonos
│   │   │   ├── rede_ilpf_lapig.duckdb   # Banco analítico DuckDB SQL (OLAP)
│   │   │   ├── amostras_pontos.parquet  # Base columnar Parquet de pontos
│   │   │   ├── amostras_poligonos.parquet # Base columnar Parquet de polígonos
│   │   │   └── matriz_transicoes_mapbiomas.csv # Matriz de transição 2020-2025
│   │   ├── amostras_poligonos.geojson # 1.267 talhões em formato aberto
│   │   ├── amostras_pontos.geojson  # 848 pontos de referência
│   │   ├── amostras_poligonos.csv   # Tabela com centróides, EVI2 e MapBiomas 2020-2025
│   │   ├── amostras_pontos.csv      # Tabela de pontos, EVI2 e MapBiomas 2020-2025
│   │   └── amostras_summary.json    # Metadados e estatísticas consolidadas
│   ├── analise-top3/                # Página dedicada do Mapa Interativo
│   ├── mapa/                        # Rota alternativa para o Mapa
│   ├── produtos/                    # Página de Downloads & Dados Abertos
│   ├── cronograma/                  # Página do Cronograma & Fases
│   └── index.html                   # Página Inicial
│
├── 🗺️ mapas_base/                    # Bases geográficas originais e consolidadas (GPKG, TIF)
│   ├── pontos_integrado_ilpf_evi2_mapbiomas.gpkg      # Produto final consolidado (Pontos)
│   ├── amostras_poligonos_ilpf_evi2_mapbiomas.gpkg    # Produto final consolidado (Polígonos)
│   ├── amostras_ilpf_inspecionadas_4326_evi2.gpkg     # GPKG polígonos original
│   └── pontos_integrado_final_v2_evi2.gpkg            # GPKG pontos original
│
├── 📄 documentos_de_base/           # Relatórios contratuais, plano de trabalho e apresentações
├── 🛠️ gerar_produtos_completos_duckdb.py # Pipeline de extração zonal, DuckDB e exportação
├── 🛠️ convert_mapas_base.py         # Script complementar de conversão para web
├── 🚀 servidor_local.py             # Servidor Python para teste local dinâmico
└── 📖 README.md                     # Documentação geral do repositório
```

---

## 🚀 Como Executar o Servidor Local

Para testar e navegar por todo o site localmente com renderização em tempo real dos includes e layouts:

```bash
python servidor_local.py
```

Abra o navegador no endereço: **`http://localhost:8000`** ou **`http://localhost:8000/analise-top3/`**.

---

## 🏛️ Instituições Parceiras
* **LAPIG / UFG** — Laboratório de Processamento de Imagens e Geoprocessamento (Universidade Federal de Goiás)
* **Associação Rede ILPF**
* **Embrapa** — Empresa Brasileira de Pesquisa Agropecuária
