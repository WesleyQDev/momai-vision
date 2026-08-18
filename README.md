# 👁️ MomAI Vision

A **MomAI Vision** é a extensão oficial de visão computacional para a assistente virtual **MomAI**. Ela dá "olhos" à MomAI: captura de câmeras, descrição de cena, monitoramento contínuo e alertas — tudo **100% local**, sem enviar nenhum pixel para fora da sua máquina.

---

## 💡 Sobre a Extensão

A extensão conecta a **MomAI** às suas câmeras para que ela possa ver e reagir ao ambiente:

- 📷 **Snapshots de câmeras** — webcam e câmeras IP/MJPEG
- 🧠 **Descrição de cena** — o modelo de visão local descreve o que a câmera está vendo ("o que você vê aí?")
- 🔍 **Detecção de objetos (YOLO)** — detecta pessoas, animais, carros e outras classes COCO
- 🚨 **Monitoramento com alertas** — movimento, presença/ausência, perguntas de cena e resumos periódicos
- 📊 **Dashboard interativo** — visualize câmeras, active monitoramentos e veja o feed de alertas

Tudo funciona **localmente**: o motor de inferência (ONNX Runtime) e o modelo YOLO rodam direto na sua máquina, sem depender de nuvem.

---

## 🎯 O que você pode fazer

### 💬 Snapshots e descrição de cena

- *"O que você vê aí?"* → captura um snapshot da câmera e descreve a cena
- *"Tira um print da câmera da garagem"* → captura da câmera especificada
- *"Re-descreve o último snapshot"* → nova descrição de um print da galeria

### 🔍 Monitoramento e alertas

- *"Me avise quando alguém chegar na câmera da garagem"* → alerta de detecção de pessoa
- *"Monitora a porta dos fundos por movimento"* → alerta de movimento
- *"Me avise se o portão estiver aberto"* → pergunta de cena (SIM/NÃO) periódica
- *"Envia um resumo a cada hora do que a câmera vê"* → resumo periódico
- *"Pausa o monitoramento da garagem"* → pausa mantendo os dados salvos
- *"Exclui o monitoramento da garagem"* → remove o monitoramento e seus dados

### 📊 Painel dedicado

A extensão adiciona uma página completa à barra lateral da MomAI para:

- Selecionar/ativar as câmeras desejadas
- Visualizar o feed de alertas e a galeria de snapshots
- Gerenciar monitoramentos (criar, pausar, retomar, excluir)
- Acompanhar o status em tempo real de cada câmera

---

## 🔑 Requisitos

- **MomAI 1.9.0 ou superior**
- Uma câmera (webcam integrada ou câmera IP/MJPEG na rede local)
- Para monitoramento com detecção de objetos: hardware capaz de rodar o modelo YOLO localmente

---

## 🚀 Instalação

1. Abra a **MomAI** e acesse a **Loja de Extensões**.
2. Procure por **MomAI Vision**.
3. Clique em **Instalar**.
4. Abra a página da extensão na barra lateral e selecione as câmeras que deseja ativar.

---

## 🧰 Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `list_cameras` | Lista câmeras (webcam/IP) com status e monitors ativos |
| `capture_snapshot` | Captura e descreve a cena ("o que você vê aí?") |
| `describe_snapshot` | Re-descreve um snapshot da galeria |
| `update_monitoring` | Edita as configurações de um monitoramento existente |
| `pause_monitoring` | Pausa sem excluir: para a execução, mas os dados ficam salvos |
| `resume_monitoring` | Retoma um monitoramento pausado |
| `stop_monitoring` | **EXCLUI** definitivamente o monitoramento e seus dados |
| `get_status` | Monitors ativos/pausados por câmera |
| `list_snapshots` | Galeria (mais recentes primeiro) |

---

## 🔐 Privacidade

- **Frames** ficam apenas em memória, nunca em disco.
- **Snapshots** ficam no diretório local da extensão (7 dias / máx. 200 / 100MB, configurável).
- **Visão e detecção são 100% locais** — nenhum pixel sai da sua máquina.

---

## ⚠️ Limites (honestidade)

- A detecção identifica **"uma pessoa"**, não **quem** é (sem reconhecimento facial).
- Temperatura, trinco e outros estados **não visuais** não são detectados.
- Objetos muito pequenos, distantes, com pouca luz ou em movimento rápido podem não ser captados.
- "Encomenda/pacote", "porta aberta" e "luz acesa" não são classes COCO — use perguntas de cena (SIM/NÃO).
