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
  - "movimento"
---

# MomAI Vision

A MomAI Vision dá olhos à MomAI: snapshots de câmeras (webcam + IP/MJPEG),
descrição de cena com o modelo de visão local e monitoramento com alertas —
funcionando mesmo com a MomAI minimizada.

## Ferramentas

| Ferramenta | Uso |
| --- | --- |
| `list_cameras` | Lista câmeras (webcam/IP) com status e monitors ativos |
| `capture_snapshot {cameraId?}` | Captura e descreve a cena ("o que você vê aí?") |
| `describe_snapshot {snapshotId}` | Re-descreve um snapshot da galeria |
| `start_monitoring {cameraId, triggers[], ...}` | Inicia monitoramento com alertas (**REQUER CÂMERA**) |
| `update_monitoring {monitorId, cameraId?, triggers?, ...}` | Edita as configurações de um monitoramento ativo existente |
| `stop_monitoring {monitorId?}` | Para monitoramento(s) |
| `get_status` | Monitors ativos por câmera |
| `list_snapshots {limit?}` | Galeria (mais recentes primeiro) |

## Regra Estrita de Câmera para Monitoramento

- **REQUER CÂMERA EXPLÍCITA**: O LLM **NUNCA** deve chamar `start_monitoring` sem que o usuário tenha informado explicitamente qual câmera deseja monitorar (ex.: "garagem", "Yoosee", "webcam", "da porta").
- Se o usuário pedir para iniciar monitoramento sem especificar a câmera (ex.: "inicie o monitoramento", "vigie a porta", "me avise se alguém aparecer" sem informar a câmera), o LLM **DEVE** primeiro perguntar ao usuário qual câmera ele quer usar (ou chamar `list_cameras` para mostrar as opções disponíveis antes de perguntar ao usuário).

## Triggers (start_monitoring / update_monitoring)

```json
{
  "cameraId": "webcam:<deviceId>",
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
- `cooldownSec` — intervalo mínimo entre alertas do mesmo monitor (padrão 300 = 5min; aceita desde 10s). Quando o usuário falar em frequência ("avise a cada X", "não enche muito", "quero saber na hora"), passe o valor; se ficar em dúvida, pergunte ao usuário antes de iniciar.
- `schedule.days`: 0-6 (domingo=0). O monitoramento começa imediatamente na chamada; o plano é anunciado na resposta.

## Edição de Monitoramento (update_monitoring)

Para alterar um monitoramento que já está rodando (ex.: "mude o tempo do alerta da garagem para 10 minutos" ou "altere os triggers da câmera da porta"), use `update_monitoring { monitorId: "mon-...", cooldownSec: 600 }`. Use `get_status` caso precise descobrir o `monitorId`.

## Como usar (gramática)

- "o que você vê aí?" → `capture_snapshot`
- "me avise quando alguém chegar em casa na câmera da garagem" → `start_monitoring` com `cameraId: "garagem"` e `presence entered` (person)
- "mude o intervalo da câmera da garagem para 10 minutos" → `update_monitoring` com `cooldownSec: 600`
- "vigia a garagem de madrugada" → `start_monitoring` com `cameraId: "garagem"` + `motion` + `schedule` 22h-6h + cooldown
- "avise se alguém ficar parado na porta por 2 minutos na câmera da frente" → `start_monitoring` com `cameraId: "frente"` e `presence still_present` windowSec 120
- "me avise se o gato subir na mesa na câmera da sala" → `start_monitoring` com `cameraId: "sala"`, `motion` (gate) + `scene` "tem um gato na mesa?"

Quando o usuário nomear uma câmera específica ("da caza", "do j6", "da usb"), SEMPRE passe o `cameraId` exato retornado por `list_cameras` (ou o nome da câmera — ex.: `"caza"`). Se o usuário não disser qual câmera quer monitorar, PERGUNTE a ele.

## Honestidade (limites que a MomAI declara)

- **Identidade**: detecto "uma pessoa", não "quem" (ex.: "meu filho"). Sem reconhecimento facial.
- **Não-visual/oculto**: temperatura, trinco, outro cômodo — não detecto.
- **Transientes curtos**: um passarinho que passa rápido pode não ser captado.
- **Iluminação/clima**: noite sem IR, chuva, reflexos reduzem a qualidade.
- **Geometria/escala**: objeto muito pequeno ou distante não é detectado.
- **Subjetivo**: "está arrumado", "está triste" — não consigo avaliar; refinar para uma pergunta verificável.
- "Encomenda/pacote", "porta aberta", "luz acesa" **não são classes COCO** — use `scene` com pergunta SIM/NÃO (muitas vezes combinado com `motion` como gate).

## Fluxo de monitoramento

1. Chame `start_monitoring` com `cameraId` e `triggers` — o monitoramento começa imediatamente.
2. Anuncie na resposta o plano (câmera, triggers, horário, cooldown) e informe que está monitorando.
3. Ao disparar um trigger: snapshot salvo na galeria + **overlay flutuante** com a imagem + cartão no chat (`vision_alert`) + entrada no feed de alertas da página.
4. Para parar: `stop_monitoring {monitorId}` — ou o usuário para pela página/overlay.

## Performance

- Orçamento padrão: 1fps por câmera. Com muitas câmeras ativas, o sistema pode reduzir a taxa.
- Motion (gate barato) roda primeiro; detecção YOLO e visão só quando necessário.
- Cooldown/dedupe por monitor evita alertas repetidos.

## Privacidade

- Frames ficam só em memória (nunca em disco).
- Snapshots ficam no diretório local da extensão (7 dias / máx 200 / 100MB, configurável).
- Visão e detecção são 100% locais — nenhum pixel sai da máquina.
