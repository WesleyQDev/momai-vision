---
name: MomAI Vision
description: Olhos para a MomAI: snapshots de câmeras, monitoramento e alertas 100% locais.
author: WesleyQDev
version: 1.0.0
icon: 👁️
tags:
  - vision
  - camera
  - monitoring
permissions:
  - camera
  - network
intents:
  - "o que você vê aí"
  - "tirar snapshot"
  - "me avise quando"
  - "monitorar"
  - "vigiar"
  - "câmera"
  - "câmeras"
  - "movimento"
  - "ver as câmeras"
---

# MomAI Vision

A MomAI Vision dá olhos à MomAI: snapshots de câmeras (webcam + IP/MJPEG),
descrição de cena com o modelo de visão local e monitoramento com alertas —
funcionando mesmo com a M## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `list_cameras` | Lista câmeras (webcam/IP) com status e monitors ativos |
| `capture_snapshot {cameraId?}` | Captura e descreve a cena ("o que você vê aí?") |
| `describe_snapshot {snapshotId}` | Re-descreve um snapshot da galeria |
| `update_monitoring {monitorId, cameraId?, triggers?, ...}` | Edita as configurações de um monitoramento existente |
| `pause_monitoring {monitorId?}` | Pausa sem excluir: para a execução e o card some, mas os dados ficam salvos |
| `resume_monitoring {monitorId?}` | Retoma um monitoramento pausado |
| `stop_monitoring {monitorId?}` | **EXCLUI** definitivamente o monitoramento e seus dados |
| `get_status` | Monitors ativos/pausados por câmera |
| `list_snapshots {limit?}` | Galeria (mais recentes primeiro) |

## Regra Estrita de Câmera para Snapshots

- **APENAS CÂMERAS SELECIONADAS NO PAINEL**: As ferramentas (`capture_snapshot`, `get_frame`, etc.) funcionam **apenas** nas câmeras que o usuário ativou/selecionou no painel da página MomAI Vision (`selected: true` em `list_cameras`).
- Se o usuário pedir para tirar snapshot ou interagir com uma câmera que não está selecionada/ativa no painel, informe ao usuário para abrir o painel da MomAI Vision e clicar no botão `+` para selecionar/ativar a câmera desejada.

## Integração com o Automation Hub (Notificações & Ações Externas)

- **REGRA DE OURO PARA O ASSISTENTE (LLM)**:
  - Sempre que o usuário solicitar uma automação, alerta ou notificação envolvendo o MomAI Vision (ex.: avisar no WhatsApp, e-mail, tocar som ou notificação quando a câmera detectar algo), o assistente **DEVE APENAS CHAMAR A FERRAMENTA `create_automation`** (da skill `automation`).
  - **NÃO chame nenhuma ferramenta individual de monitoramento visual antes.** Execute **somente** `create_automation`, vinculando o evento `momai-vision.vision_alert` à ação desejada (ex: `whatsapp.send_message`), utilizando `{{trigger.payload.description}}` e `{{trigger.payload.imageDataUri}}`.

## Triggers (update_monitoring)

```json
{
  "monitorId": "mon-1722880000000",
  "triggers": [{ "type": "motion", "sensitivity": "med" }],
  "schedule": { "days": [0,1,2,3,4,5,6], "start": "22:00", "end": "06:00" },
  "cooldownSec": 300,
  "notify": { "native": true, "chat": true },
  "label": "Garagem"
}
```

- `motion` — movimento (absdiff); `sensitivity`: low/med/high; `minArea`.
- `object` — detecção COCO: `className` (person, cat, dog, car…), `minConfidence`, `present`.
- `presence`/`absence` — `className` (default person), `event`: entered/left/still_present, `windowSec`.
- `scene` — pergunta SIM/NÃO via visão local: `question`, `everySec` (15-300), `onAnswer`: yes/no/change, `confirmN`.
- `periodic` — resumo periódico: `everySec`, `task`.
- `cooldownSec` — intervalo mínimo entre alertas do mesmo monitor (padrão 300 = 5min; aceita desde 10s).
- `schedule.days`: 0-6 (domingo=0).

## Edição de Monitoramento (update_monitoring)

Para alterar um monitoramento existente (ex.: "mude o tempo do alerta da garagem para 10 minutos" ou "altere os triggers da câmera da porta"), use `update_monitoring { monitorId: "mon-...", cooldownSec: 600 }`. Use `get_status` caso precise descobrir o `monitorId`.

## Pausar, Retomar e Excluir

- **Pausar** (`pause_monitoring`): o monitoramento para de executar e o card some, mas os dados e a configuração ficam salvos. "pausa o monitoramento da garagem", "para de monitorar por enquanto, mas não exclui".
- **Retomar** (`resume_monitoring`): reativa um monitoramento pausado. "volta a monitorar a garagem".
- **Excluir** (`stop_monitoring`): remove o monitoramento **definitivamente**, incluindo dados/configurações. "exclui o monitoramento da garagem", "quero parar de vez com esse monitoramento". Pausar não é excluir; se o usuário quiser apagar de vez, use `stop_monitoring`.

## Como usar (gramática)

- "o que você vê aí?" → `capture_snapshot`
- "ver as câmeras" → chame `list_cameras` e liste as câmeras disponíveis
- "me avise quando alguém chegar em casa na câmera da garagem" → `create_automation` vinculando `momai-vision.vision_alert` com condição `className: "person"`
- "mude o intervalo da câmera da garagem para 10 minutos" → `update_monitoring` com `cooldownSec: 600`
- "pausar monitoramento da garagem" → `pause_monitoring`

## Honestidade (limites que a MomAI declara)

- **Identidade**: detecto "uma pessoa", não "quem" (ex.: "meu filho"). Sem reconhecimento facial.
- **Não-visual/oculto**: temperatura, trinco, outro cômodo — não detecto.
- **Transientes curtos**: um passarinho que passa rápido pode não ser captado.
- **Iluminação/clima**: noite sem IR, chuva, reflexos reduzem a qualidade.
- **Geometria/escala**: objeto muito pequeno ou distante não é detectado.
- **Subjetivo**: "está arrumado", "está triste" — não consigo avaliar; refinar para uma pergunta verificável.
- "Encomenda/pacote", "porta aberta", "luz acesa" **não são classes COCO** — use `scene` com pergunta SIM/NÃO.

## Fluxo de monitoramento

1. Para criar uma automação de visão, chame **somente** `create_automation`.
2. Ao disparar um trigger: snapshot salvo na galeria + **overlay flutuante** com a imagem + cartão no chat (`vision_alert`) + entrada no feed de alertas da página.
3. Para pausar (manter salvo): `pause_monitoring {monitorId}` — o overlay e o card somem, mas o monitor continua gerenciável na página. Para retomar depois: `resume_monitoring {monitorId}`.
4. Para excluir de vez (remover dados): `stop_monitoring {monitorId}` — também pela página (botão lixeira) ou pelo overlay.�gina. Para retomar depois: `resume_monitoring {monitorId}`.
5. Para excluir de vez (remover dados): `stop_monitoring {monitorId}` — também pela página (botão lixeira) ou pelo overlay.

## Performance

- Orçamento padrão: 1fps por câmera. Com muitas câmeras ativas, o sistema pode reduzir a taxa.
- Motion (gate barato) roda primeiro; detecção YOLO e visão só quando necessário.
- Cooldown/dedupe por monitor evita alertas repetidos.

## Privacidade

- Frames ficam só em memória (nunca em disco).
- Snapshots ficam no diretório local da extensão (7 dias / máx 200 / 100MB, configurável).
- Visão e detecção são 100% locais — nenhum pixel sai da máquina.
